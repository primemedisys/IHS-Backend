# Doctor Dashboard 2.0 — API

Envelope `{ success, message, data }`; doctor role; `req.doctorId` is pinned to the
signed-in doctor (any `doctorId` in the query is stripped). Exact response shapes:
`backend/src/services/doctorAnalytics.service.js` (each endpoint = one exported function).

Common query: `from`, `to` = IST days `YYYY-MM-DD` (inclusive). Default = 1st of this
month → today. Max 366 days. `granularity` = `day | week | month` (default by range
length: ≤31 d → day, ≤120 d → week, else month; daily capped at 92 days).
Every response has `period: { from, to, days, previousFrom, previousTo, today }` —
`previous*` is the equally long span right before (used for growth %).

A metric IHS does not record comes back as `{ available: false, reason }` — show the
reason, never a 0.

| Endpoint | Function | Contents |
|---|---|---|
| `GET /doctor/analytics/overview?from&to` | `overview` | `patients`, `appointments`, `financial`, `quality`, `productivity`, `acquisition` — every KPI card on the overview |
| `GET /doctor/analytics/trends?from&to&granularity` | `trends` | zero-filled series: `revenue[{bucket,collected,doctorNet,refunded}]`, `appointments[{bucket,completed,pending,cancelled,noShow,clinic,video}]`, `patients[{bucket,unique,new,returning}]`, `acquisition[{bucket,google,social,referral,ihs,other,undisclosed,not_captured}]` |
| `GET /doctor/analytics/patients?from&to&segment=all\|new\|returning&search&page&limit` | `patientsDetail` | `summary` (= overview.patients), `timeline.patients` series, `patients[]` table `{id,name,registrationNumber,firstVisit,lastVisit,visits,completed,cancelled,upcoming,isNew,acquisitionSource{source,label}\|null}`, `total,page,limit,totalPages` |
| `GET /doctor/analytics/appointments?from&to&status&mode=clinic\|video&page&limit` | `appointmentsDetail` | `summary` (= overview.appointments), `trend.appointments`, `appointments[]` `{id,date,sessionStart,sessionEnd,token,mode,clinic,patient,status,rescheduled,amount,paymentStatus,consultMinutes}` |
| `GET /doctor/analytics/financial?from&to&method=online\|cash\|upi&status&page&limit` | `financialDetail` | `summary` (= overview.financial), `trend.revenue`, `transactions[]` `{id,gatewayReference,bookingId,patient,serviceType,method,billed,collected,refunded,commission,doctorNet,status,date}` |
| `GET /doctor/analytics/quality?from&to&granularity` | `qualityDetail` | `summary` (= overview.quality + `completionRate`, `waitingTime`), `documentation[{bucket,completed,documented}]`, `followUps[{bucket,scheduled,completed,overdue}]` |
| `GET /doctor/analytics/productivity?from&to&granularity` | `productivityDetail` | `summary` (= overview.productivity + `consultDuration`, `completionRate`), `series[{bucket,consultations,workingDays,patients,consultationsPerDay,clinic,video,averageMinutes}]` |
| `GET /doctor/analytics/acquisition?from&to&granularity` | `acquisitionDetail` | `summary` (period, with previous-period change), `allTime`, `bookingAnswersInPeriod`, `monthly` (= trends.acquisition), `newVsReturning` (= trends.patients) |

### Overview object (abridged)

```jsonc
{
  "patients": { "total", "active", "activeWindowDays": 90, "new", "newPrevious", "newGrowth",
                "seenInPeriod", "returning", "returningPercent",
                "today": { "patients", "completed", "remaining" },
                "cancellations": { "count", "rate", "eligible" } },
  "appointments": {
    "period": { "total", "byStatus": { "pending_payment","confirmed","completed","cancelled","no_show" },
                "clinic", "video", "clinicRate", "videoRate", "rescheduled", "completed", "completedClinic",
                "completedVideo", "completionRate", "noShow", "noShowRate", "cancelled", "notMarkedComplete" },
    "today": { "total", "clinic", "video", "queued", "serving", "awaitingPayment" },   // queued = in today's token queue, NOT checked in
    "upcoming": { "count", "awaitingPayment", "next": { "bookingId","date","time","mode","token","patientName" } | null },
    "consultDuration": { "available": true, "averageMinutes", "measured" } | unavailable,
    "waitingTime": unavailable            // no check-in time is recorded
  },
  "financial": {
    "period": { "collected", "commission", "doctorNet", "transactions",
                "consultation": { "clinic", "video", "total" }, "methods": { "online", "cash", "upi" },
                "refunded", "refundCount", "failedTransactions", "averagePerCompletedConsult" },
    "previous": { "collected", "doctorNet" }, "growth",
    "pending": { "amount", "count", "overdueAmount", "overdueCount" },   // outstanding NOW (not range-bound)
    "today", "last7Days", "yearToDate",
    "procedureRevenue": unavailable, "surgeryRevenue": unavailable, "contractRevenue": unavailable
  },
  "quality": {
    "satisfaction": { "available": false, "reason", "portfolioTestimonials": { "count", "averageRating" } },
    "feedback": unavailable,
    "documentation": { "completedConsultations", "withFinalizedPrescription", "withClinicalNote", "missingPrescription", "rate" },
    "followUp": { "scheduled", "completed", "pending", "overdue", "rate" }
  },
  "productivity": { "consultations", "workingDays", "consultationsPerDay", "patientsPerDay", "opd", "video",
                    "scheduleAdherence": { "available", "onTime", "sessions", "rate", "averageStartDelayMinutes", "toleranceMinutes" } | unavailable,
                    "utilization": { "available", "booked", "capacity", "rate", "basis" } | unavailable },
  "acquisition": { "newPatients", "groups": [ { "group", "label", "count", "percent", "previous", "change",
                                                "sources": [ { "source", "label", "count" } ] } ] }
                 // groups: google, social, referral, ihs, other, undisclosed, not_captured
}
```

Percentages are numbers with one decimal (e.g. `66.7`) or `null` when the denominator is 0.

## Patient acquisition capture

| Endpoint | Purpose |
|---|---|
| `GET /patient/acquisition/sources` (patient) | `{ groups: [{ value, label, sources: [{ value, label, textField, referral }] }] }` — render the question from this |
| `GET /patient/acquisition/doctors/:doctorId` (patient) | `{ answered, group, source }` — when `answered` is true, skip the question |
| `POST /patient/bookings` (existing) | new optional field `acquisition: { source, otherText?, referralDetails?, capturedVia?: "web"\|"mobile", utm?: { source, medium, campaign, term, content } }` |

`source` must be a catalogue value. `otherText` is kept only for options with `textField`,
`referralDetails` only for `referral` options. The first answer becomes the patient's
ORIGINAL source for that doctor and is never overwritten; every answer is also stored on its
booking. Clinic-portal bookings (`POST /clinic/patients/:id/bookings`) accept the same field
(stored with `captured_via = clinic`).
