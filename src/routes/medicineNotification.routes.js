const router = require("express").Router();
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");
const { ROLES, ALL_MEDICINE_PROVIDER_ROLES } = require("../config/constants");

/**
 * Everyone notified through this table: the patient, every pharmacy role, the
 * Diagnostic Lab Center (migration 038, reference_type 'diagnostic_request')
 * and the Blood Bank (migration 039, reference_type 'blood_*'), which reuse
 * the same notification table, as does the Ambulance provider (migration 040,
 * reference_type 'ambulance*'). Every query is scoped to req.user.id, so a role
 * here only ever reads its own notifications.
 */
const NOTIFIED_ROLES = [
  ROLES.PATIENT,
  // Doctors (appointment + record-access consent events). Same scoping: a
  // doctor only ever reads rows whose user_id is their own.
  ROLES.DOCTOR,
  ...ALL_MEDICINE_PROVIDER_ROLES,
  ROLES.DIAGNOSTIC_LAB,
  ROLES.BLOOD_BANK,
  ROLES.AMBULANCE_PROVIDER,
];
const medicineNotificationController = require("../controllers/medicineNotification.controller");

router.get(
  "/",
  authenticate,
  authorize(...NOTIFIED_ROLES),
  medicineNotificationController.listByUser
);

router.get(
  "/unread-count",
  authenticate,
  authorize(...NOTIFIED_ROLES),
  medicineNotificationController.getUnreadCount
);

router.put(
  "/:id/read",
  authenticate,
  authorize(...NOTIFIED_ROLES),
  medicineNotificationController.markAsRead
);

router.put(
  "/read-all",
  authenticate,
  authorize(...NOTIFIED_ROLES),
  medicineNotificationController.markAllAsRead
);

router.delete(
  "/:id",
  authenticate,
  authorize(...NOTIFIED_ROLES),
  medicineNotificationController.deleteOne
);

module.exports = router;
