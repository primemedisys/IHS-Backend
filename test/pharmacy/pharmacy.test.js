/**
 * Pharmacy management (migration 043) — end-to-end API tests.
 *
 * Real HTTP, no mocks: validation → auth → role gate → service → transaction
 * → DB. The scenarios run in order and share state — one pharmacy's working
 * day: catalogue + inventory, images, batches and expiry, Excel template /
 * preview / import, suppliers + purchases, patient orders with discount and
 * GST, the bill, returns / credit notes, reports — plus ownership and role
 * checks, and the existing patient flows (browse, cart, prescription, order).
 *
 * Two ways to run:
 *   1. The project way (in-process app, LOCAL `_test` database):
 *        npm run test:db && npm test
 *   2. Against an already-running API (writes test data into THAT server's
 *      database; accounts are tagged @ihs-test.example.com and deactivated at the end):
 *        PHARMACY_E2E_BASE_URL=http://localhost:5055 node --test test/pharmacy/pharmacy.test.js
 */
const path = require("path");

const EXTERNAL = process.env.PHARMACY_E2E_BASE_URL || "";
if (!EXTERNAL) require("../testEnv");
else {
  // Only the DB connection (for assertions) and the admin login come from .env.
  process.env.NODE_ENV = "test";
  require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
}

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");

const { sequelize, User, MedicineMaster, MedicineStoreMedicine, MedicineStockBatch } = require("../../src/models");
const COLUMN_KEYS = require("../../src/services/pharmacyImport.service").COLUMNS.map((c) => c.key);

const RUN = Date.now().toString(36).toUpperCase();
const DAY_MS = 86400000;
const istDay = (offsetDays = 0) => new Date(Date.now() + 5.5 * 3600000 + offsetDays * DAY_MS).toISOString().slice(0, 10);
const round2 = (n) => Math.round(n * 100) / 100;

let server;
let base;

async function call(method, urlPath, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}/api${urlPath}`, { method, headers, body: payload });
  const type = res.headers.get("content-type") || "";
  if (type.includes("spreadsheetml")) return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json, data: json?.data };
}
const get = (p, o) => call("GET", p, o);
const post = (p, o) => call("POST", p, o);
const put = (p, o) => call("PUT", p, o);
const del = (p, o) => call("DELETE", p, o);

function expectStatus(res, status, label) {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)?.slice(0, 600)}`);
}

/** A 1×1 PNG, for image uploads. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const fileForm = (field, buffer, name, type, extra = {}) => {
  const form = new FormData();
  form.append(field, new Blob([buffer], { type }), name);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
};

const S = {};
// example.com is reserved for documentation — nothing is ever delivered there.
const email = (who) => `pharma-${who}-${RUN.toLowerCase()}@ihs-test.example.com`;

async function register(who, role, extra = {}) {
  const res = await post("/auth/register", {
    body: { name: `${who} ${RUN}`, email: email(who), password: "Pharma1234", role, phone: "9876543210", city: `Testpur${RUN}`, state: "Odisha", ...extra },
  });
  expectStatus(res, 201, `register ${who}`);
  return { id: res.data.user.id, token: res.data.tokens.accessToken };
}

before(async () => {
  await sequelize.authenticate();
  if (EXTERNAL) {
    base = EXTERNAL.replace(/\/+$/, "");
  } else {
    // eslint-disable-next-line global-require
    const app = require("../../src/app");
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;
  }
});

after(async () => {
  if (EXTERNAL) {
    // Keep the shared database clean for real users: the run's accounts and
    // catalogue entries disappear from every patient / pharmacy search.
    const ids = [S.a?.id, S.b?.id, S.patient?.id, S.lab?.id].filter(Boolean);
    if (ids.length) await User.update({ isActive: false }, { where: { id: ids } });
    await MedicineMaster.update({ isActive: false }, { where: { medicineName: { [require("sequelize").Op.like]: `%${RUN}%` } } });
  }
  if (server) await new Promise((r) => server.close(r));
  await sequelize.close();
});

describe("Pharmacy management", () => {
  it("1. accounts + pharmacy login", async () => {
    S.a = await register("store-a", "medicine_store");
    S.b = await register("hospital-b", "pharmacy_hospital");
    S.patient = await register("patient", "patient");
    S.lab = await register("lab", "diagnostic_lab");

    const login = await post("/auth/medicine/login", { body: { email: email("store-a"), password: "Pharma1234" } });
    expectStatus(login, 200, "pharmacy login");
    S.a.token = login.data.tokens.accessToken;
  });

  it("2. a new pharmacy's dashboard shows real (zero) figures", async () => {
    const res = await get("/medicine/pharmacy/dashboard", { token: S.a.token });
    expectStatus(res, 200, "dashboard");
    const c = res.data.cards;
    assert.equal(c.totalMedicines, 0);
    assert.equal(c.lowStock, 0);
    assert.equal(c.todaySales, 0);
    assert.equal(c.pendingOrders, 0);
    assert.deepEqual(res.data.recentOrders, []);
  });

  it("3–6. a catalogue medicine is reused (never duplicated); new items save without an image", async () => {
    // Pharmacy B introduces a medicine to the shared catalogue.
    const created = await post("/medicine/my-medicines", {
      token: S.b.token,
      body: { medicineName: `Zerodol-SP ${RUN}`, medicineType: "tablet", strength: "100 mg", manufacturer: "Ipca", price: 120, stock: 10 },
    });
    expectStatus(created, 201, "B creates");
    S.masterId = created.data.medicine.medicineMasterId;
    S.bItem = created.data.medicine.id;

    const mastersBefore = await MedicineMaster.count();
    const search = await get(`/medicine/masters?search=${encodeURIComponent(`zerodol-sp ${RUN.toLowerCase()}`)}`, { token: S.a.token });
    expectStatus(search, 200, "search masters");
    assert.equal(search.data.masters.length, 1, "case-insensitive search finds the one master");
    assert.equal(search.data.masters[0].inMyInventory, false);

    // A adds the SAME global medicine with its own commercial data and an opening batch — no image.
    const add = await post("/medicine/my-medicines", {
      token: S.a.token,
      body: {
        medicineMasterId: S.masterId,
        price: 250, mrp: 260, buyingPrice: 180, gstRate: 12, discountPercent: 10,
        minStock: 20, sku: `ZSP-${RUN}`, hsnCode: "30049099", packSize: "Strip of 10",
        stock: 100, batchNumber: "zsp-a1", expiryDate: istDay(400),
      },
    });
    expectStatus(add, 201, "A adds existing master");
    assert.equal(await MedicineMaster.count(), mastersBefore, "no second global medicine");
    const m = add.data.medicine;
    S.aItem = m.id;
    assert.equal(Number(m.medicineMasterId), Number(S.masterId));
    assert.equal(m.stock, 100);
    assert.equal(m.batches.length, 1);
    assert.equal(m.batches[0].batchNumber, "ZSP-A1", "batch numbers are upper-cased");
    assert.equal(m.untrackedStock, 0);
    assert.equal(m.effectivePrice, 225, "250 less 10%");
    assert.equal(m.unitMargin, round2(225 / 1.12 - 180), "margin excl. GST");
    assert.equal(m.imageUrl, null, "no image needed");

    const again = await post("/medicine/my-medicines", { token: S.a.token, body: { medicineMasterId: S.masterId, price: 1, stock: 1 } });
    expectStatus(again, 409, "duplicate inventory refused");

    // Manual entry of a brand-new medicine, minimal fields, no image.
    const manual = await post("/medicine/my-medicines", {
      token: S.a.token,
      body: { medicineName: `Paracip ${RUN}`, medicineType: "tablet", strength: "500 mg", price: 20, stock: 0 },
    });
    expectStatus(manual, 201, "manual new medicine");
    S.aOutItem = manual.data.medicine.id;
    S.paracipMaster = manual.data.medicine.medicineMasterId;
    assert.equal(manual.data.medicine.stockStatus, "out");
  });

  it("7–8. images are added later to the same medicine, replaced and removed", async () => {
    const up1 = await post(`/medicine/masters/${S.masterId}/images`, { token: S.a.token, form: fileForm("image", PNG, "strip.png", "image/png") });
    expectStatus(up1, 201, "upload image");
    const up2 = await post(`/medicine/masters/${S.masterId}/images`, { token: S.a.token, form: fileForm("image", PNG, "box.png", "image/png") });
    expectStatus(up2, 201, "upload second image");
    const [first, second] = up2.data.images;
    const reorder = await put(`/medicine/masters/${S.masterId}/images/order`, { token: S.a.token, body: { imageIds: [second.id, first.id] } });
    expectStatus(reorder, 200, "replace primary");
    const removed = await del(`/medicine/masters/${S.masterId}/images/${first.id}`, { token: S.a.token });
    expectStatus(removed, 200, "remove image");
    assert.equal(removed.data.images.length, 1);

    const list = await get(`/medicine/my-medicines?search=${encodeURIComponent(`Zerodol-SP ${RUN}`)}`, { token: S.a.token });
    assert.equal(list.data.medicines.length, 1, "still one inventory row");
    assert.ok(list.data.medicines[0].primaryImageUrl, "list shows the image");
  });

  it("9–13. stock, buying / selling price, GST and discount updates (validated)", async () => {
    const upd = await put(`/medicine/my-medicines/${S.aItem}`, {
      token: S.a.token,
      body: { buyingPrice: 175.5, price: 240, gstRate: 12, discountPercent: 10, stock: 110, stockNote: "Counted shelf" },
    });
    expectStatus(upd, 200, "update");
    const m = upd.data.medicine;
    assert.equal(Number(m.buyingPrice), 175.5);
    assert.equal(Number(m.price), 240);
    assert.equal(m.stock, 110);
    assert.equal(m.untrackedStock, 10, "the +10 correction is untracked stock");

    const tooLow = await put(`/medicine/my-medicines/${S.aItem}`, { token: S.a.token, body: { stock: 50 } });
    expectStatus(tooLow, 400, "total below batched units refused");
    const overMrp = await put(`/medicine/my-medicines/${S.aItem}`, { token: S.a.token, body: { price: 300 } });
    expectStatus(overMrp, 400, "price above MRP refused");
    assert.match(overMrp.body.error.message, /MRP/);
    const badGst = await put(`/medicine/my-medicines/${S.aItem}`, { token: S.a.token, body: { gstRate: 150 } });
    expectStatus(badGst, 422, "GST > 100 refused");
  });

  it("14–16. low stock, out of stock and expiry filters", async () => {
    const low = await put(`/medicine/my-medicines/${S.aItem}`, { token: S.a.token, body: { minStock: 200 } });
    expectStatus(low, 200, "raise reorder level");
    assert.equal(low.data.medicine.stockStatus, "low");
    let res = await get("/medicine/my-medicines?stockStatus=low", { token: S.a.token });
    assert.ok(res.data.medicines.some((x) => x.id === S.aItem), "low filter");
    res = await get("/medicine/my-medicines?stockStatus=out", { token: S.a.token });
    assert.ok(res.data.medicines.some((x) => x.id === S.aOutItem), "out filter");
    await put(`/medicine/my-medicines/${S.aItem}`, { token: S.a.token, body: { minStock: 20 } });

    // An expired batch and one expiring in 20 days on the same item.
    const expired = await post(`/medicine/pharmacy/inventory/${S.aItem}/stock`, {
      token: S.a.token,
      body: { batchNumber: "OLD-1", expiryDate: istDay(-3), quantity: 5 },
    });
    expectStatus(expired, 200, "receive expired batch");
    const soon = await post(`/medicine/pharmacy/inventory/${S.aItem}/stock`, {
      token: S.a.token,
      body: { batchNumber: "SOON-1", expiryDate: istDay(20), quantity: 4 },
    });
    expectStatus(soon, 200, "receive expiring batch");
    assert.equal(soon.data.medicine.stock, 119);
    assert.equal(soon.data.medicine.expiryStatus, "expired", "nearest batch with stock is the expired one");
    S.expiredBatchId = soon.data.medicine.batches.find((b) => b.batchNumber === "OLD-1").id;
    S.soonBatchId = soon.data.medicine.batches.find((b) => b.batchNumber === "SOON-1").id;

    res = await get("/medicine/my-medicines?expiry=expired", { token: S.a.token });
    assert.ok(res.data.medicines.some((x) => x.id === S.aItem), "expired filter");
    res = await get("/medicine/pharmacy/batches?status=expiring", { token: S.a.token });
    assert.deepEqual(res.data.batches.map((b) => b.batchNumber), ["SOON-1"]);
    res = await get("/medicine/pharmacy/batches?status=expired", { token: S.a.token });
    assert.deepEqual(res.data.batches.map((b) => b.batchNumber), ["OLD-1"]);
  });

  it("17. the Excel template follows the real schema and marks the image optional", async () => {
    const res = await get("/medicine/pharmacy/import/template", { token: S.a.token });
    expectStatus(res, 200, "template");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ["Medicines", "Instructions", "Example", "Lists"]);
    assert.equal(wb.getWorksheet("Medicines").actualRowCount, 1, "the imported sheet starts empty (examples live on their own sheet)");
    const headers = wb.getWorksheet("Medicines").getRow(1).values.filter(Boolean);
    for (const h of ["Medicine Name *", "Medicine Type *", "Selling Price (incl. GST) *", "Stock Quantity *", "Buying Price (excl. GST)", "GST %", "Discount %", "Batch Number", "Expiry Date", "Supplier", "MRP"]) {
      assert.ok(headers.includes(h), `template has ${h}`);
    }
    assert.ok(!headers.some((h) => /image/i.test(h)), "no image column");
    const instructions = [];
    wb.getWorksheet("Instructions").eachRow((row) => instructions.push(row.values.join(" ")));
    assert.ok(instructions.some((l) => /Medicine Image/.test(l) && /Optional/.test(l)), "image documented as optional");
    S.template = res.buffer;
  });

  it("18–25. Excel preview validates every row and writes nothing; import is safe and idempotent", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(S.template);
    const sheet = wb.getWorksheet("Medicines");
    // Column keys are not stored in a file; give the loaded sheet the template's keys.
    COLUMN_KEYS.forEach((key, i) => {
      sheet.getColumn(i + 1).key = key;
    });
    const row = (o) => sheet.addRow({ quantity: 0, medicineType: "tablet", ...o });
    row({ medicineName: `Zerodol-SP ${RUN}`, strength: "100 MG", price: 230, quantity: 77, batchNumber: "XL-1", expiryDate: "05/2030", supplier: `Shree ${RUN}` }); // r2 existing in A → skip/update
    row({ medicineName: `Pantop ${RUN}`, strength: "40 mg", medicineType: "Tablet", price: "₹140", mrp: 155, buyingPrice: 98, gstRate: "12%", discountPercent: 0, quantity: 60, minStock: 15, batchNumber: "PN-1", expiryDate: "2029-11-30", packSize: "Strip of 15" }); // r3 new medicine
    row({ medicineName: `Pantop ${RUN}`, strength: "40 mg", price: 140, quantity: 30, batchNumber: "PN-2", expiryDate: "31-12-2030" }); // r4 second batch
    row({ medicineName: `Pantop ${RUN}`, strength: "40 mg", price: 140, quantity: 5, batchNumber: "PN-1", expiryDate: "2029-11-30" }); // r5 duplicate of r3
    row({ medicineName: `Badgst ${RUN}`, price: 10, gstRate: 150, quantity: 1 }); // r6 GST > 100
    row({ medicineName: `Baddate ${RUN}`, price: 10, quantity: 1, batchNumber: "B-1", expiryDate: "31/31/2030" }); // r7 bad date
    row({ medicineName: `Nobatch ${RUN}`, price: 10, quantity: 1, expiryDate: "2030-01-01" }); // r8 expiry without batch
    row({ medicineName: `Price ${RUN}`, price: "abc", quantity: 1 }); // r9 bad price
    row({ medicineName: `Negative ${RUN}`, price: 10, quantity: -4 }); // r10 negative stock
    row({ medicineName: `Plain ${RUN}`, medicineType: "syrup", price: 55, quantity: 12 }); // r11 no image, no batch → fine
    const file = Buffer.from(await wb.xlsx.writeBuffer());
    const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    const inventoryBefore = await MedicineStoreMedicine.count({ where: { providerId: S.a.id } });
    const preview = await post("/medicine/pharmacy/import/preview", { token: S.a.token, form: fileForm("file", file, "stock.xlsx", XLSX) });
    expectStatus(preview, 200, "preview");
    const p = preview.data;
    assert.equal(p.summary.totalRows, 10);
    assert.equal(p.summary.errorRows, 6, JSON.stringify(p.rows.filter((r) => r.status === "error")));
    assert.equal(await MedicineStoreMedicine.count({ where: { providerId: S.a.id } }), inventoryBefore, "preview writes nothing");
    const byRow = new Map(p.rows.map((r) => [r.row, r]));
    assert.equal(byRow.get(2).action, "skip");
    assert.match(byRow.get(2).messages.join(" "), /already exists in your inventory/);
    assert.equal(byRow.get(3).action, "create");
    assert.match(byRow.get(5).messages.join(" "), /Duplicate of row 3/);
    assert.match(byRow.get(6).messages.join(" "), /GST % must be less than or equal to 100/);
    assert.match(byRow.get(7).messages.join(" "), /Expiry Date is not a real date/);
    assert.match(byRow.get(8).messages.join(" "), /Batch Number is required when an Expiry Date is given/);
    assert.match(byRow.get(9).messages.join(" "), /Selling Price \(incl\. GST\) must be a valid number/);
    assert.match(byRow.get(10).messages.join(" "), /Stock Quantity must be greater than or equal to 0/);
    assert.equal(byRow.get(11).status, "valid");

    const imported = await post("/medicine/pharmacy/import", { token: S.a.token, form: fileForm("file", file, "stock.xlsx", XLSX, { duplicateStrategy: "skip" }) });
    expectStatus(imported, 200, "import");
    assert.deepEqual(
      { imported: imported.data.summary.imported, skipped: imported.data.summary.skipped, failed: imported.data.summary.failed },
      { imported: 3, skipped: 1, failed: 6 }
    );
    const pantop = await MedicineStoreMedicine.findOne({ where: { providerId: S.a.id, medicineName: `Pantop ${RUN}` } });
    assert.ok(pantop, "new medicine imported");
    assert.equal(pantop.stock, 90, "two batches 60 + 30");
    assert.equal(String(pantop.batchNumber), "PN-1", "nearest-expiry summary");
    assert.equal(Number(pantop.gstRate), 12);
    assert.equal(Number(pantop.price), 140, "₹ and % symbols parsed");
    assert.equal(pantop.minStock, 15);
    S.pantopItem = pantop.id;
    S.pantopMaster = pantop.medicineMasterId;
    const plain = await MedicineStoreMedicine.findOne({ where: { providerId: S.a.id, medicineName: `Plain ${RUN}` } });
    assert.equal(plain.stock, 12);
    assert.equal(plain.imageUrl, null, "imported without an image");
    const zsp = await MedicineStoreMedicine.findByPk(S.aItem);
    assert.equal(zsp.stock, 119, "skipped row did not touch the existing item");

    // Re-import with "update existing": the existing item's prices/stock are SET, new rows re-applied without doubling.
    const update = await post("/medicine/pharmacy/import", { token: S.a.token, form: fileForm("file", file, "stock.xlsx", XLSX, { duplicateStrategy: "update" }) });
    expectStatus(update, 200, "import (update)");
    await pantop.reload();
    assert.equal(pantop.stock, 90, "idempotent: re-import does not double stock");
    await zsp.reload();
    assert.equal(Number(zsp.price), 230, "existing item updated");
    assert.equal(zsp.stock, 119 + 77, "new batch XL-1 set to 77");
    assert.equal(await MedicineStoreMedicine.count({ where: { providerId: S.a.id, medicineMasterId: S.masterId } }), 1, "no duplicate inventory row");
    const supplier = await get(`/medicine/pharmacy/suppliers?search=${encodeURIComponent(`Shree ${RUN}`)}`, { token: S.a.token });
    assert.equal(supplier.data.suppliers.length, 1, "supplier from the sheet created once");

    // Bad file types are refused with a clear message.
    const notExcel = await post("/medicine/pharmacy/import/preview", { token: S.a.token, form: fileForm("file", Buffer.from("hello"), "x.pdf", "application/pdf") });
    expectStatus(notExcel, 400, "pdf refused");
  });

  it("26. an image added after import attaches to the imported medicine (no duplicate)", async () => {
    const up = await post(`/medicine/masters/${S.pantopMaster}/images`, { token: S.a.token, form: fileForm("image", PNG, "pantop.png", "image/png") });
    expectStatus(up, 201, "image after import");
    assert.equal(await MedicineStoreMedicine.count({ where: { providerId: S.a.id, medicineMasterId: S.pantopMaster } }), 1);
  });

  it("27–28. purchases: supplier invoice → batches + stock IN; totals computed by the server; cancel reverses", async () => {
    const sup = await post("/medicine/pharmacy/suppliers", { token: S.a.token, body: { name: `Om Pharma ${RUN}`, phone: "9811111111", gstin: "21ABCDE1234F1Z5" } });
    expectStatus(sup, 201, "supplier");
    S.supplierId = sup.data.supplier.id;
    const dupSup = await post("/medicine/pharmacy/suppliers", { token: S.a.token, body: { name: `om pharma ${RUN}` } });
    expectStatus(dupSup, 409, "duplicate supplier name");

    const pantopBefore = (await MedicineStoreMedicine.findByPk(S.pantopItem)).stock;
    const purchase = await post("/medicine/pharmacy/purchases", {
      token: S.a.token,
      body: {
        supplierId: S.supplierId,
        invoiceNumber: `INV-${RUN}`,
        invoiceDate: istDay(0),
        items: [
          { inventoryId: S.pantopItem, batchNumber: "PN-3", expiryDate: istDay(700), quantity: 50, freeQuantity: 5, buyingPrice: 90, gstRate: 12, discountPercent: 10, mrp: 155 },
          { medicineMasterId: S.paracipMaster, quantity: 100, buyingPrice: 1.5, gstRate: 12, sellingPrice: 2.5 }, // already in A (Paracip) → reused
        ],
      },
    });
    expectStatus(purchase, 201, "purchase");
    const pu = purchase.data.purchase;
    // line 1: 50 × 90 = 4500, −10% = 4050, +12% = 486 → 4536; line 2: 150 + 18 = 168
    assert.equal(pu.subtotal, 4650);
    assert.equal(pu.discountTotal, 450);
    assert.equal(pu.taxableTotal, 4200);
    assert.equal(pu.gstTotal, 504);
    assert.equal(pu.totalAmount, 4704);
    assert.match(pu.purchaseNumber, /^PO-\d{8}-\d{6}$/);
    S.purchaseId = pu.id;
    const pantop = await MedicineStoreMedicine.findByPk(S.pantopItem);
    assert.equal(pantop.stock, pantopBefore + 55, "stock + quantity + free");
    assert.equal(Number(pantop.buyingPrice), 90);
    assert.equal(Number(pantop.supplierId), Number(S.supplierId));
    const paracip = await MedicineStoreMedicine.findByPk(S.aOutItem);
    assert.equal(paracip.stock, 100, "purchase of an existing catalogue medicine reused A's own row");
    assert.equal(Number(paracip.price), 2.5);

    const dup = await post("/medicine/pharmacy/purchases", {
      token: S.a.token,
      body: { supplierId: S.supplierId, invoiceNumber: `inv-${RUN}`, invoiceDate: istDay(0), items: [{ inventoryId: S.pantopItem, quantity: 1, buyingPrice: 1 }] },
    });
    expectStatus(dup, 409, "same invoice twice");

    const list = await get(`/medicine/pharmacy/purchases?supplierId=${S.supplierId}&search=Pantop`, { token: S.a.token });
    assert.equal(list.data.purchases.length, 1, "purchase list filters by supplier + medicine");

    // A throwaway purchase, cancelled: stock goes back out of its batch.
    const temp = await post("/medicine/pharmacy/purchases", {
      token: S.a.token,
      body: { supplierId: S.supplierId, invoiceNumber: `TMP-${RUN}`, invoiceDate: istDay(0), items: [{ inventoryId: S.pantopItem, batchNumber: "TMP", quantity: 7, buyingPrice: 90 }] },
    });
    expectStatus(temp, 201, "temp purchase");
    const cancel = await post(`/medicine/pharmacy/purchases/${temp.data.purchase.id}/cancel`, { token: S.a.token });
    expectStatus(cancel, 200, "cancel purchase");
    assert.equal(cancel.data.purchase.status, "cancelled");
    assert.equal((await MedicineStoreMedicine.findByPk(S.pantopItem)).stock, pantopBefore + 55);
    const again = await post(`/medicine/pharmacy/purchases/${temp.data.purchase.id}/cancel`, { token: S.a.token });
    expectStatus(again, 409, "cancel twice");
  });

  it("29–31. a patient order: discount + GST priced by the server, stock FEFO, expired stock never sold", async () => {
    // Existing patient browse shows the discounted price and never the pharmacy's cost.
    const browse = await get(`/medicine/browse?search=${encodeURIComponent(`Zerodol-SP ${RUN}`)}`);
    expectStatus(browse, 200, "browse");
    const listing = browse.data.medicines.find((x) => x.id === S.aItem);
    assert.ok(listing, "A's listing is public");
    assert.equal(listing.effectivePrice, 207, "230 less 10%");
    for (const key of ["buyingPrice", "supplierId", "minStock", "sku", "batchNumber", "expiryDate"]) {
      assert.ok(!(key in listing), `browse hides ${key}`);
    }
    const detail = await get(`/medicine/medicine/${S.aItem}`);
    assert.ok(!("buyingPrice" in detail.data.medicine), "detail hides buying price");

    const cart = await post("/medicine/cart/items", { token: S.patient.token, body: { medicineId: S.aItem, quantity: 3 } });
    expectStatus(cart, 201, "add to cart");
    const line = cart.data.cart.items[0];
    assert.equal(line.lineTotal, round2(230 * 3 * 0.9), "cart shows what will be charged");

    const before = await MedicineStoreMedicine.findByPk(S.aItem);
    const checkout = await post("/medicine/orders/checkout", {
      token: S.patient.token,
      body: { paymentMethod: "cod", deliveryAddress: "12 Test Lane, Testpur", deliveryCity: `Testpur${RUN}`, deliveryState: "Odisha" },
    });
    expectStatus(checkout, 201, "checkout");
    const group = checkout.data.groups[0];
    S.orderId = group.id;
    assert.equal(group.subtotal, 690);
    assert.equal(group.discountTotal, 69);
    assert.equal(group.totalAmount, 621);
    assert.equal(group.taxableTotal, round2(621 / 1.12));
    assert.equal(group.gstTotal, round2(621 - round2(621 / 1.12)));
    assert.ok(!("unitCost" in group.items[0]), "patient never sees cost");

    // Units left untracked stock first (10), then the in-date batches by expiry — never OLD-1.
    const after = await MedicineStoreMedicine.findByPk(S.aItem);
    assert.equal(after.stock, before.stock - 3);
    const oldBatch = await MedicineStockBatch.findByPk(S.expiredBatchId);
    assert.equal(oldBatch.quantityAvailable, 5, "expired batch untouched");
  });

  it("expired-only stock cannot be ordered", async () => {
    const item = await post("/medicine/my-medicines", {
      token: S.a.token,
      body: { medicineName: `Expiro ${RUN}`, medicineType: "syrup", price: 50, stock: 3, batchNumber: "EXP-OLD", expiryDate: istDay(-1) },
    });
    expectStatus(item, 201, "item with only expired stock");
    const res = await post("/medicine/orders", {
      token: S.patient.token,
      body: { medicineId: item.data.medicine.id, quantity: 1, paymentMethod: "cod", deliveryAddress: "12 Test Lane, Testpur" },
    });
    expectStatus(res, 400, "expired stock refused");
    assert.equal(res.body.error.code, "STOCK_UNAVAILABLE");
    assert.match(res.body.error.message, /within expiry/);
    S.expiroItem = item.data.medicine.id;
  });

  it("30–32. the pharmacy sees the order (patient, items, payment), filters it, moves it to delivered", async () => {
    const list = await get(`/medicine/orders/groups/provider?search=${encodeURIComponent(`patient ${RUN}`)}`, { token: S.a.token });
    expectStatus(list, 200, "provider orders");
    const order = list.data.orders.find((o) => o.id === S.orderId);
    assert.ok(order, "found by patient name");
    assert.equal(order.patient.name, `patient ${RUN}`);
    assert.ok(!("email" in order.patient), "no unnecessary patient data");
    assert.equal(order.items[0].quantity, 3);
    assert.equal(Number(order.items[0].unitCost), 175.5, "pharmacy sees its cost snapshot");
    assert.equal(order.paymentMethod, "cod");
    const byNumber = await get(`/medicine/orders/groups/provider?search=${order.orderNumber}&paymentStatus=pending`, { token: S.a.token });
    assert.equal(byNumber.data.orders.length, 1);
    const byMedicine = await get(`/medicine/orders/groups/provider?medicineId=${S.aItem}&from=${istDay(0)}&to=${istDay(0)}`, { token: S.a.token });
    assert.ok(byMedicine.data.orders.some((o) => o.id === S.orderId));

    const bad = await put(`/medicine/orders/groups/${S.orderId}/status`, { token: S.a.token, body: { status: "delivered" } });
    expectStatus(bad, 400, "no skipping steps");
    for (const status of ["confirmed", "processing", "shipped", "on_the_way", "delivered"]) {
      const res = await put(`/medicine/orders/groups/${S.orderId}/status`, { token: S.a.token, body: { status } });
      expectStatus(res, 200, `→ ${status}`);
    }
    const mine = await get(`/medicine/orders/groups/${S.orderId}`, { token: S.patient.token });
    assert.equal(mine.data.order.status, "delivered", "patient sees the status");
  });

  it("33–36. the bill: store GSTIN, per-line discount / GST / batch, totals, COD paid on delivery", async () => {
    const settings = await put("/medicine/pharmacy/settings", {
      token: S.a.token,
      body: { gstin: "21abcde1234f1z5", drugLicenseNumber: `DL-${RUN}`, expiryAlertDays: 60, invoiceNote: "Thank you" },
    });
    expectStatus(settings, 200, "settings");
    assert.equal(settings.data.store.gstin, "21ABCDE1234F1Z5");
    const badGstin = await put("/medicine/pharmacy/settings", { token: S.a.token, body: { gstin: "12345" } });
    expectStatus(badGstin, 422, "invalid GSTIN");

    const inv = await get(`/medicine/orders/groups/${S.orderId}/invoice`, { token: S.patient.token });
    expectStatus(inv, 200, "invoice");
    const b = inv.data.invoice;
    assert.equal(b.store.gstin, "21ABCDE1234F1Z5");
    assert.equal(b.store.drugLicenseNumber, `DL-${RUN}`);
    assert.equal(b.paymentStatus, "paid", "COD settled on delivery");
    assert.equal(b.gstRecorded, true);
    const l = b.lines[0];
    assert.equal(l.unitPrice, 230);
    assert.equal(l.discountAmount, 69);
    assert.equal(l.lineTotal, 621);
    assert.equal(l.gstRate, 12);
    assert.equal(round2(l.taxableAmount + l.gstAmount), 621);
    // The 3 units came from the 10 untracked units first (oldest stock), so no batch is printed.
    assert.deepEqual(l.batches, [], "sold from untracked stock");
    assert.deepEqual(b.gstSummary, [{ gstRate: 12, taxableAmount: l.taxableAmount, gstAmount: l.gstAmount }]);
    assert.equal(b.total, 621);

    const payments = await get("/medicine/pharmacy/payments", { token: S.a.token });
    const pay = payments.data.payments.find((p) => p.orderGroupId === S.orderId);
    assert.equal(pay.status, "success");
    assert.match(pay.reference, /^COD-/);
  });

  it("returns / credit notes: proportional refund, restock to the same batch, refunded when complete", async () => {
    const { order } = (await get(`/medicine/orders/groups/${S.orderId}`, { token: S.a.token })).data;
    const lineId = order.items[0].id;
    const stockBefore = (await MedicineStoreMedicine.findByPk(S.aItem)).stock;

    const over = await post(`/medicine/pharmacy/orders/${S.orderId}/returns`, { token: S.a.token, body: { items: [{ orderLineId: lineId, quantity: 4 }] } });
    expectStatus(over, 400, "cannot return more than sold");

    const r1 = await post(`/medicine/pharmacy/orders/${S.orderId}/returns`, {
      token: S.a.token,
      body: { items: [{ orderLineId: lineId, quantity: 1 }], reason: "Wrong strength", restock: true },
    });
    expectStatus(r1, 201, "return 1");
    assert.match(r1.data.return.creditNoteNumber, /^CN-\d{8}-\d{6}$/);
    assert.equal(r1.data.return.refundAmount, 207);
    assert.equal((await MedicineStoreMedicine.findByPk(S.aItem)).stock, stockBefore + 1, "restocked");

    const r2 = await post(`/medicine/pharmacy/orders/${S.orderId}/returns`, { token: S.a.token, body: { items: [{ orderLineId: lineId, quantity: 2 }], restock: false } });
    expectStatus(r2, 201, "return rest (not restocked)");
    assert.equal(round2(r1.data.return.refundAmount + r2.data.return.refundAmount), 621, "credit notes add up to the line to the paisa");
    assert.equal((await MedicineStoreMedicine.findByPk(S.aItem)).stock, stockBefore + 1, "damaged units not restocked");

    const after = await get(`/medicine/orders/groups/${S.orderId}/invoice`, { token: S.patient.token });
    assert.equal(after.data.invoice.paymentStatus, "refunded");
    assert.equal(after.data.invoice.refundedTotal, 621);
    assert.equal(after.data.invoice.netAfterReturns, 0);
    const list = await get("/medicine/pharmacy/returns", { token: S.a.token });
    assert.ok(list.data.returns.length >= 2);
    const stillVisible = await get(`/medicine/orders/groups/provider?search=${order.orderNumber}`, { token: S.a.token });
    assert.equal(stillVisible.data.orders.length, 1, "refunded order stays in the pharmacy's list");
  });

  it("cancel and reject put units back on exactly the batches they left", async () => {
    const batchesBefore = (await MedicineStockBatch.findAll({ where: { inventoryId: S.pantopItem }, order: [["id", "ASC"]] })).map((b) => b.quantityAvailable);
    const stockBefore = (await MedicineStoreMedicine.findByPk(S.pantopItem)).stock;

    const place = (qty) =>
      post("/medicine/orders", { token: S.patient.token, body: { medicineId: S.pantopItem, quantity: qty, paymentMethod: "cod", deliveryAddress: "12 Test Lane, Testpur" } });
    const o1 = await place(70); // spans two batches
    expectStatus(o1, 201, "order 70");
    assert.equal((await MedicineStoreMedicine.findByPk(S.pantopItem)).stock, stockBefore - 70);
    // First-expiry-first-out: PN-3 (exp ~700 days) before PN-1 (2029-11-30) before PN-2 (2030-12-31).
    const bill = await get(`/medicine/orders/groups/${o1.data.group.id}/invoice`, { token: S.patient.token });
    assert.deepEqual(
      bill.data.invoice.lines[0].batches.map((b) => [b.batchNumber, b.quantity]),
      [["PN-3", 55], ["PN-1", 15]],
      "the bill prints the batches the units came from"
    );
    const cancel = await put(`/medicine/orders/groups/${o1.data.group.id}/cancel`, { token: S.patient.token });
    expectStatus(cancel, 200, "patient cancels");

    const o2 = await place(5);
    const reject = await put(`/medicine/orders/groups/${o2.data.group.id}/status`, { token: S.a.token, body: { status: "rejected" } });
    expectStatus(reject, 200, "pharmacy rejects");

    // Simulated online payment: a failure cancels the order and restores stock;
    // the pharmacy only sees an online order once it is paid.
    const online = (qty) =>
      post("/medicine/orders", { token: S.patient.token, body: { medicineId: S.pantopItem, quantity: qty, paymentMethod: "online", deliveryAddress: "12 Test Lane, Testpur" } });
    const failed = await online(3);
    expectStatus(failed, 201, "online order");
    const hidden = await get(`/medicine/orders/groups/provider?search=${failed.data.group.orderNumber}`, { token: S.a.token });
    assert.equal(hidden.data.orders.length, 0, "unpaid online order not shown to the pharmacy");
    const decline = await post(`/medicine/orders/groups/${failed.data.group.id}/pay`, { token: S.patient.token, body: { outcome: "failure", idempotencyKey: `fail-${RUN}` } });
    expectStatus(decline, 400, "simulated decline");
    assert.equal(decline.body.error.code, "PAYMENT_FAILED");
    const paid = await online(2);
    const pay = await post(`/medicine/orders/groups/${paid.data.group.id}/pay`, { token: S.patient.token, body: { outcome: "success", idempotencyKey: `ok-${RUN}` } });
    expectStatus(pay, 200, "simulated payment");
    const replay = await post(`/medicine/orders/groups/${paid.data.group.id}/pay`, { token: S.patient.token, body: { outcome: "success", idempotencyKey: `ok-${RUN}` } });
    expectStatus(replay, 200, "replay is a no-op");
    assert.equal(replay.data.alreadySettled, true);
    const shown = await get(`/medicine/orders/groups/provider?search=${paid.data.group.orderNumber}&paymentStatus=paid`, { token: S.a.token });
    assert.equal(shown.data.orders.length, 1, "paid online order visible");
    const cancelPaid = await put(`/medicine/orders/groups/${paid.data.group.id}/cancel`, { token: S.patient.token });
    expectStatus(cancelPaid, 200, "cancel paid order");

    const batchesAfter = (await MedicineStockBatch.findAll({ where: { inventoryId: S.pantopItem }, order: [["id", "ASC"]] })).map((b) => b.quantityAvailable);
    assert.deepEqual(batchesAfter, batchesBefore, "every batch back to where it was");
    assert.equal((await MedicineStoreMedicine.findByPk(S.pantopItem)).stock, stockBefore);

    const history = await get(`/medicine/pharmacy/inventory/${S.pantopItem}/movements?limit=100`, { token: S.a.token });
    const types = new Set(history.data.movements.map((m) => m.movementType));
    for (const t of ["import", "purchase", "purchase_cancel", "sale", "sale_reversal"]) assert.ok(types.has(t), `history has ${t}`);
  });

  it("prescription workflow still works end to end (quote = discounted price)", async () => {
    const share = await post("/medicine/prescriptions", {
      token: S.patient.token,
      form: fileForm("prescription", PNG, "rx.png", "image/png", { providerIds: String(S.a.id) }),
    });
    expectStatus(share, 201, "share prescription");
    const incoming = await get("/medicine/prescriptions/provider-requests", { token: S.a.token });
    const request = incoming.data.requests.find((r) => Number(r.patientId) === Number(S.patient.id));
    assert.ok(request, "pharmacy receives it");
    const answer = await put(`/medicine/prescriptions/${request.id}/availability`, {
      token: S.a.token,
      body: { items: [{ status: "available", medicineId: S.aItem, quantity: 2 }, { status: "unavailable", medicineName: "Rare drug", reason: "Not stocked" }] },
    });
    expectStatus(answer, 200, "availability");
    const offered = answer.data.request.items.find((i) => i.status === "available");
    assert.equal(Number(offered.price), 207, "quoted at the price the patient will pay");
    const order = await post(`/medicine/prescriptions/${request.id}/order`, {
      token: S.patient.token,
      body: { items: [{ itemId: offered.id, quantity: 2 }], paymentMethod: "cod", deliveryAddress: "12 Test Lane, Testpur" },
    });
    expectStatus(order, 201, "order from prescription");
    assert.equal(order.data.groups[0].totalAmount, 414);
    assert.equal(order.data.groups[0].prescriptionRequestId, Number(request.id));
  });

  it("37–41. reports from real data: sales, top medicines, purchases, GST, stock, low stock, expiry", async () => {
    const q = `from=${istDay(-1)}&to=${istDay(0)}`;
    const sales = await get(`/medicine/pharmacy/reports/sales?${q}&groupBy=day`, { token: S.a.token });
    expectStatus(sales, 200, "sales");
    assert.equal(sales.data.series.length, 2, "one bucket per day, zero-filled");
    assert.ok(sales.data.totals.orders >= 2, "delivered + prescription order");
    assert.ok(sales.data.totals.net >= 621 + 414);
    assert.equal(sales.data.totals.refunds, 621);
    assert.ok(sales.data.grossMargin.costedLines >= 1);
    for (const g of ["week", "month"]) {
      const r = await get(`/medicine/pharmacy/reports/sales?${q}&groupBy=${g}`, { token: S.a.token });
      expectStatus(r, 200, `sales by ${g}`);
      assert.equal(r.data.totals.net, sales.data.totals.net, `${g} roll-up adds up`);
    }
    const tooWide = await get(`/medicine/pharmacy/reports/sales?from=2020-01-01&to=${istDay(0)}`, { token: S.a.token });
    expectStatus(tooWide, 400, "range capped");

    const top = await get(`/medicine/pharmacy/reports/top-medicines?${q}`, { token: S.a.token });
    assert.equal(top.data.medicines[0].medicineId, S.aItem);

    const purchases = await get(`/medicine/pharmacy/reports/purchases?${q}`, { token: S.a.token });
    assert.equal(purchases.data.totals.total, 4704, "cancelled purchase excluded");
    assert.equal(purchases.data.bySupplier[0].supplierName, `Om Pharma ${RUN}`);

    const gst = await get(`/medicine/pharmacy/reports/gst?${q}`, { token: S.a.token });
    expectStatus(gst, 200, "gst");
    assert.equal(gst.data.totals.inputGst, 504);
    assert.ok(gst.data.totals.outputGst > 0);
    assert.ok(gst.data.totals.returnGst > 0);

    const stock = await get("/medicine/pharmacy/reports/stock", { token: S.a.token });
    assert.ok(stock.data.summary.stockValueAtCost > 0);
    assert.ok(stock.data.summary.expiredBatches >= 1);

    const dash = await get("/medicine/pharmacy/dashboard", { token: S.a.token });
    assert.ok(dash.data.cards.todayOrders >= 2);
    assert.equal(dash.data.cards.expiryAlertDays, 60, "the pharmacy's own window");
    assert.ok(dash.data.recentPurchases.length >= 1);
  });

  it("expired stock can be written off; it then leaves the sellable total", async () => {
    const before = (await MedicineStoreMedicine.findByPk(S.aItem)).stock;
    const res = await post("/medicine/pharmacy/batches/write-off-expired", { token: S.a.token, body: { inventoryId: S.aItem } });
    expectStatus(res, 200, "write off");
    assert.equal(res.data.units, 5);
    assert.equal((await MedicineStoreMedicine.findByPk(S.aItem)).stock, before - 5);
    const batch = await put(`/medicine/pharmacy/inventory/${S.aItem}/batches/${S.soonBatchId}`, { token: S.a.token, body: { quantityAvailable: 2, note: "Damaged strips" } });
    expectStatus(batch, 200, "batch correction");
    assert.equal(batch.data.medicine.batches.find((x) => x.id === S.soonBatchId).quantityAvailable, 2);
  });

  it("42–44. ownership + roles: another pharmacy, a patient, a lab and anonymous are all kept out", async () => {
    const t = S.b.token;
    expectStatus(await get(`/medicine/my-medicines/${S.aItem}`, { token: t }), 404, "B reads A's item");
    expectStatus(await put(`/medicine/my-medicines/${S.aItem}`, { token: t, body: { price: 1 } }), 404, "B edits A's price");
    expectStatus(await post(`/medicine/pharmacy/inventory/${S.aItem}/stock`, { token: t, body: { quantity: 1 } }), 404, "B adds A's stock");
    expectStatus(await put(`/medicine/pharmacy/inventory/${S.aItem}/batches/${S.soonBatchId}`, { token: t, body: { quantityAvailable: 0 } }), 404, "B edits A's batch");
    expectStatus(await get(`/medicine/pharmacy/inventory/${S.aItem}/movements`, { token: t }), 404, "B reads A's history");
    expectStatus(await get(`/medicine/pharmacy/purchases/${S.purchaseId}`, { token: t }), 404, "B reads A's purchase");
    expectStatus(await post(`/medicine/pharmacy/purchases/${S.purchaseId}/cancel`, { token: t }), 404, "B cancels A's purchase");
    expectStatus(await get(`/medicine/pharmacy/suppliers/${S.supplierId}`, { token: t }), 404, "B reads A's supplier");
    expectStatus(await post(`/medicine/pharmacy/orders/${S.orderId}/returns`, { token: t, body: { items: [{ orderLineId: 1, quantity: 1 }] } }), 404, "B returns A's order");
    expectStatus(await get(`/medicine/orders/groups/${S.orderId}`, { token: t }), 403, "B reads A's order");
    const bPurchase = await post("/medicine/pharmacy/purchases", {
      token: t,
      body: { invoiceNumber: `X-${RUN}`, invoiceDate: istDay(0), items: [{ inventoryId: S.aItem, quantity: 1, buyingPrice: 1 }] },
    });
    expectStatus(bPurchase, 404, "B purchases into A's inventory");
    const bSupplier = await post("/medicine/pharmacy/suppliers", { token: t, body: { name: `B Sup ${RUN}` } });
    expectStatus(await put(`/medicine/my-medicines/${S.aItem}`, { token: S.a.token, body: { supplierId: bSupplier.data.supplier.id } }), 400, "A cannot use B's supplier");
    const bReports = await get("/medicine/pharmacy/reports/stock", { token: t });
    assert.ok(bReports.data.summary.totalUnits < 100, "B's reports contain only B's stock");

    for (const [who, token] of [["patient", S.patient.token], ["lab", S.lab.token]]) {
      expectStatus(await get("/medicine/pharmacy/dashboard", { token }), 403, `${who} → pharmacy dashboard`);
      expectStatus(await get("/medicine/my-medicines", { token }), 403, `${who} → inventory`);
      expectStatus(await post("/medicine/pharmacy/import/preview", { token }), 403, `${who} → import`);
    }
    expectStatus(await get("/medicine/pharmacy/dashboard"), 401, "anonymous");
    const myOrders = await get("/medicine/orders/my-orders", { token: S.patient.token });
    assert.ok(myOrders.data.orders.every((o) => !("unitCost" in o)), "legacy line view hides cost from patients");
  });

  it("45. admin pharmacy tracking still works", async () => {
    const adminEmail = EXTERNAL ? process.env.ADMIN_EMAIL : process.env.ADMIN_EMAIL || "admin@ihs-test.local";
    const adminPassword = EXTERNAL ? process.env.ADMIN_PASSWORD : process.env.ADMIN_PASSWORD || "TestAdmin#2026";
    const login = await post("/auth/admin/login", { body: { email: adminEmail, password: adminPassword } });
    expectStatus(login, 200, "admin login");
    const token = login.data.tokens.accessToken;
    for (const p of ["/admin/medicine/overview", "/admin/medicine/inventory?stock=low", "/admin/medicine/orders", "/admin/medicine/pharmacies"]) {
      expectStatus(await get(p, { token }), 200, p);
    }
    expectStatus(await get("/medicine/pharmacy/dashboard", { token }), 403, "admin is not a pharmacy");
  });
});
