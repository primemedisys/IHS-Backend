/**
 * The Cloudinary SDK, configured ONCE from the validated env (CLOUDINARY_SETUP.md).
 *
 * Lazy: nothing is configured until a caller actually needs Cloudinary, so a
 * server on the `local` driver without credentials never touches the SDK. The
 * secret is handed to the SDK and nowhere else — it is never logged, never put
 * in a response, and never needed by any client.
 */
const env = require("./env");

let sdk = null;

/** True when all three credentials are present (whatever the active driver). */
const isConfigured = () =>
  Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);

/** The configured `cloudinary.v2` instance. Throws when credentials are missing. */
function getCloudinary() {
  if (!isConfigured()) {
    throw new Error(
      "Cloudinary is not configured — set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in backend/.env"
    );
  }
  if (!sdk) {
    // eslint-disable-next-line global-require
    const { v2 } = require("cloudinary");
    v2.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    sdk = v2;
  }
  return sdk;
}

/** Test seam: swap in a fake SDK (isolated unit tests only). */
function _setCloudinaryForTests(fake) {
  sdk = fake;
}

module.exports = { isConfigured, getCloudinary, _setCloudinaryForTests };
