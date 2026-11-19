# Application Overview

## 1. Purpose

IHS is a multi-portal healthcare platform. The backend is the only component that talks to the database and to third-party providers; every web portal and mobile app is a client of the same REST API. The product started as a doctor-patient consultation marketplace ("Doctor-Patient Consultation Platform (Multi-Clinic + Video)", the original PRD) and grew modules for clinics, pharmacies, diagnostic labs, blood banks and ambulances.

## 2. Roles (the `users.role` enum)

Defined in `src/config/constants.js` (`ROLES`). Every account is a row in `users`; role-specific data lives in a profile table or on the `users` row itself.

| Role value | Who | Signs in through | Self-registration | Approval gate |
|---|---|---|---|---|
| `patient` | Patient | `POST /api/auth/login` (email or mobile), Google | Yes (`/auth/register`) | none |
| `doctor` | Doctor | `POST /api/auth/login`, Google | Yes | Admin verification (`verification_status`); public listing needs approval + `is_listed` |
| `admin` | Platform admin | `POST /api/auth/admin/login` | No - seeded from `.env` on boot | n/a |
| `clinic` | A clinic *organisation* (distinct from a doctor's `clinics` location rows) | `POST /api/auth/clinic/login`, `/auth/clinic/google` | Yes | `requireApprovedClinic` on patient data routes |
| `medicine_store` | Pharmacy: medicine store / clinic | `POST /api/auth/medicine/login`, `/auth/medicine/google` | Yes | none (own inventory only) |
| `pharmacy_hospital` | Pharmacy: hospital | same portal login | Yes | none |
| `mr` | LEGACY medicine representative | same portal login | **No** (excluded from `SELF_REGISTERABLE_ROLES`) | Existing accounts keep working and keep their data |
| `diagnostic_lab` | Diagnostic lab centre | same provider portal login (`PROVIDER_PORTAL_ROLES`) | Yes | none |
| `blood_bank` | Blood bank / centre | `POST /api/auth/blood-bank/login` (register at `/auth/blood-bank/register`) | Yes | `requireApprovedBloodBank` on operational routes |
| `ambulance_provider` | Ambulance operator | `POST /api/auth/ambulance/login` (register at `/auth/ambulance/register`) | Yes | `requireApprovedAmbulanceProvider`; each ambulance is also approved separately |

Drivers (ambulance) and donors (blood bank) are **records**, not login accounts.

## 3. Client applications served

| Client | Dev port | Backend surface it mainly uses |
|---|---|---|
| frontend-patient | 3000 | `/auth`, `/patient`, public `/doctors`, `/medicine`, `/diagnostics`, `/blood`, `/ambulances` |
| frontend-doctor | 3001 | `/auth`, `/doctor` |
| frontend-admin | 3002 | `/auth/admin/login`, `/admin` |
| frontend-clinic | 3003 | `/auth/clinic/*`, `/clinic` |
| frontend-mr (pharmacy + diagnostic-lab provider portal) | 3004 | `/auth/medicine/*`, `/medicine`, `/diagnostics` |
| frontend-blood-bank | 3006 | `/auth/blood-bank/*`, `/blood-bank` |
| frontend-ambulance | 3007 | `/auth/ambulance/*`, `/ambulance`, `/ambulances` |
| Expo apps (patient, doctor, medicine-store, diagnostic-lab) | n/a | Same REST API + Socket.IO notifications |

The port list comes from the portals' `package.json` scripts and `CLIENT_URL`; which routes each client calls is inferred from the backend's role gates and from older documentation (client-side usage is documented in each client's own documentation).

## 4. Feature inventory with verified status

Status key: **Implemented (verified)** = routes, service and model found and wired; **Partially implemented**; **Documented-but-not-found**; **Planned**; **Unclear**.

### 4.1 Identity and accounts
| Feature | Status | Notes |
|---|---|---|
| Email/password signup + login | Implemented (verified) | bcrypt cost 12, per-portal allow-lists |
| Login by Indian mobile number (patient/doctor app) | Implemented (verified) | `POST /auth/login` accepts exactly one of `email` / `phone` |
| Google sign-in | Implemented (verified) | needs `GOOGLE_CLIENT_ID` |
| Rotating refresh tokens with reuse detection | Implemented (verified) | 30 s grace window for concurrent tab refresh |
| Password reset by e-mail link | Implemented (verified) | `RESET_TOKEN_TTL_MINUTES` |
| Password reset by 6-digit OTP (SMS or e-mail) | Implemented (verified) | SMS needs `SMS_PROVIDER` (`twilio`/`mock`) |
| E-mail verification flow | Unclear | `mail.service.sendVerifyEmail` and a `verify-email.html` template exist; no caller of `sendVerifyEmail` was found anywhere in `src/` (verified by grep), so no verification e-mail is sent |

### 4.2 Doctors and discovery
| Feature | Status |
|---|---|
| Onboarding checklist + submit for verification (`professional`, `specialties`, `documents` required) | Implemented (verified) |
| Portfolio: awards (+image), links, search keywords, education, experience, services, publications, memberships, FAQs, testimonials (+photo with consent flag), affiliations, fellowships, expertise, gallery, hero images (1-3), showcase image, insurances | Implemented (verified) |
| Specializations + sub-specializations (doctors may add shared sub-specialties, rate limited) | Implemented (verified) |
| Clinics, weekly clinic availability, online (video) availability, blocked dates | Implemented (verified) |
| Public listing: filters, sort (`relevance`, `rating`, `experience`, `fee`, `nearest`), SQL pagination, map pins, related doctors, slug lookup | Implemented (verified) |
| Admin creates a doctor already approved; admin edits any doctor via the same controllers (`resolveDoctorId("param")`) | Implemented (verified) |
| Doctor reviews / ratings submission | Documented-but-not-found | `reviews` table exists in the base schema and `avg_rating` / `rating_count` columns exist on `doctor_profiles`, but there is no review model or route |

### 4.3 Booking, queue, payment, video
| Feature | Status |
|---|---|
| Consultation sessions (one row per doctor x clinic/online x date window, created lazily) and token queue | Implemented (verified) |
| Clinic and video bookings, duplicate-booking guard (one live token per patient per session), reschedule (doctor), cancel (patient) | Implemented (verified) |
| Razorpay order + client verify + webhook, idempotent confirm | Implemented (verified) |
| Offline payment (cash or doctor's UPI QR), doctor "mark paid" | Implemented (verified) |
| Earnings and admin revenue aggregates (15 % platform commission, stored split) | Implemented (verified) |
| LiveKit video token (join window: 10 min before start to 30 min after end) and webhook | Implemented (verified) |
| Doctor-approval workflow for bookings ("patient-booking-flow" proposal) | Documented-but-not-found |
| Referrals between doctors + patient care journeys | Implemented (verified) |

### 4.4 Clinical
| Feature | Status |
|---|---|
| Patient profile, allergies, conditions, medications, vitals, uploaded records, medical documents (identity docs hidden from every non-patient reader) | Implemented (verified) |
| Clinical notes (append-only), vitals on visits, vitals reference ranges (`config/vitalsRanges.js`) | Implemented (verified) |
| EMR workbench and structured entries; ICD master + coded diagnoses + Excel import | Implemented (verified) |
| Treatment timeline, patient timeline, medical history lens | Implemented (verified) |
| Follow-up statuses, per-booking follow-up, follow-up reminders (e-mail/WhatsApp) | Implemented (verified); WhatsApp live sending **Partially implemented** |
| Prescriptions: letterhead templates, finalize/amend, PDF, numbering | Implemented (verified) |
| Patient medicine routines and dose tracking | Implemented (verified) |
| Doctor record-access consent + audit log | Implemented (verified) |
| "Record reader" (one continuous document scroll) | Backend: nothing to build - the old plan states it reuses existing endpoints (`GET /doctor/bookings/:id`, `GET /doctor/bookings/:id/patient-timeline`, `GET /doctor/prescriptions/:id/pdf`, all present). Client-side status **Unclear** |
| Doctor Dashboard 2.0 analytics + patient acquisition sources | Implemented (verified) |

### 4.5 Marketplace and provider modules
| Feature | Status |
|---|---|
| Medicine marketplace (browse, suggest, categories, providers, details) | Implemented (verified) |
| Cart, checkout (one order group per pharmacy), orders, invoice, returns/credit notes | Implemented (verified) |
| Pharmacy management (batches, suppliers, purchases, GST reports, Excel import/export, settings) | Implemented (verified) |
| Prescription request flow (share prescription, pharmacy answers availability per medicine) | Implemented (verified) |
| Provider UPI QR (doctor and pharmacy) | Implemented (verified) |
| Diagnostic lab flow | Implemented (verified) |
| Blood bank flow | Implemented (verified) |
| Ambulance flow | Implemented (verified) - no live GPS, no online payment, in-app notifications only |
| Clinic account + approval | Implemented (verified) |

### 4.6 Platform
Swagger UI (`/api/docs`, off in production by default), Socket.IO notifications, local/S3/Cloudinary storage, public contact form + admin inbox, in-process schedulers.

## 5. Typical end-to-end journeys

1. **Patient books a doctor**: browse `GET /api/doctors` -> `GET /api/doctors/:id/sessions` -> `POST /api/patient/bookings` (profile must be complete: phone, dateOfBirth, gender, city) -> pay (Razorpay verify, or offline / UPI QR) -> consult (clinic or LiveKit video) -> doctor writes EMR entries and finalizes a prescription -> PDF + notification -> patient medicines sync.
2. **Patient orders medicines**: browse `/api/medicine/browse` -> cart -> `POST /api/medicine/orders/checkout` -> pharmacy moves the order group through `pending -> confirmed -> processing -> shipped -> on_the_way -> delivered`.
3. **Provider onboarding**: register -> `pending` -> admin verdict -> operational routes unlock.

See [BUSINESS-WORKFLOWS.md](BUSINESS-WORKFLOWS.md) for the state machines.
