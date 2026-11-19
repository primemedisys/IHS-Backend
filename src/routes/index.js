/**
 * The API router root. Every feature's routes are mounted here under their
 * prefix; app.js mounts THIS under env.API_PREFIX (`/api`). So the final paths
 * are e.g. `POST /api/auth/login`. Add new feature routers with one line each.
 */
const router = require("express").Router();

const authRoutes = require("./auth.routes");
const doctorRoutes = require("./doctor.routes");
const clinicRoutes = require("./clinic.routes");
const patientRoutes = require("./patient.routes");
const doctorBookingRoutes = require("./doctorBooking.routes");
const doctorPrescriptionRoutes = require("./doctorPrescription.routes");
const doctorMedicineRoutes = require("./doctorMedicine.routes");
const doctorDashboardRoutes = require("./doctorDashboard.routes");
const patientDashboardRoutes = require("./patientDashboard.routes");
const adminDashboardRoutes = require("./adminDashboard.routes");
const adminDoctorRoutes = require("./adminDoctor.routes");
const adminDoctorManageRoutes = require("./adminDoctorManage.routes");
const doctorsPublicRoutes = require("./doctorsPublic.routes");
const contactRoutes = require("./contact.routes");
const adminContactRoutes = require("./adminContact.routes");
const webhookRoutes = require("./webhook.routes");
const clinicPortalRoutes = require("./clinicPortal.routes");
const adminClinicRoutes = require("./adminClinic.routes");
const adminRegistryRoutes = require("./adminRegistry.routes");
const adminAllClinicsRoutes = require("./adminAllClinics.routes");
const adminMedicineRoutes = require("./adminMedicine.routes");
const adminIcdRoutes = require("./adminIcd.routes");
const medicineStoreRoutes = require("./medicineStore.routes");
const medicineCartRoutes = require("./medicineCart.routes");
const medicineOrderRoutes = require("./medicineOrder.routes");
const medicineNotificationRoutes = require("./medicineNotification.routes");
const prescriptionRequestRoutes = require("./prescriptionRequest.routes");
const pharmacyRoutes = require("./pharmacy.routes");
const diagnosticRoutes = require("./diagnostic.routes");
const adminDiagnosticRoutes = require("./adminDiagnostic.routes");
const bloodBankRoutes = require("./bloodBank.routes");
const bloodRoutes = require("./blood.routes");
const adminBloodBankRoutes = require("./adminBloodBank.routes");
const ambulanceProviderRoutes = require("./ambulanceProvider.routes");
const ambulanceRoutes = require("./ambulance.routes");
const adminAmbulanceRoutes = require("./adminAmbulance.routes");
const doctorRecordAccessRoutes = require("./doctorRecordAccess.routes");
const patientRecordAccessRoutes = require("./patientRecordAccess.routes");
const fileRoutes = require("./file.routes");
const doctorEmrRoutes = require("./doctorEmr.routes");
const patientEmrRoutes = require("./patientEmr.routes");
const patientMedicineRoutes = require("./patientMedicine.routes");
const patientAcquisitionRoutes = require("./patientAcquisition.routes");
const doctorAnalyticsRoutes = require("./doctorAnalytics.routes");

// Lightweight health check for load balancers / uptime probes.
router.get("/health", (_req, res) => res.json({ status: "ok" }));

router.use("/files", fileRoutes); // backend-signed private file links (CLOUDINARY_SETUP.md)
router.use("/auth", authRoutes);
router.use("/doctor", doctorRoutes); // doctor-owned profile & portfolio
router.use("/doctor", clinicRoutes); // doctor-owned clinics & availability
router.use("/doctor", doctorBookingRoutes); // doctor-owned appointments
router.use("/doctor", doctorPrescriptionRoutes); // doctor-owned letterheads & prescriptions
router.use("/doctor", doctorMedicineRoutes); // doctor-owned medicine master list
router.use("/doctor", doctorDashboardRoutes); // doctor-owned dashboard tiles & earnings
router.use("/doctor", doctorAnalyticsRoutes); // Dashboard 2.0 KPIs, Explore More analytics, acquisition
router.use("/doctor", doctorRecordAccessRoutes); // patient search + record-access consent requests
router.use("/doctor", doctorEmrRoutes); // EMR workbench + patient medical workspace (migration 051)
router.use("/patient", patientRoutes); // patient-owned profile & bookings
router.use("/patient", patientDashboardRoutes); // patient-owned dashboard tiles
router.use("/patient", patientRecordAccessRoutes); // the patient's decisions on doctor record-access requests
router.use("/patient", patientEmrRoutes); // the patient's own medical profile + visit summaries
router.use("/patient", patientMedicineRoutes); // My Medicines: routines, doses, reminders (migration 055)
router.use("/patient", patientAcquisitionRoutes); // "How did you hear about Dr. X?" options (migration 056)
router.use("/clinic", clinicPortalRoutes); // the clinic portal: its account + the patient workspace
router.use("/admin", adminDashboardRoutes); // platform revenue + operational health
router.use("/admin", adminDoctorRoutes); // admin verification queue + verdict
router.use("/admin", adminDoctorManageRoutes); // admin create-doctor + full editing surface
router.use("/admin", adminContactRoutes); // admin contact-message inbox
router.use("/admin", adminClinicRoutes); // admin clinic verification queue + verdict
router.use("/admin", adminRegistryRoutes); // admin registry: registered doctors/patients + record upload
router.use("/admin", adminAllClinicsRoutes); // admin all clinics: total clinic details
router.use("/admin", adminMedicineRoutes); // admin pharmacy & medicine tracking (read-only)
router.use("/admin", adminIcdRoutes); // admin diagnosis / ICD code master (migration 059)
router.use("/admin", adminDiagnosticRoutes); // admin diagnostic lab tracking (read-only)
router.use("/admin", adminBloodBankRoutes); // admin blood bank verification + tracking
router.use("/admin", adminAmbulanceRoutes); // admin ambulance verification, fleet control + booking monitoring
router.use("/medicine", medicineStoreRoutes); // medicine marketplace: browse + provider CRUD
router.use("/medicine/cart", medicineCartRoutes); // the ONE medicine cart (patient)
router.use("/medicine/orders", medicineOrderRoutes); // checkout, orders, bill, simulated payment
router.use("/medicine/notifications", medicineNotificationRoutes); // medicine notifications
router.use("/medicine/prescriptions", prescriptionRequestRoutes); // patient prescription upload & sharing
router.use("/medicine/pharmacy", pharmacyRoutes); // pharmacy management: stock, purchases, billing, reports
router.use("/diagnostics", diagnosticRoutes); // diagnostic labs: share, test answer, booking, reports
router.use("/blood-bank", bloodBankRoutes); // blood bank portal: donors, units, requests, camps
router.use("/blood", bloodRoutes); // patient blood search, requests, camps, history
router.use("/ambulance", ambulanceProviderRoutes); // ambulance provider portal: fleet, drivers, bookings
router.use("/ambulances", ambulanceRoutes); // public ambulance discovery + patient bookings
router.use("/webhooks", webhookRoutes); // public, HMAC-verified (Razorpay)
router.use("/contact", contactRoutes); // public "Contact us" form
router.use("/", doctorsPublicRoutes); // /doctors/:slug, /specializations, /languages

module.exports = router;
