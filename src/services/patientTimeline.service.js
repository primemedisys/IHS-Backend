/**
 * The longitudinal patient timeline for the doctor's patient workbench.
 *
 * A LENS, not a store. It flattens the already-authorized, already-serialized
 * history (`serializeMedicalHistory`, built by medicalHistory.service with the
 * doctor's consent scope applied) and document list (`documentsForDoctor`) into
 * one list of events. Because it only reads what those two already returned,
 * it can never show a record the doctor could not open on the other pages —
 * there is no second authorization path to drift.
 *
 * Rules (from the product brief):
 *   - one event per source record: a prescription, a report or a diagnosis is
 *     emitted ONCE from its canonical list, then referenced by `bookingId`;
 *   - a clinical event keeps its own date. A document is dated by its
 *     `recordDate` (the test date); when that is missing the event is undated
 *     (`date: null`, sorted last) and `uploadedAt` is carried separately —
 *     an upload date is never presented as a clinical date;
 *   - nothing is invented: a field the system does not store is null.
 */

/** Filter groups the UI offers → the event types in each. */
const TYPE_GROUPS = Object.freeze({
  consultations: ["consultation", "complaint", "examination", "vitals", "note"],
  diagnoses: ["diagnosis"],
  investigations: ["investigation", "report"],
  prescriptions: ["prescription"],
  followups: ["follow_up"],
});

const day = (v) => (v ? String(v).slice(0, 10) : null);

/** Sort key: ISO instant when we have one, else the day. */
const stamp = (e) => e.at ?? e.date ?? null;

function buildEvents(history, documents = []) {
  const events = [];
  const visitByBooking = new Map();
  for (const c of history.consultations) visitByBooking.set(String(c.visit.bookingId), c.visit);

  /** Doctor + specialty + clinic of a booking, when the event belongs to one. */
  const context = (bookingId, doctorFallback = null) => {
    const v = bookingId != null ? visitByBooking.get(String(bookingId)) : null;
    return {
      doctor: v?.doctor ? { id: v.doctor.id, name: v.doctor.name } : doctorFallback,
      specialties: v?.doctor?.specializations ?? [],
      clinic: v?.clinic ?? null,
      consultation: v ? { bookingId: String(v.bookingId), date: v.date, appointmentType: v.appointmentType, status: v.status } : null,
    };
  };

  const push = (e) => events.push({ status: null, details: [], link: null, ...e });

  // ── Consultations and what was recorded inside them ──────────────────────
  for (const c of history.consultations) {
    const v = c.visit;
    const ctx = context(v.bookingId);
    const at = v.date ? `${v.date}${v.startTime ? `T${v.startTime.slice(0, 5)}` : ""}` : null;
    push({
      id: `consultation:${v.bookingId}`,
      type: "consultation",
      title: v.appointmentType === "video" ? "Video consultation" : "Consultation",
      date: day(v.date),
      at,
      ...ctx,
      status: v.status,
      source: { kind: "booking", id: String(v.bookingId) },
      details: [v.clinic?.name, c.isMine ? "Your consultation" : null].filter(Boolean),
    });
    for (const x of c.complaints) {
      push({
        id: `entry:${x.id}`,
        type: "complaint",
        title: "Chief complaint",
        date: day(v.date),
        at: x.createdAt ?? at,
        ...ctx,
        doctor: x.author ? { id: x.author.id, name: x.author.name } : ctx.doctor,
        source: { kind: "clinical_entry", id: String(x.id) },
        details: [x.title].filter(Boolean),
      });
    }
    for (const x of c.examinations) {
      push({
        id: `entry:${x.id}`,
        type: "examination",
        title: "Examination",
        date: day(v.date),
        at: x.createdAt ?? at,
        ...ctx,
        doctor: x.author ? { id: x.author.id, name: x.author.name } : ctx.doctor,
        source: { kind: "clinical_entry", id: String(x.id) },
        details: [x.title, x.remarks].filter(Boolean),
      });
    }
    for (const x of c.vitals) {
      push({
        id: `vitals:${x.id}`,
        type: "vitals",
        title: "Vitals recorded",
        date: day(x.recordedOn ?? v.date),
        at: x.recordedAt,
        ...ctx,
        doctor: x.recordedBy ? { id: x.recordedBy.id, name: x.recordedBy.name } : ctx.doctor,
        source: { kind: "patient_vitals", id: String(x.id) },
        details: Object.entries(x.values ?? {})
          .filter(([, val]) => val != null && val !== "")
          .map(([k, val]) => `${k}: ${val}`),
      });
    }
    for (const x of c.notes ?? []) {
      push({
        id: `entry:${x.id}`,
        type: "note",
        title: "Doctor's note",
        date: day(v.date),
        at: x.createdAt ?? at,
        ...ctx,
        doctor: x.author ? { id: x.author.id, name: x.author.name } : ctx.doctor,
        source: { kind: "clinical_entry", id: String(x.id) },
        details: [x.remarks].filter(Boolean),
      });
    }
    if (c.followUp) {
      push({
        id: `followup:${v.bookingId}`,
        type: "follow_up",
        title: "Follow-up advised",
        date: day(c.followUp.followUpOn ?? v.date),
        at: null,
        ...ctx,
        doctor: c.followUp.doctor ?? ctx.doctor,
        status: c.followUp.status?.label ?? null,
        source: { kind: "patient_follow_up", id: String(v.bookingId) },
        details: [c.followUp.note, c.followUp.serviceName].filter(Boolean),
      });
    }
  }

  // ── Canonical lists (each source record exactly once) ────────────────────
  for (const d of history.diagnoses) {
    push({
      id: `entry:${d.id}`,
      type: "diagnosis",
      title: d.title ?? "Diagnosis",
      date: day(d.visitDate ?? d.recordedOn ?? d.createdAt),
      at: d.createdAt,
      ...context(d.bookingId, d.author ? { id: d.author.id, name: d.author.name } : null),
      doctor: d.author ? { id: d.author.id, name: d.author.name } : context(d.bookingId).doctor,
      status: d.status === "active" ? d.category ?? null : d.status,
      source: { kind: "clinical_entry", id: String(d.id) },
      details: [d.code ? `${[d.codeSystem, d.code].filter(Boolean).join(" ")}` : null, d.remarks].filter(Boolean),
    });
  }
  for (const d of history.prescriptionDiagnoses) {
    push({
      id: `rxdx:${d.prescriptionId}`,
      type: "diagnosis",
      title: d.diagnosis,
      date: day(d.visitDate ?? d.date),
      at: d.date,
      ...context(d.bookingId, d.doctor),
      doctor: d.doctor ?? context(d.bookingId).doctor,
      status: "from prescription",
      source: { kind: "prescription", id: String(d.prescriptionId) },
      link: { type: "prescription", id: String(d.prescriptionId) },
    });
  }
  for (const i of history.investigations) {
    push({
      id: `entry:${i.id}`,
      type: "investigation",
      title: i.title ?? "Investigation advised",
      date: day(i.visitDate ?? i.recordedOn ?? i.createdAt),
      at: i.createdAt,
      ...context(i.bookingId),
      doctor: i.author ? { id: i.author.id, name: i.author.name } : context(i.bookingId).doctor,
      status: i.details?.priority ?? null,
      source: { kind: "clinical_entry", id: String(i.id) },
      details: [i.category, i.remarks].filter(Boolean),
    });
  }
  for (const rx of history.prescriptions) {
    // An unsigned draft is work in progress, not a clinical event.
    if (rx.status !== "finalized") continue;
    push({
      id: `rx:${rx.id}`,
      type: "prescription",
      title: rx.rxNumber ? `Prescription ${rx.rxNumber}` : "Prescription",
      date: day(rx.visitDate ?? rx.finalizedAt ?? rx.createdAt),
      at: rx.finalizedAt ?? rx.createdAt,
      ...context(rx.bookingId, rx.doctor),
      doctor: rx.doctor ?? context(rx.bookingId).doctor,
      status: rx.status,
      source: { kind: "prescription", id: String(rx.id) },
      details: rx.noMedication && !rx.items.length ? ["Medication not needed"] : rx.items.map((m) => m.medicineName),
    });
  }

  // ── Documents: dated by the test date, never by the upload date ──────────
  for (const d of documents) {
    const label = d.tag?.trim() || d.originalName || "Medical document";
    push({
      id: `doc:${d.id}`,
      type: "report",
      title: label,
      date: day(d.recordDate),
      at: null,
      uploadedAt: d.uploadedAt,
      // The record carries no ordering consultation; say so rather than guess.
      // Only a professional is a "doctor" here: the name written on the document,
      // or the doctor / clinic / lab that filed it. A patient's own upload has none.
      doctor: d.doctorName
        ? { id: null, name: d.doctorName }
        : d.source !== "patient" && d.recordedBy
          ? { id: d.source === "doctor" ? d.recordedBy.id : null, name: d.recordedBy.name }
          : null,
      uploadedBy: d.recordedBy ? { name: d.recordedBy.name, source: d.source } : null,
      specialties: [],
      clinic: d.location ? { id: null, name: d.location, city: null } : null,
      consultation: null,
      source: { kind: "uploaded_record", id: String(d.id) },
      details: [d.documentKind, d.description].filter(Boolean),
    });
  }
  return events;
}

/** Newest first by default; undated events always last. */
function sortEvents(events, order = "desc") {
  const dir = order === "asc" ? 1 : -1;
  return [...events].sort((a, b) => {
    const x = stamp(a);
    const y = stamp(b);
    if (x == null && y == null) return String(a.id).localeCompare(String(b.id));
    if (x == null) return 1;
    if (y == null) return -1;
    return x === y ? String(a.id).localeCompare(String(b.id)) * dir : (x < y ? -1 : 1) * dir;
  });
}

function filterEvents(events, { types, doctorId, specialty, from, to } = {}) {
  const allowed = types && types !== "all" ? new Set(TYPE_GROUPS[types] ?? []) : null;
  return events.filter((e) => {
    if (allowed && !allowed.has(e.type)) return false;
    if (doctorId && String(e.doctor?.id ?? "") !== String(doctorId)) return false;
    if (specialty && !e.specialties.some((s) => s.toLowerCase() === specialty.toLowerCase())) return false;
    if (from || to) {
      // A date range excludes undated events: they cannot be placed in it.
      if (!e.date) return false;
      if (from && e.date < from) return false;
      if (to && e.date > to) return false;
    }
    return true;
  });
}

/** Distinct doctors / specialties across ALL events, so the filters list what exists. */
function facets(events) {
  const doctors = new Map();
  const specialties = new Set();
  for (const e of events) {
    if (e.doctor?.id) doctors.set(String(e.doctor.id), e.doctor.name ?? "Unknown doctor");
    for (const s of e.specialties) specialties.add(s);
  }
  return {
    doctors: [...doctors].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    specialties: [...specialties].sort(),
  };
}

function build(history, documents, query = {}) {
  const all = buildEvents(history, documents);
  const filtered = sortEvents(filterEvents(all, query), query.order);
  const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
  const page = Math.max(Number(query.page) || 1, 1);
  const start = (page - 1) * limit;
  return {
    events: filtered.slice(start, start + limit),
    total: filtered.length,
    page,
    limit,
    facets: facets(all),
    // Honest about the history cap (medicalHistory.service) so the UI can say so.
    capped: history.capped,
  };
}

module.exports = { build, buildEvents, filterEvents, sortEvents, TYPE_GROUPS };
