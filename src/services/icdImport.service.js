/**
 * Excel bulk import into the ICD & Diagnosis Master (icd_codes, migration 059;
 * audit trail icd_import_batches, migration 060).
 *
 *   template → fill → upload → PREVIEW (every row checked, nothing written)
 *            → CONFIRM (the SAME file, re-checked, valid rows written in ONE
 *              transaction) → summary + audit record
 *
 * The template's six columns are the import format:
 *   ICD_Code · Diagnosis_Name · Code_System · Category · Description · Is_Active
 * The classification RELEASE (e.g. "2019" for WHO ICD-10, "FY2027" for
 * ICD-10-CM) is chosen once for the whole upload — a code is only unique
 * within (Code_System, version, ICD_Code), exactly like the master's key.
 *
 * Rules:
 *   - Nothing is invented: no code is generated, guessed or "fixed" beyond
 *     the canonical form (upper case; ICD-10 family "E119" → "E11.9").
 *   - Invalid rows are never written. They are listed in the preview with
 *     the reason, and counted on the audit record.
 *   - A code repeated inside the file: the FIRST row is used, the others are
 *     reported as in-file duplicates.
 *   - A code already in the master is never duplicated. By default it is
 *     SKIPPED (left exactly as it is). Only when the admin, having seen the
 *     differences in the preview, confirms the "update" policy are the
 *     changed fields written — and a blank cell still keeps the current
 *     value. Recorded diagnoses keep their own snapshot either way.
 *   - The confirm step carries the preview's SHA-256: a different file is
 *     refused, so what is written is what was reviewed.
 */
const crypto = require("crypto");
const ExcelJS = require("exceljs");
const { Op, UniqueConstraintError } = require("sequelize");
const { sequelize, IcdCode, IcdImportBatch, User } = require("../models");
const ApiError = require("../utils/ApiError");
const { clean, canonicalCode, codeFormatError, dotless } = require("./icdCode.service");
const { ERROR_CODES, ICD_CODING_SYSTEMS, ICD_EXCEL } = require("../config/constants");

// ── The columns: one definition for template, parser and instructions ───────
const COLUMNS = [
  {
    key: "code",
    header: "ICD_Code",
    required: true,
    width: 14,
    aliases: ["icdcode", "code", "icd"],
    format: "The code exactly as in the official source, e.g. E11.9 (dot optional for ICD-10 / ICD-10-CM)",
  },
  {
    key: "title",
    header: "Diagnosis_Name",
    required: true,
    width: 48,
    aliases: ["diagnosisname", "diagnosis", "title", "name"],
    format: "The name doctors search and see (2–255 characters)",
  },
  {
    key: "codingSystem",
    header: "Code_System",
    required: true,
    width: 14,
    aliases: ["codesystem", "codingsystem", "system"],
    format: "ICD-10, ICD-10-CM or ICD-11 — they are different classifications",
  },
  {
    key: "category",
    header: "Category",
    required: false,
    width: 34,
    aliases: ["category", "chapter", "specialty", "speciality"],
    format: "Optional chapter / block / specialty (max 150 characters)",
  },
  {
    key: "description",
    header: "Description",
    required: false,
    width: 60,
    aliases: ["description", "officialdescription"],
    format: "Optional official description (max 1000 characters)",
  },
  {
    key: "isActive",
    header: "Is_Active",
    required: false,
    width: 11,
    aliases: ["isactive", "active", "status"],
    format: "Yes or No. Blank = Yes for a new code (and keeps the current status of an existing one)",
  },
];
const SHEET = "ICD Codes";
const slug = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const HEADER_LOOKUP = new Map(COLUMNS.flatMap((c) => c.aliases.map((a) => [a, c.key])));
const BY_KEY = Object.fromEntries(COLUMNS.map((c) => [c.key, c]));
const REQUIRED_KEYS = COLUMNS.filter((c) => c.required).map((c) => c.key);

/** "icd10", "ICD-10 (WHO)", "icd 10 cm" → the master's system key. */
const SYSTEM_LOOKUP = new Map([
  ["icd10", "ICD-10"],
  ["icd10who", "ICD-10"],
  ["who", "ICD-10"],
  ["icd10cm", "ICD-10-CM"],
  ["icd10cmusclinicalmodification", "ICD-10-CM"],
  ["icd11", "ICD-11"],
  ["icd11mms", "ICD-11"],
  ["icd11mmswho", "ICD-11"],
  ...ICD_CODING_SYSTEMS.flatMap((s) => [
    [slug(s.key), s.key],
    [slug(s.label), s.key],
  ]),
]);
const SYSTEM_KEYS = ICD_CODING_SYSTEMS.map((s) => s.key);

const TRUE_WORDS = new Set(["yes", "y", "true", "1", "active"]);
const FALSE_WORDS = new Set(["no", "n", "false", "0", "inactive"]);

// ── Reading the workbook ─────────────────────────────────────────────────────
/** exceljs cell values come as text, numbers, booleans, Dates, rich text, formulas or hyperlinks. */
function cellValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && !(value instanceof Date)) {
    if (value.richText) return value.richText.map((t) => t.text).join("");
    if (value.result !== undefined) return cellValue(value.result);
    if (value.text !== undefined) return cellValue(value.text);
    if (value.error) return "";
  }
  return value;
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** Every .xlsx is a ZIP archive: "PK\x03\x04". */
const isZip = (buf) => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;

function checkFile(file) {
  if (!file?.buffer?.length) throw ApiError.badRequest("Choose the filled-in Excel template (.xlsx) to upload");
  const name = String(file.originalname || "");
  if (!/\.xlsx$/i.test(name)) {
    throw new ApiError(422, "Upload an Excel workbook (.xlsx). Older .xls and .csv files are not accepted — save the file as .xlsx", {
      code: ERROR_CODES.UNSUPPORTED_FILE_TYPE,
    });
  }
  if (file.size > ICD_EXCEL.MAX_MB * 1024 * 1024 || file.buffer.length > ICD_EXCEL.MAX_MB * 1024 * 1024) {
    throw new ApiError(422, `The file is larger than ${ICD_EXCEL.MAX_MB} MB — split it into smaller files`, {
      code: ERROR_CODES.VALIDATION_ERROR,
    });
  }
  if (!isZip(file.buffer) || (file.mimetype && file.mimetype !== XLSX_MIME && file.mimetype !== "application/octet-stream")) {
    throw new ApiError(422, "This file is not a valid .xlsx workbook — download the template and try again", {
      code: ERROR_CODES.UNSUPPORTED_FILE_TYPE,
    });
  }
}

async function readSheet(file) {
  checkFile(file);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(file.buffer);
  } catch {
    throw ApiError.badRequest("This file could not be read as an Excel workbook — download the template and try again");
  }
  const sheet = workbook.getWorksheet(SHEET) || workbook.worksheets[0];
  if (!sheet) throw ApiError.badRequest("The workbook has no sheet with data");

  // Header row: the first of the top 5 rows with at least two recognised columns.
  let headerRow = null;
  let map = null;
  let unexpected = [];
  let repeated = [];
  for (let r = 1; r <= Math.min(sheet.rowCount, 5); r += 1) {
    const candidate = new Map();
    const unknown = [];
    const twice = [];
    sheet.getRow(r).eachCell((cell, colNumber) => {
      const text = String(cellValue(cell.value)).trim();
      if (!text) return;
      const key = HEADER_LOOKUP.get(slug(text));
      if (!key) unknown.push(text);
      else if ([...candidate.values()].includes(key)) twice.push(text);
      else candidate.set(colNumber, key);
    });
    if (candidate.size >= 2) {
      headerRow = r;
      map = candidate;
      unexpected = unknown;
      repeated = twice;
      break;
    }
  }
  if (!map) {
    throw new ApiError(422, `No template headers found. The first row must contain: ${COLUMNS.map((c) => c.header).join(", ")}`, {
      code: ERROR_CODES.VALIDATION_ERROR,
    });
  }
  const found = [...map.values()];
  const missing = REQUIRED_KEYS.filter((k) => !found.includes(k));
  if (missing.length || repeated.length) {
    const parts = [];
    if (missing.length) parts.push(`required column(s) missing: ${missing.map((k) => BY_KEY[k].header).join(", ")}`);
    if (repeated.length) parts.push(`column(s) appear twice: ${repeated.join(", ")}`);
    throw new ApiError(422, `The header row is not valid — ${parts.join("; ")}`, {
      code: ERROR_CODES.VALIDATION_ERROR,
      details: { missing: missing.map((k) => BY_KEY[k].header), repeated, unexpected },
    });
  }

  const rows = [];
  for (let r = headerRow + 1; r <= sheet.rowCount; r += 1) {
    const raw = {};
    let any = false;
    sheet.getRow(r).eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const key = map.get(colNumber);
      if (!key) return;
      const v = cellValue(cell.value);
      if (v !== "" && v !== null) any = true;
      raw[key] = v;
    });
    if (!any) continue;
    rows.push({ rowNumber: r, raw });
    if (rows.length > ICD_EXCEL.MAX_ROWS) {
      throw new ApiError(422, `A file can hold at most ${ICD_EXCEL.MAX_ROWS.toLocaleString("en-IN")} rows — split it into smaller files`, {
        code: ERROR_CODES.VALIDATION_ERROR,
      });
    }
  }
  if (!rows.length) {
    throw new ApiError(422, "The sheet has the headers but no diagnosis rows", { code: ERROR_CODES.VALIDATION_ERROR });
  }
  return {
    sheetName: sheet.name,
    rows,
    columns: {
      found: COLUMNS.filter((c) => found.includes(c.key)).map((c) => c.header),
      missingOptional: COLUMNS.filter((c) => !c.required && !found.includes(c.key)).map((c) => c.header),
      unexpected,
    },
  };
}

// ── One row ──────────────────────────────────────────────────────────────────
const text = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").trim());

function parseActive(v) {
  if (typeof v === "boolean") return { value: v };
  const t = text(v).toLowerCase();
  if (!t) return { value: null };
  if (TRUE_WORDS.has(t)) return { value: true };
  if (FALSE_WORDS.has(t)) return { value: false };
  return { error: `Is_Active "${text(v)}" is not valid — use Yes or No` };
}

/**
 * Validate and normalise one sheet row. Returns the row's values and a list
 * of problems; `missingRequired` marks a row with an empty required cell.
 */
function checkRow({ rowNumber, raw }) {
  const errors = [];
  let missingRequired = false;
  const input = {
    code: text(raw.code),
    title: clean(text(raw.title)),
    codingSystem: text(raw.codingSystem),
    category: clean(text(raw.category)),
    description: clean(text(raw.description)),
  };

  const codingSystem = input.codingSystem ? SYSTEM_LOOKUP.get(slug(input.codingSystem)) : null;
  if (!input.codingSystem) {
    errors.push("Code_System is required");
    missingRequired = true;
  } else if (!codingSystem) {
    errors.push(`Code_System "${input.codingSystem}" is not supported — use ${SYSTEM_KEYS.join(", ")}`);
  }

  let code = null;
  if (!input.code) {
    errors.push("ICD_Code is required");
    missingRequired = true;
  } else {
    code = canonicalCode(codingSystem, input.code);
    if (code.length > 20) errors.push("ICD_Code is longer than 20 characters");
    else if (!/^[A-Z0-9][A-Z0-9.-]*$/.test(code)) errors.push(`ICD_Code "${input.code}" may only use letters, digits, '.' and '-'`);
    else if (codingSystem) {
      const problem = codeFormatError(codingSystem, code);
      if (problem) errors.push(problem);
    }
  }

  if (!input.title) {
    errors.push("Diagnosis_Name is required");
    missingRequired = true;
  } else if (input.title.length < 2) errors.push("Diagnosis_Name is too short");
  else if (input.title.length > 255) errors.push("Diagnosis_Name is longer than 255 characters");

  if (input.category && input.category.length > 150) errors.push("Category is longer than 150 characters");
  if (input.description && input.description.length > 1000) errors.push("Description is longer than 1000 characters");

  const active = parseActive(raw.isActive);
  if (active.error) errors.push(active.error);

  return {
    rowNumber,
    errors,
    missingRequired,
    value: {
      codingSystem,
      code,
      title: input.title,
      category: input.category,
      description: input.description,
      isActive: active.value ?? null,
    },
    shown: { code: code || input.code || null, title: input.title, codingSystem: codingSystem || input.codingSystem || null },
  };
}

// ── The plan: what the import would do, row by row ───────────────────────────
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const keyOf = (system, code) => `${system}|${dotless(code)}`;

/** Fields an "update" would change on an existing row (a blank cell keeps the current value). */
function changesFor(existing, v) {
  const out = [];
  if (v.title && v.title !== existing.title) out.push({ field: "Diagnosis_Name", from: existing.title, to: v.title });
  if (v.category && v.category !== existing.category) out.push({ field: "Category", from: existing.category, to: v.category });
  if (v.description && v.description !== existing.description) {
    out.push({ field: "Description", from: existing.description, to: v.description });
  }
  if (v.isActive !== null && v.isActive !== Boolean(existing.isActive)) {
    out.push({ field: "Is_Active", from: existing.isActive ? "Yes" : "No", to: v.isActive ? "Yes" : "No" });
  }
  return out;
}

async function plan(file, { systemVersion }) {
  const version = clean(systemVersion);
  const { sheetName, rows, columns } = await readSheet(file);
  const checked = rows.map(checkRow);

  const invalid = [];
  const duplicatesInFile = [];
  const unique = [];
  const firstRow = new Map();
  for (const r of checked) {
    if (r.errors.length) {
      invalid.push(r);
      continue;
    }
    const k = keyOf(r.value.codingSystem, r.value.code);
    if (firstRow.has(k)) {
      duplicatesInFile.push({ ...r, firstRowNumber: firstRow.get(k) });
      continue;
    }
    firstRow.set(k, r.rowNumber);
    unique.push(r);
  }

  // Everything already in this version of the systems the file uses — one query.
  const systems = [...new Set(unique.map((r) => r.value.codingSystem))];
  const existingRows = systems.length
    ? await IcdCode.findAll({
        where: { codingSystem: { [Op.in]: systems }, systemVersion: version },
        attributes: ["id", "codingSystem", "systemVersion", "code", "title", "category", "description", "isActive", "createdAt", "createdBy"],
        raw: true,
      })
    : [];
  const existingByKey = new Map(existingRows.map((e) => [keyOf(e.codingSystem, e.code), e]));

  const fresh = [];
  const existing = [];
  for (const r of unique) {
    const twin = existingByKey.get(keyOf(r.value.codingSystem, r.value.code));
    if (!twin) fresh.push(r);
    else existing.push({ ...r, existing: twin, changes: changesFor(twin, r.value) });
  }

  // Other releases of the same systems already in the master — so the admin
  // notices an upload aimed at the wrong version.
  const fileSystems = [...new Set(checked.map((r) => r.value.codingSystem).filter(Boolean))];
  const versionsInMaster = fileSystems.length
    ? await IcdCode.findAll({
        where: { codingSystem: { [Op.in]: fileSystems } },
        attributes: ["codingSystem", "systemVersion", [sequelize.fn("COUNT", sequelize.col("id")), "total"]],
        group: ["codingSystem", "systemVersion"],
        raw: true,
      })
    : [];

  const bySystem = new Map();
  for (const r of checked) {
    const s = r.value.codingSystem || "Unrecognised";
    bySystem.set(s, (bySystem.get(s) || 0) + 1);
  }

  return {
    fileName: String(file.originalname || "upload.xlsx").slice(0, 255),
    fileSha256: sha256(file.buffer),
    fileSize: file.buffer.length,
    sheetName,
    systemVersion: version,
    columns,
    total: checked.length,
    invalid,
    duplicatesInFile,
    fresh,
    existing,
    systems: [...bySystem.entries()].map(([codingSystem, count]) => ({ codingSystem, rows: count })),
    versionsInMaster: versionsInMaster.map((v) => ({ codingSystem: v.codingSystem, systemVersion: v.systemVersion, total: Number(v.total) })),
  };
}

const issue = (r, extra = {}) => ({ rowNumber: r.rowNumber, ...r.shown, ...extra });
const cap = (list) => list.slice(0, ICD_EXCEL.ISSUE_CAP);

function counts(p) {
  const changed = p.existing.filter((e) => e.changes.length).length;
  return {
    total: p.total,
    valid: p.fresh.length + p.existing.length + p.duplicatesInFile.length,
    new: p.fresh.length,
    invalid: p.invalid.length,
    missingRequired: p.invalid.filter((r) => r.missingRequired).length,
    duplicatesInFile: p.duplicatesInFile.length,
    existing: p.existing.length,
    existingSame: p.existing.length - changed,
    existingChanged: changed,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────
/** Validate the upload and report exactly what an import would do. Writes nothing. */
async function preview(file, opts) {
  const p = await plan(file, opts);
  return {
    fileName: p.fileName,
    fileSha256: p.fileSha256,
    fileSize: p.fileSize,
    sheetName: p.sheetName,
    systemVersion: p.systemVersion,
    columns: p.columns,
    counts: counts(p),
    systems: p.systems,
    versionsInMaster: p.versionsInMaster,
    issues: {
      invalid: cap(p.invalid).map((r) => issue(r, { errors: r.errors, missingRequired: r.missingRequired })),
      duplicatesInFile: cap(p.duplicatesInFile).map((r) => issue(r, { firstRowNumber: r.firstRowNumber })),
      existing: cap(p.existing).map((r) =>
        issue(r, {
          existing: {
            id: String(r.existing.id),
            title: r.existing.title,
            category: r.existing.category,
            description: r.existing.description,
            isActive: Boolean(r.existing.isActive),
          },
          changes: r.changes,
        })
      ),
    },
    sample: p.fresh.slice(0, ICD_EXCEL.SAMPLE_ROWS).map((r) => ({
      rowNumber: r.rowNumber,
      code: r.value.code,
      title: r.value.title,
      codingSystem: r.value.codingSystem,
      category: r.value.category,
      isActive: r.value.isActive ?? true,
    })),
    capped: ICD_EXCEL.ISSUE_CAP,
  };
}

function auditBase(adminId, p, duplicatePolicy) {
  const c = counts(p);
  return {
    fileName: p.fileName,
    fileSha256: p.fileSha256,
    systemVersion: p.systemVersion,
    duplicatePolicy,
    totalRows: c.total,
    validRows: c.valid,
    invalidRows: c.invalid,
    duplicateFileRows: c.duplicatesInFile,
    existingRows: c.existing,
    systems: p.systems,
    errorSample: p.invalid.slice(0, ICD_EXCEL.ERROR_SAMPLE).map((r) => ({ rowNumber: r.rowNumber, code: r.shown.code, errors: r.errors })),
    importedBy: adminId,
  };
}

/**
 * Write the previewed file: new codes are added; existing codes are skipped,
 * or — with duplicatePolicy "update", confirmed after the preview — get the
 * changed fields. One transaction; an audit row records the outcome.
 */
async function commit(adminId, file, { systemVersion, duplicatePolicy = "skip", expectedSha256 }) {
  const p = await plan(file, { systemVersion });
  if (p.fileSha256 !== String(expectedSha256 || "").toLowerCase()) {
    throw ApiError.conflict("This is not the file you previewed — preview it again before importing", {
      code: ERROR_CODES.ICD_IMPORT_STALE,
    });
  }
  const now = new Date();
  const toInsert = p.fresh.map((r) => ({
    codingSystem: r.value.codingSystem,
    systemVersion: p.systemVersion,
    code: r.value.code,
    title: r.value.title,
    category: r.value.category,
    description: r.value.description,
    isActive: r.value.isActive ?? true,
    createdBy: adminId,
    updatedBy: adminId,
    createdAt: now,
    updatedAt: now,
  }));
  // Update rows keep their stored identity (id + code as stored) so the
  // upsert hits the same row; a blank cell keeps the current value.
  const toUpdate =
    duplicatePolicy === "update"
      ? p.existing
          .filter((r) => r.changes.length)
          .map(({ existing: e, value: v }) => ({
            id: e.id,
            codingSystem: e.codingSystem,
            systemVersion: e.systemVersion,
            code: e.code,
            title: v.title || e.title,
            category: v.category ?? e.category,
            description: v.description ?? e.description,
            isActive: v.isActive ?? Boolean(e.isActive),
            createdBy: e.createdBy,
            createdAt: e.createdAt,
            updatedBy: adminId,
            updatedAt: now,
          }))
      : [];
  const skipped = p.existing.length - toUpdate.length;
  const base = auditBase(adminId, p, duplicatePolicy);

  let batch;
  try {
    batch = await sequelize.transaction(async (transaction) => {
      for (let i = 0; i < toInsert.length; i += ICD_EXCEL.CHUNK) {
        await IcdCode.bulkCreate(toInsert.slice(i, i + ICD_EXCEL.CHUNK), { transaction, validate: false });
      }
      for (let i = 0; i < toUpdate.length; i += ICD_EXCEL.CHUNK) {
        await IcdCode.bulkCreate(toUpdate.slice(i, i + ICD_EXCEL.CHUNK), {
          transaction,
          validate: false,
          updateOnDuplicate: ["title", "category", "description", "isActive", "updatedBy", "updatedAt"],
        });
      }
      return IcdImportBatch.create(
        { ...base, status: "completed", insertedRows: toInsert.length, updatedRows: toUpdate.length, skippedRows: skipped },
        { transaction }
      );
    });
  } catch (err) {
    // Nothing was written (the transaction rolled back). Record the attempt
    // without the database's own message.
    const raced = err instanceof UniqueConstraintError;
    await IcdImportBatch.create({
      ...base,
      status: "failed",
      failureReason: raced ? "Some codes were added by someone else during the import" : "Database error — nothing was imported",
    }).catch(() => {});
    if (raced) {
      throw ApiError.conflict("Some of these codes were added while the import was running. Nothing was imported — preview the file again", {
        code: ERROR_CODES.ICD_DUPLICATE,
      });
    }
    throw err;
  }

  return {
    batchId: String(batch.id),
    fileName: p.fileName,
    systemVersion: p.systemVersion,
    duplicatePolicy,
    counts: {
      ...counts(p),
      inserted: toInsert.length,
      updated: toUpdate.length,
      skippedExisting: skipped,
    },
  };
}

async function history({ page = 1, limit = 20 } = {}) {
  const { rows, count } = await IcdImportBatch.findAndCountAll({
    include: [{ model: User, as: "importer", attributes: ["id", "name"] }],
    order: [["createdAt", "DESC"], ["id", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return {
    rows: rows.map((b) => ({
      id: String(b.id),
      fileName: b.fileName,
      systemVersion: b.systemVersion,
      duplicatePolicy: b.duplicatePolicy,
      status: b.status,
      totalRows: b.totalRows,
      validRows: b.validRows,
      invalidRows: b.invalidRows,
      duplicateFileRows: b.duplicateFileRows,
      existingRows: b.existingRows,
      insertedRows: b.insertedRows,
      updatedRows: b.updatedRows,
      skippedRows: b.skippedRows,
      systems: b.systems ?? [],
      errorSample: b.errorSample ?? [],
      failureReason: b.failureReason,
      importedBy: b.importer ? { id: String(b.importer.id), name: b.importer.name } : null,
      createdAt: b.createdAt ? new Date(b.createdAt).toISOString() : null,
    })),
    total: count,
    page,
    limit,
  };
}

// ── Template ─────────────────────────────────────────────────────────────────
const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF17365D" } };
const REQUIRED_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC62828" } };

/**
 * Two illustrative rows for the Example sheet (never imported — only the
 * "ICD Codes" sheet is read). Both are real codes with their official titles
 * in that system; an administrator still imports from their licensed source.
 */
const EXAMPLES = [
  ["I10", "Essential (primary) hypertension", "ICD-10", "Diseases of the circulatory system", "Essential (primary) hypertension", "Yes"],
  ["E11.9", "Type 2 diabetes mellitus without complications", "ICD-10-CM", "Endocrine, nutritional and metabolic diseases", "Type 2 diabetes mellitus without complications", "Yes"],
];
const LIST_ROWS = 200000;

function addCodesSheet(workbook, name, rows) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.alignment = { vertical: "middle" };
  header.height = 22;
  COLUMNS.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.fill = c.required ? REQUIRED_FILL : HEADER_FILL;
    cell.note = `${c.required ? "REQUIRED" : "Optional"} — ${c.format}`;
  });
  // Codes as text so Excel never turns "1A00" or "E11.10" into a number.
  sheet.getColumn(1).numFmt = "@";
  for (const r of rows) sheet.addRow(r);
  const col = (key) => sheet.getColumn(COLUMNS.findIndex((c) => c.key === key) + 1).letter;
  sheet.dataValidations.add(`${col("codingSystem")}2:${col("codingSystem")}${LIST_ROWS}`, {
    type: "list",
    allowBlank: true,
    formulae: [`"${SYSTEM_KEYS.join(",")}"`],
    showErrorMessage: true,
    errorTitle: "Code_System",
    error: `Choose one of: ${SYSTEM_KEYS.join(", ")}`,
  });
  sheet.dataValidations.add(`${col("isActive")}2:${col("isActive")}${LIST_ROWS}`, {
    type: "list",
    allowBlank: true,
    formulae: ['"Yes,No"'],
    showErrorMessage: true,
    errorTitle: "Is_Active",
    error: "Choose Yes or No",
  });
  return sheet;
}

function addInstructionsSheet(workbook) {
  const sheet = workbook.addWorksheet("Instructions");
  sheet.columns = [
    { header: "Column", key: "column", width: 18 },
    { header: "Required?", key: "required", width: 12 },
    { header: "What to enter", key: "format", width: 90 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const c of COLUMNS) sheet.addRow({ column: c.header, required: c.required ? "REQUIRED" : "Optional", format: c.format });
  sheet.addRow({});
  sheet.addRow(["How the import works"]).font = { bold: true };
  const lines = [
    "Fill in the “ICD Codes” sheet only — it is the only sheet that is imported. The “Example” sheet shows two filled rows for reference.",
    "Enter codes exactly as published by the official source your organisation uses. ICD-10 (WHO), ICD-10-CM and ICD-11 are different classifications: never mix their codes under one Code_System.",
    "When you upload, you choose the release / version of the classification (for example 2019 for WHO ICD-10, FY2027 for ICD-10-CM). A code is unique within Code_System + version.",
    "Every upload is checked first and nothing is saved until you confirm. The preview lists invalid rows, rows missing required values, codes repeated in the file and codes already in the master.",
    "A code repeated in the file: the first row is used. A code already in the master is skipped unless you choose to update it after reviewing the differences — a blank cell never erases the current value.",
    "Diagnoses already recorded for patients are never changed by an import; they keep the code and description they were saved with.",
    `At most ${ICD_EXCEL.MAX_ROWS.toLocaleString("en-IN")} rows and ${ICD_EXCEL.MAX_MB} MB per file.`,
  ];
  for (const line of lines) sheet.addRow(["", "", line]);
  sheet.eachRow((row) => {
    row.alignment = { vertical: "top", wrapText: true };
  });
}

async function template() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Indian Health System";
  workbook.created = new Date();
  addCodesSheet(workbook, SHEET, []);
  addInstructionsSheet(workbook);
  addCodesSheet(workbook, "Example", EXAMPLES);
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    fileName: "IHS_ICD_Bulk_Import_Template.xlsx",
    contentType: XLSX_MIME,
  };
}

module.exports = { preview, commit, history, template, COLUMNS, checkRow, SHEET };
