/**
 * OpenAPI 3.0 spec for the API, served by swagger-ui-express at `${API_PREFIX}/docs`
 * (and as raw JSON at `${API_PREFIX}/docs.json`). The whole contract is defined
 * here as a plain object — no scattered JSDoc to keep in sync — so it doubles as
 * the single human-readable reference for the auth endpoints.
 */
const env = require("./env");

// ── Reusable components ─────────────────────────────────────────────────────
const components = {
  securitySchemes: {
    bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
  },
  schemas: {
    User: {
      type: "object",
      properties: {
        id: { type: "string", example: "12" },
        name: { type: "string", example: "Dr. Rao" },
        email: { type: "string", format: "email", example: "rao@example.com" },
        role: { type: "string", enum: ["admin", "doctor", "patient"] },
        phone: { type: "string", nullable: true, example: "+91 90000 00000" },
        avatarUrl: { type: "string", nullable: true },
        isEmailVerified: { type: "boolean" },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
    },
    Tokens: {
      type: "object",
      properties: {
        accessToken: { type: "string", example: "eyJhbGciOi..." },
        refreshToken: { type: "string", example: "9f2c8a..." },
      },
    },
    AuthPayload: {
      type: "object",
      properties: {
        user: { $ref: "#/components/schemas/User" },
        tokens: { $ref: "#/components/schemas/Tokens" },
      },
    },
    Error: {
      type: "object",
      properties: {
        error: {
          type: "object",
          properties: {
            message: { type: "string" },
            code: { type: "string" },
            details: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
          },
        },
      },
    },
    // ── Contact inbox ─────────────────────────────────────────────────────────
    ContactMessage: {
      type: "object",
      properties: {
        id: { type: "string", example: "42" },
        name: { type: "string" },
        email: { type: "string", format: "email" },
        phone: { type: "string", nullable: true },
        message: { type: "string" },
        handled: { type: "boolean" },
        createdAt: { type: "string", format: "date-time" },
      },
    },
    // ── Doctor registration & portfolio ──────────────────────────────────────
    Specialization: {
      type: "object",
      properties: {
        id: { type: "integer", example: 1 },
        name: { type: "string", example: "Cardiologist" },
        slug: { type: "string", example: "cardiologist" },
      },
    },
    SubSpecialization: {
      type: "object",
      properties: {
        id: { type: "integer", example: 12 },
        name: { type: "string", example: "Spine Surgery" },
        slug: { type: "string", example: "orthopaedics-spine-surgery" },
        specializationId: { type: "integer", example: 5 },
      },
    },
    Language: {
      type: "object",
      properties: { id: { type: "integer", example: 1 }, name: { type: "string", example: "English" } },
    },
    OnboardingStatus: {
      type: "object",
      properties: {
        steps: {
          type: "object",
          properties: {
            professional: { type: "boolean" },
            specialties: { type: "boolean" },
            portfolio: { type: "boolean" },
            documents: { type: "boolean" },
            clinics: { type: "boolean", nullable: true },
            availability: { type: "boolean", nullable: true },
            bank: { type: "boolean", nullable: true },
          },
        },
        canSubmit: { type: "boolean" },
        isSubmitted: { type: "boolean" },
        verificationStatus: { type: "string", enum: ["pending", "approved", "rejected"] },
        verificationNotes: { type: "string", nullable: true },
      },
    },
    DoctorProfile: {
      type: "object",
      properties: {
        id: { type: "string" },
        slug: { type: "string", example: "dr-asha-rao-12" },
        qualification: { type: "string", nullable: true },
        registrationNumber: { type: "string", nullable: true },
        experienceYears: { type: "integer" },
        bio: { type: "string", nullable: true },
        onlineFee: { type: "number", nullable: true },
        verificationStatus: { type: "string", enum: ["pending", "approved", "rejected"] },
        verificationNotes: { type: "string", nullable: true },
        isSubmitted: { type: "boolean" },
        isListed: {
          type: "boolean",
          description:
            "Admin public-visibility toggle. false hides an approved doctor from every patient-facing read (discovery, map, portfolio, related, slots, new bookings) without touching their account or existing bookings.",
        },
        avgRating: { type: "number" },
        ratingCount: { type: "integer" },
        name: { type: "string", nullable: true },
        photoUrl: { type: "string", nullable: true },
        showcaseImageUrl: { type: "string", nullable: true },
        specializations: { type: "array", items: { $ref: "#/components/schemas/Specialization" } },
        languages: { type: "array", items: { $ref: "#/components/schemas/Language" } },
        awards: { type: "array", items: { type: "object" } },
        links: { type: "array", items: { type: "object" } },
        documents: { type: "array", items: { type: "object" } },
        keywords: { type: "array", items: { type: "object" } },
      },
    },
    PublicDoctor: {
      type: "object",
      description: "Public portfolio, mapped onto the frontend DoctorDetail type.",
      properties: {
        id: { type: "string" },
        slug: { type: "string" },
        name: { type: "string" },
        specialtyName: { type: "string" },
        qualifications: { type: "array", items: { type: "string" } },
        experienceYears: { type: "integer" },
        languages: { type: "array", items: { type: "string" } },
        about: { type: "string" },
        showcaseImageUrl: { type: "string", nullable: true },
        verified: { type: "boolean" },
        rating: { type: "number" },
        reviewsCount: { type: "integer" },
        onlineFee: { type: "number" },
        clinics: { type: "array", items: { type: "object" } },
        reviews: { type: "array", items: { type: "object" } },
      },
    },
    WeeklySlot: {
      type: "object",
      required: ["dayOfWeek", "startTime", "endTime"],
      properties: {
        dayOfWeek: { type: "integer", minimum: 0, maximum: 6, description: "0=Sunday .. 6=Saturday" },
        startTime: { type: "string", example: "10:00" },
        endTime: { type: "string", example: "13:00" },
        slotDurationMinutes: { type: "integer", default: 15 },
      },
    },
    Booking: {
      type: "object",
      description: "A booking as returned to the patient (doctor + clinic summary + payment state).",
      properties: {
        id: { type: "string" },
        mode: { type: "string", enum: ["video", "clinic"] },
        doctor: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, slug: { type: "string" }, specialtyName: { type: "string", nullable: true }, photoUrl: { type: "string", nullable: true } } },
        clinic: { type: "object", nullable: true, properties: { name: { type: "string" }, address: { type: "string" }, city: { type: "string", nullable: true } } },
        date: { type: "string", format: "date" },
        startTime: { type: "string", example: "10:30" },
        endTime: { type: "string", example: "10:45" },
        status: { type: "string", enum: ["pending_payment", "confirmed", "completed", "cancelled", "no_show"] },
        amount: { type: "number" },
        paymentMode: { type: "string", enum: ["online", "offline"] },
        meetLink: { type: "string", nullable: true },
        payment: {
          type: "object",
          nullable: true,
          properties: {
            status: { type: "string", enum: ["initiated", "success", "failed", "refunded", "pending_at_clinic"] },
            mode: { type: "string", enum: ["online", "offline"], nullable: true },
            offlineMethod: { type: "string", enum: ["cash", "upi_qr"], nullable: true, description: "Offline payments only (migration 044)" },
            payerReference: { type: "string", nullable: true, description: "UPI reference the patient REPORTED (unverified)" },
            reportedAt: { type: "string", format: "date-time", nullable: true },
          },
        },
      },
    },
    VideoSession: {
      type: "object",
      description: "The runtime state of a video consult's LiveKit room (docs/video-consultation).",
      properties: {
        status: { type: "string", enum: ["pending", "live", "ended"] },
        roomName: { type: "string", example: "consult-77" },
        startedAt: { type: "string", format: "date-time", nullable: true },
        endedAt: { type: "string", format: "date-time", nullable: true },
        durationSec: { type: "integer", nullable: true },
        doctorJoined: { type: "boolean" },
        patientJoined: { type: "boolean" },
      },
    },
    VideoToken: {
      type: "object",
      description: "A LiveKit join grant. `url` is the public SFU URL; `token` is a short-lived, room-scoped JWT. The API secret is never returned.",
      properties: {
        url: { type: "string", example: "wss://project.livekit.cloud" },
        token: { type: "string" },
        roomName: { type: "string", example: "consult-77" },
        session: { oneOf: [{ $ref: "#/components/schemas/VideoSession" }, { type: "null" }] },
      },
    },
    PatientSnapshot: {
      type: "object",
      description: "The clinical data a doctor sees for a confirmed booking (the data the patient saved).",
      properties: {
        name: { type: "string" },
        phone: { type: "string", nullable: true },
        age: { type: "integer", nullable: true },
        gender: { type: "string", enum: ["male", "female", "other"], nullable: true },
        bloodGroup: { type: "string" },
        city: { type: "string", nullable: true },
        allergies: { type: "array", items: { type: "object" } },
        conditions: { type: "array", items: { type: "object" } },
        currentMedications: { type: "array", items: { type: "object" } },
        uploadedRecords: { type: "array", items: { type: "object" } },
      },
    },
    PatientProfile: {
      type: "object",
      description: "The patient's own profile + the completeness status the booking gate reads.",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        email: { type: "string", format: "email" },
        phone: { type: "string", nullable: true },
        avatarUrl: { type: "string", nullable: true },
        dateOfBirth: { type: "string", format: "date", nullable: true },
        gender: { type: "string", enum: ["male", "female", "other"], nullable: true },
        bloodGroup: { type: "string", enum: ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"] },
        addressLine: { type: "string", nullable: true },
        city: { type: "string", nullable: true },
        state: { type: "string", nullable: true },
        pincode: { type: "string", nullable: true },
        status: {
          type: "object",
          properties: {
            complete: { type: "boolean" },
            missing: { type: "array", items: { type: "string" }, example: ["dateOfBirth", "city"] },
          },
        },
      },
    },
  },
};

/** Wrap a data schema in the standard `{ success, message, data }` envelope. */
const envelope = (dataSchema) => ({
  type: "object",
  properties: {
    success: { type: "boolean", example: true },
    message: { type: "string" },
    data: dataSchema,
  },
});

const jsonBody = (schema) => ({ content: { "application/json": { schema } } });
const errorResponse = (desc) => ({ description: desc, ...jsonBody({ $ref: "#/components/schemas/Error" }) });

// Shared request-body shapes
const emailPw = {
  type: "object",
  required: ["email", "password"],
  properties: { email: { type: "string", format: "email" }, password: { type: "string" } },
};

// ── Dashboards & earnings shapes (docs/dashboards-earnings/integration-plan.md §2)
const periodParams = [
  { name: "from", in: "query", schema: { type: "string", format: "date-time" }, description: "Inclusive start. Defaults to 6 months back." },
  { name: "to", in: "query", schema: { type: "string", format: "date-time" }, description: "EXCLUSIVE end (half-open range). Must be greater than `from`." },
];
const granularityParam = {
  name: "granularity",
  in: "query",
  schema: { type: "string", enum: ["month", "day"], default: "month" },
};

/** Money is a JSON number of RUPEES (2 dp), never paise and never a string. */
const money = (description) => ({ type: "number", format: "double", description });

const dashboardSchemas = {
  PatientDashboard: {
    type: "object",
    properties: {
      upcoming: { type: "integer" },
      completed: { type: "integer" },
      pendingPayment: { type: "integer" },
      doctorsConsulted: { type: "integer" },
      totalSpent: money("Gross paid by the patient. Commission is never exposed here."),
      nextAppointment: { type: "object", nullable: true },
    },
  },
  DoctorDashboard: {
    type: "object",
    properties: {
      todaysAppointments: { type: "integer", description: "Confirmed + completed today (= todaysClinic + todaysVideo)" },
      todaysClinic: { type: "integer", description: "Of today's: booking_type offline (clinic)" },
      todaysVideo: { type: "integer", description: "Of today's: booking_type online (video)" },
      patientsThisMonth: { type: "integer" },
      averageRating: { type: "number", nullable: true, description: "Always null — no reviews table. Render as an em-dash, never 0." },
      earnedThisMonth: money("SUM(doctor_payout_amount) for the current IST month."),
      totalPatients: { type: "integer", description: "All-time distinct patients with a confirmed or completed booking" },
      consultedPatients: { type: "integer", description: "All-time distinct patients with a completed booking" },
      totalRevenue: money("All-time SUM(doctor_payout_amount) over successful payments only."),
      appointments: {
        type: "object",
        description: "Non-cancelled bookings. today + previous + upcoming = total (IST slot date); pending = awaiting payment or confirmed.",
        properties: {
          today: { type: "integer" },
          total: { type: "integer" },
          pending: { type: "integer" },
          previous: { type: "integer" },
          upcoming: { type: "integer" },
        },
      },
    },
  },
  EarningsSummary: {
    type: "object",
    properties: {
      period: { type: "object", properties: { from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" } } },
      gross: money("SUM(amount)"),
      commission: money("SUM(commission_amount) — the platform's cut"),
      net: money("SUM(doctor_payout_amount) — the headline figure the doctor is paid"),
      refunded: money("SUM(refund_amount), bucketed by refunded_at"),
      consults: { type: "integer" },
      averagePerConsult: { type: "number", nullable: true, description: "null when consults === 0 — not 0, not NaN." },
      awaitingCollection: money("pending_at_clinic cash owed by patients, NOT a platform payout"),
    },
  },
  EarningsSeries: {
    type: "object",
    properties: {
      granularity: { type: "string", enum: ["month", "day"] },
      buckets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            bucket: { type: "string", description: "Opaque IST label: `2026-07` or `2026-07-04`. Not an instant." },
            gross: money(), commission: money(), net: money(), consults: { type: "integer" },
          },
        },
      },
    },
  },
  Ledger: {
    type: "object",
    properties: {
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            paidAt: { type: "string", format: "date-time" },
            date: { type: "string", format: "date" },
            patientName: { type: "string", nullable: true },
            mode: { type: "string", enum: ["online", "offline"], description: "PAYMENT mode, not booking mode." },
            gross: money(), commission: money(), net: money(),
          },
        },
      },
      page: { type: "integer" }, limit: { type: "integer" },
      total: { type: "integer" }, totalPages: { type: "integer" },
    },
  },
  AdminDashboard: {
    type: "object",
    properties: {
      verifiedDoctors: { type: "integer" },
      pendingVerifications: { type: "integer" },
      bookingsThisMonth: { type: "integer" },
      platformRevenue: money("SUM(commission_amount) — the platform's income, NOT GMV"),
      gmv: money("SUM(amount) — total transacted"),
      doctorPayouts: money("SUM(doctor_payout_amount). platformRevenue + doctorPayouts === gmv"),
    },
  },
  RevenueSeries: {
    type: "object",
    properties: {
      granularity: { type: "string", enum: ["month", "day"] },
      buckets: { type: "array", items: { type: "object", properties: { bucket: { type: "string" }, gmv: money(), commission: money(), payouts: money(), bookings: { type: "integer" } } } },
    },
  },
  TopDoctors: {
    type: "object",
    properties: {
      rows: { type: "array", items: { type: "object", properties: { doctorId: { type: "string" }, name: { type: "string" }, net: money(), consults: { type: "integer" } } } },
    },
  },
};

// ── Treatment timeline (docs/treatment-timeline) ────────────────────────────
/** `month` without `year` is allowed: "every March, any year". */
const timelineQueryParams = [
  { name: "year", in: "query", schema: { type: "integer", minimum: 2000, maximum: 2100 } },
  { name: "month", in: "query", schema: { type: "integer", minimum: 1, maximum: 12 } },
  { name: "sort", in: "query", schema: { type: "string", enum: ["newest", "oldest"], default: "newest" } },
];

const timelineRowSchema = {
  type: "object",
  properties: {
      bookingId: { type: "string" },
      date: { type: "string", format: "date", example: "2026-07-02" },
      startTime: { type: "string", nullable: true, example: "10:30" },
      mode: { type: "string", enum: ["clinic", "video"] },
      location: {
        type: "object",
        nullable: true,
        description: "NULL for a video consult — the UI supplies the label.",
        properties: { name: { type: "string" }, city: { type: "string", nullable: true } },
      },
      doctor: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string", nullable: true },
          specialization: { type: "string", nullable: true },
        },
      },
      issue: {
        type: "string",
        nullable: true,
        description: "Note diagnosis → prescription diagnosis → note complaints → null.",
      },
      prescription: {
        type: "object",
        nullable: true,
        description:
          "`id` is NULL and `canView` false for a DOCTOR viewer — the PDF is patient-only, enforced by omitting the id rather than by a flag the client could ignore.",
        properties: {
          id: { type: "string", nullable: true },
          rxNumber: { type: "string", nullable: true },
          canView: { type: "boolean" },
        },
    },
  },
};

// ── Vitals reference ranges (docs/vitals-reference-ranges) ──────────────────
const vitalsSchemas = {
  VitalsMatrix: {
    type: "object",
    description:
      "The record table: `fields` are the parameters, `entries` the dated readings. `entries[].statuses` is a PARALLEL map to `values` — added without touching `values`, so existing consumers are unaffected.",
    properties: {
      fields: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            label: { type: "string" },
            unit: { type: "string" },
            derived: { type: "boolean" },
            normal: {
              type: "object",
              nullable: true,
              description:
                "The adult reference range. ABSENT for Weight and Height — neither has one (weight's signal is BMI), and a field with no `normal` is never coloured.",
              properties: {
                min: { type: "number", nullable: true },
                max: { type: "number", nullable: true },
                display: { type: "string", description: "BP only, e.g. \"< 130/85\"" },
              },
            },
          },
        },
      },
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            recordedOn: { type: "string", format: "date" },
            source: { type: "string", enum: ["patient", "doctor"] },
            note: { type: "string", nullable: true },
            location: { type: "string", nullable: true },
            values: { type: "object", description: "Raw values, unchanged." },
            statuses: {
              type: "object",
              description:
                "Per-field band. `unknown` means NOT EVALUATED (patient under 18, no date of birth, unparseable value, or a field with no reference range) — it does NOT mean normal. Colour encodes SEVERITY, not direction: a dangerously LOW SpO₂ or temperature is `critical`, never `low`.",
              additionalProperties: {
                type: "object",
                properties: {
                  status: {
                    type: "string",
                    enum: ["normal", "low", "borderline", "high", "critical", "unknown"],
                  },
                  label: { type: "string", example: "Tachycardia" },
                  normal: { type: "object", nullable: true },
                  reason: { type: "string", example: "adult_ranges_only" },
                },
              },
            },
          },
        },
      },
    },
  },
};

const timelineSchemas = {
  Timeline: {
    type: "object",
    properties: {
      // Reused by JS reference, not `$ref`: `components.schemas` is assembled
      // above this block, and the sibling dashboard schemas inline the same way.
      rows: { type: "array", items: timelineRowSchema },
      years: {
        type: "array",
        items: { type: "integer" },
        description: "Every year the patient has consultations in — computed over the FULL history, not the capped page.",
      },
      total: { type: "integer" },
      capped: { type: "boolean", description: "true when the 200-row cap was hit." },
    },
  },
  DoctorPatients: {
    type: "object",
    properties: {
      patients: {
        type: "array",
        items: {
          type: "object",
          properties: {
            patient: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string", nullable: true },
                photoUrl: { type: "string", nullable: true },
              },
            },
            consultationCount: { type: "integer" },
            lastSeenOn: { type: "string", format: "date", nullable: true },
          },
        },
      },
      total: { type: "integer" },
      capped: { type: "boolean" },
    },
  },
};

// ── Paths ───────────────────────────────────────────────────────────────────
const paths = {
  "/files/{token}/{name}": {
    get: {
      tags: ["Files"],
      summary: "Open a private stored file through a signed, expiring link",
      description:
        "Private files (records, reports, prescriptions, certificates, letterhead assets) are never returned as storage URLs. " +
        "Any API response that references one carries this link instead, minted by the server inside an already-authorised response " +
        "and valid for FILE_URL_TTL_MINUTES–2×FILE_URL_TTL_MINUTES. No bearer token is needed (it is opened from <img>/<iframe>/new tab). " +
        "Passive formats (images, PDF, txt, csv) render inline; Word, Excel, RTF, DICOM download as attachments. See CLOUDINARY_SETUP.md.",
      security: [],
      parameters: [
        { name: "token", in: "path", required: true, schema: { type: "string" }, description: "Server-signed link token" },
        { name: "name", in: "path", required: true, schema: { type: "string" }, description: "Display file name (keeps the extension for viewers; not used for lookup)" },
      ],
      responses: {
        200: { description: "The file bytes, with its Content-Type", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
        403: errorResponse("Link expired (FILE_LINK_EXPIRED) — reload the page for a fresh link"),
        404: errorResponse("Unknown, forged or missing file"),
      },
    },
  },
  "/auth/register": {
    post: {
      tags: ["Auth"],
      summary: "Local signup (doctor/patient)",
      requestBody: jsonBody({
        type: "object",
        required: ["name", "email", "password", "role"],
        properties: {
          name: { type: "string" },
          email: { type: "string", format: "email" },
          phone: { type: "string", nullable: true },
          password: { type: "string", description: "min 8 chars, ≥1 letter and ≥1 number" },
          role: { type: "string", enum: ["doctor", "patient", "clinic", "medicine_store", "pharmacy_hospital", "diagnostic_lab", "blood_bank"], description: "A clinic self-registers but stays verification_status='pending' until an admin approves it. Pharmacies (medicine_store / pharmacy_hospital) and Diagnostic Lab Centers (diagnostic_lab) are usable immediately, send their Google location (addressLine/city/state/pincode/lat/lng) and sign in through POST /auth/medicine/login." },
        },
      }),
      responses: {
        201: { description: "Registered", ...jsonBody(envelope({ $ref: "#/components/schemas/AuthPayload" })) },
        409: errorResponse("Email already registered"),
        422: errorResponse("Validation failed"),
      },
    },
  },
  "/auth/login": {
    post: {
      tags: ["Auth"],
      summary: "Local login (doctor/patient) by email OR mobile number",
      description:
        "Send exactly one of `email` / `phone`. `phone` is a 10-digit Indian mobile (`+91`, `0`, spaces and dashes are accepted). Phone numbers are not unique: only accounts of the `audience` role are considered, and the password picks the account; if it fits more than one, 409 PHONE_SHARED asks the user to sign in by email.",
      requestBody: jsonBody({
        type: "object",
        required: ["password"],
        properties: {
          email: { type: "string", format: "email" },
          phone: { type: "string", example: "9876543210" },
          password: { type: "string" },
          audience: { type: "string", enum: ["doctor", "patient"], description: "Calling portal; a valid-but-wrong-role account is rejected with WRONG_PORTAL." },
        },
      }),
      responses: {
        200: { description: "Logged in", ...jsonBody(envelope({ $ref: "#/components/schemas/AuthPayload" })) },
        401: errorResponse("Invalid credentials"),
        403: errorResponse("Wrong portal for this account (WRONG_PORTAL)"),
        409: errorResponse("Mobile number shared by several accounts that this password fits (PHONE_SHARED)"),
        422: errorResponse("Neither/both of email and phone, or an invalid mobile number"),
        429: errorResponse("Rate limited"),
      },
    },
  },
  "/auth/google": {
    post: {
      tags: ["Auth"],
      summary: "Google signup/signin",
      requestBody: jsonBody({
        type: "object",
        required: ["credential"],
        properties: {
          credential: { type: "string", description: "Google ID token from the Identity button" },
          role: { type: "string", enum: ["doctor", "patient"], description: "required only for a new account" },
        },
      }),
      responses: {
        200: { description: "Logged in", ...jsonBody(envelope({ $ref: "#/components/schemas/AuthPayload" })) },
        400: errorResponse("Role required for new account"),
        401: errorResponse("Invalid Google credential"),
      },
    },
  },
  "/auth/admin/login": {
    post: {
      tags: ["Auth"],
      summary: "Admin-only login",
      requestBody: jsonBody(emailPw),
      responses: {
        200: { description: "Admin logged in", ...jsonBody(envelope({ $ref: "#/components/schemas/AuthPayload" })) },
        401: errorResponse("Invalid credentials"),
      },
    },
  },
  "/auth/clinic/login": {
    post: {
      tags: ["Clinic Portal"],
      summary: "Clinic-only login",
      description:
        "Admits ONLY `role='clinic'`. A doctor/patient/admin is rejected here, and a clinic is rejected by `/auth/login` and `/auth/admin/login` — the allowed roles belong to the ROUTE, not to a client-supplied `audience`.",
      requestBody: jsonBody(emailPw),
      responses: {
        200: { description: "Clinic logged in", ...jsonBody(envelope({ $ref: "#/components/schemas/AuthPayload" })) },
        401: errorResponse("Invalid credentials"),
        429: errorResponse("Rate limited"),
      },
    },
  },
  "/auth/clinic/google": {
    post: {
      tags: ["Clinic Portal"],
      summary: "Clinic Google signup/signin",
      description:
        "A brand-new account from this button is ALWAYS created as `role='clinic'`, regardless of what the client sends. An existing doctor/patient/admin pressing it gets WRONG_PORTAL.",
      requestBody: jsonBody({
        type: "object",
        required: ["credential"],
        properties: { credential: { type: "string", description: "Google ID token from the Identity button" } },
      }),
      responses: {
        200: { description: "Logged in", ...jsonBody(envelope({ $ref: "#/components/schemas/AuthPayload" })) },
        403: errorResponse("Wrong portal for this account (WRONG_PORTAL)"),
      },
    },
  },
  "/auth/refresh": {
    post: {
      tags: ["Auth"],
      summary: "Rotate session tokens",
      description: "Returns the token pair directly under `data` (no success/message wrapper).",
      requestBody: jsonBody({
        type: "object",
        required: ["refreshToken"],
        properties: { refreshToken: { type: "string" } },
      }),
      responses: {
        200: {
          description: "New token pair",
          ...jsonBody({ type: "object", properties: { data: { $ref: "#/components/schemas/Tokens" } } }),
        },
        401: errorResponse("Invalid/expired/reused refresh token"),
      },
    },
  },
  "/auth/forgot-password": {
    post: {
      tags: ["Auth"],
      summary: "Request a password reset link",
      description: "Always 200 (no user enumeration).",
      requestBody: jsonBody({
        type: "object",
        required: ["email"],
        properties: { email: { type: "string", format: "email" } },
      }),
      responses: { 200: { description: "Accepted", ...jsonBody(envelope({ nullable: true })) } },
    },
  },
  "/auth/forgot-password/otp": {
    post: {
      tags: ["Auth"],
      summary: "Request a password-reset code by SMS or email (patients / doctors)",
      description:
        "Send exactly one of `phone` (SMS) or `email` (email code). `audience` picks whose account may be reset (default patient; the doctor website/app send doctor). Always 200 when the channel is configured, whether or not the account exists (no enumeration); a per-number/per-address resend gap and hourly cap silently apply. 503 SMS_UNAVAILABLE / EMAIL_UNAVAILABLE when that channel isn't configured or delivery failed.",
      requestBody: jsonBody({
        type: "object",
        properties: {
          phone: { type: "string", example: "9876543210" },
          email: { type: "string", example: "doctor@example.com" },
          audience: { type: "string", enum: ["patient", "doctor"], default: "patient" },
        },
      }),
      responses: {
        200: { description: "Accepted", ...jsonBody(envelope({ nullable: true })) },
        422: errorResponse("Invalid mobile number / email, or both / neither sent"),
        429: errorResponse("Rate limited"),
        503: errorResponse("Channel not configured / not delivered (SMS_UNAVAILABLE, EMAIL_UNAVAILABLE)"),
      },
    },
  },
  "/auth/forgot-password/otp/verify": {
    post: {
      tags: ["Auth"],
      summary: "Verify the reset code (SMS or email) and get a single-use reset token",
      description:
        "On success returns `{ resetToken }` (valid 15 min) to spend on POST /auth/reset-password. Codes expire (PASSWORD_OTP_TTL_MINUTES) and burn after PASSWORD_OTP_MAX_ATTEMPTS misses.",
      requestBody: jsonBody({
        type: "object",
        required: ["otp"],
        properties: {
          phone: { type: "string" },
          email: { type: "string" },
          otp: { type: "string", example: "123456" },
          audience: { type: "string", enum: ["patient", "doctor"], default: "patient" },
        },
      }),
      responses: {
        200: {
          description: "Verified",
          ...jsonBody(envelope({ type: "object", properties: { resetToken: { type: "string" } } })),
        },
        400: errorResponse("Incorrect or expired code (OTP_INVALID)"),
        409: errorResponse("Number shared by several accounts; use email reset (PHONE_SHARED)"),
        429: errorResponse("Rate limited"),
      },
    },
  },
  "/auth/reset-password": {
    post: {
      tags: ["Auth"],
      summary: "Reset password with a token",
      requestBody: jsonBody({
        type: "object",
        required: ["token", "password"],
        properties: { token: { type: "string" }, password: { type: "string" } },
      }),
      responses: {
        200: { description: "Password reset", ...jsonBody(envelope({ nullable: true })) },
        400: errorResponse("Invalid or expired token"),
      },
    },
  },
  "/auth/me": {
    get: {
      tags: ["Auth"],
      summary: "Current user + role profile",
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: "Current user", ...jsonBody(envelope({ $ref: "#/components/schemas/User" })) },
        401: errorResponse("Unauthenticated"),
      },
    },
  },
  "/auth/profile": {
    patch: {
      tags: ["Auth"],
      summary: "Update own profile",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({
        type: "object",
        properties: {
          name: { type: "string" },
          phone: { type: "string", nullable: true },
          avatarUrl: { type: "string", nullable: true },
          doctor: { type: "object" },
          patient: { type: "object" },
        },
      }),
      responses: {
        200: { description: "Updated", ...jsonBody(envelope({ $ref: "#/components/schemas/User" })) },
        401: errorResponse("Unauthenticated"),
        422: errorResponse("Validation failed"),
      },
    },
  },
  "/auth/change-password": {
    post: {
      tags: ["Auth"],
      summary: "Change password while logged in",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({
        type: "object",
        required: ["currentPassword", "newPassword"],
        properties: { currentPassword: { type: "string" }, newPassword: { type: "string" } },
      }),
      responses: {
        200: { description: "Changed", ...jsonBody(envelope({ nullable: true })) },
        400: errorResponse("Current password incorrect"),
      },
    },
  },
  "/auth/logout": {
    post: {
      tags: ["Auth"],
      summary: "Revoke the current refresh token",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({
        type: "object",
        properties: { refreshToken: { type: "string" } },
      }),
      responses: { 200: { description: "Logged out", ...jsonBody(envelope({ nullable: true })) } },
    },
  },

  // ── Doctors (public) ────────────────────────────────────────────────────────
  "/doctors": {
    get: {
      tags: ["Doctors (public)"],
      summary: "Discovery list (approved doctors) — filtered, sorted, paginated",
      description:
        "Filtering, sorting and paging all run in SQL. `specialtySlug` matches ANY of a doctor's specialties. `city`, `stateCode` and `symptomSlug` accept either the display text or its slugified form, and match against any ACTIVE clinic. `maxFee`/`sort=fee` use the listing price (the cheapest of the online fee and the active clinic fees).",
      parameters: [
        { name: "search", in: "query", description: "Matches doctor name, specialty name, clinic name or clinic city.", schema: { type: "string" } },
        { name: "specialtySlug", in: "query", schema: { type: "string" } },
        { name: "subSpecialtySlug", in: "query", schema: { type: "string" }, description: "Catalog sub-specialty slug (GET /sub-specializations)" },
        { name: "excludeIds", in: "query", schema: { type: "string" }, description: "Comma-separated doctor ids to exclude (max 200)" },
        { name: "includeIds", in: "query", schema: { type: "string" }, description: "Comma-separated doctor ids to restrict the results to (max 200)" },
        { name: "symptomSlug", in: "query", description: "Matches an approved doctor search keyword.", schema: { type: "string" } },
        { name: "stateCode", in: "query", schema: { type: "string" } },
        { name: "city", in: "query", schema: { type: "string" } },
        { name: "hospital", in: "query", description: "Substring match on clinic name.", schema: { type: "string" } },
        { name: "gender", in: "query", schema: { type: "string", enum: ["male", "female", "other"] } },
        { name: "language", in: "query", description: "Language name, e.g. `Hindi`.", schema: { type: "string" } },
        { name: "minExperience", in: "query", schema: { type: "integer", minimum: 0, maximum: 100 } },
        { name: "maxFee", in: "query", schema: { type: "number", minimum: 0 } },
        { name: "minRating", in: "query", schema: { type: "number", minimum: 0, maximum: 5 } },
        { name: "videoConsult", in: "query", description: "Only doctors with an active online schedule.", schema: { type: "boolean" } },
        { name: "verified", in: "query", description: "Accepted and ignored — the list is approved-only.", schema: { type: "boolean" } },
        { name: "available", in: "query", description: "Accepted and ignored — every listed doctor is available.", schema: { type: "boolean" } },
        { name: "sort", in: "query", schema: { type: "string", enum: ["relevance", "rating", "experience", "fee", "nearest"], default: "relevance" } },
        { name: "lat", in: "query", description: "Required with `lng` for `sort=nearest`; orders by distance from the doctor's primary clinic.", schema: { type: "number", minimum: -90, maximum: 90 } },
        { name: "lng", in: "query", description: "Required with `lat`.", schema: { type: "number", minimum: -180, maximum: 180 } },
        { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
        { name: "pageSize", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 9 } },
      ],
      responses: {
        200: { description: "Doctor list page", ...jsonBody(envelope({ type: "object" })) },
        422: errorResponse("Invalid filter (e.g. `lat` without `lng`)"),
      },
    },
  },
  "/doctors/{slug}/related": {
    get: {
      tags: ["Doctors (public)"],
      summary: "Other approved doctors in the same specialty",
      parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        200: { description: "Related doctors", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) },
      },
    },
  },
  "/doctors/{slug}": {
    get: {
      tags: ["Doctors (public)"],
      summary: "Public portfolio by slug (approved doctors only)",
      parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" }, example: "dr-asha-rao-12" }],
      responses: {
        200: { description: "Doctor profile", ...jsonBody(envelope({ $ref: "#/components/schemas/PublicDoctor" })) },
        404: errorResponse("Not found or not yet approved"),
      },
    },
  },
  "/specializations": {
    get: {
      tags: ["Doctors (public)"],
      summary: "Specialization lookup list",
      responses: {
        200: { description: "Specializations", ...jsonBody(envelope({ type: "array", items: { $ref: "#/components/schemas/Specialization" } })) },
      },
    },
  },
  "/sub-specializations": {
    get: {
      tags: ["Doctors (public)"],
      summary: "Sub-specialization lookup list (optionally for one parent)",
      parameters: [{ name: "specializationId", in: "query", required: false, schema: { type: "integer" } }],
      responses: {
        200: { description: "Sub-specializations", ...jsonBody(envelope({ type: "array", items: { $ref: "#/components/schemas/SubSpecialization" } })) },
      },
    },
  },
  "/languages": {
    get: {
      tags: ["Doctors (public)"],
      summary: "Language lookup list",
      responses: {
        200: { description: "Languages", ...jsonBody(envelope({ type: "array", items: { $ref: "#/components/schemas/Language" } })) },
      },
    },
  },

  // ── Contact (public) ─────────────────────────────────────────────────────────
  "/contact": {
    post: {
      tags: ["Contact (public)"],
      summary: "Submit the public contact form",
      description:
        "No auth. Rate-limited per IP (spam cap). Persists the message and best-effort emails the platform admin; the reply-to is set to the sender.",
      requestBody: jsonBody({
        type: "object",
        required: ["name", "email", "message"],
        properties: {
          name: { type: "string", minLength: 2, maxLength: 150, example: "Asha Rao" },
          email: { type: "string", format: "email", example: "asha@example.com" },
          phone: { type: "string", maxLength: 30, nullable: true, example: "+91 90000 00000" },
          message: { type: "string", minLength: 20, maxLength: 5000, example: "I'd like to know how clinics can partner with IHS." },
        },
      }),
      responses: {
        201: {
          description: "Message received",
          ...jsonBody(
            envelope({
              type: "object",
              properties: {
                id: { type: "string", example: "42" },
                name: { type: "string" },
                email: { type: "string", format: "email" },
                createdAt: { type: "string", format: "date-time" },
              },
            })
          ),
        },
        422: errorResponse("Validation failed"),
        429: errorResponse("Too many submissions — try again later"),
      },
    },
  },

  // ── Contact inbox (admin) ─────────────────────────────────────────────────────
  "/admin/contact-messages": {
    get: {
      tags: ["Contact (public)"],
      summary: "List contact-form submissions (admin inbox)",
      description: "Admin-only. Newest first, paginated. Optional `handled` filter (unread vs followed-up).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
        { name: "pageSize", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
        { name: "handled", in: "query", schema: { type: "boolean" } },
      ],
      responses: {
        200: {
          description: "Paginated contact messages",
          ...jsonBody(
            envelope({
              type: "object",
              properties: {
                data: { type: "array", items: { $ref: "#/components/schemas/ContactMessage" } },
                page: { type: "integer" },
                pageSize: { type: "integer" },
                total: { type: "integer" },
                totalPages: { type: "integer" },
              },
            })
          ),
        },
        401: errorResponse("Not authenticated"),
        403: errorResponse("Not an admin"),
      },
    },
  },
  "/admin/contact-messages/{id}": {
    patch: {
      tags: ["Contact (public)"],
      summary: "Toggle a message's followed-up flag (admin)",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: jsonBody({ type: "object", required: ["handled"], properties: { handled: { type: "boolean" } } }),
      responses: {
        200: { description: "Updated message", ...jsonBody(envelope({ $ref: "#/components/schemas/ContactMessage" })) },
        404: errorResponse("Message not found"),
      },
    },
  },

  // ── Doctor (owned) ──────────────────────────────────────────────────────────
  "/doctor/onboarding": {
    get: {
      tags: ["Doctor"],
      summary: "Onboarding completeness checklist (drives the wizard)",
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: "Onboarding status", ...jsonBody(envelope({ $ref: "#/components/schemas/OnboardingStatus" })) },
        403: errorResponse("Not a doctor"),
      },
    },
  },
  "/doctor/profile": {
    get: {
      tags: ["Doctor"],
      summary: "Own full draft profile (all relations)",
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: "Profile", ...jsonBody(envelope({ $ref: "#/components/schemas/DoctorProfile" })) },
        403: errorResponse("Not a doctor"),
      },
    },
    patch: {
      tags: ["Doctor"],
      summary: "Update professional/bio fields",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({
        type: "object",
        properties: {
          qualification: { type: "string" },
          registrationNumber: { type: "string" },
          experienceYears: { type: "integer" },
          bio: { type: "string" },
          onlineFee: { type: "number", nullable: true },
          headline: { type: "string", example: "Board-Certified Cardiologist" },
          gender: { type: "string", enum: ["male", "female", "other"] },
          practicePhilosophy: { type: "string" },
          publicPhone: { type: "string" },
          publicEmail: { type: "string", format: "email" },
          shortIntro: { type: "string", maxLength: 500, description: "One-to-two sentence introduction (migration 049)" },
          careerSummary: { type: "string", maxLength: 2000, description: "Short career overview (migration 049)" },
        },
      }),
      responses: {
        200: { description: "Updated", ...jsonBody(envelope({ $ref: "#/components/schemas/DoctorProfile" })) },
        409: errorResponse("Registration number already in use"),
        422: errorResponse("Validation failed"),
      },
    },
  },
  "/doctor/preview": {
    get: {
      tags: ["Doctor"],
      summary: "Own profile in the public shape (preview, any status)",
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: "Preview", ...jsonBody(envelope({ $ref: "#/components/schemas/PublicDoctor" })) },
        403: errorResponse("Not a doctor"),
      },
    },
  },
  "/doctor/specializations": {
    put: {
      tags: ["Doctor"],
      summary: "Replace the doctor's specialty set",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({
        type: "object",
        required: ["specializationIds"],
        properties: { specializationIds: { type: "array", items: { type: "integer" }, example: [1, 3] } },
      }),
      responses: {
        200: { description: "Updated", ...jsonBody(envelope({ $ref: "#/components/schemas/DoctorProfile" })) },
        422: errorResponse("Invalid ids"),
      },
    },
  },
  "/doctor/sub-specializations": {
    put: {
      tags: ["Doctor"],
      summary: "Replace the doctor's sub-specialty set",
      description:
        "Each id must belong to one of the doctor's saved specialties. An empty array clears the set. Saving specialties (PUT /doctor/specializations) drops sub-specialties whose parent was removed.",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({
        type: "object",
        required: ["subSpecializationIds"],
        properties: { subSpecializationIds: { type: "array", maxItems: 10, items: { type: "integer" }, example: [12, 14] } },
      }),
      responses: {
        200: { description: "Updated", ...jsonBody(envelope({ $ref: "#/components/schemas/DoctorProfile" })) },
        422: errorResponse("Invalid ids, or a sub-specialty outside the doctor's specialties"),
      },
    },
  },
  "/doctor/catalog/sub-specializations": {
    post: {
      tags: ["Doctor"],
      summary: "Add a sub-specialty to the shared catalog (find-or-create)",
      description:
        "Creates a sub-specialty under the given specialization so it appears in every doctor's picker. A case-insensitive name/slug match returns the existing row (200) instead of a duplicate. All-lowercase input is title-cased; other casing is kept. Does NOT change the doctor's own selection — follow with PUT /doctor/sub-specializations. Rate limited per doctor.",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({
        type: "object",
        required: ["specializationId", "name"],
        properties: {
          specializationId: { type: "integer", example: 5 },
          name: { type: "string", minLength: 2, maxLength: 100, example: "Limb Reconstruction" },
        },
      }),
      responses: {
        201: { description: "Created", ...jsonBody(envelope({ $ref: "#/components/schemas/SubSpecialization" })) },
        200: { description: "Already existed — the existing row", ...jsonBody(envelope({ $ref: "#/components/schemas/SubSpecialization" })) },
        422: errorResponse("Invalid name or unknown specialization"),
        429: errorResponse("Too many new sub-specialties"),
      },
    },
  },
  "/doctor/languages": {
    put: {
      tags: ["Doctor"],
      summary: "Replace the doctor's language set",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({
        type: "object",
        required: ["languageIds"],
        properties: { languageIds: { type: "array", items: { type: "integer" }, example: [1, 2] } },
      }),
      responses: { 200: { description: "Updated", ...jsonBody(envelope({ $ref: "#/components/schemas/DoctorProfile" })) } },
    },
  },

  // ── Doctor portfolio v2 sections (docs/doctor-portfolio-v2) ─────────────────
  // The 6 generic owned resources share the list/create + patch/delete shape.
  ...Object.fromEntries(
    [
      ["education", "an education entry"],
      ["experience", "a career experience entry"],
      ["services", "a service/procedure"],
      ["publications", "a publication"],
      ["memberships", "a membership (membershipNumber is public only when showMembershipNumber is true)"],
      ["faqs", "an FAQ"],
      // Migration 049
      ["affiliations", "a current (or, when isCurrent=false, past) affiliation"],
      ["fellowships", "a fellowship / advanced-training entry"],
      ["expertise", "an expertise entry (category: clinical | scientific | area | interest; 409 on a duplicate)"],
    ].flatMap(([key, label]) => [
      [
        `/doctor/${key}`,
        {
          get: { tags: ["Doctor"], summary: `List ${key}`, security: [{ bearerAuth: [] }], responses: { 200: { description: key, ...jsonBody(envelope({ type: "array", items: { type: "object" } })) } } },
          post: { tags: ["Doctor"], summary: `Add ${label}`, security: [{ bearerAuth: [] }], requestBody: jsonBody({ type: "object" }), responses: { 201: { description: "Created", ...jsonBody(envelope({ type: "object" })) }, 422: errorResponse("Validation failed") } },
        },
      ],
      [
        `/doctor/${key}/{id}`,
        {
          patch: { tags: ["Doctor"], summary: `Update ${label}`, security: [{ bearerAuth: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: jsonBody({ type: "object" }), responses: { 200: { description: "Updated", ...jsonBody(envelope({ type: "object" })) }, 404: errorResponse("Not found") } },
          delete: { tags: ["Doctor"], summary: `Remove ${label}`, security: [{ bearerAuth: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Removed", ...jsonBody(envelope({ nullable: true })) }, 404: errorResponse("Not found") } },
        },
      ],
    ])
  ),
  "/doctor/gallery": {
    get: { tags: ["Doctor"], summary: "List gallery images", security: [{ bearerAuth: [] }], responses: { 200: { description: "Gallery", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) } } },
    post: {
      tags: ["Doctor"],
      summary: "Upload a gallery image (multipart)",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["file"],
              properties: {
                file: { type: "string", format: "binary" },
                title: { type: "string", maxLength: 150 },
                caption: { type: "string", maxLength: 255 },
                category: { type: "string", enum: ["clinic", "facilities", "equipment", "events", "activities", "other"] },
                altText: { type: "string", maxLength: 255 },
                takenOn: { type: "string", format: "date" },
                consent: { type: "boolean", description: "Doctor confirms no identifiable patient is shown (or consent was obtained)" },
              },
            },
          },
        },
      },
      responses: { 201: { description: "Created", ...jsonBody(envelope({ type: "object" })) }, 422: errorResponse("Unsupported file / too many images") },
    },
  },
  "/doctor/gallery/order": {
    put: {
      tags: ["Doctor"],
      summary: "Re-order the gallery (every image id, in the new order)",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({ type: "object", required: ["ids"], properties: { ids: { type: "array", items: { type: "string" }, example: ["12", "9"] } } }),
      responses: { 200: { description: "Reordered", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) }, 422: errorResponse("Missing / foreign ids") },
    },
  },
  "/doctor/gallery/{id}": {
    patch: {
      tags: ["Doctor"],
      summary: "Edit a gallery image's metadata (title, caption, category, altText, takenOn)",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: jsonBody({ type: "object", properties: { title: { type: "string" }, caption: { type: "string" }, category: { type: "string" }, altText: { type: "string" }, takenOn: { type: "string", format: "date" } } }),
      responses: { 200: { description: "Updated", ...jsonBody(envelope({ type: "object" })) }, 404: errorResponse("Not found") },
    },
    delete: { tags: ["Doctor"], summary: "Remove a gallery image", security: [{ bearerAuth: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Removed", ...jsonBody(envelope({ nullable: true })) }, 404: errorResponse("Not found") } },
  },
  "/doctor/insurances": {
    put: {
      tags: ["Doctor"],
      summary: "Replace the doctor's accepted-insurance set",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({ type: "object", required: ["insuranceIds"], properties: { insuranceIds: { type: "array", items: { type: "integer" }, example: [1, 6] } } }),
      responses: { 200: { description: "Updated", ...jsonBody(envelope({ $ref: "#/components/schemas/DoctorProfile" })) }, 422: errorResponse("Invalid ids") },
    },
  },
  "/insurances": {
    get: { tags: ["Doctors (public)"], summary: "Insurance provider lookup list", responses: { 200: { description: "Insurances", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) } } },
  },

  "/doctor/awards": {
    get: { tags: ["Doctor"], summary: "List awards", security: [{ bearerAuth: [] }], responses: { 200: { description: "Awards", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) } } },
    post: {
      tags: ["Doctor"],
      summary: "Add an award",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({ type: "object", required: ["title"], properties: { title: { type: "string" }, description: { type: "string" }, awardYear: { type: "integer" } } }),
      responses: { 201: { description: "Created", ...jsonBody(envelope({ type: "object" })) } },
    },
  },
  "/doctor/awards/{id}": {
    delete: { tags: ["Doctor"], summary: "Remove an award", security: [{ bearerAuth: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Removed", ...jsonBody(envelope({ nullable: true })) }, 404: errorResponse("Not found") } },
  },
  "/doctor/links": {
    get: { tags: ["Doctor"], summary: "List links", security: [{ bearerAuth: [] }], responses: { 200: { description: "Links", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) } } },
    post: {
      tags: ["Doctor"],
      summary: "Add a link",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({ type: "object", required: ["linkType", "url"], properties: { linkType: { type: "string", enum: ["website", "linkedin", "instagram", "youtube", "other"] }, url: { type: "string", format: "uri" } } }),
      responses: { 201: { description: "Created", ...jsonBody(envelope({ type: "object" })) } },
    },
  },
  "/doctor/links/{id}": {
    delete: { tags: ["Doctor"], summary: "Remove a link", security: [{ bearerAuth: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Removed", ...jsonBody(envelope({ nullable: true })) } } },
  },
  "/doctor/keywords": {
    get: { tags: ["Doctor"], summary: "List search keywords", security: [{ bearerAuth: [] }], responses: { 200: { description: "Keywords", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) } } },
    post: {
      tags: ["Doctor"],
      summary: "Add a search keyword",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({ type: "object", required: ["keyword"], properties: { keyword: { type: "string" }, weight: { type: "integer", minimum: 1, maximum: 5 } } }),
      responses: { 201: { description: "Created", ...jsonBody(envelope({ type: "object" })) }, 409: errorResponse("Duplicate keyword") },
    },
  },
  "/doctor/keywords/{id}": {
    delete: { tags: ["Doctor"], summary: "Remove a keyword", security: [{ bearerAuth: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Removed", ...jsonBody(envelope({ nullable: true })) } } },
  },
  "/doctor/documents": {
    get: { tags: ["Doctor"], summary: "List verification documents", security: [{ bearerAuth: [] }], responses: { 200: { description: "Documents", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) } } },
    post: {
      tags: ["Doctor"],
      summary: "Upload a verification document (multipart)",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["docType", "file"],
              properties: {
                docType: { type: "string", enum: ["degree_certificate", "id_proof", "council_registration", "other"] },
                file: { type: "string", format: "binary", description: "PDF/PNG/JPEG, ≤ MAX_UPLOAD_MB" },
              },
            },
          },
        },
      },
      responses: { 201: { description: "Uploaded", ...jsonBody(envelope({ type: "object" })) }, 422: errorResponse("Bad file / validation") },
    },
  },
  "/doctor/documents/{id}": {
    delete: { tags: ["Doctor"], summary: "Remove a document (before approval)", security: [{ bearerAuth: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Removed", ...jsonBody(envelope({ nullable: true })) }, 403: errorResponse("Approved — cannot remove") } },
  },
  "/doctor/photo": {
    post: {
      tags: ["Doctor"],
      summary: "Upload/replace profile photo (multipart)",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" } } } } },
      },
      responses: { 200: { description: "Updated", ...jsonBody(envelope({ $ref: "#/components/schemas/User" })) } },
    },
  },
  "/doctor/showcase-image": {
    post: {
      tags: ["Doctor"],
      summary: 'Upload/replace the "Why Choose" section image (multipart, image only)',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" } } } } },
      },
      responses: {
        200: { description: "Updated", ...jsonBody(envelope({ type: "object", properties: { showcaseImageUrl: { type: "string" } } })) },
        422: errorResponse("Unsupported file type / too large"),
      },
    },
    delete: {
      tags: ["Doctor"],
      summary: 'Remove the "Why Choose" section image (revert to stock)',
      security: [{ bearerAuth: [] }],
      responses: { 200: { description: "Removed", ...jsonBody(envelope({ type: "object", properties: { showcaseImageUrl: { type: "string", nullable: true } } })) } },
    },
  },
  "/doctor/submit": {
    post: {
      tags: ["Doctor"],
      summary: "Submit for verification (guards all required steps)",
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: "Submitted", ...jsonBody(envelope({ $ref: "#/components/schemas/OnboardingStatus" })) },
        422: errorResponse("Onboarding incomplete (details.steps)"),
      },
    },
  },

  // ── Clinics & Availability ──────────────────────────────────────────────────
  "/doctor/clinics": {
    get: { tags: ["Clinics & Availability"], summary: "List own clinics (+ availability)", security: [{ bearerAuth: [] }], responses: { 200: { description: "Clinics", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) } } },
    post: {
      tags: ["Clinics & Availability"],
      summary: "Add a clinic",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({ type: "object", required: ["name", "addressLine", "lat", "lng", "offlineFee"], properties: { name: { type: "string" }, addressLine: { type: "string" }, city: { type: "string", nullable: true }, state: { type: "string", nullable: true }, pincode: { type: "string", nullable: true }, lat: { type: "number" }, lng: { type: "number" }, phone: { type: "string", nullable: true }, offlineFee: { type: "number" } } }),
      responses: { 201: { description: "Created", ...jsonBody(envelope({ type: "object" })) }, 422: errorResponse("Validation failed") },
    },
  },
  "/doctor/clinics/{id}": {
    get: { tags: ["Clinics & Availability"], summary: "Get one owned clinic", security: [{ bearerAuth: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Clinic", ...jsonBody(envelope({ type: "object" })) }, 404: errorResponse("Not found") } },
    patch: { tags: ["Clinics & Availability"], summary: "Update a clinic", security: [{ bearerAuth: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: jsonBody({ type: "object", properties: { name: { type: "string" }, offlineFee: { type: "number" }, isActive: { type: "boolean" } } }), responses: { 200: { description: "Updated", ...jsonBody(envelope({ type: "object" })) }, 404: errorResponse("Not found") } },
    delete: { tags: ["Clinics & Availability"], summary: "Remove a clinic (cascades slots)", security: [{ bearerAuth: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Removed", ...jsonBody(envelope({ nullable: true })) }, 404: errorResponse("Not found") } },
  },
  "/doctor/clinics/{id}/availability": {
    get: { tags: ["Clinics & Availability"], summary: "Get a clinic's weekly schedule", security: [{ bearerAuth: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Slots", ...jsonBody(envelope({ type: "array", items: { $ref: "#/components/schemas/WeeklySlot" } })) }, 404: errorResponse("Not found") } },
    put: {
      tags: ["Clinics & Availability"],
      summary: "Replace a clinic's weekly schedule",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: jsonBody({ type: "object", required: ["slots"], properties: { slots: { type: "array", items: { $ref: "#/components/schemas/WeeklySlot" } } } }),
      responses: { 200: { description: "Updated", ...jsonBody(envelope({ type: "array", items: { $ref: "#/components/schemas/WeeklySlot" } })) }, 404: errorResponse("Not found"), 422: errorResponse("Validation failed") },
    },
  },
  "/doctor/online-availability": {
    get: { tags: ["Clinics & Availability"], summary: "Get the online/video weekly schedule", security: [{ bearerAuth: [] }], responses: { 200: { description: "Slots", ...jsonBody(envelope({ type: "array", items: { $ref: "#/components/schemas/WeeklySlot" } })) } } },
    put: {
      tags: ["Clinics & Availability"],
      summary: "Replace the online/video weekly schedule",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({ type: "object", required: ["slots"], properties: { slots: { type: "array", items: { $ref: "#/components/schemas/WeeklySlot" } } } }),
      responses: { 200: { description: "Updated", ...jsonBody(envelope({ type: "array", items: { $ref: "#/components/schemas/WeeklySlot" } })) }, 422: errorResponse("Validation failed") },
    },
  },
  "/doctor/exceptions": {
    get: { tags: ["Clinics & Availability"], summary: "List blocked-date exceptions", security: [{ bearerAuth: [] }], responses: { 200: { description: "Exceptions", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) } } },
    post: {
      tags: ["Clinics & Availability"],
      summary: "Block a date (clinicId null = online)",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({ type: "object", required: ["exceptionDate"], properties: { clinicId: { type: "string", nullable: true }, exceptionDate: { type: "string", format: "date" }, reason: { type: "string", nullable: true } } }),
      responses: { 201: { description: "Created", ...jsonBody(envelope({ type: "object" })) }, 404: errorResponse("Clinic not owned"), 422: errorResponse("Validation failed") },
    },
  },
  "/doctor/exceptions/{id}": {
    delete: { tags: ["Clinics & Availability"], summary: "Unblock a date", security: [{ bearerAuth: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Removed", ...jsonBody(envelope({ nullable: true })) }, 404: errorResponse("Not found") } },
  },
  "/doctors/{id}/slots": {
    get: {
      tags: ["Doctors (public)"],
      summary: "Slot preview: offered times on a date (bookings NOT subtracted)",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "mode", in: "query", required: true, schema: { type: "string", enum: ["clinic", "online"] } },
        { name: "clinicId", in: "query", schema: { type: "string" }, description: "Required when mode=clinic" },
        { name: "date", in: "query", required: true, schema: { type: "string", format: "date" } },
      ],
      responses: { 200: { description: "Slots", ...jsonBody(envelope({ type: "object" })) }, 404: errorResponse("Doctor/clinic not found"), 422: errorResponse("Invalid query") },
    },
  },

  // ── Patient (owned) ─────────────────────────────────────────────────────────
  "/patient/profile": {
    get: {
      tags: ["Patient"],
      summary: "Own profile + booking-completeness status",
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: "Profile", ...jsonBody(envelope({ $ref: "#/components/schemas/PatientProfile" })) },
        403: errorResponse("Not a patient"),
      },
    },
    put: {
      tags: ["Patient"],
      summary: "Update own profile (partial; fills the booking gate)",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({
        type: "object",
        properties: {
          name: { type: "string" },
          phone: { type: "string", nullable: true },
          dateOfBirth: { type: "string", format: "date" },
          gender: { type: "string", enum: ["male", "female", "other"] },
          bloodGroup: { type: "string", enum: ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"] },
          addressLine: { type: "string", nullable: true },
          city: { type: "string", nullable: true },
          state: { type: "string", nullable: true },
          pincode: { type: "string", nullable: true },
        },
      }),
      responses: {
        200: { description: "Updated", ...jsonBody(envelope({ $ref: "#/components/schemas/PatientProfile" })) },
        403: errorResponse("Not a patient"),
        422: errorResponse("Validation failed"),
      },
    },
  },

  // ── Bookings (patient-owned) ────────────────────────────────────────────────
  "/patient/bookings": {
    get: {
      tags: ["Bookings & Payments"],
      summary: "List own bookings",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "status", in: "query", schema: { type: "string", enum: ["pending_payment", "confirmed", "completed", "cancelled", "no_show"] } }],
      responses: { 200: { description: "Bookings", ...jsonBody(envelope({ type: "array", items: { $ref: "#/components/schemas/Booking" } })) }, 403: errorResponse("Not a patient") },
    },
    post: {
      tags: ["Bookings & Payments"],
      summary: "Create a booking (holds the slot)",
      description: "Gated on a complete patient profile. Video ⇒ paymentMode is forced to 'online'. Offline ('pay at clinic') confirms immediately and returns the Booking flat; online holds the slot and returns { booking, payment, razorpayOrder } for Checkout.",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({
        type: "object",
        required: ["doctorId", "mode", "date", "startTime", "paymentMode"],
        properties: {
          doctorId: { type: "integer" },
          mode: { type: "string", enum: ["video", "clinic"] },
          clinicId: { type: "integer", description: "Required when mode=clinic" },
          date: { type: "string", format: "date" },
          startTime: { type: "string", example: "10:30" },
          paymentMode: { type: "string", enum: ["online", "offline"] },
          offlineMethod: { type: "string", enum: ["cash", "upi_qr"], default: "cash", description: "How an OFFLINE payment is made (migration 044). upi_qr = the doctor's own UPI QR: requires paymentMode=offline and a doctor with an active QR (else 409 PAYMENT_QR_UNAVAILABLE); allowed for video too (video + cash is still forced online). The booking is confirmed with payment pending_at_clinic until the doctor marks it paid." },
          referralId: { type: "integer", description: "Optional: the referral this booking fulfils" },
          acquisition: { ...require("./swagger.doctorAnalytics").AcquisitionAnswer, description: "Optional 'How did you hear about the doctor?' answer (migration 056). First answer = the patient's original source for this doctor (never overwritten); every answer is also stored on the booking." },
        },
      }),
      responses: {
        201: { description: "Created (offline: Booking; online: { booking, payment, razorpayOrder })", ...jsonBody(envelope({ $ref: "#/components/schemas/Booking" })) },
        409: errorResponse("PROFILE_INCOMPLETE or SLOT_TAKEN"),
        422: errorResponse("SLOT_UNAVAILABLE / validation"),
        503: errorResponse("Online payment not configured (keys missing)"),
      },
    },
  },
  "/patient/bookings/{id}": {
    get: { tags: ["Bookings & Payments"], summary: "Get one own booking", security: [{ bearerAuth: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Booking", ...jsonBody(envelope({ $ref: "#/components/schemas/Booking" })) }, 404: errorResponse("Not found") } },
  },
  "/patient/bookings/{id}/pay/verify": {
    post: {
      tags: ["Bookings & Payments"],
      summary: "Verify a Razorpay payment → confirm the booking",
      description: "Client fast-path. Verifies the Checkout signature (HMAC of orderId|paymentId). Idempotent — a repeat verify on an already-successful payment returns the confirmed booking. The webhook is the reliable backstop.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: jsonBody({
        type: "object",
        required: ["razorpayOrderId", "razorpayPaymentId", "razorpaySignature"],
        properties: {
          razorpayOrderId: { type: "string" },
          razorpayPaymentId: { type: "string" },
          razorpaySignature: { type: "string" },
        },
      }),
      responses: {
        200: { description: "Verified", ...jsonBody(envelope({ type: "object", properties: { booking: { $ref: "#/components/schemas/Booking" }, payment: { type: "object", properties: { status: { type: "string" } } } } })) },
        400: errorResponse("PAYMENT_VERIFICATION_FAILED (signature mismatch)"),
        409: errorResponse("BOOKING_NOT_PAYABLE"),
      },
    },
  },
  "/patient/bookings/{id}/cancel": {
    post: { tags: ["Bookings & Payments"], summary: "Cancel a booking (frees the slot)", security: [{ bearerAuth: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: jsonBody({ type: "object", properties: { reason: { type: "string", nullable: true } } }), responses: { 200: { description: "Cancelled", ...jsonBody(envelope({ nullable: true })) }, 409: errorResponse("No longer cancellable") } },
  },
  "/patient/bookings/{id}/video-token": {
    post: {
      tags: ["Video Consultation"],
      summary: "Mint a LiveKit join token for the patient's video consult",
      description: "A short-lived, room-scoped LiveKit token for the caller's OWN confirmed video booking, only within the join window (10 min before → 30 min after the slot). The API secret is never returned.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        200: { description: "Join token", ...jsonBody(envelope({ $ref: "#/components/schemas/VideoToken" })) },
        403: errorResponse("VIDEO_WINDOW_CLOSED — outside the join window"),
        404: errorResponse("Not found / not owned"),
        409: errorResponse("VIDEO_NOT_AVAILABLE — not a confirmed video consult"),
        503: errorResponse("VIDEO_NOT_CONFIGURED — LiveKit keys absent"),
      },
    },
  },

  // ── Patient uploaded records (reports & documents) ──────────────────────────
  "/patient/records": {
    get: { tags: ["Patient"], summary: "List own documents (reports, prescriptions, identity & insurance cards)", security: [{ bearerAuth: [] }], responses: { 200: { description: "Records", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) } } },
    post: {
      tags: ["Patient"],
      summary: "Add a record by URL (paste-a-link)",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({ type: "object", required: ["fileUrl"], properties: { fileUrl: { type: "string", format: "uri" }, fileType: { type: "string", enum: ["prescription", "lab_report", "xray", "mri", "other", "identity"] }, documentKind: { type: "string", nullable: true, description: "constants.DOCUMENT_KINDS — when given, decides fileType server-side" }, doctorName: { type: "string", nullable: true }, description: { type: "string", nullable: true }, idLast4: { type: "string", pattern: "^[0-9]{4}$", nullable: true, description: "Identity documents only — never a full number" }, recordDate: { type: "string", format: "date", nullable: true }, tag: { type: "string", nullable: true }, location: { type: "string", nullable: true } } }),
      responses: { 201: { description: "Added", ...jsonBody(envelope({ type: "object" })) }, 422: errorResponse("Validation failed") },
    },
  },
  "/patient/records/upload": {
    post: {
      tags: ["Patient"],
      summary: "Upload a record file (multipart: PDF/PNG/JPEG)",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" }, fileType: { type: "string", enum: ["prescription", "lab_report", "xray", "mri", "other", "identity"] }, documentKind: { type: "string", nullable: true, description: "constants.DOCUMENT_KINDS — when given, decides fileType server-side" }, doctorName: { type: "string", nullable: true }, description: { type: "string", nullable: true }, idLast4: { type: "string", pattern: "^[0-9]{4}$", nullable: true, description: "Identity documents only — never a full number" }, recordDate: { type: "string", format: "date" }, tag: { type: "string" }, location: { type: "string" } } } } },
      },
      responses: { 201: { description: "Uploaded", ...jsonBody(envelope({ type: "object" })) }, 422: errorResponse("Unsupported file type / too large") },
    },
  },
  "/patient/records/{id}": {
    patch: {
      tags: ["Patient"],
      summary: "Edit a record's metadata (date of test, type, label)",
      description:
        "Metadata only — the stored file is immutable. Restricted to rows the patient uploaded themselves; editing a clinic- or doctor-authored record returns 403.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: jsonBody({ type: "object", minProperties: 1, properties: { fileType: { type: "string", enum: ["prescription", "lab_report", "xray", "mri", "other", "identity"] }, documentKind: { type: "string", nullable: true, description: "constants.DOCUMENT_KINDS — when given, decides fileType server-side" }, doctorName: { type: "string", nullable: true }, description: { type: "string", nullable: true }, idLast4: { type: "string", pattern: "^[0-9]{4}$", nullable: true, description: "Identity documents only — never a full number" }, recordDate: { type: "string", format: "date", nullable: true }, tag: { type: "string", nullable: true }, location: { type: "string", nullable: true } } }),
      responses: { 200: { description: "Updated", ...jsonBody(envelope({ type: "object" })) }, 403: errorResponse("Not your upload"), 404: errorResponse("Not found"), 422: errorResponse("Validation failed") },
    },
    delete: { tags: ["Patient"], summary: "Remove a document you uploaded yourself (deletes the stored file too); 403 for doctor/clinic/lab-filed records", security: [{ bearerAuth: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Removed", ...jsonBody(envelope({ nullable: true })) }, 403: errorResponse("Not your upload"), 404: errorResponse("Not found") } },
  },
  "/patient/records/{id}/file": {
    put: {
      tags: ["Patient"],
      summary: "Replace the file behind one of your own documents (details kept)",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" } } } } } },
      responses: { 200: { description: "Replaced", ...jsonBody(envelope({ type: "object" })) }, 403: errorResponse("Not your upload"), 404: errorResponse("Not found"), 422: errorResponse("Unsupported file type / too large") },
    },
  },

  // ── Bookings (doctor-owned appointments) ────────────────────────────────────
  "/doctor/bookings": {
    get: {
      tags: ["Bookings & Payments"],
      summary: "The doctor's appointments (with patient summary)",
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: "status", in: "query", schema: { type: "string", enum: ["pending_payment", "confirmed", "completed", "cancelled", "no_show"] } },
        { name: "date", in: "query", schema: { type: "string", format: "date" } },
        { name: "clinicId", in: "query", schema: { type: "string" } },
      ],
      responses: { 200: { description: "Appointments", ...jsonBody(envelope({ type: "array", items: { $ref: "#/components/schemas/Booking" } })) }, 403: errorResponse("Not a doctor") },
    },
  },
  "/doctor/bookings/{id}": {
    get: {
      tags: ["Bookings & Payments"],
      summary: "One appointment + patient snapshot (confirmed/completed only)",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        200: { description: "Appointment", ...jsonBody(envelope({ type: "object", properties: { booking: { $ref: "#/components/schemas/Booking" }, patient: { oneOf: [{ $ref: "#/components/schemas/PatientSnapshot" }, { type: "null" }] } } })) },
        404: errorResponse("Not found / not owned"),
      },
    },
  },
  "/doctor/bookings/{id}/mark-paid": {
    post: { tags: ["Bookings & Payments"], summary: "Record an at-clinic cash payment (offline)", security: [{ bearerAuth: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Paid", ...jsonBody(envelope({ $ref: "#/components/schemas/Booking" })) }, 409: errorResponse("Not awaiting an at-clinic payment") } },
  },
  "/doctor/bookings/{id}/complete": {
    post: { tags: ["Bookings & Payments"], summary: "Mark a confirmed booking completed / no-show", description: "Completing an attended booking also settles a still `pending_at_clinic` offline payment (marks it paid + stamps the commission split) in the same action — so `mark-paid` is not a required separate step. A no-show leaves the payment untouched.", security: [{ bearerAuth: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: jsonBody({ type: "object", properties: { noShow: { type: "boolean", default: false } } }), responses: { 200: { description: "Updated", ...jsonBody(envelope({ $ref: "#/components/schemas/Booking" })) }, 409: errorResponse("Not confirmed") } },
  },
  "/doctor/bookings/{id}/video-token": {
    post: {
      tags: ["Video Consultation"],
      summary: "Mint a LiveKit join token for the doctor's video consult",
      description: "A short-lived, room-scoped LiveKit token for the doctor's OWN confirmed video booking, only within the join window (10 min before → 30 min after the slot). The API secret is never returned.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        200: { description: "Join token", ...jsonBody(envelope({ $ref: "#/components/schemas/VideoToken" })) },
        403: errorResponse("VIDEO_WINDOW_CLOSED — outside the join window"),
        404: errorResponse("Not found / not owned"),
        409: errorResponse("VIDEO_NOT_AVAILABLE — not a confirmed video consult"),
        503: errorResponse("VIDEO_NOT_CONFIGURED — LiveKit keys absent"),
      },
    },
  },

  // ── Razorpay webhook (public, HMAC-verified) ────────────────────────────────
  "/webhooks/razorpay": {
    post: {
      tags: ["Bookings & Payments"],
      summary: "Razorpay server-to-server events (payment.captured / order.paid)",
      description: "Public, no app auth. Verified by an HMAC (X-Razorpay-Signature) over the RAW body using RAZORPAY_WEBHOOK_SECRET. Confirms the booking idempotently — a replay of a handled event is a harmless 200. A bad signature → 400.",
      requestBody: jsonBody({ type: "object", description: "Raw Razorpay event payload" }),
      responses: {
        200: { description: "Handled (Razorpay stops retrying)" },
        400: errorResponse("Invalid webhook signature"),
      },
    },
  },

  // ── LiveKit webhook (public, signed-JWT-verified) ───────────────────────────
  "/webhooks/livekit": {
    post: {
      tags: ["Video Consultation"],
      summary: "LiveKit room lifecycle (room_started / participant_joined / room_finished)",
      description: "Public, no app auth. Verified by LiveKit's signed Authorization JWT over the RAW body. Drives the booking's video_session pending → live → ended (audit/attendance). Always answers 200 (best-effort) so LiveKit never retry-storms.",
      requestBody: jsonBody({ type: "object", description: "Raw LiveKit WebhookEvent" }),
      responses: { 200: { description: "Received (always)" } },
    },
  },

  // ── Current medications (docs/patient-health-records) ───────────────────────
  "/patient/medications": {
    get: { tags: ["Patient"], summary: "List own current medications", security: [{ bearerAuth: [] }], responses: { 200: { description: "Medications", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) } } },
    post: {
      tags: ["Patient"],
      summary: "Add a current medication",
      description: "Withdraws the `noCurrentMedications` answer on the profile — the two cannot both hold.",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({ type: "object", required: ["medicineName"], properties: { medicineName: { type: "string" }, dosage: { type: "string", nullable: true }, frequency: { type: "string", nullable: true }, startedOn: { type: "string", format: "date", nullable: true }, notes: { type: "string", nullable: true } } }),
      responses: { 201: { description: "Added", ...jsonBody(envelope({ type: "object" })) }, 422: errorResponse("Validation failed") },
    },
    patch: {
      tags: ["Patient"],
      summary: 'Record the "no current medications" answer',
      description:
        'The counterpart of `noKnown` on allergies/conditions. Setting it true CLEARS the medication list — an empty list means "not asked", this means "I take nothing". Returns the resulting list.',
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({ type: "object", required: ["noCurrentMedications"], properties: { noCurrentMedications: { type: "boolean" } } }),
      responses: { 200: { description: "Updated", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) }, 422: errorResponse("Validation failed") },
    },
  },

  // ── Vitals record table (docs/patient-health-records + vitals-reference-ranges)
  "/patient/vitals": {
    get: {
      tags: ["Patient"],
      summary: "The patient's own vitals record table (with reference-range bands)",
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: "Matrix", ...jsonBody(envelope(vitalsSchemas.VitalsMatrix)) },
        401: errorResponse("Unauthenticated"),
      },
    },
  },
  "/doctor/bookings/{id}/patient-vitals": {
    get: {
      tags: ["Bookings & Payments"],
      summary: "That appointment's patient's vitals record table",
      description:
        "Bands are computed from the SAME source as the patient's own view, so a doctor and a patient can never see different verdicts on one reading.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        200: { description: "Matrix", ...jsonBody(envelope(vitalsSchemas.VitalsMatrix)) },
        403: errorResponse("Patient details unlock once the booking is confirmed"),
        404: errorResponse("Booking not found"),
      },
    },
  },

  // ── Treatment Timeline (docs/treatment-timeline) ────────────────────────────
  //
  // The FLAT lens over a patient's consultations — one row per completed visit:
  // date · location · doctor · issue · prescription. Contrast /patient/journeys,
  // which groups the same rows into referral-linked episodes.
  //
  // `issue` resolves in one place, in this order: clinical-note diagnosis →
  // prescription diagnosis → note complaints → null.
  // `location` is null for a video consult; the label lives in the UI.
  "/patient/timeline": {
    get: {
      tags: ["Treatment Timeline"],
      summary: "The patient's own treatment history",
      security: [{ bearerAuth: [] }],
      parameters: [...timelineQueryParams],
      responses: {
        200: { description: "Timeline", ...jsonBody(envelope(timelineSchemas.Timeline)) },
        401: errorResponse("Unauthenticated"),
        422: errorResponse("Validation failed"),
      },
    },
  },
  "/doctor/bookings/{id}/patient-timeline": {
    get: {
      tags: ["Treatment Timeline"],
      summary: "That appointment's patient's history (in-consult / in-call)",
      description:
        "Booking-keyed on purpose: the patient is DERIVED from a booking the caller owns, so this route takes NO patient parameter and cannot be pivoted to another patient. Same gate as /doctor/bookings/{id}/patient-vitals. Rows include consultations by OTHER doctors — that is the feature. Prescription ids are omitted for doctors (see the Timeline schema).",
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Booking id" },
        ...timelineQueryParams,
      ],
      responses: {
        200: { description: "Timeline", ...jsonBody(envelope(timelineSchemas.Timeline)) },
        403: errorResponse("Patient details unlock once the booking is confirmed"),
        404: errorResponse("Booking not found / not yours"),
      },
    },
  },
  "/doctor/patients": {
    get: {
      tags: ["Treatment Timeline"],
      summary: "My Patients — everyone this doctor has consulted",
      description:
        "Derived from the caller's OWN bookings, never a listing of platform patients. Most-recently-seen first.",
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: "Roster", ...jsonBody(envelope(timelineSchemas.DoctorPatients)) },
        403: errorResponse("Not a doctor"),
      },
    },
  },
  "/doctor/patients/{patientId}/status": {
    patch: {
      tags: ["Treatment Timeline"],
      summary: "Set a patient's My-Patients status (doctor override)",
      description:
        "One of new_patient / opd_followup / surgery_pending / surgery_followup. New/OPD are otherwise derived from visit count; the surgery pair only ever comes from this override. Scoped to patients the caller has actually treated — anyone else 404s.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "patientId", in: "path", required: true, schema: { type: "string" } }],
      requestBody: jsonBody({ type: "object", required: ["status"], properties: { status: { type: "string", enum: ["new_patient", "opd_followup", "surgery_pending", "surgery_followup"] } } }),
      responses: { 200: { description: "Updated", ...jsonBody(envelope({ type: "object" })) }, 404: errorResponse("Not treated by this doctor"), 422: errorResponse("Validation failed") },
    },
  },
  "/doctor/patients/{patientId}/timeline": {
    get: {
      tags: ["Treatment Timeline"],
      summary: "A named patient's history (from the My Patients roster)",
      description:
        "Asserts the treating relationship before loading anything, and 404s (not 403s) when absent — a 403 would confirm the patient exists.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: "patientId", in: "path", required: true, schema: { type: "string" } },
        ...timelineQueryParams,
      ],
      responses: {
        200: { description: "Timeline", ...jsonBody(envelope(timelineSchemas.Timeline)) },
        404: errorResponse("Patient not found / never treated by you"),
      },
    },
  },

  // ── Admin – Verification ────────────────────────────────────────────────────
  "/admin/doctors": {
    get: {
      tags: ["Admin – Verification"],
      summary: "Verification queue",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "status", in: "query", schema: { type: "string", enum: ["pending", "approved", "rejected"], default: "pending" } }],
      responses: {
        200: { description: "Queue", ...jsonBody(envelope({ type: "array", items: { $ref: "#/components/schemas/DoctorProfile" } })) },
        403: errorResponse("Not an admin"),
      },
    },
    post: {
      tags: ["Admin – Doctor Management"],
      summary: "Create a doctor (auto-approved)",
      description:
        "Creates a doctor account + profile that is LIVE immediately (verification_status='approved', is_submitted=true). The admin then builds the rest of the profile via /admin/doctors/{doctorId}/* — those endpoints mirror the /doctor/* request bodies exactly.",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({
        type: "object",
        required: ["name", "email", "password"],
        properties: {
          name: { type: "string" },
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 8, maxLength: 72 },
        },
      }),
      responses: {
        201: { description: "Created & approved", ...jsonBody(envelope({ $ref: "#/components/schemas/DoctorProfile" })) },
        409: errorResponse("Email already registered"),
        422: errorResponse("Validation failed"),
      },
    },
  },
  "/admin/doctors/{doctorId}/profile": {
    patch: {
      tags: ["Admin – Doctor Management"],
      summary: "Edit any doctor's profile (admin)",
      description:
        "Representative of the full admin editing surface at /admin/doctors/{doctorId}/*. Every route under this prefix reuses the identically-named /doctor/* endpoint and its request body — see the Doctor tag for the shapes (specializations, languages, education, experience, services, publications, memberships, faqs, awards, links, keywords, documents, photo, gallery, insurances, clinics, availability).",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "doctorId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        200: { description: "Updated", ...jsonBody(envelope({ $ref: "#/components/schemas/DoctorProfile" })) },
        403: errorResponse("Not an admin"),
        404: errorResponse("Doctor not found"),
      },
    },
  },
  "/admin/doctors/{id}": {
    get: {
      tags: ["Admin – Verification"],
      summary: "One doctor's full profile + documents",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "Doctor", ...jsonBody(envelope({ $ref: "#/components/schemas/DoctorProfile" })) }, 404: errorResponse("Not found") },
    },
  },
  "/admin/doctors/{id}/verify": {
    post: {
      tags: ["Admin – Verification"],
      summary: "Approve or reject a doctor",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: jsonBody({ type: "object", required: ["decision"], properties: { decision: { type: "string", enum: ["approved", "rejected"] }, notes: { type: "string", nullable: true } } }),
      responses: { 200: { description: "Decision saved", ...jsonBody(envelope({ $ref: "#/components/schemas/DoctorProfile" })) }, 422: errorResponse("Validation failed") },
    },
  },
  "/admin/doctors/{id}/listing": {
    patch: {
      tags: ["Admin – Verification"],
      summary: "Show or hide a doctor on the patient side",
      description:
        "Flips `doctor_profiles.is_listed`. Independent of the approve/reject verdict: this is NOT a rejection — the doctor keeps their account, dashboard and existing bookings, they simply stop appearing in discovery / find-a-doctor, the map, their public portfolio, related-doctor rails, slot previews and new bookings (all 404 while hidden).",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: jsonBody({ type: "object", required: ["isListed"], properties: { isListed: { type: "boolean" } } }),
      responses: {
        200: { description: "Visibility saved", ...jsonBody(envelope({ $ref: "#/components/schemas/DoctorProfile" })) },
        403: errorResponse("Not an admin"),
        404: errorResponse("Doctor not found"),
        422: errorResponse("Validation failed"),
      },
    },
  },

  // ── Dashboards & Earnings (docs/dashboards-earnings) ────────────────────────
  //
  // Money rules these endpoints obey, so a client never has to guess:
  //   • only `payments.status='success'` counts as money;
  //   • money is bucketed by `paid_at`, in IST (+05:30), half-open [from, to);
  //   • the commission split is read from stored columns, never re-derived;
  //   • `gross === commission + net` on every summary and every bucket.
  "/patient/dashboard/summary": {
    get: {
      tags: ["Dashboards & Earnings"],
      summary: "Patient dashboard tiles (counts + gross spend)",
      description:
        "Server-computed so the tiles stay correct when GET /patient/bookings becomes paginated. `totalSpent` is GROSS — commission is never exposed to a patient.",
      security: [{ bearerAuth: [] }],
      responses: { 200: { description: "Summary", ...jsonBody(envelope(dashboardSchemas.PatientDashboard)) }, 401: errorResponse("Unauthenticated") },
    },
  },
  "/doctor/dashboard/summary": {
    get: {
      tags: ["Dashboards & Earnings"],
      summary: "Doctor dashboard tiles",
      description:
        "`averageRating` is ALWAYS null until the `reviews` table is migrated — never 0, which would render as a zero-star doctor.",
      security: [{ bearerAuth: [] }],
      responses: { 200: { description: "Summary", ...jsonBody(envelope(dashboardSchemas.DoctorDashboard)) }, 403: errorResponse("Forbidden") },
    },
  },
  "/doctor/dashboard/today": {
    get: {
      tags: ["Dashboards & Earnings"],
      summary: "The doctor's schedule for today (IST)",
      security: [{ bearerAuth: [] }],
      responses: { 200: { description: "Today's bookings", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) } },
    },
  },
  "/doctor/earnings/summary": {
    get: {
      tags: ["Dashboards & Earnings"],
      summary: "Earnings totals for a period",
      description:
        "`averagePerConsult` is null when consults === 0 (not 0, not NaN). `awaitingCollection` is cash owed by PATIENTS at the clinic — not a platform payout; no payouts table exists.",
      security: [{ bearerAuth: [] }],
      parameters: periodParams,
      responses: { 200: { description: "Totals", ...jsonBody(envelope(dashboardSchemas.EarningsSummary)) }, 422: errorResponse("Validation failed") },
    },
  },
  "/doctor/earnings/series": {
    get: {
      tags: ["Dashboards & Earnings"],
      summary: "Earnings bucketed by IST month or day",
      description:
        "Zero-filled: a bucket with no payments is present with zeros, so the array length is a pure function of the range. `bucket` is an opaque IST label (`2026-07` / `2026-07-04`) — do not parse it as an instant. `granularity=day` is capped at 92 days (400).",
      security: [{ bearerAuth: [] }],
      parameters: [...periodParams, granularityParam],
      responses: { 200: { description: "Series", ...jsonBody(envelope(dashboardSchemas.EarningsSeries)) }, 400: errorResponse("Range too wide for day granularity") },
    },
  },
  "/doctor/earnings/transactions": {
    get: {
      tags: ["Dashboards & Earnings"],
      summary: "Paginated per-consult earnings ledger",
      description:
        "Exists so a doctor can reconcile a total against its line items: summing `net` across every page equals the summary's `net` for the same range. `mode` is the PAYMENT mode (online|offline), not the booking mode (video|clinic).",
      security: [{ bearerAuth: [] }],
      parameters: [
        ...periodParams,
        { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
      ],
      responses: { 200: { description: "Ledger page", ...jsonBody(envelope(dashboardSchemas.Ledger)) } },
    },
  },
  "/admin/dashboard/summary": {
    get: {
      tags: ["Dashboards & Earnings"],
      summary: "Platform health + revenue tiles",
      description:
        "`platformRevenue` is COMMISSION, not GMV. All three of platformRevenue, gmv and doctorPayouts ship together because `platformRevenue + doctorPayouts === gmv`.",
      security: [{ bearerAuth: [] }],
      parameters: periodParams,
      responses: { 200: { description: "Summary", ...jsonBody(envelope(dashboardSchemas.AdminDashboard)) }, 403: errorResponse("Forbidden") },
    },
  },
  "/admin/dashboard/revenue-series": {
    get: {
      tags: ["Dashboards & Earnings"],
      summary: "Platform revenue bucketed by IST month or day (zero-filled)",
      security: [{ bearerAuth: [] }],
      parameters: [...periodParams, granularityParam],
      responses: { 200: { description: "Series", ...jsonBody(envelope(dashboardSchemas.RevenueSeries)) } },
    },
  },
  "/admin/dashboard/top-doctors": {
    get: {
      tags: ["Dashboards & Earnings"],
      summary: "Top doctors by net payout in a period",
      description: "Ranked order is meaningful — do not re-sort client-side.",
      security: [{ bearerAuth: [] }],
      parameters: [...periodParams, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 20, default: 5 } }],
      responses: { 200: { description: "Ranked doctors", ...jsonBody(envelope(dashboardSchemas.TopDoctors)) } },
    },
  },

  // ── Clinic portal (docs/clinic-account) ────────────────────────────────────
  //
  // TWO guard tiers, and the difference is load-bearing:
  //   • the clinic's OWN account works while still pending — finishing
  //     onboarding is the whole point of the pending state;
  //   • anything under /clinic/patients requires an APPROVED clinic, because a
  //     clinic self-registers and the directory reaches every patient.
  "/clinic/profile": {
    get: {
      tags: ["Clinic Portal"],
      summary: "The clinic's own profile",
      security: [{ bearerAuth: [] }],
      responses: { 200: { description: "Clinic profile", ...jsonBody(envelope({ type: "object" })) } },
    },
    put: {
      tags: ["Clinic Portal"],
      summary: "Update the clinic's own profile",
      description:
        "Whitelisted columns only. `verificationStatus`, `isSubmitted` and `isActive` are NOT writable here — a clinic cannot approve itself.",
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody({
        type: "object",
        properties: {
          clinicName: { type: "string" },
          registrationNumber: { type: "string", nullable: true },
          phone: { type: "string", nullable: true },
          addressLine: { type: "string", nullable: true },
          city: { type: "string", nullable: true },
          state: { type: "string", nullable: true },
          pincode: { type: "string", nullable: true },
          lat: { type: "number", nullable: true, description: "Map pin latitude" },
          lng: { type: "number", nullable: true, description: "Map pin longitude" },
          about: { type: "string", nullable: true },
        },
      }),
      responses: { 200: { description: "Profile updated", ...jsonBody(envelope({ type: "object" })) } },
    },
  },
  "/clinic/onboarding": {
    get: {
      tags: ["Clinic Portal"],
      summary: "Verification checklist",
      description:
        "Computed by the SAME function that guards POST /clinic/submit, so what this shows and what submit accepts can never disagree. Steps: profile, location, documents.",
      security: [{ bearerAuth: [] }],
      responses: { 200: { description: "Onboarding status", ...jsonBody(envelope({ type: "object" })) } },
    },
  },
  "/clinic/submit": {
    post: {
      tags: ["Clinic Portal"],
      summary: "Submit for verification",
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: "Submitted", ...jsonBody(envelope({ type: "object" })) },
        422: errorResponse("A required step is incomplete (ONBOARDING_INCOMPLETE)"),
      },
    },
  },
  "/clinic/documents": {
    post: {
      tags: ["Clinic Portal"],
      summary: "Upload a verification document (multipart)",
      security: [{ bearerAuth: [] }],
      responses: { 201: { description: "Document uploaded", ...jsonBody(envelope({ type: "object" })) } },
    },
  },
  "/clinic/documents/{documentId}": {
    delete: {
      tags: ["Clinic Portal"],
      summary: "Delete a verification document",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "documentId", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "Deleted" }, 404: errorResponse("Not found") },
    },
  },
  "/clinic/patients": {
    get: {
      tags: ["Clinic Portal"],
      summary: "Search / browse every registered patient",
      description:
        "The ONLY endpoint that enumerates patients. `q` is interpreted by SHAPE: containing `@` = exact email match; 6+ digits = phone, matched on its last 10 digits so a country code on either side is irrelevant; anything else = a name substring. Email is deliberately exact — a partial match would make this an address harvester. Neither phone nor email is ever RETURNED, so it cannot be used as a reverse lookup for contact details. Rows carry no address and no medical data. Requires an approved clinic.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: "q", in: "query", schema: { type: "string" }, description: "Exact phone or email, or a partial name. Empty browses all." },
        { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
        { name: "pageSize", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 20 } },
      ],
      responses: {
        200: { description: "Patients", ...jsonBody(envelope({ type: "object" })) },
        403: errorResponse("Clinic not approved yet (ONBOARDING_INCOMPLETE)"),
      },
    },
  },
  "/clinic/patients/{patientId}": {
    get: {
      tags: ["Clinic Portal"],
      summary: "One patient's clinical snapshot",
      description: "The same snapshot a treating doctor sees. Omits email.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "patientId", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "Patient", ...jsonBody(envelope({ type: "object" })) }, 404: errorResponse("Not found") },
    },
  },
  "/clinic/patients/{patientId}/timeline": {
    get: {
      tags: ["Clinic Portal"],
      summary: "The patient's treatment timeline",
      description:
        "The same rows the patient and their doctors see. A clinic-written clinical note is deliberately ABSENT — the timeline's spine is bookings and such a note has none; read it from /clinical-notes instead.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: "patientId", in: "path", required: true, schema: { type: "string" } },
        { name: "year", in: "query", schema: { type: "integer" } },
        { name: "month", in: "query", schema: { type: "integer", minimum: 1, maximum: 12 } },
        { name: "sort", in: "query", schema: { type: "string", enum: ["newest", "oldest"] } },
      ],
      responses: { 200: { description: "Timeline", ...jsonBody(envelope({ type: "object" })) } },
    },
  },
  "/clinic/patients/{patientId}/vitals": {
    get: {
      tags: ["Clinic Portal"],
      summary: "The patient's vitals record table",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "patientId", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "Vitals", ...jsonBody(envelope({ type: "object" })) } },
    },
    post: {
      tags: ["Clinic Portal"],
      summary: "Record a reading (stamped source='clinic')",
      description:
        "Accepts exactly the body the patient's own endpoint accepts — one validator, so the two entry points cannot diverge on a medical field.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "patientId", in: "path", required: true, schema: { type: "string" } }],
      responses: { 201: { description: "Recorded", ...jsonBody(envelope({ type: "object" })) } },
    },
  },
  "/clinic/patients/{patientId}/records": {
    get: {
      tags: ["Clinic Portal"],
      summary: "The patient's reports & documents",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "patientId", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "Records", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) } },
    },
    post: {
      tags: ["Clinic Portal"],
      summary: "Add a record by URL",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "patientId", in: "path", required: true, schema: { type: "string" } }],
      responses: { 201: { description: "Added", ...jsonBody(envelope({ type: "object" })) } },
    },
  },
  "/clinic/patients/{patientId}/records/upload": {
    post: {
      tags: ["Clinic Portal"],
      summary: "Upload a report (multipart)",
      description: "Stored under `clinic/{clinicId}/patients/{patientId}` so a clinic's uploads are grouped and auditable.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "patientId", in: "path", required: true, schema: { type: "string" } }],
      responses: { 201: { description: "Uploaded", ...jsonBody(envelope({ type: "object" })) } },
    },
  },
  "/clinic/patients/{patientId}/allergies": {
    get: {
      tags: ["Clinic Portal"],
      summary: "The patient's allergies",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "patientId", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "Allergies", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) } },
    },
    post: {
      tags: ["Clinic Portal"],
      summary: "ADD allergies (never replaces)",
      description:
        "POST, deliberately not PUT. The patient's own endpoint replaces the whole set — correct for a form showing every row, and catastrophic here, where the clinic is showing none of them. Re-adding an existing name is a no-op that preserves the original row's source and severity.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "patientId", in: "path", required: true, schema: { type: "string" } }],
      responses: { 201: { description: "Added", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) } },
    },
  },
  "/clinic/patients/{patientId}/conditions": {
    get: {
      tags: ["Clinic Portal"],
      summary: "The patient's chronic conditions",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "patientId", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "Conditions", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) } },
    },
    post: {
      tags: ["Clinic Portal"],
      summary: "ADD conditions (never replaces)",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "patientId", in: "path", required: true, schema: { type: "string" } }],
      responses: { 201: { description: "Added", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) } },
    },
  },
  "/clinic/patients/{patientId}/clinical-notes": {
    get: {
      tags: ["Clinic Portal"],
      summary: "Every clinical note on the patient's record",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "patientId", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "Notes", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) } },
    },
    post: {
      tags: ["Clinic Portal"],
      summary: "Add a clinic-authored note",
      description:
        "Written with doctorId NULL and bookingId NULL, so it is visible on the Records page but never as a timeline row.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "patientId", in: "path", required: true, schema: { type: "string" } }],
      responses: { 201: { description: "Added", ...jsonBody(envelope({ type: "object" })) } },
    },
  },
  "/clinic/patients/{patientId}/prescriptions/{id}/pdf": {
    get: {
      tags: ["Clinic Portal"],
      summary: "A prescription PDF off the patient's timeline",
      description: "Scoped to :patientId AND finalized-only — a doctor's draft is never reachable.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: "patientId", in: "path", required: true, schema: { type: "string" } },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: { 200: { description: "PDF stream" }, 404: errorResponse("Not found") },
    },
  },
  "/clinic/patients/{patientId}/profile": {
    patch: {
      tags: ["Clinic Portal"],
      summary: "Fill the patient's missing booking-required fields",
      description:
        "ONLY phone, dateOfBirth, gender, city and bloodGroup. A walk-in usually has not completed their profile, and the booking gate rejects without the first four. The patient's address, emergency contact, name and account remain theirs alone.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "patientId", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "Updated", ...jsonBody(envelope({ type: "object" })) } },
    },
  },
  "/clinic/patients/{patientId}/bookings": {
    get: {
      tags: ["Clinic Portal"],
      summary: "Appointments THIS clinic booked for this patient",
      description: "Scoped to bookedByUserId — consults the patient booked directly stay private to them.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "patientId", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "Appointments", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) } },
    },
    post: {
      tags: ["Clinic Portal"],
      summary: "Book an appointment on the patient's behalf",
      description:
        "Reuses the ordinary booking service verbatim; the only difference is the bookedByUserId stamp, which renders as 'booked by X Clinic' for the doctor and 'via X Clinic' for the patient. Doctors and slots come from the PUBLIC discovery endpoints, so a clinic can book exactly the set a patient could.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "patientId", in: "path", required: true, schema: { type: "string" } }],
      requestBody: jsonBody({
        type: "object",
        required: ["doctorId", "mode", "date", "startTime", "paymentMode"],
        properties: {
          doctorId: { type: "integer" },
          mode: { type: "string", enum: ["clinic", "video"] },
          clinicId: { type: "integer", description: "Required for mode=clinic; forbidden for video" },
          date: { type: "string", format: "date" },
          startTime: { type: "string", example: "10:00" },
          paymentMode: { type: "string", enum: ["online", "offline"] },
          offlineMethod: { type: "string", enum: ["cash", "upi_qr"], default: "cash", description: "How an OFFLINE payment is made (migration 044). upi_qr = the doctor's own UPI QR: requires paymentMode=offline and a doctor with an active QR (else 409 PAYMENT_QR_UNAVAILABLE); allowed for video too (video + cash is still forced online). The booking is confirmed with payment pending_at_clinic until the doctor marks it paid." },
        },
      }),
      responses: {
        201: { description: "Booked", ...jsonBody(envelope({ type: "object" })) },
        409: errorResponse("Slot taken (SLOT_TAKEN) or patient profile incomplete (PROFILE_INCOMPLETE)"),
      },
    },
  },
  "/clinic/bookings/{bookingId}/video-token": {
    post: {
      tags: ["Clinic Portal"],
      summary: "Join a video consult this clinic arranged",
      description:
        "So a patient can sit at the clinic and see the doctor on the clinic's screen. Gated on bookings.booked_by_user_id being THIS clinic — a consult the patient booked directly returns 404. The patient can still join independently from their own app; both tokens are for the same room.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "bookingId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        200: { description: "LiveKit grant", ...jsonBody(envelope({ type: "object" })) },
        403: errorResponse("Outside the join window (VIDEO_WINDOW_CLOSED)"),
        404: errorResponse("Not a booking this clinic made"),
      },
    },
  },
  // ── Admin: clinic verification ─────────────────────────────────────────────
  "/admin/clinics": {
    get: {
      tags: ["Admin – Clinics"],
      summary: "Clinic verification queue",
      description: "Approval is the ONLY thing between a self-registered account and the whole patient directory.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "status", in: "query", schema: { type: "string", enum: ["pending", "approved", "rejected"] } }],
      responses: { 200: { description: "Queue", ...jsonBody(envelope({ type: "array", items: { type: "object" } })) } },
    },
  },
  "/admin/clinics/{id}": {
    get: {
      tags: ["Admin – Clinics"],
      summary: "One clinic's profile + documents, for review",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "Clinic", ...jsonBody(envelope({ type: "object" })) } },
    },
  },
  "/admin/clinics/{id}/verify": {
    post: {
      tags: ["Admin – Clinics"],
      summary: "Approve or reject a clinic",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: jsonBody({
        type: "object",
        required: ["decision"],
        properties: {
          decision: { type: "string", enum: ["approved", "rejected"] },
          notes: { type: "string", nullable: true, description: "Shown to the clinic on reject" },
        },
      }),
      responses: { 200: { description: "Decision saved", ...jsonBody(envelope({ type: "object" })) } },
    },
  },
  "/admin/clinics/{id}/active": {
    patch: {
      tags: ["Admin – Clinics"],
      summary: "Suspend / reinstate an approved clinic",
      description:
        "Independent of the verdict: the account and its history survive, but every patient route stops answering.",
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: jsonBody({ type: "object", required: ["isActive"], properties: { isActive: { type: "boolean" } } }),
      responses: { 200: { description: "Updated", ...jsonBody(envelope({ type: "object" })) } },
    },
  },
};

// ── Medicine marketplace: global categories, global medicine master, provider
// inventory, patient browse and location-based prescription sharing (035) ──
const idParam = { name: "id", in: "path", required: true, schema: { type: "integer" } };
const bearer = [{ bearerAuth: [] }];
const categoryShape = {
  type: "object",
  properties: { id: { type: "integer", description: "INT id: a JSON number end-to-end" }, name: { type: "string" }, slug: { type: "string" } },
};
const categoryList = { 200: { description: "Categories", ...jsonBody(envelope({ type: "object", properties: { categories: { type: "array", items: categoryShape } } })) } };
const cityStateParams = [
  { name: "city", in: "query", schema: { type: "string" }, description: "Google selection city, matched case-insensitively against the provider's registered users.city" },
  { name: "state", in: "query", schema: { type: "string" }, description: "Google selection state, matched against users.state" },
];
const categoryCreate = {
  requestBody: jsonBody({ type: "object", required: ["name"], properties: { name: { type: "string", maxLength: 150 }, slug: { type: "string", nullable: true } } }),
  responses: {
    201: { description: "New global category created", ...jsonBody(envelope({ type: "object", properties: { category: categoryShape, created: { type: "boolean", example: true } } })) },
    200: { description: "An equivalent (case-insensitive) category already existed and is returned; no duplicate row", ...jsonBody(envelope({ type: "object", properties: { category: categoryShape, created: { type: "boolean", example: false } } })) },
    422: errorResponse("Validation failed"),
  },
};
/** The delivery + payment contract every checkout path shares. */
const checkoutProps = {
  paymentMethod: { type: "string", enum: ["cod", "online", "upi_qr"], description: "'online' is SIMULATED in this phase - no gateway is integrated. 'upi_qr' = paid to the pharmacy's OWN UPI QR (every pharmacy in the checkout must have one, else 409 PAYMENT_QR_UNAVAILABLE); live at once like COD, paid only when the pharmacy confirms receipt. requiresPayment stays false for it; paymentInstructions='upi_qr'." },
  deliveryAddress: { type: "string", minLength: 5, maxLength: 500 },
  deliveryCity: { type: "string", nullable: true },
  deliveryState: { type: "string", nullable: true },
  deliveryPincode: { type: "string", nullable: true },
  deliveryLat: { type: "number", nullable: true },
  deliveryLng: { type: "number", nullable: true },
  notes: { type: "string", nullable: true },
};

/** The medicines a patient picked off a pharmacy's availability answer. */
const prescriptionSelection = {
  type: "object",
  required: ["items"],
  properties: {
    items: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["itemId", "quantity"],
        properties: { itemId: { type: "integer" }, quantity: { type: "integer", minimum: 1 } },
      },
    },
  },
};

/** The delivery lifecycle, in order (migration 036 added on_the_way). */
const orderStatuses = ["pending", "confirmed", "processing", "shipped", "on_the_way", "delivered", "rejected", "cancelled"];

const medicinePaths = {
  "/medicine/categories": {
    get: {
      tags: ["Medicine"],
      summary: "List/search the GLOBAL categories (public)",
      parameters: [{ name: "search", in: "query", schema: { type: "string" }, description: "Case-insensitive substring" }],
      responses: categoryList,
    },
    post: { tags: ["Medicine"], summary: "Admin: find-or-create a global category", security: bearer, ...categoryCreate },
  },
  "/medicine/categories/{id}": {
    delete: {
      tags: ["Medicine"],
      summary: "Admin: delete an unused category (providers can never delete shared categories)",
      security: bearer,
      parameters: [idParam],
      responses: { 200: { description: "Deleted" }, 400: errorResponse("Category has medicines assigned"), 403: errorResponse("Not an admin") },
    },
  },
  "/medicine/my-categories": {
    get: {
      tags: ["Medicine"],
      summary: "MR / Store: list/search the global categories",
      security: bearer,
      parameters: [{ name: "search", in: "query", schema: { type: "string" } }],
      responses: categoryList,
    },
    post: { tags: ["Medicine"], summary: "MR / Store: find-or-create a global category (case-insensitive)", security: bearer, ...categoryCreate },
  },
  "/medicine/masters": {
    get: {
      tags: ["Medicine"],
      summary: "MR / Store: search the global medicine master (case-insensitive name / generic name)",
      security: bearer,
      parameters: [
        { name: "search", in: "query", schema: { type: "string" } },
        { name: "categoryId", in: "query", schema: { type: "integer" } },
        { name: "limit", in: "query", schema: { type: "integer", maximum: 50, default: 20 } },
      ],
      responses: { 200: { description: "Masters, each flagged inMyInventory / myInventoryId for the caller" } },
    },
  },
  "/medicine/masters/{id}/media": {
    get: {
      tags: ["Medicine"],
      summary: "Pharmacy / Admin: images + substitutes of a GLOBAL medicine (migration 037)",
      security: bearer,
      parameters: [idParam],
      responses: {
        200: { description: "{ masterId, images[{ id, imageUrl, sortOrder, uploadedBy, canDelete }], substitutes[master], maxImages, maxSubstitutes, canEdit }" },
        404: errorResponse("Medicine not in the catalogue"),
      },
    },
  },
  "/medicine/masters/{id}/images": {
    post: {
      tags: ["Medicine"],
      summary: "Pharmacy / Admin: upload ONE image to a global medicine (max 4)",
      description:
        "multipart/form-data, field `image` (any image type except SVG, MAX_UPLOAD_MB). Stored through the existing upload.service (local disk / S3). Only an admin or a pharmacy that currently sells the medicine may upload.",
      security: bearer,
      parameters: [idParam],
      requestBody: {
        content: { "multipart/form-data": { schema: { type: "object", required: ["image"], properties: { image: { type: "string", format: "binary" } } } } },
      },
      responses: {
        201: { description: "Updated media (same shape as GET /media)" },
        403: errorResponse("Caller does not sell this medicine"),
        422: errorResponse("Not an image, too large, or the medicine already has 4 images"),
      },
    },
  },
  "/medicine/masters/{id}/images/order": {
    put: {
      tags: ["Medicine"],
      summary: "Pharmacy / Admin: reorder a medicine's images (first = primary)",
      security: bearer,
      parameters: [idParam],
      requestBody: jsonBody({ type: "object", required: ["imageIds"], properties: { imageIds: { type: "array", items: { type: "integer" } } } }),
      responses: { 200: { description: "Updated media" }, 400: errorResponse("imageIds must list every image exactly once") },
    },
  },
  "/medicine/masters/{id}/images/{imageId}": {
    delete: {
      tags: ["Medicine"],
      summary: "Pharmacy / Admin: remove an image (uploader or admin only; the stored object is deleted too)",
      security: bearer,
      parameters: [idParam, { name: "imageId", in: "path", required: true, schema: { type: "integer" } }],
      responses: { 200: { description: "Updated media" }, 403: errorResponse("Not the uploader"), 404: errorResponse("Image not found") },
    },
  },
  "/medicine/masters/{id}/substitutes": {
    put: {
      tags: ["Medicine"],
      summary: "Pharmacy / Admin: replace a medicine's substitute list with EXISTING global medicines",
      description:
        "Replace-the-set (an empty array clears it). Ids must be existing, active masters other than the medicine itself; nothing new is ever created. Directional: A → B lists B on A's page only.",
      security: bearer,
      parameters: [idParam],
      requestBody: jsonBody({ type: "object", required: ["substituteIds"], properties: { substituteIds: { type: "array", maxItems: 12, items: { type: "integer" } } } }),
      responses: { 200: { description: "Updated media" }, 400: errorResponse("Self, unknown or too many substitutes"), 403: errorResponse("Caller does not sell this medicine") },
    },
  },
  "/medicine/medicine/{id}": {
    get: {
      tags: ["Medicine"],
      summary: "Patient/public: one pharmacy's listing, with the medicine's gallery and substitutes",
      description:
        "`images` and `primaryImageUrl` come from the global medicine. Each substitute carries `price` (cheapest active listing, in-stock preferred), `providerCount`, `inStockCount`, `available` and `listingId` (that listing, or null when no active pharmacy sells it) — all computed from real inventory.",
      parameters: [idParam],
      responses: { 200: { description: "{ medicine }" }, 404: errorResponse("Listing inactive or its pharmacy is not an active type") },
    },
  },
  "/medicine/my-medicines": {
    get: {
      tags: ["Medicine"],
      summary: "Pharmacy: MY inventory — searched, filtered, sorted and paginated in the database",
      description:
        "Each row carries the stored commercial data plus derived figures: effectivePrice (after the item discount), unitMargin (excl. GST; null without a buying price), stockStatus (in / low / out against minStock) and expiryStatus of the nearest-expiring batch that still has stock.",
      security: bearer,
      parameters: [
        { name: "search", in: "query", schema: { type: "string" }, description: "Name, generic, manufacturer, SKU or batch" },
        { name: "category", in: "query", schema: { type: "integer" } },
        { name: "form", in: "query", schema: { type: "string" } },
        { name: "stockStatus", in: "query", schema: { type: "string", enum: ["in", "low", "out"] } },
        { name: "expiry", in: "query", schema: { type: "string", enum: ["expired", "expiring", "valid", "none"] }, description: "Against the pharmacy's own expiry window (Settings)" },
        { name: "supplierId", in: "query", schema: { type: "integer" } },
        { name: "active", in: "query", schema: { type: "string", enum: ["active", "inactive", "all"], default: "active" } },
        { name: "sort", in: "query", schema: { type: "string", enum: ["name", "stock", "price", "expiry", "updated"], default: "name" } },
        { name: "order", in: "query", schema: { type: "string", enum: ["asc", "desc"], default: "asc" } },
        { name: "page", in: "query", schema: { type: "integer" } },
        { name: "limit", in: "query", schema: { type: "integer", maximum: 100 } },
      ],
      responses: { 200: { description: "{ medicines, total, page, limit, totalPages }" } },
    },
    post: {
      tags: ["Medicine"],
      summary: "Pharmacy: add a medicine to MY inventory (image NOT required)",
      description:
        "Send medicineMasterId to sell an existing global medicine, or the medicine details (medicineName + medicineType required) to add a new one. An existing master with the same case-insensitive NAME|STRENGTH|TYPE is reused, never duplicated. Price, cost, GST, discount and stock are always the caller's own. Opening stock goes into `batchNumber` (with `expiryDate`) when given, otherwise it is untracked. Selling price may not exceed MRP. Images are added later through /medicine/masters/{id}/images.",
      security: bearer,
      requestBody: jsonBody({
        type: "object",
        required: ["price"],
        properties: {
          medicineMasterId: { type: "integer" },
          medicineName: { type: "string" },
          medicineType: { type: "string" },
          genericName: { type: "string" },
          strength: { type: "string" },
          manufacturer: { type: "string" },
          description: { type: "string" },
          categoryId: { type: "integer", nullable: true },
          price: { type: "number", description: "Selling price per unit, GST-INCLUSIVE, before discount" },
          mrp: { type: "number", nullable: true },
          buyingPrice: { type: "number", nullable: true, description: "Purchase rate per unit, excl. GST — never shown to patients" },
          gstRate: { type: "number", minimum: 0, maximum: 100 },
          discountPercent: { type: "number", minimum: 0, maximum: 100 },
          minStock: { type: "integer", description: "Reorder level (default 10)" },
          sku: { type: "string" },
          hsnCode: { type: "string" },
          packSize: { type: "string" },
          supplierId: { type: "integer", nullable: true, description: "One of the caller's own suppliers" },
          stock: { type: "integer", default: 0 },
          batchNumber: { type: "string" },
          expiryDate: { type: "string", format: "date" },
          location: { type: "string", description: "Defaults to the provider's registered city, state" },
        },
      }),
      responses: { 201: { description: "Inventory row created (linked to the master)" }, 400: errorResponse("Price above MRP / unknown supplier"), 409: errorResponse("Caller already sells this medicine") },
    },
  },
  "/medicine/my-medicines/{id}": {
    get: {
      tags: ["Medicine"],
      summary: "Pharmacy: one of MY inventory rows, with its batches and untracked stock",
      security: bearer,
      parameters: [idParam],
      responses: { 200: { description: "Medicine" }, 404: errorResponse("Not the caller's inventory row") },
    },
    put: {
      tags: ["Medicine"],
      summary: "Pharmacy: update MY inventory row (commercial fields, stock total, location, image, active)",
      description:
        "Global medicine fields belong to the shared master and are ignored. A new `stock` is a manual correction of the TOTAL, applied to the untracked units and written to the stock ledger; it may not go below the units held in batches (correct those per batch).",
      security: bearer,
      parameters: [idParam],
      requestBody: jsonBody({
        type: "object",
        properties: {
          price: { type: "number" }, mrp: { type: "number", nullable: true }, buyingPrice: { type: "number", nullable: true },
          gstRate: { type: "number" }, discountPercent: { type: "number" }, minStock: { type: "integer" },
          sku: { type: "string" }, hsnCode: { type: "string" }, packSize: { type: "string" }, supplierId: { type: "integer", nullable: true },
          stock: { type: "integer" }, stockNote: { type: "string" },
          location: { type: "string" }, imageUrl: { type: "string" }, isActive: { type: "boolean" },
        },
      }),
      responses: { 200: { description: "Updated" }, 400: errorResponse("Price above MRP / stock below batched units"), 404: errorResponse("Not the caller's inventory row") },
    },
  },
  "/medicine/browse": {
    get: {
      tags: ["Medicine"],
      summary: "Patient/public: provider-specific inventory rows (one per provider selling the medicine)",
      parameters: [
        { name: "search", in: "query", schema: { type: "string" }, description: "Split into words on punctuation (\"Zerodol-SP\" matches \"Zerodol Sp\"); every word must match the name, generic name, manufacturer or strength. LIKE wildcards are matched literally." },
        { name: "category", in: "query", schema: { type: "integer" }, description: "Legacy - still accepted, no longer sent by the patient app" },
        ...cityStateParams,
        { name: "providerType", in: "query", schema: { type: "string", enum: ["medicine_store", "pharmacy_hospital", "mr"] }, description: "Active pharmacy types only. 'mr' is accepted but retired: it matches no providers (migration 036)." },
        { name: "availability", in: "query", schema: { type: "string", enum: ["in", "out"] } },
        { name: "minPrice", in: "query", schema: { type: "number", minimum: 0 }, description: "On the price the patient pays (after the item discount)" },
        { name: "maxPrice", in: "query", schema: { type: "number", minimum: 0 } },
        { name: "sort", in: "query", schema: { type: "string", enum: ["relevance", "price_asc", "price_desc", "discount", "name"], default: "relevance" }, description: "Every sort except name lists in-stock rows first" },
        { name: "location", in: "query", schema: { type: "string" }, description: "Legacy free-text listing location" },
        { name: "page", in: "query", schema: { type: "integer" } },
        { name: "limit", in: "query", schema: { type: "integer" } },
      ],
      responses: { 200: { description: "Inventory rows with provider { id, name, role, city, state }, primaryImageUrl (the global medicine's first image) and server-computed pricing: effectivePrice, mrp, discountPercent, compareAtPrice (MRP, else the pre-discount price; null when there is no saving), savingsAmount, savingsPercent (floored)" } },
    },
  },
  "/medicine/suggest": {
    get: {
      tags: ["Medicine"],
      summary: "Patient/public: search-as-you-type, one suggestion per global medicine",
      description:
        "Same search and same for-sale gate as /medicine/browse, grouped per global medicine. fromPrice is the cheapest price among IN-STOCK listings (null when none has stock); listingId is the listing to open (cheapest in stock). Only counts are returned about pharmacies.",
      parameters: [
        { name: "q", in: "query", schema: { type: "string", maxLength: 100 } },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 20, default: 8 } },
      ],
      responses: {
        200: { description: "{ suggestions: [{ masterId, listingId, medicineName, genericName, medicineType, strength, manufacturer, packSize, imageUrl, fromPrice, available, inStockCount, pharmacyCount }] }" },
      },
    },
  },
  "/medicine/providers": {
    get: {
      tags: ["Medicine"],
      summary: "Registered pharmacies (public): the store directory, its map pins and the prescription-share recipient list",
      description:
        "Real registered providers from `users` only - name, registered Google location (city/state/pincode/lat/lng) and a live count of the medicines each one lists. The retired MR type is never returned.",
      parameters: [
        { name: "providerType", in: "query", schema: { type: "string", enum: ["medicine_store", "pharmacy_hospital", "all", "mr"] } },
        ...cityStateParams,
        { name: "search", in: "query", schema: { type: "string" } },
        { name: "withCoordinates", in: "query", schema: { type: "boolean" }, description: "Map view: only pharmacies whose registered location has lat/lng" },
      ],
      responses: { 200: { description: "Providers (id, name, role, providerType, typeLabel, phone, addressLine, city, state, pincode, lat, lng, medicineCount)" } },
    },
  },
  "/medicine/prescriptions": {
    post: {
      tags: ["Medicine"],
      summary: "Patient: upload a prescription and share it with the selected providers",
      description:
        "Every providerId is re-validated server-side: an ACTIVE pharmacy (Pharmacy Medicine Store / Clinic or Pharmacy Hospital) of providerType (all = both) and, when city/state are sent, registered in that location. One invalid id rejects the whole share. One prescription_request per selected provider; provider_type comes from the provider's real role. The retired MR type can no longer receive a new share.",
      security: bearer,
      requestBody: {
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["prescription", "providerIds"],
              properties: {
                prescription: { type: "string", format: "binary" },
                providerIds: { type: "array", items: { type: "integer" } },
                providerType: { type: "string", enum: ["medicine_store", "pharmacy_hospital", "all"] },
                city: { type: "string" },
                state: { type: "string" },
                notes: { type: "string" },
              },
            },
          },
        },
      },
      responses: { 201: { description: "Shared" }, 400: errorResponse("A selected provider is not valid for the type/location") },
    },
  },
  "/medicine/prescriptions/{id}/cart": {
    post: {
      tags: ["Medicine"],
      summary: "Patient: add the pharmacy's AVAILABLE medicines from this prescription to the existing cart",
      description:
        "Each selection is re-checked against the stored answer (belongs to this patient's request, marked available, still stocked, within the quantity the pharmacy offered). No price is taken from the client - the cart line points at the provider's inventory row.",
      security: bearer,
      parameters: [idParam],
      requestBody: jsonBody(prescriptionSelection),
      responses: { 201: { description: "Cart" }, 400: errorResponse("A selected medicine is unavailable or out of stock") },
    },
  },
  "/medicine/prescriptions/{id}/order": {
    post: {
      tags: ["Medicine"],
      summary: "Patient: order the pharmacy's available medicines from this prescription",
      description: "Runs through the same checkout path as the cart: one order + bill per pharmacy, server-computed total, simulated payment.",
      security: bearer,
      parameters: [idParam],
      requestBody: jsonBody({
        type: "object",
        required: ["items", "paymentMethod", "deliveryAddress"],
        properties: { ...prescriptionSelection.properties, ...checkoutProps },
      }),
      responses: { 201: { description: "Order placed (requiresPayment=true for online)" }, 400: errorResponse("Unavailable / out of stock") },
    },
  },
  "/medicine/cart": {
    get: {
      tags: ["Medicine"],
      summary: "Patient: the cart, grouped by pharmacy",
      description:
        "Prices and stock are read LIVE from each provider's inventory row on every read, so a stale line is re-priced and an out-of-stock line is flagged (`blocked`) before checkout.",
      security: bearer,
      responses: {
        200: {
          description:
            "Cart with items (each: unitPrice, discountAmount, lineTotal, gstRate, gstAmount, mrpTotal, mrpSavings, maxQuantity = live stock, blocked, medicine incl. imageUrl/packSize, provider), providerGroups, itemCount, grossTotal, discountTotal, subtotal, gstIncluded (inside the prices, not added), mrpSavings, deliveryFee (always 0 - no delivery fee exists), total, hasBlockedItems. Money totals count orderable lines only.",
        },
      },
    },
    delete: { tags: ["Medicine"], summary: "Patient: empty the cart", security: bearer, responses: { 200: { description: "Cart" } } },
  },
  "/medicine/cart/count": {
    get: { tags: ["Medicine"], summary: "Patient: cart badge count", security: bearer, responses: { 200: { description: "{ itemCount }" } } },
  },
  "/medicine/cart/items": {
    post: {
      tags: ["Medicine"],
      summary: "Patient: add a provider's medicine to the cart (login required)",
      description:
        "A signed-out visitor may browse and read every medicine; adding to the cart is authenticated, so the frontend sends them through the existing login and straight back.",
      security: bearer,
      requestBody: jsonBody({
        type: "object",
        required: ["medicineId"],
        properties: {
          medicineId: { type: "integer", description: "A PROVIDER inventory row id - it carries that provider's own price and stock" },
          quantity: { type: "integer", minimum: 1, default: 1 },
          prescriptionRequestId: { type: "integer", nullable: true },
        },
      }),
      responses: { 201: { description: "Cart" }, 400: errorResponse("Out of stock / pharmacy not accepting orders") },
    },
  },
  "/medicine/cart/items/{id}": {
    put: {
      tags: ["Medicine"],
      summary: "Patient: set a cart line's quantity (0 removes it)",
      security: bearer,
      parameters: [idParam],
      requestBody: jsonBody({ type: "object", required: ["quantity"], properties: { quantity: { type: "integer", minimum: 0 } } }),
      responses: { 200: { description: "Cart" }, 400: errorResponse("Insufficient stock") },
    },
    delete: { tags: ["Medicine"], summary: "Patient: remove a cart line", security: bearer, parameters: [idParam], responses: { 200: { description: "Cart" } } },
  },
  "/medicine/orders/checkout": {
    post: {
      tags: ["Medicine"],
      summary: "Patient: check the cart out into one order (and one bill) per pharmacy",
      description:
        "Every line is re-read under a row lock: the medicine must be active, its pharmacy active and of an ACTIVE type, and stock must cover the quantity. The unit price charged is the provider's CURRENT price and the total is computed here - a price, stock or total sent by a client is ignored. Stock is decremented in the same transaction. COD notifies the pharmacy at once; an online order waits for its payment.",
      security: bearer,
      requestBody: jsonBody({
        type: "object",
        required: ["paymentMethod", "deliveryAddress"],
        properties: {
          itemIds: { type: "array", items: { type: "integer" }, description: "Omit to check out the whole cart" },
          ...checkoutProps,
        },
      }),
      responses: {
        201: { description: "{ groups: [...], requiresPayment }" },
        400: errorResponse("Empty cart / out of stock / pharmacy not accepting orders"),
        409: errorResponse("The cart lines were already consumed by a concurrent checkout (double submit) - no second order is created"),
      },
    },
  },
  "/medicine/orders/groups/my": {
    get: {
      tags: ["Medicine"],
      summary: "Patient: my orders (one row per order, not per medicine)",
      security: bearer,
      parameters: [{ name: "status", in: "query", schema: { type: "string", enum: orderStatuses } }],
      responses: { 200: { description: "Orders" } },
    },
  },
  "/medicine/orders/groups/provider": {
    get: {
      tags: ["Medicine"],
      summary: "Pharmacy: incoming orders (searchable)",
      description:
        "Only this pharmacy's own orders, and only those that are real: an online order is withheld until its payment succeeds (and stays visible if later refunded). Lines carry the price / discount / GST snapshot and the pharmacy-private unitCost.",
      security: bearer,
      parameters: [
        { name: "status", in: "query", schema: { type: "string", enum: orderStatuses } },
        { name: "paymentStatus", in: "query", schema: { type: "string", enum: ["pending", "paid", "failed", "refunded"] } },
        { name: "paymentMethod", in: "query", schema: { type: "string", enum: ["cod", "online", "upi_qr"] } },
        { name: "search", in: "query", schema: { type: "string" }, description: "Order number or patient name" },
        { name: "from", in: "query", schema: { type: "string", format: "date" }, description: "IST day, inclusive" },
        { name: "to", in: "query", schema: { type: "string", format: "date" }, description: "IST day, inclusive" },
        { name: "medicineId", in: "query", schema: { type: "integer" }, description: "Orders containing this inventory row" },
        { name: "page", in: "query", schema: { type: "integer" } },
        { name: "limit", in: "query", schema: { type: "integer" } },
      ],
      responses: { 200: { description: "Orders" } },
    },
  },
  "/medicine/orders/groups/{id}": {
    get: {
      tags: ["Medicine"],
      summary: "One order - readable only by its patient or its pharmacy",
      security: bearer,
      parameters: [idParam],
      responses: { 200: { description: "Order" }, 403: errorResponse("Not your order") },
    },
  },
  "/medicine/orders/groups/{id}/pay": {
    post: {
      tags: ["Medicine"],
      summary: "Patient: settle an online order's SIMULATED payment",
      description:
        "No payment gateway is integrated in this phase: no gateway is contacted, no credentials exist and no money moves. The stored reference is an obviously synthetic 'SIM-...' string. `outcome` lets the failure path be exercised end to end; a real gateway replaces this endpoint with its signed callback and the outcome stops being client-supplied. Idempotent - a repeated call returns the settled order instead of charging again. On success the pharmacy is notified and the order becomes visible to it; on failure the order is cancelled and its stock returned.",
      security: bearer,
      parameters: [idParam],
      requestBody: jsonBody({
        type: "object",
        properties: {
          outcome: { type: "string", enum: ["success", "failure"], default: "success" },
          idempotencyKey: { type: "string", nullable: true },
        },
      }),
      responses: { 200: { description: "{ group, alreadySettled }" }, 400: errorResponse("Not payable / payment failed") },
    },
  },
  "/medicine/orders/groups/{id}/status": {
    put: {
      tags: ["Medicine"],
      summary: "Pharmacy: move the order along its delivery lifecycle",
      description:
        "pending -> confirmed|rejected -> processing -> shipped -> on_the_way -> delivered. The allowed next steps come from ONE transition table, so an arbitrary or backwards jump is rejected. Rejecting returns the stock; delivering a COD order settles its bill.",
      security: bearer,
      parameters: [idParam],
      requestBody: jsonBody({ type: "object", required: ["status"], properties: { status: { type: "string", enum: orderStatuses } } }),
      responses: { 200: { description: "Order" }, 400: errorResponse("Invalid status transition / not paid"), 403: errorResponse("Not your order") },
    },
  },
  "/medicine/orders/groups/{id}/cancel": {
    put: {
      tags: ["Medicine"],
      summary: "Patient: cancel an order that is not being prepared yet (stock is returned)",
      security: bearer,
      parameters: [idParam],
      responses: { 200: { description: "Order" }, 400: errorResponse("No longer cancellable") },
    },
  },
  "/medicine/orders/groups/{id}/invoice": {
    get: {
      tags: ["Medicine"],
      summary: "The bill for an order - readable by its patient or its pharmacy",
      description:
        "DERIVED from the order rather than stored separately, so the bill and the order can never disagree. Each line carries the snapshot taken when the order was placed: MRP, selling price, item discount, GST rate, the taxable value and the GST INCLUDED in the amount (prices are GST-inclusive), HSN and the batches the units came from (stock ledger). `gstSummary` groups tax by rate; `gstRecorded` is false for orders placed before GST data existed. `store` adds the pharmacy's GSTIN / drug licence (Settings). Credit notes appear under `returns`. No delivery line is emitted (none is charged). `payment.simulated` is true while payments are simulated.",
      security: bearer,
      parameters: [idParam],
      responses: { 200: { description: "Invoice" }, 403: errorResponse("Not your order") },
    },
  },
};

// ── Admin pharmacy & medicine tracking (routes/adminMedicine.routes.js) ──────
const adminOrderFilterParams = [
  { name: "from", in: "query", schema: { type: "string", format: "date-time" }, description: "created_at >= from" },
  { name: "to", in: "query", schema: { type: "string", format: "date-time" }, description: "created_at < to (must be after from)" },
  { name: "pharmacyId", in: "query", schema: { type: "integer" } },
  { name: "providerType", in: "query", schema: { type: "string", enum: ["medicine_store", "pharmacy_hospital", "mr"] } },
  { name: "medicine", in: "query", schema: { type: "string" }, description: "Order contains a medicine whose name/generic matches" },
  { name: "orderStatus", in: "query", schema: { type: "string", enum: ["pending", "confirmed", "processing", "shipped", "on_the_way", "delivered", "rejected", "cancelled"] } },
  { name: "paymentStatus", in: "query", schema: { type: "string", enum: ["pending", "paid", "failed", "refunded"] } },
  { name: "paymentMethod", in: "query", schema: { type: "string", enum: ["cod", "online", "upi_qr"] } },
];
const adminPageParams = [
  { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
];
const adminMedicineGet = (summary, description, parameters, dataSchema) => ({
  get: {
    tags: ["Admin – Pharmacy & Medicine"],
    summary,
    description,
    security: [{ bearerAuth: [] }],
    parameters,
    responses: {
      200: { description: summary, ...jsonBody(envelope(dataSchema)) },
      401: errorResponse("Not authenticated"),
      403: errorResponse("Not an admin"),
      422: errorResponse("Invalid filter"),
    },
  },
});
const adminMedicinePaths = {
  "/admin/medicine/overview": adminMedicineGet(
    "Medicine & pharmacy ecosystem overview",
    "Admin-only, read-only aggregates (COUNT/SUM/GROUP BY). An order is a checkout group, or a legacy one-line order with no group. Order filters apply to orders/payments/pharmacies; medicine, provider and inventory counts are platform-wide. Stock is never summed across providers.",
    adminOrderFilterParams,
    {
      type: "object",
      properties: {
        medicines: { type: "object", description: "{ total, active, inactive, byCategory[{ id, name, medicines }] }" },
        providers: { type: "object", description: "{ active[{ role, label, total, active, inactive }], legacyMr{…} }" },
        orders: { type: "object", description: "{ total, patients, amount, paidAmount, byStatus{status: count} }" },
        payments: { type: "object", description: "{ paid, pending, failed, refunded, cod, online, unspecifiedMethod, breakdown[], attempts[] }" },
        pharmacies: { type: "array", items: { type: "object" }, description: "Pharmacy-wise orders: { id, name, providerType, typeLabel, city, state, orders, patients, amount, byStatus }" },
        inventory: { type: "object", description: "{ records, medicines, providers, inStock, outOfStock, lowStock, lowStockThreshold }" },
      },
    }
  ),
  "/admin/medicine/orders": adminMedicineGet(
    "Medicine order tracking",
    "Admin-only. Newest first. Patient is id + name only. Each order carries its lines (medicine, quantity, unit/total price), amount, payment method/status and order status.",
    [...adminOrderFilterParams, ...adminPageParams],
    { type: "object", properties: { orders: { type: "array", items: { type: "object" } }, total: { type: "integer" }, page: { type: "integer" }, limit: { type: "integer" }, totalPages: { type: "integer" } } }
  ),
  "/admin/medicine/inventory": adminMedicineGet(
    "Provider-wise medicine inventory",
    "Admin-only. One row per ACTIVE provider inventory record (medicine × provider) with that provider's own price and stock.",
    [
      { name: "search", in: "query", schema: { type: "string" } },
      { name: "providerId", in: "query", schema: { type: "integer" } },
      { name: "providerType", in: "query", schema: { type: "string", enum: ["medicine_store", "pharmacy_hospital", "mr"] } },
      { name: "stock", in: "query", schema: { type: "string", enum: ["in", "out", "low"] } },
      ...adminPageParams,
    ],
    { type: "object", properties: { items: { type: "array", items: { type: "object" } }, total: { type: "integer" }, page: { type: "integer" }, limit: { type: "integer" }, totalPages: { type: "integer" }, lowStockThreshold: { type: "integer" } } }
  ),
  "/admin/medicine/pharmacies": adminMedicineGet(
    "Registered pharmacy providers",
    "Admin-only. Every pharmacy account (legacy MR flagged `isLegacy`) with its active inventory and out-of-stock counts.",
    [
      { name: "providerType", in: "query", schema: { type: "string", enum: ["medicine_store", "pharmacy_hospital", "mr"] } },
      { name: "search", in: "query", schema: { type: "string" } },
    ],
    { type: "array", items: { type: "object" } }
  ),
};

// ── Diagnostic Lab (migration 038) ───────────────────────────────────────
const diagStatuses = ["pending", "viewed", "available", "booking_requested", "confirmed", "test_completed", "report_ready", "rejected"];
const diagListParams = [
  { name: "status", in: "query", schema: { type: "string", enum: diagStatuses } },
  { name: "from", in: "query", schema: { type: "string", format: "date-time" } },
  { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
  { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
];
const diagOp = (summary, description, { responses = {}, tags = ["Diagnostic Lab"], ...extra } = {}) => ({
  tags,
  summary,
  description,
  security: bearer,
  ...extra,
  responses: {
    200: { description: "OK" },
    401: errorResponse("Not authenticated"),
    403: errorResponse("Wrong role, or not this request's patient / lab"),
    404: errorResponse("Not found"),
    422: errorResponse("Validation failed"),
    ...responses,
  },
});
const testIdParam = { name: "testId", in: "path", required: true, schema: { type: "integer" } };
const multipart = (required, properties) => ({
  content: { "multipart/form-data": { schema: { type: "object", required, properties } } },
});

const diagnosticPaths = {
  "/diagnostics/labs": {
    get: diagOp(
      "Patient: registered Diagnostic Lab Centers in the selected location",
      "Same Google city/state rule as the pharmacy directory (case-insensitive exact match on the lab's registered location). Each lab carries `testCount` (active, available catalogue tests).",
      {
        parameters: [
          { name: "city", in: "query", schema: { type: "string" } },
          { name: "state", in: "query", schema: { type: "string" } },
          { name: "search", in: "query", schema: { type: "string" } },
          { name: "page", in: "query", schema: { type: "integer" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
        ],
      }
    ),
  },
  "/diagnostics/requests": {
    post: diagOp(
      "Patient: share a prescription with the selected diagnostic lab(s)",
      "Every labId is re-validated server-side (an ACTIVE diagnostic_lab and, when city/state are sent, registered there). One invalid id rejects the whole share. One diagnostic_request per lab; each lab is notified.",
      {
        requestBody: multipart(["prescription", "labIds"], {
          prescription: { type: "string", format: "binary" },
          labIds: { type: "array", items: { type: "integer" } },
          city: { type: "string" },
          state: { type: "string" },
          notes: { type: "string" },
        }),
        responses: { 201: { description: "{ requests }" }, 400: errorResponse("A selected lab is not valid for the location") },
      }
    ),
  },
  "/diagnostics/requests/mine": {
    get: diagOp("Patient: my diagnostic requests", "Newest first, with the lab.", { parameters: diagListParams }),
  },
  "/diagnostics/requests/incoming": {
    get: diagOp("Lab: requests shared with MY lab", "Newest first, with the patient (id, name, phone).", {
      parameters: diagListParams,
    }),
  },
  "/diagnostics/summary": {
    get: diagOp("Lab: my overview counts", "{ total, byStatus{status: count}, tests }"),
  },
  "/diagnostics/requests/{id}": {
    get: diagOp(
      "Patient or lab: one request with its tests",
      "Only the request's patient or its lab. `tests[]` carries the lab's answer (status, price, reason), the patient's `isSelected`, and `report` metadata when uploaded.",
      { parameters: [idParam] }
    ),
  },
  "/diagnostics/requests/{id}/file": {
    get: diagOp("Patient or lab: stream the shared prescription file", "Streamed inline, private/no-store. Never a public URL.", {
      parameters: [idParam],
    }),
  },
  "/diagnostics/requests/{id}/tests/{testId}/report": {
    get: diagOp("Patient or lab: stream a test's report", "Streamed inline, private/no-store.", {
      parameters: [idParam, testIdParam],
    }),
  },
  "/diagnostics/requests/{id}/status": {
    put: diagOp(
      "Lab: move the request along",
      "Allowed: pending→viewed|rejected, viewed→rejected, available→rejected, booking_requested→confirmed|rejected, confirmed→test_completed. The patient is notified; `note` is shown to them.",
      {
        parameters: [idParam],
        requestBody: jsonBody({
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string", enum: ["viewed", "confirmed", "test_completed", "rejected"] },
            note: { type: "string" },
          },
        }),
        responses: { 400: errorResponse("Transition not allowed") },
      }
    ),
  },
  "/diagnostics/requests/{id}/response": {
    put: diagOp(
      "Lab: answer which tests are available and at what price",
      "Replaces any previous answer; allowed while pending/viewed/available. An available test is a catalogue test (diagnosticTestId; price defaults to the catalogue price) or a typed-in test (testName + price). Status → available; the patient is notified.",
      {
        parameters: [idParam],
        requestBody: jsonBody({
          type: "object",
          required: ["tests"],
          properties: {
            tests: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["available", "unavailable"] },
                  diagnosticTestId: { type: "integer" },
                  testName: { type: "string" },
                  price: { type: "number" },
                  reason: { type: "string" },
                },
              },
            },
            note: { type: "string" },
          },
        }),
      }
    ),
  },
  "/diagnostics/requests/{id}/book": {
    post: diagOp(
      "Patient: book available tests for a date",
      "Only while status is `available`. The date must be today or later (max 180 days). Status → booking_requested; the lab is notified.",
      {
        parameters: [idParam],
        requestBody: jsonBody({
          type: "object",
          required: ["testIds", "preferredDate"],
          properties: {
            testIds: { type: "array", items: { type: "integer" } },
            preferredDate: { type: "string", format: "date" },
            notes: { type: "string" },
          },
        }),
      }
    ),
  },
  "/diagnostics/requests/{id}/reports": {
    post: diagOp(
      "Lab: upload a report for one or more booked tests",
      "Only after test_completed. The file is filed into the patient's medical records (uploaded_records, source diagnostic_lab) and linked to the tests. When every booked test has a report the request becomes report_ready. The patient is notified.",
      {
        parameters: [idParam],
        requestBody: multipart(["report", "testIds"], {
          report: { type: "string", format: "binary" },
          testIds: { type: "array", items: { type: "integer" } },
          fileType: { type: "string", enum: ["lab_report", "xray", "mri", "other"], default: "lab_report" },
        }),
      }
    ),
  },
  "/diagnostics/tests": {
    get: diagOp("Lab: my test catalogue", "Active tests only.", {
      parameters: [{ name: "search", in: "query", schema: { type: "string" } }],
    }),
    post: diagOp("Lab: add a test to my catalogue", "Name must be unique among my active tests.", {
      requestBody: jsonBody({
        type: "object",
        required: ["name", "price"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          price: { type: "number" },
          isAvailable: { type: "boolean", default: true },
        },
      }),
      responses: { 409: errorResponse("Duplicate test name") },
    }),
  },
  "/diagnostics/tests/{id}": {
    put: diagOp("Lab: edit one of my tests", "Any of name / description / price / isAvailable.", {
      parameters: [idParam],
      requestBody: jsonBody({ type: "object" }),
    }),
    delete: diagOp("Lab: remove one of my tests", "Soft delete — answers already sent keep their link.", {
      parameters: [idParam],
    }),
  },
  "/admin/diagnostics/overview": {
    get: diagOp(
      "Admin: Diagnostic Lab overview",
      "Read-only aggregates: labs{total,active,inactive}, requests{total,patients,responded,byStatus}, bookings{total,confirmed,completed}, reports{total}, tests{total}, perLab[]. No files, no test names.",
      { tags: ["Admin – Diagnostic Labs"] }
    ),
  },
  "/admin/diagnostics/requests": {
    get: diagOp(
      "Admin: diagnostic workflow ledger",
      "One row per request: patient (id, name) → lab → step timestamps (responded, booking requested, preferred date, confirmed, completed, report ready) and test counts. No files, no test names.",
      {
        tags: ["Admin – Diagnostic Labs"],
        parameters: [...diagListParams, { name: "labId", in: "query", schema: { type: "integer" } }],
      }
    ),
  },
};

// Blood Bank module (migration 039) — its own file, merged below.
const { bloodBankPaths, bloodBankTags } = require("./swagger.bloodBank");
// Ambulance module (migration 040) — its own file, merged below.
const { ambulancePaths, ambulanceTags } = require("./swagger.ambulance");
// Pharmacy management (migration 043) — its own file, merged below.
const { pharmacyPaths, pharmacyTags } = require("./swagger.pharmacy");
// Provider UPI QR payments (migration 044) — its own file, merged below.
const { paymentQrPaths, paymentQrTags } = require("./swagger.paymentQr");
const { recordAccessPaths, recordAccessTags } = require("./swagger.recordAccess");
const { emrPaths, emrTags } = require("./swagger.emr");
const { clinicalCodingPaths, clinicalCodingTags } = require("./swagger.clinicalCoding");
const { patientMedicinePaths, patientMedicineTags } = require("./swagger.patientMedicine");
const { doctorAnalyticsPaths, doctorAnalyticsTags } = require("./swagger.doctorAnalytics");

const spec = {
  openapi: "3.0.3",
  info: {
    title: "Indian Health System API",
    version: "1.0.0",
    description: "Doctor–Patient Consultation Platform — auth API.",
  },
  servers: [{ url: env.API_PREFIX, description: env.NODE_ENV }],
  tags: [
    { name: "Auth", description: "Authentication & session management" },
    { name: "Doctor", description: "Doctor-owned profile & portfolio management" },
    { name: "Doctors (public)", description: "Public discovery & portfolio reads" },
    { name: "Clinics & Availability", description: "Doctor clinics, weekly schedules & exceptions" },
    { name: "Patient", description: "Patient-owned profile & bookings" },
    { name: "Bookings & Payments", description: "Slot booking, offline pay-at-clinic, and doctor appointments" },
    { name: "Admin – Verification", description: "Doctor verification queue & verdicts" },
    { name: "Admin – Doctor Management", description: "Admin create-doctor (auto-approved) + full editing of any doctor" },
    { name: "Dashboards & Earnings", description: "Server-computed tiles, the doctor's earnings module, and platform revenue" },
    {
      name: "Clinic Portal",
      description:
        "The clinic account: its own profile & verification, the patient directory, one patient's record (reads + writes), booking on a patient's behalf, and joining a video consult it arranged. Every /clinic/patients* route requires an APPROVED clinic.",
    },
    { name: "Admin – Clinics", description: "Clinic verification queue, verdicts & suspension" },
    { name: "Admin – Pharmacy & Medicine", description: "Read-only medicine, pharmacy, order, payment and inventory tracking" },
    {
      name: "Diagnostic Lab",
      description:
        "Diagnostic Lab Centers: location-based prescription sharing, the lab's test catalogue, test availability + price answers, booking a test date, confirmation, completion and report upload (filed into the patient's medical records)",
    },
    { name: "Admin – Diagnostic Labs", description: "Read-only diagnostic lab counts and workflow tracking" },
    ...bloodBankTags,
    ...ambulanceTags,
    ...pharmacyTags,
    ...paymentQrTags,
    ...recordAccessTags,
    ...emrTags,
    ...clinicalCodingTags,
    ...patientMedicineTags,
    ...doctorAnalyticsTags,
    { name: "Treatment Timeline", description: "A patient's flat treatment history (patient's own, and the doctor's view of a patient they treat)" },
    {
      name: "Medicine",
      description:
        "The pharmacy platform: global categories and medicine master, provider inventory, public browse, the registered-pharmacy directory, location-based prescription sharing, the cart, checkout, the bill, simulated payment and the delivery lifecycle",
    },
  ],
  components,
  paths: { ...paths, ...medicinePaths, ...adminMedicinePaths, ...diagnosticPaths, ...bloodBankPaths, ...ambulancePaths, ...pharmacyPaths, ...paymentQrPaths, ...recordAccessPaths, ...emrPaths, ...clinicalCodingPaths, ...patientMedicinePaths, ...doctorAnalyticsPaths },
};

module.exports = spec;
