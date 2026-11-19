/**
 * Prescription business logic (docs/prescriptions/backend-plan.md §4.3).
 *
 * The two rules everything else follows from:
 *
 *  1. FINALIZE FREEZES. We copy the whole resolved template into
 *     `template_snapshot` and render from that, forever. Rendering from the
 *     live template would mean changing your logo silently restyles every
 *     prescription you ever signed. Corrections go through `amend`, which
 *     creates a new version — a finalized record is never mutated.
 *
 *  2. NEVER RENDER INSIDE THE TRANSACTION. Chromium takes 300–1500ms; holding
 *     a row lock across it deadlocks under concurrency, and a browser crash
 *     would roll back a clinically-completed prescription. So finalize commits
 *     first and renders after — which legitimately leaves `pdf_url` NULL if the
 *     render fails. That is not corruption: the snapshot makes the PDF
 *     reproducible at any time, and `getPdf` heals it on the next read.
 */
const { Op, UniqueConstraintError } = require("sequelize");
const {
  sequelize,
  Prescription,
  PrescriptionItem,
  PrescriptionTemplate,
  Booking,
  Clinic,
  DoctorProfile,
  User,
  PatientProfile,
  ClinicProfile,
  UploadedRecord,
} = require("../models");
const ApiError = require("../utils/ApiError");
const { ageFrom } = require("../utils/age");
const templateService = require("./prescriptionTemplate.service");
const pdfService = require("./prescriptionPdf.service");
const workbench = require("./prescriptionWorkbench.service");
const mailService = require("./mail.service");
const upload = require("./upload.service");
const { nextRxNumber, amendedRxNumber } = require("../utils/rxNumber");
const {
  ERROR_CODES,
  PRESCRIPTION_STATUS,
  RX_ELIGIBLE_BOOKING_STATUSES,
  TREATED_BOOKING_STATUSES,
  RECORD_SOURCES,
} = require("../config/constants");

// ── Includes (eager-load; never a query in a loop) ──────────────────────────
const itemsInclude = { model: PrescriptionItem, as: "items", separate: true, order: [["sortOrder", "ASC"]] };

const fullInclude = [
  itemsInclude,
  { model: PrescriptionTemplate, as: "template", include: [{ model: Clinic, as: "clinic", attributes: ["id", "name"] }] },
  { model: Clinic, as: "clinic", attributes: ["id", "name", "addressLine", "city"] },
  {
    model: User,
    as: "patient",
    attributes: ["id", "name", "phone", "email"],
    include: [{ model: PatientProfile, as: "patientProfile" }],
  },
  {
    model: Booking,
    as: "booking",
    attributes: ["id", "slotDate", "slotStartTime", "slotEndTime", "bookingType", "status"],
    // The clinic that arranged the consult, so the patient's prescription can
    // read "consulted Dr. A via Sunrise Clinic". LEFT JOIN throughout — NULL on
    // every prescription from a booking the patient made themselves.
    include: [
      {
        model: User,
        as: "bookedBy",
        attributes: ["id", "name", "role"],
        include: [
          { model: ClinicProfile, as: "clinicProfile", attributes: ["clinicName", "city", "phone"] },
        ],
      },
    ],
  },
];

const listInclude = [
  { model: User, as: "patient", attributes: ["id", "name"] },
  { model: Clinic, as: "clinic", attributes: ["id", "name"] },
];

/** One owned prescription, fully loaded, or 404. Ownership is the WHERE clause. */
async function findOwned(where) {
  const rx = await Prescription.findOne({ where, include: fullInclude });
  if (!rx) throw new ApiError(404, "Prescription not found", { code: ERROR_CODES.NOT_FOUND });
  return rx;
}

const isDraft = (rx) => rx.status === PRESCRIPTION_STATUS.DRAFT;

function assertEditable(rx) {
  if (!isDraft(rx)) {
    throw new ApiError(409, "A finalized prescription can't be edited — amend it instead", {
      code: ERROR_CODES.RX_NOT_EDITABLE,
    });
  }
}

// ── Create ──────────────────────────────────────────────────────────────────
exports.createDraft = async (doctorId, { bookingId, templateId }) => {
  const booking = await Booking.findOne({ where: { id: bookingId, doctorId } });
  if (!booking) throw new ApiError(404, "Appointment not found", { code: ERROR_CODES.NOT_FOUND });

  if (!RX_ELIGIBLE_BOOKING_STATUSES.includes(booking.status)) {
    throw new ApiError(422, "Only a confirmed or completed appointment can carry a prescription", {
      code: ERROR_CODES.RX_BOOKING_NOT_ELIGIBLE,
    });
  }

  // One live prescription per booking. Superseded versions don't count — they
  // are history, and the newest one is "the" prescription. The 409 names the
  // existing one, so a double-click or a refresh lands on it instead of failing.
  const alreadyExists = (existing) =>
    new ApiError(409, "This appointment already has a prescription", {
      code: ERROR_CODES.RX_ALREADY_EXISTS,
      details: existing ? { prescriptionId: String(existing.id) } : undefined,
    });
  const live = await Prescription.findOne({ where: { bookingId, supersededById: null } });
  if (live) throw alreadyExists(live);

  const template = await templateService.resolveTemplate(doctorId, {
    clinicId: booking.clinicId,
    templateId,
  });

  let created;
  try {
    created = await Prescription.create({
      bookingId: booking.id,
      doctorId,
      patientId: booking.patientId,
      clinicId: booking.clinicId,
      templateId: template.id,
      status: PRESCRIPTION_STATUS.DRAFT,
      adviceSelected: [],
    });
  } catch (err) {
    // Two creates racing for the same booking: uq_rx_booking_version keeps one.
    if (err instanceof UniqueConstraintError) {
      throw alreadyExists(await Prescription.findOne({ where: { bookingId, supersededById: null } }));
    }
    throw err;
  }

  // Opens already filled from the Patient Workbench consultation (migration 059).
  await workbench.syncDraft(created);
  return findOwned({ id: created.id, doctorId });
};

/**
 * Refresh a draft from its Patient Workbench consultation (migration 059) and
 * return it with the snapshot. The Workbench record itself is only read.
 */
exports.syncWorkbench = async (doctorId, id) => {
  const rx = await findOwned({ id, doctorId });
  assertEditable(rx);
  await workbench.syncDraft(rx);
  return findOwned({ id, doctorId });
};

// ── Read ────────────────────────────────────────────────────────────────────
exports.getOne = (doctorId, id) => findOwned({ id, doctorId });

exports.getByBooking = async (doctorId, bookingId) => {
  const rx = await Prescription.findOne({
    where: { bookingId, doctorId, supersededById: null },
    include: fullInclude,
  });
  if (!rx) throw new ApiError(404, "No prescription for this appointment", { code: ERROR_CODES.NOT_FOUND });
  return rx;
};

exports.listForDoctor = (doctorId, { status, patientId, bookingId } = {}) => {
  const where = { doctorId };
  if (status) where.status = status;
  if (patientId) where.patientId = patientId;
  if (bookingId) where.bookingId = bookingId;
  return Prescription.findAll({ where, include: listInclude, order: [["createdAt", "DESC"]] });
};

/** Patients see FINALIZED prescriptions only — a half-written diagnosis is a clinical hazard. */
exports.listForPatient = (patientId) =>
  Prescription.findAll({
    where: { patientId, status: PRESCRIPTION_STATUS.FINALIZED },
    include: [
      itemsInclude,
      { model: Clinic, as: "clinic", attributes: ["id", "name"] },
      {
        model: DoctorProfile,
        as: "doctor",
        attributes: ["userId", "qualification"],
        include: [{ model: User, as: "user", attributes: ["name"] }],
      },
      // The clinic that arranged the consult, for the "consulted Dr. A via
      // Sunrise Clinic" line. LEFT JOIN — NULL on every prescription from a
      // booking the patient made themselves.
      {
        model: Booking,
        as: "booking",
        attributes: ["id"],
        include: [
          {
            model: User,
            as: "bookedBy",
            attributes: ["id", "name", "role"],
            include: [
              { model: ClinicProfile, as: "clinicProfile", attributes: ["clinicName", "city", "phone"] },
            ],
          },
        ],
      },
    ],
    order: [["finalizedAt", "DESC"]],
  });

exports.getOneForPatient = async (patientId, id) => {
  const rx = await Prescription.findOne({
    where: { id, patientId, status: PRESCRIPTION_STATUS.FINALIZED },
    include: [
      itemsInclude,
      { model: Clinic, as: "clinic", attributes: ["id", "name", "addressLine", "city"] },
      {
        model: DoctorProfile,
        as: "doctor",
        attributes: ["userId", "qualification"],
        include: [{ model: User, as: "user", attributes: ["name"] }],
      },
      // The clinic that arranged the consult, for the "consulted Dr. A via
      // Sunrise Clinic" line. LEFT JOIN — NULL on every prescription from a
      // booking the patient made themselves.
      {
        model: Booking,
        as: "booking",
        attributes: ["id"],
        include: [
          {
            model: User,
            as: "bookedBy",
            attributes: ["id", "name", "role"],
            include: [
              { model: ClinicProfile, as: "clinicProfile", attributes: ["clinicName", "city", "phone"] },
            ],
          },
        ],
      },
    ],
  });
  if (!rx) throw new ApiError(404, "Prescription not found", { code: ERROR_CODES.NOT_FOUND });
  return rx;
};

// ── Update (draft only) ─────────────────────────────────────────────────────
exports.patch = async (doctorId, id, dto) => {
  const rx = await findOwned({ id, doctorId });
  assertEditable(rx);

  const { vitals, items, templateId, ...rest } = dto;

  if (templateId) {
    // Re-resolve so we 404 on someone else's template rather than trusting the id.
    const template = await templateService.resolveTemplate(doctorId, { templateId });
    rest.templateId = template.id;
  }

  await sequelize.transaction(async (t) => {
    await rx.update({ ...rest, ...(vitals ?? {}) }, { transaction: t });

    if (items) {
      // Replace-the-set: destroy + bulkCreate. Never a create() per row.
      await PrescriptionItem.destroy({ where: { prescriptionId: rx.id }, transaction: t });
      if (items.length) {
        await PrescriptionItem.bulkCreate(
          items.map((it, i) => ({ ...it, prescriptionId: rx.id, sortOrder: i })),
          { transaction: t }
        );
      }
    }
  });

  return findOwned({ id, doctorId });
};

exports.remove = async (doctorId, id) => {
  const rx = await findOwned({ id, doctorId });
  assertEditable(rx);
  await rx.destroy(); // items cascade
  return { id: String(id) };
};

// ── The render view ─────────────────────────────────────────────────────────
const SEX_LETTER = { male: "M", female: "F", other: "O" };

/**
 * The flat object the renderer reads. `patient` keys must match
 * PRESCRIPTION_PATIENT_FIELDS — that's the whole point of the frozen list.
 */
function buildRenderView(rx) {
  const p = rx.patient ?? {};
  const profile = p.patientProfile ?? {};
  const age = ageFrom(profile.dateOfBirth);
  const address = [profile.addressLine, profile.city].filter(Boolean).join(", ");
  const date = rx.finalizedAt ?? rx.booking?.slotDate ?? rx.createdAt;

  const vitals = {
    heightCm: rx.heightCm,
    weightKg: rx.weightKg,
    bloodPressure: rx.bloodPressure,
    pulseRateBpm: rx.pulseRateBpm,
    temperatureF: rx.temperatureF,
    spo2Percent: rx.spo2Percent,
  };

  return {
    rxNumber: rx.rxNumber,
    date,
    patient: {
      name: p.name ?? "",
      age: age != null ? String(age) : "",
      sex: SEX_LETTER[profile.gender] ?? "",
      phone: p.phone ?? "",
      address,
      bp: rx.bloodPressure ?? "",
      pulse: rx.pulseRateBpm != null ? String(rx.pulseRateBpm) : "",
      weight: rx.weightKg != null ? String(rx.weightKg) : "",
      height: rx.heightCm != null ? String(rx.heightCm) : "",
      temperature: rx.temperatureF != null ? String(rx.temperatureF) : "",
      spo2: rx.spo2Percent != null ? String(rx.spo2Percent) : "",
      date: date ? new Date(date).toLocaleDateString("en-GB") : "",
    },
    vitals,
    chiefComplaint: rx.chiefComplaint,
    diagnosis: rx.diagnosis,
    notes: rx.notes,
    advice: rx.advice,
    adviceSelected: rx.adviceSelected ?? [],
    followUpDate: rx.followUpDate,
    // From the Patient Workbench snapshot frozen with the prescription (version
    // 2+). Older snapshots have neither, so those PDFs render exactly as before.
    investigations: rx.clinicalSnapshot?.printed?.investigations ?? [],
    followUpNote: rx.clinicalSnapshot?.printed?.followUpNote ?? null,
    items: (rx.items ?? []).map((i) => (typeof i.get === "function" ? i.get({ plain: true }) : i)),
  };
}
exports.buildRenderView = buildRenderView;

/**
 * The frozen letterhead. Only the fields the renderer reads — this JSON is
 * stored on every prescription forever, so it stays lean and, crucially,
 * carries no `id`/`updatedAt` that could tempt a future reader to go look the
 * live template up again.
 */
function snapshotOf(t) {
  const s = t.get({ plain: true });
  return {
    name: s.name,
    logoUrl: s.logoUrl,
    watermarkUrl: s.watermarkUrl,
    signatureUrl: s.signatureUrl,
    watermarkOpacity: Number(s.watermarkOpacity),
    headerBgColor: s.headerBgColor,
    headerTextColor: s.headerTextColor,
    footerBgColor: s.footerBgColor,
    footerTextColor: s.footerTextColor,
    accentColor: s.accentColor,
    fontFamily: s.fontFamily,
    baseFontSizePt: Number(s.baseFontSizePt),
    pageSize: s.pageSize,
    marginMmTop: s.marginMmTop,
    marginMmRight: s.marginMmRight,
    marginMmBottom: s.marginMmBottom,
    marginMmLeft: s.marginMmLeft,
    showHeader: s.showHeader,
    showFooter: s.showFooter,
    showSidebar: s.showSidebar,
    showWatermark: s.showWatermark,
    sidebarWidthPct: s.sidebarWidthPct,
    headerJson: s.headerJson,
    patientFieldsJson: s.patientFieldsJson,
    sidebarJson: s.sidebarJson,
    bodyJson: s.bodyJson,
    footerJson: s.footerJson,
  };
}
exports.snapshotOf = snapshotOf;

/**
 * Render + store. Returns `{ url, error }` — `url` is null when it failed, and
 * `error` carries WHY (see §2 above).
 *
 * Returning the cause rather than swallowing it matters: this runs in two very
 * different places (after finalize, where a failure must not undo a signed
 * record, and on read, where the doctor is waiting and deserves an explanation).
 * Both failure modes live in the try below — `pdfService.render` (Chromium) and
 * `upload.put` (S3/disk) — and they need completely different fixes, so the
 * caller must be able to tell them apart.
 */
/**
 * Mirror a finalized prescription into the PATIENT's own record, so it shows up
 * under Documents → Prescription without anyone re-uploading the PDF by hand.
 *
 * Keyed on `rxNumber`, deliberately not on the URL: renderAndStore also runs to
 * HEAL a missing PDF on read, and that produces a new storage key — keying on
 * the URL would add a second row to the patient's record every time a render
 * was retried. Stamped `source: doctor` so the patient's UI chips it as
 * clinician-authored and the provenance guard keeps them from editing it.
 *
 * `recordDate` is left null: the row falls back to `uploadedAt`, which is the
 * moment the prescription was signed. Never throws — a signed prescription must
 * not fail because a convenience copy could not be filed.
 */
async function linkToPatientRecord(rx, url) {
  if (!rx.patientId || !url) return;
  const tag = rx.rxNumber || "Prescription";
  try {
    const [row, created] = await UploadedRecord.findOrCreate({
      where: { patientId: rx.patientId, fileType: "prescription", tag },
      defaults: {
        patientId: rx.patientId,
        fileUrl: url,
        fileType: "prescription",
        tag,
        source: RECORD_SOURCES.DOCTOR,
        recordedByUserId: rx.doctorId,
      },
    });
    if (!created && row.fileUrl !== url) await row.update({ fileUrl: url });
  } catch (err) {
    console.error(`⚠️  Could not file prescription ${rx.id} into the patient record:`, err.message);
  }
}

async function renderAndStore(rx) {
  try {
    const buffer = await pdfService.render(rx.templateSnapshot, buildRenderView(rx));
    const opts = { keyPrefix: `prescriptions/${rx.doctorId}`, filename: `${rx.rxNumber}.pdf`, mimetype: "application/pdf" };
    const url = await upload.storeThen(buffer, opts, async (stored) => {
      await rx.update({ pdfUrl: stored.url });
      return stored.url;
    });
    // The patient's Documents copy — same file, filed under their record.
    await linkToPatientRecord(rx, url);
    return { url, error: null };
  } catch (err) {
    // The record is signed and the snapshot is frozen — the PDF is reproducible.
    // Log loudly for ops; getPdf() will heal it on the next read.
    console.error(`❌ PDF render failed for prescription ${rx.id}:`, err.message);
    return { url: null, error: err };
  }
}

// ── Finalize ────────────────────────────────────────────────────────────────
exports.finalize = async (doctorId, id, { emailPatient = false } = {}) => {
  let rx = await findOwned({ id, doctorId });

  // Idempotent: a double-clicked button, a retried request, a flaky network —
  // all produce ONE rx_number, ONE pdf, ONE email.
  if (rx.status === PRESCRIPTION_STATUS.FINALIZED) {
    // A retry also heals a medicine sync that failed the first time (idempotent).
    await require("./patientMedicine.service").syncFromPrescription(rx.id);
    return rx;
  }

  const template = await templateService.resolveTemplate(doctorId, {
    clinicId: rx.clinicId,
    templateId: rx.templateId,
  });

  await sequelize.transaction(async (t) => {
    // The signed document carries the Workbench record as it is NOW (migration
    // 059): complaint, diagnosis, vitals and follow-up are refreshed and the
    // clinical snapshot is frozen with the prescription.
    await workbench.syncDraft(rx, { transaction: t });

    // An amendment keeps its parent's number and adds a suffix — `OSC-2026-000123-A2`
    // — so the patient, the pharmacy and the doctor all still recognise the
    // document. Only a first version consumes a new sequence value.
    let rxNumber;
    if (rx.parentPrescriptionId) {
      const parent = await Prescription.findByPk(rx.parentPrescriptionId, {
        attributes: ["rxNumber"],
        transaction: t,
      });
      const base = (parent?.rxNumber ?? "").replace(/-A\d+$/, "");
      rxNumber = base
        ? amendedRxNumber(base, rx.version)
        : await nextRxNumber(sequelize, doctorId, template.rxNumberPrefix, { transaction: t });
    } else {
      rxNumber = await nextRxNumber(sequelize, doctorId, template.rxNumberPrefix, { transaction: t });
    }

    await rx.update(
      {
        status: PRESCRIPTION_STATUS.FINALIZED,
        rxNumber,
        templateSnapshot: snapshotOf(template),
        templateId: template.id,
        finalizedAt: new Date(),
      },
      { transaction: t }
    );
  });

  // AFTER COMMIT. Never inside the transaction.
  rx = await findOwned({ id, doctorId });
  await renderAndStore(rx);
  // In-app notice to the patient (never fails the signed prescription).
  await require("./appointmentNotification.service").notifyPrescriptionReady(rx.id);
  // Copy the signed medicine lines into the patient's My Medicines (and, for an
  // amendment, retire the previous version's). Never throws; idempotent.
  await require("./patientMedicine.service").syncFromPrescription(rx.id);

  if (emailPatient && rx.patient?.email) {
    // Fire-and-log: a bounced email must not fail a signed prescription.
    mailService
      .sendPrescriptionReady(rx.patient, {
        rxNumber: rx.rxNumber,
        doctorName: template.headerJson?.doctorNameLine ?? "Your doctor",
        date: rx.finalizedAt,
      })
      .catch((err) => console.error("✉️  prescription-ready email failed:", err.message));
  }

  return findOwned({ id, doctorId });
};

// ── Amend ───────────────────────────────────────────────────────────────────
exports.amend = async (doctorId, id, { reason }) => {
  const original = await findOwned({ id, doctorId });

  if (original.status !== PRESCRIPTION_STATUS.FINALIZED) {
    throw new ApiError(409, "Only a finalized prescription can be amended", {
      code: ERROR_CODES.RX_NOT_EDITABLE,
    });
  }
  if (original.supersededById) {
    throw new ApiError(409, "This prescription has already been amended", {
      code: ERROR_CODES.RX_NOT_EDITABLE,
    });
  }

  const draftId = await sequelize.transaction(async (t) => {
    const draft = await Prescription.create(
      {
        bookingId: original.bookingId,
        doctorId,
        patientId: original.patientId,
        clinicId: original.clinicId,
        templateId: original.templateId,
        status: PRESCRIPTION_STATUS.DRAFT,
        version: original.version + 1,
        parentPrescriptionId: original.id,
        amendReason: reason,
        chiefComplaint: original.chiefComplaint,
        heightCm: original.heightCm,
        weightKg: original.weightKg,
        bloodPressure: original.bloodPressure,
        pulseRateBpm: original.pulseRateBpm,
        temperatureF: original.temperatureF,
        spo2Percent: original.spo2Percent,
        diagnosis: original.diagnosis,
        notes: original.notes,
        advice: original.advice,
        adviceSelected: original.adviceSelected ?? [],
        followUpDate: original.followUpDate,
        noMedication: original.noMedication,
        clinicalSnapshot: original.clinicalSnapshot ?? null,
      },
      { transaction: t }
    );

    // Deep-copy the medicines so the doctor edits a filled form, not a blank one.
    const items = original.items ?? [];
    if (items.length) {
      await PrescriptionItem.bulkCreate(
        items.map((i, idx) => {
          const plain = i.get({ plain: true });
          delete plain.id;
          return { ...plain, prescriptionId: draft.id, sortOrder: idx };
        }),
        { transaction: t }
      );
    }

    await original.update({ supersededById: draft.id }, { transaction: t });
    return draft.id;
  });

  return findOwned({ id: draftId, doctorId });
};

// ── PDF ─────────────────────────────────────────────────────────────────────
/**
 * The stored object's URL. Renders on demand ONLY when a finalized row has no
 * pdf_url (a prior render failed) — a re-render on every read would be slow and
 * would silently defeat the snapshot's whole purpose if it ever drifted.
 */
async function pdfUrlFor(rx) {
  if (rx.status !== PRESCRIPTION_STATUS.FINALIZED) {
    throw new ApiError(409, "Finalize the prescription before downloading it", {
      code: ERROR_CODES.RX_NOT_EDITABLE,
    });
  }
  if (rx.pdfUrl) return rx.pdfUrl;

  const { url, error } = await renderAndStore(rx); // self-heal
  if (!url) {
    throw new ApiError(500, "Could not build the prescription PDF", {
      code: ERROR_CODES.PDF_RENDER_FAILED,
      // The reason the render failed, verbatim. `details` reaches the client
      // (errorHandler passes it through), so a 500 here names its own cause
      // instead of requiring shell access to the server to diagnose.
      details: { reason: error?.message ?? "unknown" },
    });
  }
  return url;
}

/**
 * A doctor reading a prescription PDF.
 *
 * Two ways in, checked in this order:
 *   1. they AUTHORED it — any status, including their own draft;
 *   2. it is FINALIZED and belongs to a patient they treat — the treatment
 *      timeline surfaces other doctors' prescriptions for continuity of care
 *      (docs/treatment-timeline §7-A), matching the precedent that clinical
 *      notes are already patient-wide and readable by any treating doctor.
 *
 * Case 2 is deliberately narrower than case 1: FINALIZED only (never someone
 * else's half-written draft) and only for a patient this doctor actually has a
 * booking with. A doctor with no booking for that patient gets the same 404 as
 * a stranger.
 */
exports.getPdfForDoctor = async (doctorId, id) => {
  const own = await Prescription.findOne({ where: { id, doctorId }, include: fullInclude });
  if (own) return { url: await pdfUrlFor(own), rxNumber: own.rxNumber };

  const rx = await Prescription.findOne({
    where: { id, status: PRESCRIPTION_STATUS.FINALIZED },
    include: fullInclude,
  });
  if (!rx) throw new ApiError(404, "Prescription not found", { code: ERROR_CODES.NOT_FOUND });

  const treats = await Booking.findOne({
    where: { doctorId, patientId: rx.patientId, status: { [Op.in]: TREATED_BOOKING_STATUSES } },
    attributes: ["id"],
  });
  if (!treats) throw new ApiError(404, "Prescription not found", { code: ERROR_CODES.NOT_FOUND });
  // Another doctor's prescription needs the patient's `medications` grant (migration 057).
  const access = require("./clinicalAccess.service");
  const scope = await access.scopeFor(doctorId, rx.patientId);
  if (!scope.has("medications")) throw new ApiError(404, "Prescription not found", { code: ERROR_CODES.NOT_FOUND });

  return { url: await pdfUrlFor(rx), rxNumber: rx.rxNumber };
};

/**
 * The finalized prescription PDF for a booking, WITHOUT an author-ownership check
 * — the CALLER authorizes (used by the referral case view so a referral's target
 * doctor can read the referring doctor's Rx; referral.service already gated it to
 * `to_doctor_id = req.doctorId`). 404s when the source consult has no finalized Rx.
 */
exports.getPdfForBooking = async (bookingId) => {
  const rx = await Prescription.findOne({
    where: { bookingId, supersededById: null, status: PRESCRIPTION_STATUS.FINALIZED },
  });
  if (!rx) throw new ApiError(404, "No prescription for this consultation", { code: ERROR_CODES.NOT_FOUND });
  return { url: await pdfUrlFor(rx), rxNumber: rx.rxNumber };
};

/**
 * Ownership is re-checked here even though the stored object URL is public.
 * The `finalized` filter is part of the WHERE, not a later check, so a patient
 * can't even learn that a draft for them exists.
 */
exports.getPdfForPatient = async (patientId, id) => {
  const rx = await Prescription.findOne({
    where: { id, patientId, status: PRESCRIPTION_STATUS.FINALIZED },
    include: fullInclude,
  });
  if (!rx) throw new ApiError(404, "Prescription not found", { code: ERROR_CODES.NOT_FOUND });
  return { url: await pdfUrlFor(rx), rxNumber: rx.rxNumber };
};
