/**
 * Admin ICD code master (migration 059) + the doctor's diagnosis search.
 *
 * Rules everything here follows:
 *   - Nothing is seeded or invented. Every row comes from an administrator,
 *     typed in or imported from a verified source file.
 *   - A code is only meaningful within its coding system AND version — the
 *     duplicate check, the import and the unique key all use that triple.
 *   - Rows are never deleted. Deactivating hides a row from doctors; diagnoses
 *     already recorded keep their own snapshot of code / system / version /
 *     description, so history never changes underneath them.
 *   - The import only ADDS rows. An existing code is reported, never
 *     overwritten.
 */
const { Op, UniqueConstraintError, fn, col, where: sqlWhere } = require("sequelize");
const { sequelize, IcdCode, ClinicalEntry } = require("../models");
const ApiError = require("../utils/ApiError");
const env = require("../config/env");
const {
  ERROR_CODES,
  ICD_CODING_SYSTEMS,
  ICD_SEARCH_LIMIT,
  CLINICAL_ENTRY_KIND,
  CLINICAL_ENTRY_STATUS,
} = require("../config/constants");

// ── Normalization ── one definition, shared by every write and the import ──
/** Trim + collapse inner whitespace (display value). */
const clean = (v) => (v == null ? null : String(v).trim().replace(/\s+/g, " ") || null);
/** Codes compare upper-case with no spaces: " m54.5 " → "M54.5". */
const normCode = (v) => String(v ?? "").replace(/\s+/g, "").toUpperCase();
/** "M54.5" → "M545", so a doctor typing the code without its dot still finds it. */
const dotless = (v) => normCode(v).replace(/\./g, "");

/**
 * Per-system code shape. Only the SHAPE is checked — whether a code exists in
 * the classification is the administrator's responsibility (the master is
 * filled from a verified source). ICD-10 / ICD-10-CM codes may be written
 * without their dot ("E119" → "E11.9", the way CMS publishes them); ICD-11
 * codes are kept exactly as written.
 */
const CODE_RULES = {
  "ICD-10": {
    re: /^[A-Z][0-9]{2}(\.[0-9A-Z]{1,2})?$/,
    hint: "letter + 2 digits, optional '.' + 1–2 characters (e.g. I10, E11.9)",
  },
  "ICD-10-CM": {
    re: /^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/,
    hint: "letter + digit + character, optional '.' + 1–4 characters (e.g. E11.9, S72.001A)",
  },
  "ICD-11": {
    re: /^(?:[0-9A-Z]{4}(?:\.[0-9A-Z]{1,2}){0,2}|X[0-9A-Z]{2,7})$/,
    hint: "4-character stem code, optional '.' extensions (e.g. 5A11, BA00.0) or an X extension code",
  },
};

/** The stored form of a code in a system: upper-case, no spaces, ICD-10 family dotted. */
function canonicalCode(codingSystem, v) {
  const code = normCode(v);
  if ((codingSystem === "ICD-10" || codingSystem === "ICD-10-CM") && !code.includes(".") && /^[A-Z][0-9][0-9A-Z][0-9A-Z]+$/.test(code)) {
    return `${code.slice(0, 3)}.${code.slice(3)}`;
  }
  return code;
}

/** Null when the (canonical) code fits its system's shape, else a message. */
function codeFormatError(codingSystem, code) {
  const rule = CODE_RULES[codingSystem];
  if (!rule || rule.re.test(code)) return null;
  return `"${code}" is not a valid ${codingSystem} code — expected ${rule.hint}`;
}

const likeOf = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const prefixOf = (q) => `${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function normalized(dto) {
  return {
    codingSystem: dto.codingSystem,
    systemVersion: clean(dto.systemVersion),
    code: canonicalCode(dto.codingSystem, dto.code),
    title: clean(dto.title),
    description: clean(dto.description),
    category: clean(dto.category),
  };
}

const duplicateError = (row) =>
  ApiError.conflict(`${row.code} already exists in ${row.codingSystem} ${row.systemVersion}`, {
    code: ERROR_CODES.ICD_DUPLICATE,
    details: { id: String(row.id) },
  });

async function findTwin({ codingSystem, systemVersion, code }, exceptId = null, transaction) {
  const where = { codingSystem, systemVersion, code };
  if (exceptId) where.id = { [Op.ne]: exceptId };
  return IcdCode.findOne({ where, transaction });
}

// ── Admin: list / meta ───────────────────────────────────────────────────────
async function list({ q, codingSystem, systemVersion, category, status = "all", page = 1, limit = 25 } = {}) {
  const where = {};
  if (codingSystem) where.codingSystem = codingSystem;
  if (systemVersion) where.systemVersion = systemVersion;
  if (category === "__none__") where.category = null;
  else if (category) where.category = category;
  if (status === "active") where.isActive = true;
  if (status === "inactive") where.isActive = false;
  const term = clean(q);
  if (term) {
    where[Op.or] = [
      { code: { [Op.like]: prefixOf(normCode(term)) } },
      sqlWhere(fn("REPLACE", col("code"), ".", ""), { [Op.like]: prefixOf(dotless(term)) }),
      { title: { [Op.like]: likeOf(term) } },
      { description: { [Op.like]: likeOf(term) } },
      { category: { [Op.like]: likeOf(term) } },
    ];
  }
  const { rows, count } = await IcdCode.findAndCountAll({
    where,
    order: [
      ["codingSystem", "ASC"],
      ["systemVersion", "ASC"],
      ["code", "ASC"],
    ],
    limit,
    offset: (page - 1) * limit,
  });
  // How many recorded diagnoses point at each row on this page — one query.
  const ids = rows.map((r) => r.id);
  const usage = ids.length
    ? await ClinicalEntry.findAll({
        where: { icdCodeId: { [Op.in]: ids }, kind: CLINICAL_ENTRY_KIND.DIAGNOSIS },
        attributes: ["icdCodeId", [fn("COUNT", col("id")), "n"]],
        group: ["icdCodeId"],
        raw: true,
      })
    : [];
  const used = new Map(usage.map((u) => [String(u.icdCodeId), Number(u.n)]));
  return { rows, total: count, page, limit, usedCount: (id) => used.get(String(id)) ?? 0 };
}

/** The coding systems the master accepts, the versions and categories in use, and their counts. */
async function meta() {
  const categoriesQuery = IcdCode.findAll({
    attributes: ["category", [fn("COUNT", col("id")), "total"]],
    where: { category: { [Op.ne]: null } },
    group: ["category"],
    order: [["category", "ASC"]],
    limit: 500,
    raw: true,
  });
  const versionsQuery = IcdCode.findAll({
    attributes: [
      "codingSystem",
      "systemVersion",
      [fn("COUNT", col("id")), "total"],
      [fn("SUM", col("is_active")), "active"],
    ],
    group: ["codingSystem", "systemVersion"],
    order: [
      ["codingSystem", "ASC"],
      ["systemVersion", "ASC"],
    ],
    raw: true,
  });
  const [versions, categories] = await Promise.all([versionsQuery, categoriesQuery]);
  return {
    systems: ICD_CODING_SYSTEMS,
    categories: categories.map((c) => ({ name: c.category, total: Number(c.total) })),
    versions: versions.map((v) => ({
      codingSystem: v.codingSystem,
      systemVersion: v.systemVersion,
      total: Number(v.total),
      active: Number(v.active),
    })),
    doctorSearch: {
      codingSystem: env.ICD_SEARCH_SYSTEM || null,
      systemVersion: env.ICD_SEARCH_VERSION || null,
    },
  };
}

// ── Admin: create / update ───────────────────────────────────────────────────
function assertCodeFormat(codingSystem, code) {
  const problem = codeFormatError(codingSystem, code);
  if (problem) throw new ApiError(422, problem, { code: ERROR_CODES.VALIDATION_ERROR, details: { field: "code" } });
}

async function create(adminId, dto) {
  const values = normalized(dto);
  assertCodeFormat(values.codingSystem, values.code);
  const twin = await findTwin(values);
  if (twin) throw duplicateError(twin);
  try {
    return await IcdCode.create({ ...values, isActive: dto.isActive ?? true, createdBy: adminId, updatedBy: adminId });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      const raced = await findTwin(values);
      if (raced) throw duplicateError(raced);
    }
    throw err;
  }
}

async function update(adminId, id, dto) {
  const row = await IcdCode.findByPk(id);
  if (!row) throw ApiError.notFound("ICD code not found");
  const patch = {};
  if (dto.codingSystem !== undefined) patch.codingSystem = dto.codingSystem;
  if (dto.systemVersion !== undefined) patch.systemVersion = clean(dto.systemVersion);
  if (dto.code !== undefined) patch.code = canonicalCode(patch.codingSystem ?? row.codingSystem, dto.code);
  if (dto.title !== undefined) patch.title = clean(dto.title);
  if (dto.description !== undefined) patch.description = clean(dto.description);
  if (dto.category !== undefined) patch.category = clean(dto.category);
  if (dto.isActive !== undefined) patch.isActive = dto.isActive;

  const identity = {
    codingSystem: patch.codingSystem ?? row.codingSystem,
    systemVersion: patch.systemVersion ?? row.systemVersion,
    code: patch.code ?? row.code,
  };
  // Re-check the shape only when the identity changes — an existing row's
  // name / status can always be edited.
  if (patch.code !== undefined || patch.codingSystem !== undefined) assertCodeFormat(identity.codingSystem, identity.code);
  const twin = await findTwin(identity, row.id);
  if (twin) throw duplicateError(twin);
  try {
    await row.update({ ...patch, updatedBy: adminId });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      const raced = await findTwin(identity, row.id);
      if (raced) throw duplicateError(raced);
    }
    throw err;
  }
  return row;
}

// ── Admin: import a verified catalogue (add-only) ───────────────────────────
/**
 * Adds the rows of one coding system + version. Codes already in that
 * catalogue are SKIPPED (reported, never overwritten); a code repeated inside
 * the file keeps its first row. `dryRun` reports the same counts without
 * writing. Every row is validated by the Joi schema before it gets here.
 */
async function importRows(adminId, { codingSystem, systemVersion, rows, dryRun = false }) {
  const version = clean(systemVersion);
  const seen = new Set();
  const duplicatesInFile = [];
  const invalidFormat = [];
  const unique = [];
  for (const r of rows) {
    const v = normalized({ ...r, codingSystem, systemVersion: version });
    if (codeFormatError(codingSystem, v.code)) {
      invalidFormat.push(v.code);
      continue;
    }
    if (seen.has(v.code)) {
      duplicatesInFile.push(v.code);
      continue;
    }
    seen.add(v.code);
    unique.push(v);
  }

  const existing = unique.length
    ? await IcdCode.findAll({
        where: { codingSystem, systemVersion: version, code: { [Op.in]: unique.map((v) => v.code) } },
        attributes: ["code"],
        raw: true,
      })
    : [];
  const have = new Set(existing.map((e) => normCode(e.code)));
  const fresh = unique.filter((v) => !have.has(v.code));

  if (!dryRun && fresh.length) {
    await sequelize.transaction((transaction) =>
      IcdCode.bulkCreate(
        fresh.map((v) => ({ ...v, isActive: true, createdBy: adminId, updatedBy: adminId })),
        // A concurrent import of the same code: the unique key keeps one row.
        { transaction, ignoreDuplicates: true }
      )
    );
  }
  return {
    codingSystem,
    systemVersion: version,
    dryRun,
    received: rows.length,
    inserted: dryRun ? 0 : fresh.length,
    wouldInsert: fresh.length,
    skippedExisting: [...have],
    duplicatesInFile,
    invalidFormat,
  };
}

// ── Admin: diagnoses doctors recorded WITHOUT a master code ──────────────────
/**
 * Diagnosis names (and the code the doctor typed, if any) saved to encounters
 * without a catalogue match, most frequent first. This is the review queue
 * for growing the master: an administrator verifies a name/code against the
 * official source and adds it — nothing here is ever published automatically,
 * and no patient detail is exposed (names, codes and counts only).
 */
async function doctorEntries({ q, limit = 50 } = {}) {
  const where = {
    kind: CLINICAL_ENTRY_KIND.DIAGNOSIS,
    icdCodeId: null,
    status: CLINICAL_ENTRY_STATUS.ACTIVE,
    title: { [Op.ne]: null },
  };
  const term = clean(q);
  if (term) where[Op.and] = [{ [Op.or]: [{ title: { [Op.like]: likeOf(term) } }, { code: { [Op.like]: prefixOf(normCode(term)) } }] }];
  const rows = await ClinicalEntry.findAll({
    where,
    attributes: [
      "title",
      "code",
      [fn("COUNT", col("id")), "entries"],
      [fn("COUNT", fn("DISTINCT", col("created_by"))), "doctors"],
      [fn("MAX", col("created_at")), "lastRecordedAt"],
    ],
    group: ["title", "code"],
    order: [[fn("COUNT", col("id")), "DESC"], ["title", "ASC"]],
    limit,
    raw: true,
  });
  return rows.map((r) => ({
    title: r.title,
    code: r.code || null,
    entries: Number(r.entries),
    doctors: Number(r.doctors),
    lastRecordedAt: r.lastRecordedAt ? new Date(r.lastRecordedAt).toISOString() : null,
  }));
}

// ── Doctor: diagnosis search ─────────────────────────────────────────────────
/** The catalogue doctors search: pinned by env, else every active row. */
function searchScope() {
  const where = { isActive: true };
  if (env.ICD_SEARCH_SYSTEM) where.codingSystem = env.ICD_SEARCH_SYSTEM;
  if (env.ICD_SEARCH_VERSION) where.systemVersion = env.ICD_SEARCH_VERSION;
  return where;
}

/** Lower is better: exact code, code prefix, exact name, name prefix, the rest. */
function rank(row, term) {
  const code = dotless(term);
  const rowCode = dotless(row.code);
  const title = String(row.title).toLowerCase();
  const t = term.toLowerCase();
  if (rowCode === code) return 0;
  if (code.length >= 2 && rowCode.startsWith(code)) return 1;
  if (title === t) return 2;
  if (title.startsWith(t)) return 3;
  return 4;
}

/**
 * Active catalogue rows matching a diagnosis name (every word, in the name,
 * description or category) OR a code (prefix, with or without its dot).
 * Several matches are returned for the doctor to choose — nothing is picked
 * automatically.
 */
async function search(q) {
  const term = clean(q) ?? "";
  const words = term.split(" ").filter(Boolean).slice(0, 6);
  const nameMatch = {
    [Op.and]: words.map((w) => ({
      [Op.or]: [
        { title: { [Op.like]: likeOf(w) } },
        { description: { [Op.like]: likeOf(w) } },
        { category: { [Op.like]: likeOf(w) } },
      ],
    })),
  };
  const codeMatch = [
    { code: { [Op.like]: prefixOf(normCode(term)) } },
    sqlWhere(fn("REPLACE", col("code"), ".", ""), { [Op.like]: prefixOf(dotless(term)) }),
  ];
  const rows = await IcdCode.findAll({
    where: { ...searchScope(), [Op.or]: [nameMatch, ...codeMatch] },
    order: [["title", "ASC"]],
    limit: ICD_SEARCH_LIMIT * 3,
  });
  return rows
    .map((row) => ({ row, r: rank(row, term) }))
    .sort((a, b) => a.r - b.r || String(a.row.title).localeCompare(String(b.row.title)))
    .slice(0, ICD_SEARCH_LIMIT)
    .map((x) => x.row);
}

/**
 * The catalogue row a doctor picked for a diagnosis entry — it must still be
 * active. Returns the snapshot the entry stores.
 */
async function snapshotFor(icdCodeId, transaction) {
  const row = await IcdCode.findOne({ where: { id: icdCodeId, isActive: true }, transaction });
  if (!row) {
    throw new ApiError(422, "That ICD code is no longer active in the catalogue — search again", {
      code: ERROR_CODES.ICD_INACTIVE,
    });
  }
  return {
    icdCodeId: row.id,
    code: row.code,
    codeSystem: row.codingSystem,
    codeVersion: row.systemVersion,
    codeDescription: row.description ?? row.title,
  };
}

module.exports = {
  list,
  meta,
  create,
  update,
  importRows,
  doctorEntries,
  search,
  snapshotFor,
  normCode,
  dotless,
  rank,
  clean,
  canonicalCode,
  codeFormatError,
  CODE_RULES,
};
