/**
 * Real-time delivery of in-app notifications over Socket.IO.
 *
 * The `medicine_notifications` row is ALWAYS the source of truth: it is
 * written first, and only after its transaction commits is it pushed to the
 * recipient's live sockets. A client that was offline (or whose app was
 * closed) simply fetches the rows over REST when it reconnects — nothing is
 * lost if a push is missed. Socket.IO cannot wake a closed app; that needs a
 * separate OS push service, which is not part of this phase.
 *
 * Security:
 *  - The handshake must carry a valid access JWT in `auth.token` (never the
 *    query string, which ends up in logs). It is verified with the SAME
 *    verifier as the HTTP `authenticate` middleware.
 *  - The server puts each socket in exactly ONE room, derived from the
 *    VERIFIED token subject: `user:<id>`. There is no client → server event to
 *    join or leave rooms, so a client can never listen to another user.
 *  - A socket is disconnected when its access token expires; the client
 *    refreshes the token and reconnects.
 *  - Payloads go to that one room only — nothing is broadcast.
 */
const { Server } = require("socket.io");
const env = require("../config/env");
const { verifyAccessToken } = require("../utils/accessToken");
const { MedicineNotification } = require("../models");
const { serializeNotification } = require("../utils/serializers");
const { REALTIME_NOTIFICATION_EVENT } = require("../config/constants");

let io = null;

const userRoom = (userId) => `user:${String(userId)}`;
const MAX_TIMER_MS = 2 ** 31 - 1;

function authError(code) {
  const err = new Error("Unauthorized");
  err.data = { code };
  return err;
}

function emitToUser(userId, event, payload) {
  if (!io || userId == null) return;
  io.to(userRoom(userId)).emit(event, payload);
}

/** Push freshly created notification rows — after commit when in a transaction. */
function pushRows(rows, options) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter((r) => r && r.id != null);
  if (!list.length) return;
  const send = () => {
    for (const row of list) emitToUser(row.userId, REALTIME_NOTIFICATION_EVENT, serializeNotification(row));
  };
  if (options?.transaction) options.transaction.afterCommit(send);
  else send();
}

let hooked = false;
function registerHooks() {
  if (hooked) return;
  hooked = true;
  // Every module writes notifications through this one model (create or
  // bulkCreate), so hooking it delivers ALL of them live without touching
  // the pharmacy / lab / blood / ambulance services.
  MedicineNotification.addHook("afterCreate", "realtimePush", (row, options) => pushRows(row, options));
  MedicineNotification.addHook("afterBulkCreate", "realtimePush", (rows, options) => pushRows(rows, options));
}

function init(httpServer) {
  if (io) return io;
  const origins = env.CLIENT_URL.split(",").map((u) => u.trim());
  io = new Server(httpServer, {
    path: "/socket.io",
    serveClient: false,
    // Browsers are held to the same origin list as the REST API. Native apps
    // send no Origin header and authenticate with the token like any client.
    cors: { origin: origins, credentials: true },
    // Clients never send data to the server on this channel.
    maxHttpBufferSize: 1024,
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string" || !token) return next(authError("UNAUTHENTICATED"));
    try {
      const user = verifyAccessToken(token);
      socket.data.user = { id: String(user.id), role: user.role, exp: user.exp };
      return next();
    } catch {
      return next(authError("TOKEN_INVALID"));
    }
  });

  io.on("connection", (socket) => {
    const { id, exp } = socket.data.user;
    socket.join(userRoom(id));
    if (exp) {
      const ms = Math.min(Math.max(exp * 1000 - Date.now(), 0), MAX_TIMER_MS);
      const timer = setTimeout(() => socket.disconnect(true), ms);
      socket.once("disconnect", () => clearTimeout(timer));
    }
    // Tells the client it is authenticated and subscribed, so it can fetch
    // anything it missed while disconnected.
    socket.emit("ready");
  });

  registerHooks();
  return io;
}

function close() {
  if (!io) return Promise.resolve();
  const server = io;
  io = null;
  return new Promise((resolve) => server.close(() => resolve()));
}

module.exports = { init, close, emitToUser, userRoom, registerHooks };
