#!/usr/bin/env node
/**
 * Move files stored by the LOCAL driver (backend/uploads, referenced as
 * `<PUBLIC_URL>/uploads/<key>`) to Cloudinary — controlled, verified, resumable,
 * and reversible. CLOUDINARY_SETUP.md §"Migrating existing files" is the runbook.
 *
 *   node scripts/migrateUploadsToCloudinary.js               inventory only (read-only, the default)
 *   node scripts/migrateUploadsToCloudinary.js --upload      upload + verify each file (no DB writes)
 *   node scripts/migrateUploadsToCloudinary.js --apply       point DB rows at verified Cloudinary copies
 *   node scripts/migrateUploadsToCloudinary.js --rollback storage-migration/runs/<id>/applied.json
 *   node scripts/migrateUploadsToCloudinary.js --cleanup     retry Cloudinary deletions that failed earlier
 *   options: --limit <n>   process at most n files this run
 *
 * Guarantees:
 *  - NOTHING is ever deleted: local files and old references are left in place.
 *  - Each file keeps its storage key, so its Cloudinary public_id is
 *    deterministic: re-running never duplicates an asset (overwrite:false).
 *  - A file counts as migrated only when the bytes read BACK from Cloudinary
 *    have the same SHA-256 as the local file.
 *  - `--apply` changes a row only if it still holds the exact old URL, writes
 *    the undo list (applied.json) BEFORE committing, and runs per column in a
 *    transaction. `--rollback` replays that list in reverse.
 *  - Progress lives in storage-migration/state.json, so any step can be re-run
 *    or resumed after a failure. Failed files are reported and keep their
 *    original reference.
 *
 * URLs inside JSON columns (e.g. a finalized prescription's frozen template
 * snapshot) are reported but never rewritten — a signed record is not edited.
 * Those keep reading from the local file, which is why local files are kept.
 */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

process.chdir(path.join(__dirname, "..")); // .env, UPLOAD_DIR and state paths are backend-relative

const env = require("../src/config/env");
const { sequelize } = require("../src/models");
const { Op, DataTypes } = require("sequelize");
const upload = require("../src/services/upload.service");
const cloud = require("../src/services/cloudinaryStorage.service");
const { isSafeKey } = require("../src/config/storage");

const STATE_DIR = path.resolve("storage-migration");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = path.join(STATE_DIR, "runs", RUN_ID);

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => (args.indexOf(flag) !== -1 ? args[args.indexOf(flag) + 1] : undefined);
const LIMIT = Number(valueOf("--limit")) || Infinity;

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback);
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

/** state.files[oldUrl] = { key, bytes, sha256, status, newUrl?, error?, verifiedAt? } */
const loadState = () => readJson(STATE_FILE, { version: 1, files: {} });
const saveState = (state) => writeJson(STATE_FILE, state);

/** Every URL-ish STRING column, and every JSON/TEXT column, across all models. */
function discoverColumns() {
  const urlColumns = [];
  const embeddedColumns = [];
  for (const model of Object.values(sequelize.models)) {
    const pk = model.primaryKeyAttribute;
    if (!pk) continue;
    for (const [attr, def] of Object.entries(model.rawAttributes)) {
      const field = def.field || attr;
      if (def.type instanceof DataTypes.STRING && /_url$/i.test(field)) urlColumns.push({ model, attr, field, pk });
      else if (def.type instanceof DataTypes.JSON || def.type instanceof DataTypes.TEXT) embeddedColumns.push({ model, attr, field, pk });
    }
  }
  return { urlColumns, embeddedColumns };
}

/** Rows whose column references a local upload — one query per column. */
async function inventory() {
  const { urlColumns, embeddedColumns } = discoverColumns();
  const refs = [];
  for (const c of urlColumns) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await c.model.findAll({
      attributes: [c.pk, c.attr],
      where: { [c.attr]: { [Op.like]: "%/uploads/%" } },
      raw: true,
    });
    for (const r of rows) refs.push({ table: c.model.getTableName(), model: c.model.name, column: c.field, attr: c.attr, pk: c.pk, id: r[c.pk], url: r[c.attr] });
  }
  const embedded = [];
  for (const c of embeddedColumns) {
    // eslint-disable-next-line no-await-in-loop
    const count = await c.model.count({ where: sequelize.where(sequelize.cast(sequelize.col(c.field), "CHAR"), { [Op.like]: "%/uploads/%" }) });
    if (count) embedded.push({ table: c.model.getTableName(), column: c.field, rows: count });
  }

  const byUrl = new Map();
  for (const ref of refs) {
    if (!byUrl.has(ref.url)) byUrl.set(ref.url, []);
    byUrl.get(ref.url).push(`${ref.table}.${ref.column}#${ref.id}`);
  }
  const files = [...byUrl.entries()].map(([url, usedBy]) => {
    const key = upload.keyFromUrl(url);
    const localPath = upload.localPathFor(key);
    const exists = Boolean(localPath && fs.existsSync(localPath));
    return { url, key, usedBy, exists, bytes: exists ? fs.statSync(localPath).size : null };
  });
  const diskFiles = listDiskFiles();
  const referenced = new Set(files.map((f) => f.key));
  const unreferenced = diskFiles.filter((k) => !referenced.has(k));
  return { refs, files, embedded, unreferenced };
}

function listDiskFiles() {
  const root = path.resolve(env.UPLOAD_DIR);
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out;
}

function requireCloudinary() {
  if (!cloud.isConfigured()) {
    console.error("❌ Cloudinary credentials are not set in backend/.env (CLOUDINARY_CLOUD_NAME / _API_KEY / _API_SECRET).");
    process.exit(1);
  }
}

/** Upload + verify every referenced local file not yet verified. */
async function uploadAll(files, state) {
  requireCloudinary();
  let done = 0;
  for (const f of files) {
    if (done >= LIMIT) break;
    const prev = state.files[f.url];
    if (prev?.status === "verified") continue;
    done += 1;
    const entry = { key: f.key, status: "pending" };
    try {
      if (!f.key || !isSafeKey(f.key)) throw new Error("unsafe or unparseable storage key");
      if (!f.exists) throw new Error("local file is missing");
      // eslint-disable-next-line no-await-in-loop
      const buffer = await fs.promises.readFile(upload.localPathFor(f.key));
      entry.bytes = buffer.length;
      entry.sha256 = sha256(buffer);
      // Same key → same public_id: a rerun returns the existing asset, never a duplicate.
      // eslint-disable-next-line no-await-in-loop
      const stored = await cloud.put(buffer, f.key);
      // eslint-disable-next-line no-await-in-loop
      const back = await cloud.read(cloud.parseUrl(stored.url));
      if (!back) throw new Error("uploaded, but could not be read back for verification");
      if (sha256(back) !== entry.sha256) throw new Error("read-back checksum does not match the local file");
      Object.assign(entry, { status: "verified", newUrl: stored.url, verifiedAt: new Date().toISOString() });
      console.log(`✅ ${f.key}`);
    } catch (err) {
      Object.assign(entry, { status: "failed", error: String(err.message || err).slice(0, 300) });
      console.warn(`❌ ${f.key || f.url}: ${entry.error}`);
    }
    state.files[f.url] = entry;
    saveState(state); // after every file — a crash loses nothing
  }
}

/** Switch DB references to verified Cloudinary URLs. Writes the undo list first. */
async function applyAll(refs, state) {
  requireCloudinary();
  const changes = refs
    .filter((r) => state.files[r.url]?.status === "verified")
    .map((r) => ({ model: r.model, table: r.table, column: r.column, attr: r.attr, pk: r.pk, id: r.id, from: r.url, to: state.files[r.url].newUrl }));
  if (!changes.length) {
    console.log("Nothing to apply — run --upload first, or every reference is already migrated.");
    return;
  }
  const undoFile = path.join(RUN_DIR, "applied.json");
  writeJson(undoFile, { runId: RUN_ID, changes });

  const groups = new Map();
  for (const ch of changes) {
    const g = `${ch.model}.${ch.attr}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(ch);
  }
  let updated = 0;
  for (const list of groups.values()) {
    const model = sequelize.models[list[0].model];
    // eslint-disable-next-line no-await-in-loop
    await sequelize.transaction(async (transaction) => {
      for (const ch of list) {
        // Only rows that still hold the exact old URL — a changed row is left alone.
        // eslint-disable-next-line no-await-in-loop
        const [n] = await model.update({ [ch.attr]: ch.to }, { where: { [ch.pk]: ch.id, [ch.attr]: ch.from }, transaction, hooks: false });
        updated += n;
      }
    });
  }
  console.log(`✅ ${updated} reference(s) now point at Cloudinary. Undo list: ${path.relative(process.cwd(), undoFile)}`);
}

/** Reverse an --apply run from its applied.json. */
async function rollback(file) {
  const { changes } = readJson(path.resolve(file), { changes: [] });
  let restored = 0;
  await sequelize.transaction(async (transaction) => {
    for (const ch of changes) {
      const model = sequelize.models[ch.model];
      // eslint-disable-next-line no-await-in-loop
      const [n] = await model.update({ [ch.attr]: ch.from }, { where: { [ch.pk]: ch.id, [ch.attr]: ch.to }, transaction, hooks: false });
      restored += n;
    }
  });
  console.log(`↩️  Restored ${restored} of ${changes.length} reference(s) to their original local URLs.`);
}

/** Retry deletions that failed earlier (storage-cleanup.jsonl). */
async function cleanup() {
  requireCloudinary();
  const queue = cloud.CLEANUP_QUEUE_FILE;
  if (!fs.existsSync(queue)) {
    console.log("Cleanup queue is empty.");
    return;
  }
  const processing = `${queue}.${RUN_ID}.processing`;
  fs.renameSync(queue, processing); // failures re-queue into a fresh file
  const keys = [...new Set(fs.readFileSync(processing, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).key))];
  let ok = 0;
  for (const key of keys) {
    // eslint-disable-next-line no-await-in-loop
    if (await cloud.remove(key)) ok += 1;
  }
  fs.renameSync(processing, path.join(STATE_DIR, `cleanup-done-${RUN_ID}.jsonl`));
  console.log(`🧹 ${ok}/${keys.length} queued deletion(s) completed; any failures were re-queued.`);
}

async function main() {
  await sequelize.authenticate();
  fs.mkdirSync(RUN_DIR, { recursive: true });

  if (has("--rollback")) return rollback(valueOf("--rollback"));
  if (has("--cleanup")) return cleanup();

  const inv = await inventory();
  const state = loadState();
  writeJson(path.join(RUN_DIR, "inventory.json"), {
    runId: RUN_ID,
    uploadDir: path.resolve(env.UPLOAD_DIR),
    references: inv.refs.length,
    files: inv.files,
    embeddedReferences: inv.embedded,
    unreferencedDiskFiles: inv.unreferenced,
  });

  if (has("--upload")) await uploadAll(inv.files, state);
  if (has("--apply")) await applyAll(inv.refs, state);

  const statusOf = (f) => state.files[f.url]?.status || "not uploaded";
  const summary = inv.files.reduce((acc, f) => ({ ...acc, [statusOf(f)]: (acc[statusOf(f)] || 0) + 1 }), {});
  const failed = inv.files.filter((f) => statusOf(f) === "failed").map((f) => ({ key: f.key, url: f.url, error: state.files[f.url].error }));
  const report = {
    runId: RUN_ID,
    mode: has("--apply") ? "apply" : has("--upload") ? "upload" : "inventory",
    referencesStillLocal: inv.refs.length,
    distinctFiles: inv.files.length,
    missingOnDisk: inv.files.filter((f) => !f.exists).map((f) => f.url),
    byStatus: summary,
    failed,
    embeddedReferences: inv.embedded,
    unreferencedDiskFiles: inv.unreferenced.length,
  };
  writeJson(path.join(RUN_DIR, "report.json"), report);
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nReport + inventory: ${path.relative(process.cwd(), RUN_DIR)}`);
  return undefined;
}

main()
  .catch((err) => {
    console.error("❌ Migration step failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
