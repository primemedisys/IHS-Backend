/**
 * Diagnostic Lab business logic (migration 038). Mirrors the pharmacy
 * prescription-request flow (prescriptionRequest.service) for a different kind
 * of provider:
 *
 *   patient shares a prescription with a lab in their Google location
 *     → lab views it, answers which tests are available + at what price
 *     → patient picks tests + a preferred date (the booking)
 *     → lab confirms (or rejects) → marks the test completed
 *     → lab uploads the report, which is FILED INTO THE PATIENT'S EXISTING
 *       medical records (uploaded_records, source 'diagnostic_lab').
 *
 * Reuses, rather than duplicates: the provider location rule
 * (medicineStore.userLocationWhere), the storage driver (upload.service), and
 * the notification table (medicine_notifications, reference_type
 * 'diagnostic_request').
 *
 * Every read and write is scoped server-side: a patient only ever reaches rows
 * whose patient_id is theirs, a lab only rows whose lab_id is theirs.
 */
const { Op, fn, col } = require("sequelize");
const {
  sequelize,
  User,
  DiagnosticTest,
  DiagnosticRequest,
  DiagnosticRequestTest,
  UploadedRecord,
  MedicineNotification,
} = require("../models");
const ApiError = require("../utils/ApiError");
const { sameId } = require("../utils/ids");
const uploadService = require("./upload.service");
const { userLocationWhere } = require("./medicineStore.service");
const {
  ROLES,
  RECORD_SOURCES,
  DIAGNOSTIC_REQUEST_STATUS: S,
  DIAGNOSTIC_LAB_TRANSITIONS,
  DIAGNOSTIC_RESPONDABLE_STATUSES,
  DIAGNOSTIC_REPORTABLE_STATUSES,
  DIAGNOSTIC_TEST_STATUS,
  DIAGNOSTIC_NOTIFICATION_REF,
} = require("../config/constants");

/** How far ahead a patient may book (days). */
const MAX_BOOKING_DAYS_AHEAD = 180;

const LAB_ATTRIBUTES = ["id", "name", "phone", "addressLine", "city", "state", "pincode"];
/** Same patient fields the pharmacy side exposes to a provider. */
const PATIENT_ATTRIBUTES = ["id", "name", "phone"];
/** The stored prescription URL never leaves the server — files are streamed. */
const REQUEST_ATTRIBUTES = { exclude: ["fileUrl"] };

const DETAIL_INCLUDE = [
  { model: User, as: "patient", attributes: PATIENT_ATTRIBUTES },
  { model: User, as: "lab", attributes: LAB_ATTRIBUTES },
  {
    model: DiagnosticRequestTest,
    as: "tests",
    // Loaded in its own query so the order holds (a limited parent query
    // would otherwise wrap it in a subquery).
    separate: true,
    order: [["id", "ASC"]],
    include: [
      // The filed report's metadata only — the file itself is streamed through
      // the API (streamReport), never handed out by URL from here.
      { model: UploadedRecord, as: "report", attributes: ["id", "fileType", "tag", "recordDate", "uploadedAt"] },
    ],
  },
];

// ── helpers ──────────────────────────────────────────────────────────────

/** One or more in-app notifications through the EXISTING notification table. */
function notify(rows, transaction) {
  return MedicineNotification.bulkCreate(
    rows.map((r) => ({ ...r, referenceType: DIAGNOSTIC_NOTIFICATION_REF })),
    { transaction }
  );
}

/** Optional request-date range on created_at (`from` inclusive, `to` exclusive). */
function createdAtRange({ from, to }) {
  if (!from && !to) return null;
  const range = {};
  if (from) range[Op.gte] = from;
  if (to) range[Op.lt] = to;
  return range;
}

function listWhere(base, { status, from, to }) {
  const where = { ...base };
  if (status) where.status = status;
  const createdAt = createdAtRange({ from, to });
  if (createdAt) where.createdAt = createdAt;
  return where;
}

function paged(rows, count, page, limit) {
  return { requests: rows, total: count, page, limit, totalPages: Math.ceil(count / limit) };
}

/** Local calendar date (YYYY-MM-DD) of the server clock. */
function localIsoDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Load a request and require the caller to be its lab. */
async function findForLab(labId, requestId, options = {}) {
  const request = await DiagnosticRequest.findByPk(requestId, options);
  if (!request) throw ApiError.notFound("Diagnostic request not found");
  if (!sameId(request.labId, labId)) throw ApiError.forbidden("Not authorized");
  return request;
}

/** Load a request and require the caller to be its patient. */
async function findForPatient(patientId, requestId, options = {}) {
  const request = await DiagnosticRequest.findByPk(requestId, options);
  if (!request) throw ApiError.notFound("Diagnostic request not found");
  if (!sameId(request.patientId, patientId)) throw ApiError.forbidden("Not authorized");
  return request;
}

/** Load a request and require the caller to be its patient OR its lab. */
async function findForParticipant(userId, requestId, options = {}) {
  const request = await DiagnosticRequest.findByPk(requestId, options);
  if (!request) throw ApiError.notFound("Diagnostic request not found");
  if (!sameId(request.patientId, userId) && !sameId(request.labId, userId)) {
    throw ApiError.forbidden("Not authorized");
  }
  return request;
}

/** Test names for a notification message ("MRI, CBC"). */
const testNames = (tests) => tests.map((t) => t.testName).join(", ");

// ── Patient: find labs + share ───────────────────────────────────────────

/**
 * Registered Diagnostic Lab Centers in the patient's selected Google location,
 * using the SAME city/state rule as the pharmacy directory and share flow.
 * Each row carries a live count of the tests the lab currently offers (one
 * grouped query for the page — never a count per row).
 */
exports.listLabs = async ({ city, state, search, page = 1, limit = 20 } = {}) => {
  const where = { isActive: true, role: ROLES.DIAGNOSTIC_LAB };
  if (search) where.name = { [Op.like]: `%${search}%` };
  const clauses = userLocationWhere({ city, state });
  if (clauses.length) where[Op.and] = clauses;

  const { rows, count } = await User.findAndCountAll({
    where,
    attributes: [...LAB_ATTRIBUTES, "profilePhotoUrl", "lat", "lng"],
    order: [["name", "ASC"]],
    limit,
    offset: (page - 1) * limit,
  });

  const ids = rows.map((r) => r.id);
  const counts = ids.length
    ? await DiagnosticTest.findAll({
        attributes: ["labId", [fn("COUNT", col("id")), "n"]],
        where: { labId: { [Op.in]: ids }, isActive: true, isAvailable: true },
        group: ["labId"],
        raw: true,
      })
    : [];
  const byLab = new Map(counts.map((c) => [String(c.labId), Number(c.n)]));

  const labs = rows.map((row) => ({
    ...row.toJSON(),
    providerType: ROLES.DIAGNOSTIC_LAB,
    testCount: byLab.get(String(row.id)) || 0,
  }));
  return { labs, total: count, page, limit, totalPages: Math.ceil(count / limit) };
};

/**
 * Patient uploads a prescription and shares it with the selected lab(s). Every
 * lab id is re-validated here: it must be an ACTIVE Diagnostic Lab Center and —
 * when a location was selected — registered in that city/state. One invalid id
 * rejects the whole share. One request per lab, created atomically with each
 * lab's notification.
 */
exports.shareRequest = async (patientId, file, { labIds, notes, city, state }) => {
  if (!file) throw ApiError.badRequest("Prescription file is required");

  const uniqueIds = [...new Set(labIds.map((id) => Number(id)))];
  const labs = await User.findAll({
    where: {
      id: { [Op.in]: uniqueIds },
      role: ROLES.DIAGNOSTIC_LAB,
      isActive: true,
      [Op.and]: userLocationWhere({ city, state }),
    },
    attributes: ["id"],
  });
  if (labs.length !== uniqueIds.length) {
    throw ApiError.badRequest(
      city || state
        ? "One or more selected labs are not available in the selected location"
        : "One or more selected labs are not available"
    );
  }

  const opts = { keyPrefix: `diagnostic/patients/${patientId}/prescriptions`, filename: file.originalname, mimetype: file.mimetype };
  return uploadService.storeThen(file.buffer, opts, ({ url }) => sequelize.transaction(async (transaction) => {
    const requests = await DiagnosticRequest.bulkCreate(
      labs.map((lab) => ({
        patientId,
        labId: lab.id,
        fileUrl: url,
        fileName: file.originalname,
        notes: notes || null,
        status: S.PENDING,
      })),
      { transaction }
    );
    await notify(
      [
        ...requests.map((r) => ({
          userId: r.labId,
          title: "New diagnostic request",
          message: "A patient shared a prescription with your lab. Check the tests to respond.",
          type: "diagnostic_request_received",
          referenceId: r.id,
        })),
        {
          userId: patientId,
          title: "Prescription sent to diagnostic lab",
          message:
            requests.length > 1
              ? `Your prescription was sent to ${requests.length} diagnostic labs.`
              : "Your prescription was sent to the diagnostic lab.",
          type: "diagnostic_request_sent",
          referenceId: requests[0].id,
        },
      ],
      transaction
    );
    return requests;
  }));
};

// ── Lists + detail ───────────────────────────────────────────────────────

exports.listMyRequests = async (patientId, { page = 1, limit = 20, ...filters } = {}) => {
  const { rows, count } = await DiagnosticRequest.findAndCountAll({
    where: listWhere({ patientId }, filters),
    attributes: REQUEST_ATTRIBUTES,
    include: [{ model: User, as: "lab", attributes: LAB_ATTRIBUTES }],
    order: [["createdAt", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return paged(rows, count, page, limit);
};

exports.listLabRequests = async (labId, { page = 1, limit = 20, ...filters } = {}) => {
  const { rows, count } = await DiagnosticRequest.findAndCountAll({
    where: listWhere({ labId }, filters),
    attributes: REQUEST_ATTRIBUTES,
    include: [{ model: User, as: "patient", attributes: PATIENT_ATTRIBUTES }],
    order: [["createdAt", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return paged(rows, count, page, limit);
};

/** One request with its tests + report metadata (patient or its lab only). */
exports.getRequest = async (userId, requestId) => {
  const request = await findForParticipant(userId, requestId, {
    attributes: REQUEST_ATTRIBUTES,
    include: DETAIL_INCLUDE,
  });
  return request;
};

// ── File streaming (never a public URL) ──────────────────────────────────

async function streamStored(url, fileName) {
  const buffer = await uploadService.readByUrl(url);
  if (!buffer) throw ApiError.notFound("File not found");
  return { buffer, contentType: uploadService.contentTypeFor(fileName || url), fileName };
}

exports.streamFile = async (userId, requestId) => {
  const request = await findForParticipant(userId, requestId, {
    attributes: ["id", "patientId", "labId", "fileUrl", "fileName"],
  });
  return streamStored(request.fileUrl, request.fileName || `prescription-${request.id}`);
};

exports.streamReport = async (userId, requestId, testId) => {
  await findForParticipant(userId, requestId, { attributes: ["id", "patientId", "labId"] });
  const test = await DiagnosticRequestTest.findOne({
    where: { id: testId, diagnosticRequestId: requestId },
    include: [{ model: UploadedRecord, as: "report", attributes: ["id", "fileUrl"] }],
  });
  if (!test) throw ApiError.notFound("Test not found on this request");
  if (!test.report) throw ApiError.notFound("No report has been uploaded for this test");
  const ext = (String(test.report.fileUrl).split("?")[0].match(/\.([a-z0-9]{1,5})$/i) || [])[1];
  const safeName = test.testName.replace(/[^a-zA-Z0-9 _-]/g, "").trim() || "Diagnostic";
  return streamStored(test.report.fileUrl, `${safeName} Report${ext ? `.${ext}` : ""}`);
};

// ── Lab: status, response, report ────────────────────────────────────────

const STATUS_STAMP = {
  [S.CONFIRMED]: "confirmedAt",
  [S.TEST_COMPLETED]: "completedAt",
};

const STATUS_MESSAGE = {
  [S.VIEWED]: { title: "Lab viewed your request", message: "The diagnostic lab has viewed your prescription." },
  [S.CONFIRMED]: {
    title: "Diagnostic booking confirmed",
    message: "Your diagnostic test booking has been confirmed by the lab.",
  },
  [S.TEST_COMPLETED]: {
    title: "Diagnostic test completed",
    message: "Your diagnostic test is complete. The lab will upload your report soon.",
  },
  [S.REJECTED]: { title: "Diagnostic request rejected", message: "The diagnostic lab could not take your request." },
};

/**
 * The lab moves a request along the manual steps (viewed / confirm / reject /
 * test completed). Anything not in DIAGNOSTIC_LAB_TRANSITIONS is refused, so a
 * closed request cannot be reopened and a step cannot be skipped.
 */
exports.updateStatus = async (labId, requestId, status, note) => {
  const request = await findForLab(labId, requestId);
  const allowed = DIAGNOSTIC_LAB_TRANSITIONS[request.status] || [];
  if (!allowed.includes(status)) {
    throw ApiError.badRequest(`Cannot move a '${request.status}' request to '${status}'`);
  }

  const wasBooking = request.status === S.BOOKING_REQUESTED;
  const patch = { status };
  if (STATUS_STAMP[status]) patch[STATUS_STAMP[status]] = new Date();
  if (note) patch.labNote = note;

  const base = STATUS_MESSAGE[status];
  const rejectedBooking = status === S.REJECTED && wasBooking;
  await sequelize.transaction(async (transaction) => {
    await request.update(patch, { transaction });
    await notify(
      [
        {
          userId: request.patientId,
          title: rejectedBooking ? "Diagnostic booking rejected" : base.title,
          message: [rejectedBooking ? "The lab could not accept your booking." : base.message, note]
            .filter(Boolean)
            .join(" "),
          type: rejectedBooking ? "diagnostic_booking_rejected" : `diagnostic_${status}`,
          referenceId: request.id,
        },
      ],
      transaction
    );
  });

  return exports.getRequest(labId, request.id);
};

/**
 * The lab answers which tests it can do and at what price (a manual check of
 * the prescription — no OCR). Available catalogue tests take the catalogue
 * name/price unless the lab overrides the price; typed-in tests carry their
 * own. Re-sending REPLACES the previous answer, allowed only until the patient
 * books.
 */
exports.respond = async (labId, requestId, tests, note) => {
  const request = await findForLab(labId, requestId);
  if (!DIAGNOSTIC_RESPONDABLE_STATUSES.includes(request.status)) {
    throw ApiError.badRequest("This request can no longer be answered");
  }

  // Resolve every referenced catalogue test in ONE query, scoped to this lab.
  const catalogIds = [
    ...new Set(tests.filter((t) => t.diagnosticTestId).map((t) => String(t.diagnosticTestId))),
  ];
  const catalog = catalogIds.length
    ? await DiagnosticTest.findAll({
        where: { id: { [Op.in]: catalogIds }, labId, isActive: true },
      })
    : [];
  const byId = new Map(catalog.map((t) => [String(t.id), t]));
  if (byId.size !== catalogIds.length) throw ApiError.notFound("A selected test is not in your catalogue");

  const rows = tests.map((t) => {
    if (t.status === DIAGNOSTIC_TEST_STATUS.UNAVAILABLE) {
      return {
        diagnosticTestId: null,
        testName: t.testName,
        price: null,
        status: DIAGNOSTIC_TEST_STATUS.UNAVAILABLE,
        reason: t.reason || null,
      };
    }
    const entry = t.diagnosticTestId ? byId.get(String(t.diagnosticTestId)) : null;
    return {
      diagnosticTestId: entry ? entry.id : null,
      testName: (entry ? entry.name : t.testName) || t.testName,
      price: t.price ?? entry?.price,
      status: DIAGNOSTIC_TEST_STATUS.AVAILABLE,
      reason: null,
    };
  });

  const available = rows.filter((r) => r.status === DIAGNOSTIC_TEST_STATUS.AVAILABLE);
  await sequelize.transaction(async (transaction) => {
    await DiagnosticRequestTest.destroy({ where: { diagnosticRequestId: request.id }, transaction });
    await DiagnosticRequestTest.bulkCreate(
      rows.map((r) => ({ ...r, diagnosticRequestId: request.id })),
      { transaction }
    );
    await request.update(
      { status: S.AVAILABLE, respondedAt: new Date(), labNote: note || request.labNote },
      { transaction }
    );
    await notify(
      [
        {
          userId: request.patientId,
          title: "Diagnostic lab responded",
          message: available.length
            ? `Available tests and prices are ready: ${testNames(available)}. Choose your tests and a date.`
            : "The lab checked your prescription but none of the tests are currently available.",
          type: "diagnostic_availability_submitted",
          referenceId: request.id,
        },
      ],
      transaction
    );
  });

  return exports.getRequest(labId, request.id);
};

/**
 * The lab uploads a report covering one or more of the BOOKED tests. The file
 * goes through the EXISTING storage driver and is filed as a row in the
 * patient's EXISTING medical records (uploaded_records, source
 * 'diagnostic_lab', tag = test name(s), location = lab name), so it appears in
 * the patient's Records page with the lab as its source. When every booked
 * test has a report the request becomes `report_ready`.
 */
exports.uploadReport = async (labId, requestId, file, { testIds, fileType }) => {
  if (!file) throw ApiError.badRequest("Report file is required");
  const request = await findForLab(labId, requestId, {
    include: [
      { model: DiagnosticRequestTest, as: "tests" },
      { model: User, as: "lab", attributes: ["id", "name"] },
    ],
  });
  if (!DIAGNOSTIC_REPORTABLE_STATUSES.includes(request.status)) {
    throw ApiError.badRequest("Mark the test as completed before uploading the report");
  }

  const wanted = new Set(testIds.map(String));
  const targets = request.tests.filter((t) => wanted.has(String(t.id)));
  if (targets.length !== wanted.size || targets.some((t) => !t.isSelected)) {
    throw ApiError.badRequest("Reports can only be uploaded for the tests the patient booked");
  }

  const { url, key } = await uploadService.put(file.buffer, {
    keyPrefix: `diagnostic/${labId}/patients/${request.patientId}/reports`,
    filename: file.originalname,
    mimetype: file.mimetype,
  });

  const now = new Date();
  const labName = request.lab?.name || "Diagnostic lab";
  const names = testNames(targets);
  try {
    await sequelize.transaction(async (transaction) => {
      const record = await UploadedRecord.create(
        {
          patientId: request.patientId,
          fileUrl: url,
          fileType,
          recordDate: localIsoDate(request.completedAt || now),
          tag: names.slice(0, 100),
          location: labName.slice(0, 150),
          source: RECORD_SOURCES.DIAGNOSTIC_LAB,
          recordedByUserId: labId,
        },
        { transaction }
      );
      await DiagnosticRequestTest.update(
        { reportRecordId: record.id, reportUploadedAt: now },
        { where: { id: { [Op.in]: targets.map((t) => t.id) } }, transaction }
      );

      const reported = new Set(
        request.tests.filter((t) => t.reportRecordId).map((t) => String(t.id))
      );
      targets.forEach((t) => reported.add(String(t.id)));
      const allDone = request.tests.filter((t) => t.isSelected).every((t) => reported.has(String(t.id)));
      if (allDone && request.status !== S.REPORT_READY) {
        await request.update({ status: S.REPORT_READY, reportReadyAt: now }, { transaction });
      }

      await notify(
        [
          {
            userId: request.patientId,
            title: "Diagnostic report ready",
            message: `Your ${names} report from ${labName} is ready.`,
            type: "diagnostic_report_ready",
            referenceId: request.id,
          },
        ],
        transaction
      );
    });
  } catch (err) {
    // Don't leave an orphaned file behind a failed write.
    await uploadService.remove(key).catch(() => {});
    throw err;
  }

  return exports.getRequest(labId, request.id);
};

// ── Patient: booking ─────────────────────────────────────────────────────

/**
 * The patient picks some of the lab's AVAILABLE tests and a preferred date.
 * The request goes to `booking_requested` and the lab is notified to confirm.
 */
exports.book = async (patientId, requestId, { testIds, preferredDate, notes }) => {
  const request = await findForPatient(patientId, requestId, {
    include: [{ model: DiagnosticRequestTest, as: "tests" }],
  });
  if (request.status !== S.AVAILABLE) {
    throw ApiError.badRequest("This request is not open for booking");
  }

  // Joi parses a date-only string as UTC midnight, so its ISO date IS the
  // calendar day the patient picked.
  const day = new Date(preferredDate).toISOString().slice(0, 10);
  const today = localIsoDate();
  const latest = new Date();
  latest.setDate(latest.getDate() + MAX_BOOKING_DAYS_AHEAD);
  if (day < today) throw ApiError.badRequest("The test date cannot be in the past");
  if (day > localIsoDate(latest)) {
    throw ApiError.badRequest(`The test date must be within ${MAX_BOOKING_DAYS_AHEAD} days`);
  }

  const wanted = new Set(testIds.map(String));
  const chosen = request.tests.filter((t) => wanted.has(String(t.id)));
  if (chosen.length !== wanted.size) throw ApiError.badRequest("A selected test is not on this request");
  if (chosen.some((t) => t.status !== DIAGNOSTIC_TEST_STATUS.AVAILABLE)) {
    throw ApiError.badRequest("Only available tests can be booked");
  }

  await sequelize.transaction(async (transaction) => {
    await DiagnosticRequestTest.update(
      { isSelected: false },
      { where: { diagnosticRequestId: request.id }, transaction }
    );
    await DiagnosticRequestTest.update(
      { isSelected: true },
      { where: { id: { [Op.in]: chosen.map((t) => t.id) } }, transaction }
    );
    await request.update(
      {
        status: S.BOOKING_REQUESTED,
        preferredDate: day,
        bookingNotes: notes || null,
        bookingRequestedAt: new Date(),
      },
      { transaction }
    );
    await notify(
      [
        {
          userId: request.labId,
          title: "New diagnostic booking",
          message: `A patient booked ${testNames(chosen)} for ${day}. Confirm or reject the booking.`,
          type: "diagnostic_booking_requested",
          referenceId: request.id,
        },
      ],
      transaction
    );
  });

  return exports.getRequest(patientId, request.id);
};

// ── Lab catalogue ────────────────────────────────────────────────────────

exports.listTests = async (labId, { search } = {}) => {
  const where = { labId, isActive: true };
  if (search) where.name = { [Op.like]: `%${search}%` };
  return DiagnosticTest.findAll({ where, order: [["name", "ASC"]] });
};

async function assertUniqueName(labId, name, exceptId) {
  const where = { labId, isActive: true, name };
  if (exceptId) where.id = { [Op.ne]: exceptId };
  if (await DiagnosticTest.count({ where })) {
    throw ApiError.conflict(`"${name}" is already in your test list`);
  }
}

async function findOwnTest(labId, id) {
  const test = await DiagnosticTest.findOne({ where: { id, labId, isActive: true } });
  if (!test) throw ApiError.notFound("Test not found");
  return test;
}

exports.createTest = async (labId, dto) => {
  await assertUniqueName(labId, dto.name);
  return DiagnosticTest.create({ ...dto, labId, description: dto.description || null });
};

exports.updateTest = async (labId, id, dto) => {
  const test = await findOwnTest(labId, id);
  if (dto.name && dto.name !== test.name) await assertUniqueName(labId, dto.name, test.id);
  await test.update(dto);
  return test;
};

/** Soft delete: answers already sent to patients keep pointing at it. */
exports.removeTest = async (labId, id) => {
  const test = await findOwnTest(labId, id);
  await test.update({ isActive: false });
  return { id: String(test.id) };
};

// ── Lab dashboard ────────────────────────────────────────────────────────

/** Per-status counts + catalogue size for the lab's own overview cards. */
exports.labSummary = async (labId) => {
  const [byStatus, tests] = await Promise.all([
    DiagnosticRequest.findAll({
      attributes: ["status", [fn("COUNT", col("id")), "n"]],
      where: { labId },
      group: ["status"],
      raw: true,
    }),
    DiagnosticTest.count({ where: { labId, isActive: true } }),
  ]);
  const counts = Object.fromEntries(Object.values(S).map((s) => [s, 0]));
  byStatus.forEach((r) => {
    counts[r.status] = Number(r.n);
  });
  return {
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    byStatus: counts,
    tests,
  };
};
