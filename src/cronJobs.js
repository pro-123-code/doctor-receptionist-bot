const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const { Appointment, claimDailyReportRun, completeDailyReportRun, Doctor, recordServiceLog } = require('./models');
const { generateAppointmentsWorkbook } = require('./excelGenerator');
const { getLocalDateParts } = require('./dateParser');
const { isReportDueNow } = require('./clinicTiming');

function reportError(error, doctorId, reason) {
  const code = /^[A-Za-z0-9_-]{1,64}$/.test(String(error?.code || ''))
    ? String(error.code)
    : undefined;
  console.error(`Daily report failed (${error?.name || 'Error'})${code ? ` [${code}]` : ''}${reason ? `: ${reason}` : ''}`);
  recordServiceLog('Daily report', code, doctorId);
}

// Builds the mail transporter once per process. Returns null when SMTP is not
// configured, which is a supported state: the report is then only logged.
function createMailTransport() {
  const requiredSettings = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'];
  const missingSettings = requiredSettings.filter((name) => !process.env[name]?.trim());
  if (missingSettings.length) {
    return { transport: null, reason: `missing SMTP settings: ${missingSettings.join(', ')}` };
  }
  const smtpPort = Number(process.env.SMTP_PORT || '587');
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    return { transport: null, reason: 'SMTP_PORT must be a valid TCP port number' };
  }
  try {
    return {
      transport: nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: smtpPort,
        secure: process.env.SMTP_SECURE === 'true' || smtpPort === 465,
        requireTLS: process.env.SMTP_REQUIRE_TLS !== 'false' && smtpPort !== 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      }),
      reason: null
    };
  } catch {
    return { transport: null, reason: 'SMTP transporter could not be configured' };
  }
}

// Sends one clinic's daily report for the next 24 hours. The DailyReportRun claim
// is keyed on doctor and date, so repeated scheduler ticks cannot double-send.
async function dispatchDoctorDailyReport(doctorProfile, options = {}) {
  const reportDoctorId = doctorProfile?.doctorId;
  if (!reportDoctorId) return { sent: false, reason: 'missing doctor id' };

  const timeZone = options.timeZone || 'Asia/Karachi';
  const transportContext = options.transportContext || createMailTransport();
  if (!transportContext.transport) {
    console.warn(`Daily report email unavailable for doctor ${reportDoctorId}: ${transportContext.reason}`);
  }

  const now = options.now || new Date();
  const reportDate = getLocalDateParts(now, timeZone);
  const reportDateKey = `${reportDate.year}-${String(reportDate.month).padStart(2, '0')}-${String(reportDate.day).padStart(2, '0')}`;
  const lockToken = crypto.randomUUID();
  let claimed = false;
  let dispatched = false;

  try {
    const currentDoctor = await Doctor.findOne({ doctorId: reportDoctorId, isActive: true }).lean();
    if (!currentDoctor) return { sent: false, reason: 'inactive doctor' };
    if (!claimDailyReportRun(reportDoctorId, reportDateKey, lockToken, reportDoctorId)) {
      return { sent: false, reason: 'already claimed today' };
    }
    claimed = true;

    const windowEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const appointments = await Appointment.find({
      doctorId: reportDoctorId,
      status: 'booked',
      slotStart: { $gte: now, $lt: windowEnd }
    }).sort({ slotStart: 1 }).lean();

    if (!currentDoctor.email) {
      reportError(new Error('Daily report recipient is not configured'), reportDoctorId,
        'Doctor email is not configured; report was not sent');
      return { sent: false, reason: 'missing doctor email' };
    }
    if (!transportContext.transport) {
      reportError(new Error('Daily report email is not configured'), reportDoctorId, transportContext.reason);
      return { sent: false, reason: transportContext.reason };
    }

    const workbook = await generateAppointmentsWorkbook(appointments, timeZone, currentDoctor.clinicName || 'Clinic');
    if (!await Doctor.exists({ doctorId: reportDoctorId, isActive: true })) {
      return { sent: false, reason: 'doctor deactivated before send' };
    }

    await transportContext.transport.sendMail({
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
    console.log(`Daily appointment report emailed (${reportDoctorId}, ${reportDateKey}, ${appointments.length} appointments)`);
    dispatched = true;
    return { sent: true, reason: null };
  } catch (error) {
    reportError(error, reportDoctorId);
    console.warn(`Daily report fallback for doctor ${reportDoctorId} (${reportDateKey}): email dispatch failed`);
    return { sent: false, reason: error.message };
  } finally {
    if (claimed) {
      try {
        await completeDailyReportRun(reportDoctorId, reportDateKey, lockToken, dispatched, reportDoctorId);
      } catch (error) {
        reportError(error, reportDoctorId);
      }
    }
  }
}

// One shared scheduler for every clinic. Each tick dispatches the clinics whose
// saved local report time matches the current minute.
function startDailyReportScheduler(options = {}) {
  const timeZone = options.timeZone || 'Asia/Karachi';
  const tickMs = Number.isInteger(options.tickMs) ? options.tickMs : 60_000;
  const now = options.now || (() => new Date());
  const isDue = options.isReportDueNow || isReportDueNow;
  const dispatch = options.dispatch || dispatchDoctorDailyReport;
  const listDoctors = options.listDoctors || (() => Doctor.find({ isActive: true }).lean());
  const transportContext = options.transportContext || createMailTransport();
  const inFlight = new Set();

  const runTick = async () => {
    let doctors;
    try {
      doctors = await listDoctors();
    } catch (error) {
      console.error(`Daily report scheduler could not list clinics (${error?.name || 'Error'})`);
      return;
    }
    for (const doctor of doctors || []) {
      if (!doctor?.doctorId || !isDue(doctor, now(), timeZone)) continue;
      if (inFlight.has(doctor.doctorId)) continue;
      inFlight.add(doctor.doctorId);
      Promise.resolve(dispatch(doctor, { timeZone, transportContext }))
        .catch((error) => reportError(error, doctor.doctorId))
        .finally(() => inFlight.delete(doctor.doctorId));
    }
  };

  // Returns the live timer so a caller (or a test) can stop the scheduler.
  const timer = setInterval(() => { runTick().catch(() => {}); }, tickMs);
  timer.unref();
  runTick().catch(() => {});
  console.log(`Daily appointment reports scheduled per clinic (checked every ${Math.round(tickMs / 1000)}s, ${timeZone})`);
  return timer;
}


module.exports = { createMailTransport, dispatchDoctorDailyReport, startDailyReportScheduler };
