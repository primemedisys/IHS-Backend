/**
 * Process-level diagnostics: one structured JSON line for every way the API
 * process can stop, so "the backend stopped" always leaves its reason in the
 * log (nodemon in dev only prints "app crashed - waiting for file changes").
 *
 * Nothing here keeps a broken process alive: a fatal error is logged and the
 * process still exits non-zero, exactly as before. Logged errors carry name,
 * message, code and stack only — never request bodies, headers or env values.
 */
const startedAt = Date.now();

const mb = (n) => Math.round((n / 1024 / 1024) * 10) / 10;

function errorInfo(err) {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, code: err.code ?? null, stack: err.stack };
  }
  return { value: String(err) };
}

/** One JSON line on stderr: what happened, when, and the process's state at that moment. */
function logEvent(level, event, extra = {}) {
  const m = process.memoryUsage();
  const line = {
    level,
    event,
    at: new Date().toISOString(),
    pid: process.pid,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    rssMB: mb(m.rss),
    heapUsedMB: mb(m.heapUsed),
    ...extra,
  };
  (level === "info" ? console.log : console.error)(`[process] ${JSON.stringify(line)}`);
}

let installed = false;

/** Register the handlers once, before boot. */
function install() {
  if (installed) return;
  installed = true;

  // Fail loud: an unexpected async error means unknown state — log it, then exit(1).
  process.on("unhandledRejection", (reason) => {
    logEvent("fatal", "unhandledRejection", { error: errorInfo(reason) });
    process.exit(1);
  });
  process.on("uncaughtException", (err, origin) => {
    logEvent("fatal", "uncaughtException", { origin, error: errorInfo(err) });
    process.exit(1);
  });
  // Every exit — crash, signal, or a clean stop — is recorded with its code.
  process.on("exit", (code) => logEvent(code === 0 ? "info" : "error", "exit", { code }));
  process.on("warning", (w) => logEvent("warn", "processWarning", { error: errorInfo(w) }));
}

/**
 * The HTTP server's own errors. EADDRINUSE is the common one in dev (an older
 * API instance still holds the port) — say so plainly instead of a bare stack.
 */
function watchServer(server, port) {
  server.on("error", (err) => {
    const hint =
      err.code === "EADDRINUSE"
        ? `Port ${port} is already in use — another API instance (or an orphaned dev server) is running. Stop it, then start again.`
        : undefined;
    logEvent("fatal", "serverError", { port, hint, error: errorInfo(err) });
    process.exit(1);
  });
}

module.exports = { install, watchServer, logEvent, errorInfo };
