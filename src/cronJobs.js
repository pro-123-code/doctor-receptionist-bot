const crypto = require('node:crypto');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { Appointment, claimDailyReportRun, completeDailyReportRun, Doctor, recordServiceLog } = require('./models');
const { generateAppointmentsWorkbook } = require('./excelGenerator');
const { getLocalDateParts } = require('./dateParser');

function reportError(error, doctorId, reason) {
  const code = /^[A-Za-z0-9_-]{1,64}$/.test(String(error?.code || ''))
    ? String(error.code)
    : undefined;
  console.error(`Daily report failed (${error?.name || 'Error'})${code ? ` [${code}]` : ''}${reason ? `: ${reason}` : ''}`);
  recordServiceLog('Daily report', code, doctorId);
}

function startDailyReport(doctorProfile) {
  const requiredSettings = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'];
  const missingSettings = requiredSettings.filter((name) => !process.env[name]?.trim());
  const reportDoctorId = doctorProfile?.doctorId || process.env.DOCTOR_ID || process.env.CLINIC_ID;
  if (!reportDoctorId) {
    console.warn('Daily report not scheduled: doctor report identity is missing');
    return null;
  }

  const schedule = '0 0 * * *';
  const timeZone = 'Asia/Karachi';
  if (process.env.GOOGLE_TIME_ZONE && process.env.GOOGLE_TIME_ZONE !== timeZone) {
    throw new Error('GOOGLE_TIME_ZONE must be Asia/Karachi');
  }
  if (process.env.DAILY_REPORT_TIME_ZONE && process.env.DAILY_REPORT_TIME_ZONE !== timeZone) {
    throw new Error('DAILY_REPORT_TIME_ZONE must be Asia/Karachi');
  }
  new Intl.DateTimeFormat('en', { timeZone });

  let dispatchUnavailableReason = missingSettings.length
    ? `missing SMTP settings: ${missingSettings.join(', ')}`
    : null;
  let transporter = null;
  const smtpPort = Number(process.env.SMTP_PORT || '587');
  if (!dispatchUnavailableReason && (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)) {
    dispatchUnavailableReason = 'SMTP_PORT must be a valid TCP port number';
  }
  if (!dispatchUnavailableReason) {
    try {
      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: smtpPort,
        secure: process.env.SMTP_SECURE === 'true' || smtpPort === 465,
        requireTLS: process.env.SMTP_REQUIRE_TLS !== 'false' && smtpPort !== 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });
    } catch {
      dispatchUnavailableReason = 'SMTP transporter could not be configured';
    }
  }
  if (dispatchUnavailableReason) {
    console.warn(`Daily report email unavailable for doctor ${reportDoctorId}: ${dispatchUnavailableReason}; scheduled fallback logging is enabled`);
  }

  const task = cron.schedule(schedule, async () => {
    let reportDateKey;
    let lockToken;
    let claimed = false;
    let sent = false;
    try {
      const currentDoctor = await Doctor.findOne({ doctorId: reportDoctorId, isActive: true }).lean();
      if (!currentDoctor) return;
      const start = new Date();
      const reportDate = getLocalDateParts(start, timeZone);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      reportDateKey = `${reportDate.year}-${String(reportDate.month).padStart(2, '0')}-${String(reportDate.day).padStart(2, '0')}`;
      lockToken = crypto.randomUUID();
      claimed = await claimDailyReportRun(reportDoctorId, reportDateKey, lockToken, reportDoctorId);
      if (!claimed) {
        console.log(`Daily appointment report already claimed or sent (${reportDateKey})`);
        return;
      }

      const appointments = await Appointment.find({
        doctorId: reportDoctorId,
        status: 'booked',
        slotStart: { $gte: start, $lt: end }
      }).sort({ slotStart: 1 }).lean();
      if (!currentDoctor.email) {
        reportError(new Error('Daily report recipient is not configured'), reportDoctorId,
          'Doctor email is not configured; report was not sent');
        console.warn(`Daily report fallback for doctor ${reportDoctorId} (${reportDateKey}): ${appointments.length} appointments summarized locally`);
        return;
      }
      if (!transporter) {
        reportError(new Error('Daily report email is not configured'), reportDoctorId, dispatchUnavailableReason);
        console.warn(`Daily report fallback for doctor ${reportDoctorId} (${reportDateKey}): ${appointments.length} appointments summarized locally`);
        return;
      }

      const workbook = await generateAppointmentsWorkbook(appointments, timeZone, currentDoctor.clinicName || 'Clinic');
      if (!await Doctor.exists({ doctorId: reportDoctorId, isActive: true })) return;

      await transporter.sendMail({
        from: process.env.EMAIL_FROM,
        to: currentDoctor.email,
        subject: `${currentDoctor.clinicName || 'Clinic'} Daily Appointments - ${reportDateKey}`,
        text: `Daily report for ${currentDoctor.clinicName || 'Clinic'} on ${reportDateKey}: ${appointments.length} booked appointment(s). The attached spreadsheet includes patient names, contact details, stated symptoms, and appointment times.`,
        attachments: [{
          filename: `appointments-${reportDateKey}.xlsx`,
          content: workbook,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        }]
      });
      sent = true;
      console.log(`Daily appointment report emailed (${reportDateKey}, ${appointments.length} appointments)`);
    } catch (error) {
      reportError(error, reportDoctorId, error.reportReason);
      console.warn(`Daily report fallback for doctor ${reportDoctorId} (${reportDateKey || 'unknown date'}): email dispatch failed; report run marked failed`);
    } finally {
      if (claimed) {
        try {
          await completeDailyReportRun(reportDoctorId, reportDateKey, lockToken, sent, reportDoctorId);
        } catch (error) {
          reportError(error, reportDoctorId);
        }
      }
    }
  }, { timezone: timeZone, noOverlap: true });

  console.log(`Daily appointment report scheduled: ${schedule} (${timeZone})`);
  return task;
}

module.exports = { startDailyReport };