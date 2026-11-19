/**
 * The success-side counterpart to ApiError. Every controller returns through
 * these helpers so the response envelope is identical everywhere:
 *
 *   { "success": true, "message": "...", "data": <payload> }
 *
 * This is exactly the shape the frontend's `ApiResponse<T>` type expects
 * (see frontend/src/types/common.ts), so the axios layer can read `data.data`
 * unchanged.
 */

/** 200 OK with a payload. */
function ok(res, data = null, message = "OK") {
  return res.status(200).json({ success: true, message, data });
}

/** 201 Created with a payload. */
function created(res, data = null, message = "Created") {
  return res.status(201).json({ success: true, message, data });
}

/**
 * A "bare" payload response — the body is exactly `{ data: <payload> }` with no
 * success/message wrapper. Used only by `/auth/refresh`, because the frontend
 * interceptor reads the token pair directly from `data.data` on that route.
 */
function raw(res, data, status = 200) {
  return res.status(status).json({ data });
}

module.exports = { ok, created, raw };
