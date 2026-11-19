# API Reference - Medicine marketplace and pharmacy (`/api/medicine/*`)

Conventions that apply to every table below:

* Paths are shown with the mount prefix already applied (`/api` = `API_PREFIX`). Auth column: the role(s) admitted by `authenticate` + `authorize(...)`; "Public" = no `authenticate`. Rate limiting: every route also passes the global limiter (reads by a signed-in user: `READ_RATE_LIMIT_MAX` per user; writes and anonymous traffic: `RATE_LIMIT_MAX`); route-specific limiters are named in the "Validation / middleware" column.
* "body: X" / "query: X" / "params: X" name the Joi schema applied (`validate`, `validateQuery` -> `req.validatedQuery`). Unknown keys are stripped, values coerced; failures are `422 VALIDATION_ERROR` with `details` per field.
* Success envelope `{ success, message, data }`; errors `{ error: { message, code, details? } }`. Binary/stream routes (PDF, files) return the bytes directly.
* The tables were generated from the router source by a static scan (route registration order preserved within each file). Route-ordering caveat: where a literal path (e.g. `/order`, `/count`) shares a prefix with a `/:id` route the literal one is declared first in the source.

Provider roles ("medicine provider") = `medicine_store`, `pharmacy_hospital` and legacy `mr` (`ALL_MEDICINE_PROVIDER_ROLES`). New business (patient search, cart, checkout, prescription sharing, registration) uses only the two active roles; `mr` keeps read/own-data access.

Notes:

* One **cart** per patient (`/medicine/cart`); price, stock and provider are always read live from the inventory row, never from the client.
* **Checkout** (`POST /medicine/orders/checkout`) creates one `medicine_order_groups` row per pharmacy; lines are `medicine_orders`. Payment methods: `cod`, `upi_qr` (pharmacy confirms receipt with `POST /orders/groups/:id/payment/confirm-received`), `online` (**simulated**, refused when `NODE_ENV=production`).
* Status transitions follow `MEDICINE_ORDER_TRANSITIONS`: pending -> confirmed | rejected; confirmed -> processing; processing -> shipped; shipped -> on_the_way | delivered; on_the_way -> delivered. A patient may cancel only from pending or confirmed (stock returns).
* `/medicine/pharmacy/*` is every pharmacy-management function (stock, batches, suppliers, purchases, returns, GST reports, Excel import/export, store settings, own UPI QR).
* Route-order caveats visible in the source: `/orders/groups/my`, `/groups/provider` and other literal paths are declared before `/groups/:id` / `/:id`.


### `routes/medicineCart.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/medicine/cart` | patient | - | `cartController.getCart` |
| GET | `/api/medicine/cart/count` | patient | - | `cartController.getCount` |
| GET | `/api/medicine/cart/payment-options` | patient | - | `cartController.getPaymentOptions` |
| POST | `/api/medicine/cart/items` | patient | body: cartValidator.addItem | `cartController.addItem` |
| PUT | `/api/medicine/cart/items/:id` | patient | body: cartValidator.updateItem | `cartController.updateItem` |
| DELETE | `/api/medicine/cart/items/:id` | patient | - | `cartController.removeItem` |
| DELETE | `/api/medicine/cart` | patient | - | `cartController.clear` |

### `routes/medicineNotification.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/medicine/notifications` | any notified role (patient, doctor, medicine providers, diagnostic_lab, blood_bank, ambulance_provider) | - | `medicineNotificationController.listByUser` |
| GET | `/api/medicine/notifications/unread-count` | any notified role (patient, doctor, medicine providers, diagnostic_lab, blood_bank, ambulance_provider) | - | `medicineNotificationController.getUnreadCount` |
| PUT | `/api/medicine/notifications/:id/read` | any notified role (patient, doctor, medicine providers, diagnostic_lab, blood_bank, ambulance_provider) | - | `medicineNotificationController.markAsRead` |
| PUT | `/api/medicine/notifications/read-all` | any notified role (patient, doctor, medicine providers, diagnostic_lab, blood_bank, ambulance_provider) | - | `medicineNotificationController.markAllAsRead` |
| DELETE | `/api/medicine/notifications/:id` | any notified role (patient, doctor, medicine providers, diagnostic_lab, blood_bank, ambulance_provider) | - | `medicineNotificationController.deleteOne` |

### `routes/medicineOrder.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| POST | `/api/medicine/orders/checkout` | patient | body: medicineOrderValidator.checkout | `medicineOrderController.checkout` |
| POST | `/api/medicine/orders` | patient | body: medicineOrderValidator.placeOrder | `medicineOrderController.placeOrder` |
| GET | `/api/medicine/orders/groups/my` | patient | query: medicineOrderValidator.listOrders | `medicineOrderController.getMyOrderGroups` |
| GET | `/api/medicine/orders/groups/provider` | medicine provider | query: pharmacyValidator.listProviderOrders | `medicineOrderController.getProviderOrderGroups` |
| POST | `/api/medicine/orders/groups/:id/pay` | patient | body: medicineOrderValidator.payOrder | `medicineOrderController.payOrder` |
| PUT | `/api/medicine/orders/groups/:id/cancel` | patient | - | `medicineOrderController.cancelOrderGroup` |
| PUT | `/api/medicine/orders/groups/:id/status` | medicine provider | body: medicineOrderValidator.updateStatus | `medicineOrderController.updateOrderGroupStatus` |
| GET | `/api/medicine/orders/groups/:id/payment-qr` | patient | - | `medicineOrderController.getPaymentQr` |
| POST | `/api/medicine/orders/groups/:id/payment-report` | patient | body: paymentQrValidator.reportPayment | `medicineOrderController.reportPayment` |
| POST | `/api/medicine/orders/groups/:id/payment/confirm-received` | medicine provider | - | `medicineOrderController.confirmPaymentReceived` |
| GET | `/api/medicine/orders/groups/:id/invoice` | patient, medicine provider | - | `medicineOrderController.getInvoice` |
| GET | `/api/medicine/orders/groups/:id` | patient, medicine provider | - | `medicineOrderController.getOrderGroupById` |
| GET | `/api/medicine/orders/my-orders` | patient | query: medicineOrderValidator.listOrders | `medicineOrderController.getMyOrders` |
| PUT | `/api/medicine/orders/:id/cancel` | patient | - | `medicineOrderController.cancelOrder` |
| GET | `/api/medicine/orders/provider-orders` | medicine provider | query: medicineOrderValidator.listOrders | `medicineOrderController.getProviderOrders` |
| PUT | `/api/medicine/orders/:id/status` | medicine provider | body: medicineOrderValidator.updateStatus | `medicineOrderController.updateOrderStatus` |
| GET | `/api/medicine/orders/:id` | patient, medicine provider | - | `medicineOrderController.getOrderById` |

### `routes/medicineStore.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/medicine/browse` | Public | query: medicineStoreValidator.browseMedicines | `medicineStoreController.browseMedicines` |
| GET | `/api/medicine/suggest` | Public | query: medicineStoreValidator.suggestMedicines | `medicineStoreController.suggestMedicines` |
| GET | `/api/medicine/categories` | Public | query: medicineStoreValidator.listCategories | `medicineStoreController.listCategories` |
| GET | `/api/medicine/medicine/:id` | Public | - | `medicineStoreController.getMedicineDetails` |
| GET | `/api/medicine/provider/:providerId` | Public | - | `medicineStoreController.getProviderProfile` |
| GET | `/api/medicine/providers` | Public | query: medicineStoreValidator.listProviders | `medicineStoreController.listProviders` |
| GET | `/api/medicine/my-medicines` | medicine provider | query: medicineStoreValidator.listMyMedicines | `medicineStoreController.listMyMedicines` |
| GET | `/api/medicine/my-medicines/:id` | medicine provider | - | `medicineStoreController.getOne` |
| POST | `/api/medicine/my-medicines` | medicine provider | body: medicineStoreValidator.createMedicine | `medicineStoreController.create` |
| PUT | `/api/medicine/my-medicines/:id` | medicine provider | body: medicineStoreValidator.updateMedicine | `medicineStoreController.update` |
| DELETE | `/api/medicine/my-medicines/:id` | medicine provider | - | `medicineStoreController.remove` |
| GET | `/api/medicine/masters` | medicine provider | query: medicineStoreValidator.searchMasters | `medicineStoreController.searchMasters` |
| GET | `/api/medicine/masters/:id/media` | medicine provider or admin | - | `medicineStoreController.getMasterMedia` |
| POST | `/api/medicine/masters/:id/images` | medicine provider or admin | multipart file `image` | `medicineStoreController.addMasterImage` |
| PUT | `/api/medicine/masters/:id/images/order` | medicine provider or admin | body: medicineStoreValidator.reorderImages | `medicineStoreController.reorderMasterImages` |
| DELETE | `/api/medicine/masters/:id/images/:imageId` | medicine provider or admin | - | `medicineStoreController.removeMasterImage` |
| PUT | `/api/medicine/masters/:id/substitutes` | medicine provider or admin | body: medicineStoreValidator.setSubstitutes | `medicineStoreController.setMasterSubstitutes` |
| GET | `/api/medicine/my-categories` | medicine provider | query: medicineStoreValidator.listCategories | `medicineStoreController.listCategories` |
| POST | `/api/medicine/my-categories` | medicine provider | body: medicineStoreValidator.createCategory | `medicineStoreController.createCategory` |
| POST | `/api/medicine/categories` | admin | body: medicineStoreValidator.createCategory | `medicineStoreController.createCategory` |
| DELETE | `/api/medicine/categories/:id` | admin | - | `medicineStoreController.deleteCategory` |

### `routes/pharmacy.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/medicine/pharmacy/dashboard` | ...ALL_MEDICINE_PROVIDER_ROLES | - | `c.dashboard` |
| GET | `/api/medicine/pharmacy/dashboard/analytics` | ...ALL_MEDICINE_PROVIDER_ROLES | query: v.reportRange | `c.dashboardAnalytics` |
| GET | `/api/medicine/pharmacy/reports/sales` | ...ALL_MEDICINE_PROVIDER_ROLES | query: v.reportRange | `c.salesReport` |
| GET | `/api/medicine/pharmacy/reports/top-medicines` | ...ALL_MEDICINE_PROVIDER_ROLES | query: v.reportRange | `c.topMedicines` |
| GET | `/api/medicine/pharmacy/reports/purchases` | ...ALL_MEDICINE_PROVIDER_ROLES | query: v.reportRange | `c.purchaseReport` |
| GET | `/api/medicine/pharmacy/reports/gst` | ...ALL_MEDICINE_PROVIDER_ROLES | query: v.reportRange | `c.gstReport` |
| GET | `/api/medicine/pharmacy/reports/stock` | ...ALL_MEDICINE_PROVIDER_ROLES | - | `c.stockReport` |
| GET | `/api/medicine/pharmacy/batches` | ...ALL_MEDICINE_PROVIDER_ROLES | query: v.listBatches | `c.listBatches` |
| POST | `/api/medicine/pharmacy/batches/write-off-expired` | ...ALL_MEDICINE_PROVIDER_ROLES | body: v.writeOffExpired | `c.writeOffExpired` |
| POST | `/api/medicine/pharmacy/inventory/:id/stock` | ...ALL_MEDICINE_PROVIDER_ROLES | body: v.receiveStock | `c.receiveStock` |
| PUT | `/api/medicine/pharmacy/inventory/:id/batches/:batchId` | ...ALL_MEDICINE_PROVIDER_ROLES | body: v.updateBatch | `c.updateBatch` |
| GET | `/api/medicine/pharmacy/inventory/:id/movements` | ...ALL_MEDICINE_PROVIDER_ROLES | query: v.listMovements | `c.listMovements` |
| GET | `/api/medicine/pharmacy/import/template` | ...ALL_MEDICINE_PROVIDER_ROLES | - | `c.importTemplate` |
| POST | `/api/medicine/pharmacy/import/preview` | ...ALL_MEDICINE_PROVIDER_ROLES | body: v.importOptions; multipart file `file` | `c.importPreview` |
| POST | `/api/medicine/pharmacy/import` | ...ALL_MEDICINE_PROVIDER_ROLES | body: v.importOptions; multipart file `file` | `c.importCommit` |
| GET | `/api/medicine/pharmacy/export` | ...ALL_MEDICINE_PROVIDER_ROLES | query: v.exportInventory | `c.exportInventory` |
| GET | `/api/medicine/pharmacy/suppliers` | ...ALL_MEDICINE_PROVIDER_ROLES | query: v.listSuppliers | `c.listSuppliers` |
| POST | `/api/medicine/pharmacy/suppliers` | ...ALL_MEDICINE_PROVIDER_ROLES | body: v.createSupplier | `c.createSupplier` |
| GET | `/api/medicine/pharmacy/suppliers/:id` | ...ALL_MEDICINE_PROVIDER_ROLES | - | `c.getSupplier` |
| PUT | `/api/medicine/pharmacy/suppliers/:id` | ...ALL_MEDICINE_PROVIDER_ROLES | body: v.updateSupplier | `c.updateSupplier` |
| GET | `/api/medicine/pharmacy/purchases` | ...ALL_MEDICINE_PROVIDER_ROLES | query: v.listPurchases | `c.listPurchases` |
| POST | `/api/medicine/pharmacy/purchases` | ...ALL_MEDICINE_PROVIDER_ROLES | body: v.createPurchase | `c.createPurchase` |
| GET | `/api/medicine/pharmacy/purchases/:id` | ...ALL_MEDICINE_PROVIDER_ROLES | - | `c.getPurchase` |
| POST | `/api/medicine/pharmacy/purchases/:id/cancel` | ...ALL_MEDICINE_PROVIDER_ROLES | - | `c.cancelPurchase` |
| POST | `/api/medicine/pharmacy/orders/:id/returns` | ...ALL_MEDICINE_PROVIDER_ROLES | body: v.createReturn | `c.createReturn` |
| GET | `/api/medicine/pharmacy/returns` | ...ALL_MEDICINE_PROVIDER_ROLES | query: v.listReturns | `c.listReturns` |
| GET | `/api/medicine/pharmacy/returns/:id` | ...ALL_MEDICINE_PROVIDER_ROLES | - | `c.getReturn` |
| GET | `/api/medicine/pharmacy/payments` | ...ALL_MEDICINE_PROVIDER_ROLES | query: v.listPayments | `c.listPayments` |
| GET | `/api/medicine/pharmacy/settings` | ...ALL_MEDICINE_PROVIDER_ROLES | - | `c.getSettings` |
| PUT | `/api/medicine/pharmacy/settings` | ...ALL_MEDICINE_PROVIDER_ROLES | body: v.updateSettings | `c.updateSettings` |
| GET | `/api/medicine/pharmacy/payment-qr` | ...ALL_MEDICINE_PROVIDER_ROLES | - | `paymentQr.get` |
| PUT | `/api/medicine/pharmacy/payment-qr` | ...ALL_MEDICINE_PROVIDER_ROLES | body: paymentQrSchema.updatePaymentQr | `paymentQr.update` |
| POST | `/api/medicine/pharmacy/payment-qr/image` | ...ALL_MEDICINE_PROVIDER_ROLES | multipart file `file` | `paymentQr.uploadImage` |
| DELETE | `/api/medicine/pharmacy/payment-qr` | ...ALL_MEDICINE_PROVIDER_ROLES | - | `paymentQr.remove` |

### `routes/prescriptionRequest.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| POST | `/api/medicine/prescriptions` | patient | body: prescriptionRequestValidator.uploadAndShare; multipart file `prescription` | `prescriptionRequestController.uploadAndShare` |
| GET | `/api/medicine/prescriptions/my-requests` | patient | query: prescriptionRequestValidator.listRequests | `prescriptionRequestController.getMyRequests` |
| GET | `/api/medicine/prescriptions/provider-requests` | medicine provider | query: prescriptionRequestValidator.listRequests | `prescriptionRequestController.getProviderRequests` |
| PUT | `/api/medicine/prescriptions/:id/status` | medicine provider | body: prescriptionRequestValidator.updateStatus | `prescriptionRequestController.updateStatus` |
| PUT | `/api/medicine/prescriptions/:id/availability` | medicine provider | body: prescriptionRequestValidator.submitAvailability | `prescriptionRequestController.submitAvailability` |
| POST | `/api/medicine/prescriptions/:id/cart` | patient | body: prescriptionRequestValidator.addPrescriptionToCart | `prescriptionRequestController.addPrescriptionToCart` |
| POST | `/api/medicine/prescriptions/:id/order` | patient | body: prescriptionRequestValidator.placeOrderFromPrescription | `prescriptionRequestController.placeOrderFromPrescription` |
| GET | `/api/medicine/prescriptions/:id/file` | patient, medicine provider | - | `prescriptionRequestController.streamFile` |
| GET | `/api/medicine/prescriptions/:id` | patient, medicine provider | - | `prescriptionRequestController.getRequestById` |

