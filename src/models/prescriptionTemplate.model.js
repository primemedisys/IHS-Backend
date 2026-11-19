/**
 * Maps `prescription_templates` (migration 006) — a doctor's configurable
 * letterhead, scoped to one clinic or (clinic_id NULL) used for video consults
 * and as the fallback default.
 *
 * The five JSON columns hold the repeating presentation content (credential
 * lines, the Advice sidebar, footer columns). Sequelize parses/serializes them,
 * so services read and write plain JS objects — never hand-stringify.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const PrescriptionTemplate = sequelize.define(
  "PrescriptionTemplate",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    doctorId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    clinicId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true }, // NULL = video / any
    name: { type: DataTypes.STRING(120), allowNull: false },
    isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

    // ── branding assets ──────────────────────────────────────────────────────
    logoUrl: { type: DataTypes.STRING(500), allowNull: true },
    watermarkUrl: { type: DataTypes.STRING(500), allowNull: true },
    signatureUrl: { type: DataTypes.STRING(500), allowNull: true },
    watermarkOpacity: { type: DataTypes.DECIMAL(3, 2), allowNull: false, defaultValue: 0.08 },

    // ── theme ────────────────────────────────────────────────────────────────
    headerBgColor: { type: DataTypes.CHAR(7), allowNull: false, defaultValue: "#7EE0EF" },
    headerTextColor: { type: DataTypes.CHAR(7), allowNull: false, defaultValue: "#12263F" },
    footerBgColor: { type: DataTypes.CHAR(7), allowNull: false, defaultValue: "#2E4A2E" },
    footerTextColor: { type: DataTypes.CHAR(7), allowNull: false, defaultValue: "#FFFFFF" },
    accentColor: { type: DataTypes.CHAR(7), allowNull: false, defaultValue: "#12263F" },
    fontFamily: {
      type: DataTypes.STRING(60),
      allowNull: false,
      defaultValue: "Helvetica, Arial, sans-serif",
    },
    baseFontSizePt: { type: DataTypes.DECIMAL(3, 1), allowNull: false, defaultValue: 10.0 },

    // ── page ─────────────────────────────────────────────────────────────────
    pageSize: { type: DataTypes.ENUM("A4", "Letter"), allowNull: false, defaultValue: "A4" },
    marginMmTop: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 8 },
    marginMmRight: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 8 },
    marginMmBottom: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 8 },
    marginMmLeft: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 8 },

    // ── zone toggles ─────────────────────────────────────────────────────────
    showHeader: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    showFooter: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    showSidebar: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    showWatermark: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sidebarWidthPct: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 18 },

    // ── content (Joi-validated on write) ─────────────────────────────────────
    headerJson: { type: DataTypes.JSON, allowNull: false },
    patientFieldsJson: { type: DataTypes.JSON, allowNull: false },
    sidebarJson: { type: DataTypes.JSON, allowNull: false },
    bodyJson: { type: DataTypes.JSON, allowNull: false },
    footerJson: { type: DataTypes.JSON, allowNull: false },

    rxNumberPrefix: { type: DataTypes.STRING(10), allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "prescription_templates" }
);

module.exports = PrescriptionTemplate;
