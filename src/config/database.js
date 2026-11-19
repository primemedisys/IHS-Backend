/**
 * The single Sequelize instance for the whole app. Every model imports THIS
 * connection — there is exactly one pool, created once. Field names are
 * snake_case in MySQL, so `underscored: true` lets models use camelCase
 * attributes while Sequelize maps them to the real columns.
 */
const { Sequelize } = require("sequelize");
const env = require("./env");

const SLOW_QUERY_MS = 500;

const sequelize = new Sequelize(env.DB_NAME, env.DB_USER, env.DB_PASSWORD, {
  host: env.DB_HOST,
  port: env.DB_PORT,
  dialect: "mysql",
  // Statements are NOT printed by default (they flood the terminal and can carry
  // patient data). Slow queries (> SLOW_QUERY_MS) are always reported, with the
  // timing; set DB_SQL_LOG=true in development to see every statement.
  benchmark: true,
  logging: (msg, ms) => {
    if (env.DB_SQL_LOG && env.NODE_ENV === "development") console.log(`[sql] ${msg}`);
    else if (typeof ms === "number" && ms > SLOW_QUERY_MS) console.warn(`[sql:slow ${ms}ms] ${String(msg).replace(/^Executed (.*?): /, "").slice(0, 300)}`);
  },
  define: {
    underscored: true, // camelCase attribute -> snake_case column
    freezeTableName: true, // use the exact tableName we give, no pluralization
    timestamps: false, // the schema manages created_at/updated_at itself
  },
  pool: { max: 10, min: 0, acquire: 30_000, idle: 10_000 },
});

module.exports = sequelize;
