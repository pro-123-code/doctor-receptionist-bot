# Doctor Receptionist AI Agent - System Architecture

## 1. System Overview
An automated, humanized WhatsApp AI receptionist for doctors that manages appointments via Google Calendar, sends automated reminders, and sends daily schedule digests to the doctor via email.

## 2. Tech Stack Recommendations
- **Language/Framework:** Node.js (Express) or Python (FastAPI)
- **WhatsApp Integration:** Twilio WhatsApp API / Meta Cloud API
- **Calendar Service:** Google Calendar API (OAuth2)
- **Database:** SQLite / MongoDB (for local session tracking & appointment records)
- **Scheduler/Cron:** Node-Cron / Celery (for 2-hour reminders & daily email reports)
- **Email Service:** Nodemailer / SendGrid

## 3. Core Modules & Data Flow
1. **WhatsApp Webhook:** Receives incoming patient messages and routes them to the agent logic.
2. **Conversation Manager:** Collects Patient Name, Phone, and Major Symptoms using a warm, human-like prompt.
3. **Calendar Integration:** Fetches free time slots from Google Calendar and books confirmed appointments.
4. **Reminder Queue:** Schedules a job to send a WhatsApp reminder 2 hours prior to the appointment.
5. **Daily Digest Cron Job:** Queries tomorrow's appointments every night at a set time and emails the formatted list to the doctor.