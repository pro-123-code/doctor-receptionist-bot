# Doctor Receptionist AI Agent - System Architecture

## 1. System Overview
An automated WhatsApp receptionist for Dr. Ahmad's clinic. The service collects patient details and symptoms before asking for a requested date, checks that clinic-local day in Google Calendar, books a selected slot, restores reminders from MongoDB, and emails a daily Excel report. A read-only Tabler-based dashboard uses authenticated Express endpoints; browser clients never receive MongoDB credentials.

## 2. Tech Stack Recommendations
- **Language/Framework:** Node.js (Express) or Python (FastAPI)
- **WhatsApp Integration:** Baileys with a clinic-owned QR-linked session
- **Calendar Service:** Google Calendar API (OAuth2)
- **Database:** MongoDB Atlas for conversations, appointments, and expiring operational logs
- **Scheduler/Cron:** Node-Cron for clinic-local daily reports
- **Reports:** ExcelJS workbooks delivered by Nodemailer over TLS
- **Dashboard:** Tabler UI served by Express; authenticated read-only appointment API

## 3. Core Modules & Data Flow
1. **WhatsApp Gateway:** The worker manager loads one Baileys auth directory per active doctor and prints each new doctor's QR code.
2. **Conversation Manager:** Loads `doctorName`, `clinicName`, `facilitiesList`, and `welcomeMessage` from the active Doctor profile. First-message prefixes are deterministic, and Gemini receives that same profile for schema-constrained extraction. The flow collects name, contact number, symptoms, and requested date in that order.
3. **Calendar Integration:** Doctors connect through `/api/auth/google` and `/api/auth/google/callback`; OAuth state is signed, short-lived, and one-time. Refresh tokens are encrypted in that doctor's profile. Date parsing and booking resolve only that clinic-local day and reserve the slot before creating a Calendar event.
4. **Reminder Queue:** Restores future appointment reminders from MongoDB after WhatsApp reconnects.
5. **Daily Report:** At `DAILY_REPORT_CRON` (default `23:59`), queries appointments booked that clinic-local day, creates an `.xlsx` attachment, and emails it to `DOCTOR_EMAIL`.
6. **Dashboard:** The PWA at `/dashboard` authenticates database-backed `SUPERADMIN` and `DOCTOR` users with scrypt password hashes and HttpOnly signed sessions. Doctor APIs scope records by `doctorId`; superadmins can create doctors, view aggregate usage, and suspend accounts.

## 4. Deployment Boundary
The shared Express process is the SaaS control plane. `Doctor` and `DashboardUser` records provide tenant identity and `SUPERADMIN`/`DOCTOR` roles; patient data and dashboard sessions are scoped to `doctorId`. The superadmin can provision doctor accounts, supply each doctor's Google OAuth credentials (encrypted with AES-256-GCM), and suspend accounts. Each active doctor gets an independent Baileys socket/auth directory and Calendar client; worker synchronization stops sockets for inactive doctors. The service worker intentionally does not cache dashboard/API responses because they contain PHI. The server migrates legacy unscoped records/indexes to the bootstrap `DOCTOR_ID` at startup, so back up and verify legacy data before deploying this version.

Configure a unique `DOCTOR_ID`, `SUPERADMIN_EMAIL`, a 12+ character `SUPERADMIN_PASSWORD`, 32-byte `DOCTOR_CONFIG_ENCRYPTION_KEY` and `DASHBOARD_SESSION_SECRET`, plus the shared Google OAuth client ID/secret and a `GOOGLE_REDIRECT_URI` registered in Google Cloud Console. The existing `DASHBOARD_EMAIL`/`DASHBOARD_PASSWORD` pair is only used to seed the bootstrap doctor account; dashboard passwords are stored as scrypt hashes. Keep signing/encryption keys, OAuth tokens, and Baileys auth directories private.

Production must terminate HTTPS at the service or a trusted reverse proxy, use unique secrets, and keep `.env` and Baileys auth files private. Dashboard requests must go through Express; do not expose Atlas connection strings to browser code.