/**
 * Maps the `users` table (docs/dbstruct.md §1). One table, three roles.
 *
 * CRITICAL SECURITY RULE: the `defaultScope` excludes `password_hash`, so any
 * ordinary query (findByPk, findAll, associations) can NEVER accidentally leak
 * the hash. Login / change-password explicitly opt back in with the
 * `withPassword` scope. Do not remove the defaultScope.
 */
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const { ROLES, AUTH_PROVIDERS } = require("../config/constants");

const User = sequelize.define(
  "User",
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    role: { type: DataTypes.ENUM(...Object.values(ROLES)), allowNull: false },
    name: { type: DataTypes.STRING(150), allowNull: false },
    email: { type: DataTypes.STRING(190), allowNull: false, unique: true },
    phone: { type: DataTypes.STRING(20), allowNull: true },
    passwordHash: { type: DataTypes.STRING(255), allowNull: true },
    authProvider: {
      type: DataTypes.ENUM(...Object.values(AUTH_PROVIDERS)),
      allowNull: false,
      defaultValue: AUTH_PROVIDERS.LOCAL,
    },
    googleId: { type: DataTypes.STRING(190), allowNull: true, unique: true },
    profilePhotoUrl: { type: DataTypes.STRING(500), allowNull: true },
    // Registered Google location (structured). Mirrors the clinic_profiles
    // address columns so providers (MR / Medicine Store) can be found by the
    // same city/state matching the patient share flow uses. Nullable & legacy
    // rows keep NULL — no backfill, no invented coordinates.
    addressLine: { type: DataTypes.STRING(255), allowNull: true },
    city: { type: DataTypes.STRING(100), allowNull: true },
    state: { type: DataTypes.STRING(100), allowNull: true },
    pincode: { type: DataTypes.STRING(20), allowNull: true },
    lat: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    lng: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    isEmailVerified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isPhoneVerified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "users",
    // Never leak the password hash by default; opt back in only where needed.
    defaultScope: { attributes: { exclude: ["passwordHash"] } },
    scopes: {
      withPassword: { attributes: { include: ["passwordHash"] } },
    },
  }
);

module.exports = User;
