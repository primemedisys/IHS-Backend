/**
 * Maps `diagnostic_request_tests` (migration 038) — one row per test on a
 * diagnostic request:
 *   - the lab's answer: `available` (with price, optionally linked to its own
 *     catalogue entry) or `unavailable` (free-text name + optional reason);
 *   - the patient's booking choice (`isSelected`);
 *   - the report, once uploaded: `reportRecordId` points at the row filed in
 *     the patient's EXISTING medical records (uploaded_records), so the report
 *     lives in one place and shows up in the Records page automatically.
 *
 * A lab re-sending its answer REPLACES the whole set (delete + insert in a
 * transaction), exactly like prescription_request_items.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const { DIAGNOSTIC_TEST_STATUS } = require("../config/constants");

const DiagnosticRequestTest = sequelize.define(
  "DiagnosticRequestTest",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    diagnosticRequestId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    diagnosticTestId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    testName: { type: DataTypes.STRING(150), allowNull: false },
    price: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    status: {
      type: DataTypes.ENUM(...Object.values(DIAGNOSTIC_TEST_STATUS)),
      allowNull: false,
    },
    reason: { type: DataTypes.STRING(255), allowNull: true },
    isSelected: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    reportRecordId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    reportUploadedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "diagnostic_request_tests",
    timestamps: true,
    indexes: [
      { fields: ["diagnostic_request_id"], name: "idx_drt_request" },
      { fields: ["diagnostic_test_id"], name: "idx_drt_test" },
      { fields: ["report_record_id"], name: "idx_drt_report" },
    ],
  }
);

module.exports = DiagnosticRequestTest;
