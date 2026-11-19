# Modules, Controllers and Services

Layer contract (verified): routes -> middlewares -> **controller** (thin) -> **service** (all logic and DB access) -> models. Controllers are named `<domain>.controller.js`; the service with the same stem owns the logic. 58 controllers, 88 services. Exports below are the real `module.exports` / `exports.*` names.

Convention used in the tables: **Controllers** (by file name), **Services**, **Models**, **Routers**.

## 1. Identity, accounts, notifications transport

| Piece | Responsibility |
|---|---|
| Controllers: `auth`, `adminAuth`, `clinicAuth`, `medicineAuth` (+ `bloodBank.login/register`, `ambulanceProvider.login/register`) | Thin wrappers; each fixes its portal's role allow-list |
| `auth.service` | `registerLocal, loginLocal/Admin/Clinic/MedicineProvider/BloodBank/AmbulanceProvider, googleAuth, refresh, logout, forgotPassword, requestPasswordOtp, verifyPasswordOtp, resetPassword, changePassword, getMe, updateProfile` |
| `token.service` | `signAccessToken, issueTokens, rotateRefreshToken, revokeRefreshToken, revokeAllForUser` (sole owner of JWT signing and `refresh_tokens`) |
| `user.service` | `findByEmail, findByMobile, profileInclude, findWithProfile, createProfileRow, searchPatients` (shared by auth, admin, doctor, patient) |
| `google.service` | `verify` ID token (audience bound to `GOOGLE_CLIENT_ID`, email must be verified) |
| `mail.service` | Cached HTML templates with `{{key}}` / `{{#if key}}` interpolation (HTML-escaped): `sendPasswordReset, sendPasswordResetCode, sendVerifyEmail (no caller), sendPrescriptionReady, sendFollowUpReminder, sendContactNotification, isConfigured`. Ethereal in dev, nothing sent in production without SMTP |
| `sms.service` | `isConfigured, send` (Twilio REST via `fetch`, `mock`, `none`) |
| `whatsapp.service` | `sendReminder` (Twilio Content API via the undeclared `twilio` package; `mock` logs) |
| `notificationService` | `send(reminder)` - channel abstraction for follow-up reminders; each channel (email, WhatsApp) succeeds or fails independently |

Models: `User, RefreshToken, PasswordResetToken, PasswordResetOtp`.

## 2. Doctor: profile, portfolio, discovery, availability

| Piece | Responsibility |
|---|---|
| Controllers `doctor`, `publicDoctor`, `clinic`, `adminDoctor`, `adminDoctorManage` | Owner CRUD, public reads, clinic/availability, admin verdicts and "create approved doctor" |
| `doctor.service` | Own profile and every portfolio section (awards + image, links, keywords, documents, photo, showcase, hero images (1-3, `utils/heroImages`), gallery, testimonials + photo (consent flag), education, experience, services, publications, memberships, FAQs, affiliations, fellowships, expertise, insurances); `fullInclude`, `cardInclude`, `publicListingWhere/Sql`, `isPubliclyListed` |
| `verification.service` | `computeChecklist, getOnboarding, submit, listForReview, getForReview, reviewDoctor, setListing` + public reads `getPublicBySlug, listPublicDoctors, listMapDoctors, listRelatedDoctors, listSpecializations, listSubSpecializations, listLanguages`. One function feeds both the checklist and the submit guard so they cannot drift |
| `doctorSearch.service` | `search, searchDoctorIds, hydrate` - discovery executed in SQL (filters, sort, haversine "nearest", pagination) instead of loading all doctors |
| `clinic.service`, `availability.service` | A doctor's physical clinics; replace-the-set weekly windows (`getClinicAvailability, setClinicAvailability, getOnlineAvailability, setOnlineAvailability`), blocked-date exceptions, `resolveWindows`, `expireStaleHolds` |
| `adminDoctor.service` | `createDoctor` (live immediately); editing reuses `doctor.service` through `resolveDoctorId("param")` |
| `doctorMedicine.service` | The doctor's personal medicine list (`list, listAll, getOne, create, update, remove, compactStrength`); duplicates refused (`MEDICINE_DUPLICATE`) |

Models: `DoctorProfile` and its 15 portfolio models, `Specialization`, `SubSpecialization`, `Language`, `Insurance`, `Clinic`, `ClinicAvailability`, `DoctorOnlineAvailability`, `AvailabilityException`, `Medicine`.

## 3. Booking, queue, payments, video

| Piece | Responsibility |
|---|---|
| Controllers `booking`, `doctorBooking`, `session`, `paymentWebhook`, `videoWebhook`, `earnings`, `dashboard` | |
| `session.service` | Consultation **sessions** (one per doctor x clinic/online x date window, materialised lazily by `resolveSession`) and the queue: `listForDoctorDate, listRange, queueView, listQueue, start, pause, resume, end, setCap, callNext, serveOnJoin, startConsult, skip, refreshAverage, autoCloseStale`. Position is derived (count of waiting ahead), a token is immutable. Auto-close 6 h after a session's end time |
| `booking.service` | `create, reschedule, verifyPayment, listForPatient, getForPatient, listForClinicPatient, getPaymentQrForPatient, reportPaymentForPatient, paymentOptionsForDoctor`, doctor-side `markPaid` / `complete` / `list`; token allocation (`allocateToken`, row lock), duplicate-booking guard, referral link, acquisition record |
| `payment.service` | Razorpay: `isEnabled, createOrder, verify, handleWebhook, confirmPaid, provisionVideoConsult, applySplit` (15 % platform commission stored on the payment row) |
| `paymentQr.service` | A provider's own UPI QR: `getOwn, update, uploadImage (PNG/JPEG/WebP <= 2 MB), remove, findConfigured, requireConfigured, configuredIds` |
| `videoSession.service`, `livekit.service` | Join gate (own confirmed booking + time window), token mint (room `consult-<bookingId>`), webhook applier |
| `earnings.service`, `dashboard.service` | Aggregates in SQL: only `payments.status='success'` is money, bucketed by `paid_at`, split read from stored columns |
| `appointmentNotification.service` | Writes in-app notifications for booking events and prescription-ready; never throws (post-commit, failures logged) |

Models: `ConsultationSession, Booking, Payment, VideoSession, BookingAcquisitionSource`.

## 4. Referrals and care journeys

`referral.service` (`createFromBooking, listForBookingPatient, mapForBookings, listIncoming, getIncomingCase, startConsultation, listTargets, cancel, linkBooking, revertLink, completeForBooking, doctorMini`) and `careJourney.service` (`listForPatient, getForPatient`, read-only lens). Controllers `doctorReferral`, `patientJourney`. A referral is a directed edge Dr A -> Dr B inside a `care_journeys` episode; the target doctor starts a walk-in consult (a 0-rupee appointment). Models: `Referral, CareJourney`.

## 5. Patient health record and clinical

| Piece | Responsibility |
|---|---|
| Controllers `patient`, `patientPrescription`, `patientTimeline`, `patientFollowUp`, `clinicPatient`, `doctorTimeline`, `emr`, `followUp`, `followUpReminder`, `recordAccess` | |
| `patient.service` | Profile + completion gate (`assertProfileComplete`), allergies/conditions/medications, records (`uploadRecord`, `replaceRecordFile`, ...), medical documents (identity docs masked to last 4 digits), `getSnapshotForClinic` |
| `patientVitals.service` | Patient vitals timeline; shared doctor gate `gateBookingPatient`; `addEmrReading` |
| `clinicalNote.service` | Append-only notes; authored by a doctor or a clinic |
| `emr.service` | Workbench, patient workspace, vitals history, structured entries (`createEntry, updateEntry, retireEntry`, 24 h edit window then retire-with-reason), visit summaries, medical history, documents, catalogue/search (`searchMedicines, searchInvestigations, diagnosisSuggestions`) |
| `medicalHistory.service`, `patientTimeline.service`, `treatmentTimeline.service` | Read-only lenses (one builder behind the patient's Medical Record page and the doctor's workbench; flat per-consultation timeline; patient roster with derived/overridden status) |
| `followUp.service`, `followUpReminder.service` | Doctor-defined follow-up statuses (seeded per doctor on first use, archive vs delete), per-booking follow-up, reminder CRUD (`reminder_at` = follow-up day 09:00 IST minus the interval) |
| `clinicalAccess.service`, `accessGrants.service`, `doctorRecordAccess.service` | The consent engine (see authentication doc section 6) |
| `acquisition.service` | "How did you hear about Dr. X?" - catalogue from `config/constants.js` (`ACQUISITION_SOURCES`), original source per (patient, doctor) never overwritten, per-booking row written in the booking transaction |
| `config/vitalsRanges.js` | Single source of truth for adult reference bands (5 of 7 fields colourable; refuses to evaluate under age 18); used by serializers |

Models: `PatientProfile, Allergy, PatientAllergy, Condition, PatientCondition, PatientCurrentMedication, PatientVitals, UploadedRecord, ClinicalNote, ClinicalEntry, FollowUpStatus, PatientFollowUp, FollowUpReminder, DoctorPatientStatus, DoctorAccessRequest, DoctorAccessGrantItem, AccessAuditLog, PatientAcquisitionSource`.

## 6. Prescriptions

| Piece | Responsibility |
|---|---|
| Controllers `prescription`, `prescriptionTemplate`, `patientPrescription` | |
| `prescriptionTemplate.service` | Letterhead CRUD, default, duplicate, assets (logo / watermark / signature, PNG/JPEG only), `resolveTemplate` (auto-provisions a letterhead from the doctor's profile if none) |
| `prescription.service` | `createDraft, syncWorkbench, getOne, getByBooking, listForDoctor, listForPatient, patch, remove, finalize, amend, getPdf*`. **Finalize freezes** (`template_snapshot`, `clinical_snapshot`), numbers gaplessly (`utils/rxNumber`, e.g. `OSC-2026-000123`), commits, **then** renders the PDF (never inside the transaction), notifies the patient (in-app + e-mail) and syncs the patient's medicine routines. **Amend** creates version N+1 and supersedes the previous one |
| `prescriptionWorkbench.service` | `snapshotFor, syncDraft, gather` - reads the Workbench consultation and copies printable parts onto a draft |
| `prescriptionPdf.service` | Only file that knows a browser exists: `render, renderSample, preflight, shutdown`; every string HTML-escaped; assets inlined as `data:` URIs; concurrency `PDF_MAX_CONCURRENCY`; template `templates/prescriptions/rx.html` |
| `icdCode.service`, `icdImport.service` | Admin ICD master (system + version + code unique, never deleted, only deactivated) and the doctor diagnosis search (dot-less code matching, ranking); Excel import: template -> preview (nothing written) -> commit (same file re-checked, one transaction, audit in `icd_import_batches`) |

Models: `Prescription, PrescriptionItem, PrescriptionTemplate, IcdCode, IcdImportBatch`. Unnumbered table: `rx_counters`.

## 7. Patient medicine routines ("My Medicines")

`patientMedicine.service` (`getSettings, updateSettings, searchCatalogue, list, getOne, createMany, update, setStatus, listDoses, history, doseAction, summary, syncFromPrescription, generateDoses, markMissed, clearFutureDoses`) and `medicineReminder.service` (sweep). Rules enforced: ownership is the WHERE clause; the doctor's line is never rewritten (`prescribedSnapshot` locked, patient may change only reminder prefs - `PRESCRIBED_FIELD_LOCKED`); a dose is "taken" only when the patient says so; doses are generated in a rolling 7-day window; a dose still open 120 min after due becomes `missed`; max 6 reminder times per routine; max 10 medicines per request; idempotent via `clientRequestId`. Helpers: `utils/medicineSchedule` (IANA time zones, default `Asia/Kolkata`), `utils/patientMedicineSerializers`. Controller `patientMedicine`. Models: `PatientMedicine, MedicineDoseLog, MedicineDoseEvent, PatientMedicineSettings`.

## 8. Pharmacy and medicine marketplace

| Service | Responsibility |
|---|---|
| `medicineStore.service` | Provider inventory CRUD (`listMyMedicines, getOne, create, update, remove`), global master search (`searchMasters`), public `browseMedicines, suggestMedicines, getMedicineDetails, getProviderProfile, listProviders` (distance when lat/lng given), categories; location rule `userLocationWhere` (patient's Google city/state vs provider) reused by diagnostics and blood-bank search |
| `medicineMedia.service` | Master images (max 4) and substitutes (max 12); who may curate: admin or a pharmacy that sells it; deleting an image: admin or uploader |
| `medicineCart.service` | One cart per patient; `getCart, getCount, getPaymentOptions, addItem, updateItem, removeItem, clear, addFromPrescription, ...` |
| `medicineOrderGroup.service` | Checkout / billing / payment / lifecycle: `checkout, orderDirect, orderFromPrescription, payGroup, getMyGroups, getProviderGroups, getGroupById, updateGroupStatus, cancelGroup, getPaymentQrForPatient, reportPaymentForPatient, confirmPaymentReceived, getInvoice, getProviderPayments`; price/stock/provider always recomputed server-side |
| `medicineOrder.service` | Per-line reads and actions (kept compatible with pre-group orders) |
| `medicineReturn.service` | Returns against delivered orders, credit notes `CN-YYYYMMDD-nnnnnn`, optional restock to the exact batches |
| `pharmacyStock.service` | **The only writer of stock**: keeps `medicine_store_medicines.stock`, `medicine_stock_batches` and `medicine_stock_movements` consistent |
| `pharmacyInventory`, `pharmacyPurchase` (`PO-YYYYMMDD-nnnnnn`), `pharmacySupplier`, `pharmacyImport` (Excel, <= 5,000 rows), `pharmacyReport` (dashboard/sales/GST/stock/analytics, IST day boundaries, max 366-day range), `pharmacySettings` (GSTIN, drug licence, expiry alert days default 90) | pharmacy management |
| `prescriptionRequest.service` | Patient uploads a prescription to a pharmacy; provider answers availability per medicine; patient adds available lines to the cart or orders |
| `medicineNotification.service` | List / read / unread-count / delete rows of `medicine_notifications` (shared by every role) |
| `adminMedicine.service` | Read-only aggregates over groups + legacy single-line orders (no double counting) |
| Utilities | `utils/medicinePricing` (integer paise, round half-up to 2 dp), `utils/medicineIdentity` (case-insensitive identity key), `utils/documentNumber`, `config/pharmacy.js` |

Controllers: `medicineStore`, `medicineCart`, `medicineOrder`, `medicineNotification`, `medicineAuth`, `prescriptionRequest`, `pharmacy`, `adminMedicine`, `paymentQr`. Models: 22 (see database doc, "Medicine marketplace and pharmacy"). Online payment for medicine orders is a **simulation** (`gateway = simulated`), refused in production; UPI QR payments are confirmed by the pharmacy.

## 9. Diagnostic labs

`diagnostic.service`: `listLabs, shareRequest, listMyRequests, listLabRequests, getRequest, streamFile, streamReport, updateStatus, respond, uploadReport, book, listTests, createTest, updateTest, removeTest, labSummary`. Lab transitions come from `DIAGNOSTIC_LAB_TRANSITIONS`; `respond` allowed only before the patient has booked; reports can be uploaded in `test_completed` / `report_ready` and are filed into the patient's `uploaded_records` (source `diagnostic_lab`, file types `lab_report, xray, mri, other`). `adminDiagnostic.service` (`overview, listRequests`): workflow and counts only. Controllers `diagnostic`, `adminDiagnostic`. Models `DiagnosticTest, DiagnosticRequest, DiagnosticRequestTest`.

## 10. Blood bank

| Service | Responsibility |
|---|---|
| `bloodBankProfile.service` | Signup split, own profile, admin verification (pending -> approved / rejected, plus `is_active`) |
| `bloodDonor.service` | donor -> screening (a staff decision, never computed) -> donation (needs an ELIGIBLE screening shortly before) -> tests -> testing decision (failed => every unit of the donation leaves stock) |
| `bloodInventory.service` | Inventory derived from `blood_units`; release, discard, separate into components; **expiry is backend-driven** (`expireDue()` runs before inventory reads and on dashboard calls) |
| `bloodRequest.service` | patient request -> view/process -> reserve (row locks) -> cross-match recorded by staff -> authorised approval -> issue -> completed; the software never decides compatibility |
| `bloodCamp.service`, `bloodSearch.service`, `bloodDashboard.service`, `bloodAudit.service` | camps and registrations; patient search (location + optional distance; availability is a real count of AVAILABLE, tested, unexpired units, labelled indicative); aggregates; module-local audit trail written inside the change's transaction; notifications |
| Utilities | `config/bloodBank.js` (groups, components, shelf-life defaults, compatibility reference tables shown to staff), `utils/bloodCode` (gapless per-year codes via `blood_counters`) |

Controllers `bloodBank`, `bloodPatient`, `adminBloodBank`. 13 models.

## 11. Ambulance

`ambulanceProvider.service` (signup split, profile, admin verification, resubmit after rejection), `ambulanceFleet.service` (ambulances/drivers; a new ambulance starts `pending` and invisible; changing identity of an approved one sends it back to `pending`; editing a rejected one resubmits), `ambulanceSearch.service` (public visibility rule in ONE place for SQL and Sequelize: provider active+approved, ambulance approved+active, availability `available` or `on_trip` (on_trip shown, not bookable)), `ambulanceBooking.service` (state machine `requested -> accepted -> driver_assigned -> en_route -> arrived -> patient_picked_up -> completed`, plus rejected / cancelled; fare computed server-side by `utils/ambulanceFare` = base + km x rate [+ emergency surcharge] [+ waiting]), `ambulanceDashboard.service`, `ambulanceNotification.service`. Controllers `ambulanceProvider`, `ambulancePublic`, `adminAmbulance`. Booking codes `AMB-...`. **No live GPS** and no payment: status + ETA, polled by clients.

## 12. Clinic portal

`clinicPortal.service` (profile, onboarding checklist: `profile, location, documents`; submit needs `registration_certificate` + `id_proof`; admin verdict, activation), `adminAllClinics.service`. Controllers `clinicPortal`, `clinicAuth`, `clinicPatient`, `adminClinic`, `adminAllClinics`. Clinics create bookings, vitals, records, allergies/conditions and clinical notes *on a patient's behalf*; those rows carry `source = clinic` and `recorded_by_user_id`. Bookings made by a clinic carry `booked_by_user_id`.

## 13. Admin

The admin dashboard routes use the `dashboard` and `earnings` controllers (there is no `adminDashboard` controller). Admin controllers: `adminDoctor`, `adminDoctorManage`, `adminClinic`, `adminAllClinics`, `adminRegistry`, `adminContact`, `adminMedicine`, `adminDiagnostic`, `adminBloodBank`, `adminAmbulance`, `adminIcd`. Services: `adminRegistry.service` (registered doctors/patients, patient deep-read reusing `patient.service`, admin record upload stamped `source: admin`, `deletionPreview`, `deletePatient`, `doctorDeletionPreview`, `deleteDoctor`, `setDoctorActive`), plus the services above. Admin credentials: seeded from `.env` on every boot.

## 14. Contact and misc

`contact.service` (`createMessage` persists first, then best-effort e-mail to `ADMIN_EMAIL`; `listMessages`, `setHandled`), `earnings.service`, `doctorAnalytics.service` (`overview, trends, patientsDetail, appointmentsDetail, financialDetail, qualityDetail, productivityDetail, acquisitionDetail`; IST days; abandoned checkouts excluded), `fileAccess.service` / `upload.service` / `cloudinaryStorage.service` (see [FILE-STORAGE-AND-UPLOADS.md](FILE-STORAGE-AND-UPLOADS.md)), `reminderScheduler.service`, `medicineReminder.service` (see [BACKGROUND-JOBS-AND-REALTIME.md](BACKGROUND-JOBS-AND-REALTIME.md)).

## 15. Utilities worth knowing

| File | Purpose |
|---|---|
| `utils/serializers.js` | Model -> API shape for every response (3,262 lines); `buildWorkbenchSnapshot`, `serializeIcdCode`, `serializeMedicalHistory`, `serializeClinicalAccess`, `serializeWorkbench`, `serializeNotification` ... |
| `utils/period.js` | IST period math (`istToday, istDateRangeBounds, istMonthBounds, resolveRange, bucketKeys, zeroFill`) |
| `utils/phone.js` | `normalizeIndianMobile, toE164India, maskMobile` |
| `utils/slug.js` | `doctorSlug` / `parseDoctorId` (`dr-<name>-<id>`) |
| `utils/geo.js` | haversine, SQL distance expression, bounding box |
| `utils/age.js`, `utils/patientRegNo.js` (`IHS-P-000123`) | small shared helpers |
| `utils/sendFile.js` | stream a private file inline or as attachment |
| `utils/processDiagnostics.js` | structured JSON log line for every way the process can stop; friendly port-in-use message |
