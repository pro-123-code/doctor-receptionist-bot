const ExcelJS = require('exceljs');

async function generateAppointmentsWorkbook(appointments, timeZone, clinicName = 'Clinic') {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = clinicName;
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet('Appointments', {
    views: [{ state: 'frozen', ySplit: 1 }],
    autoFilter: 'A1:D1'
  });
  worksheet.columns = [
    { header: 'Patient Name', key: 'patientName', width: 28 },
    { header: 'WhatsApp Number', key: 'whatsAppNumber', width: 24 },
    { header: 'Symptoms', key: 'symptoms', width: 48 },
    { header: 'Appointment Slot', key: 'appointmentSlot', width: 36 }
  ];
  worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF176B5B' }
  };

  for (const appointment of appointments) {
    worksheet.addRow({
      patientName: appointment.details.name,
      whatsAppNumber: appointment.details.contactNumber,
      symptoms: appointment.details.majorSymptoms,
      appointmentSlot: `${new Intl.DateTimeFormat('en', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone
      }).format(appointment.slotStart)} - ${new Intl.DateTimeFormat('en', {
        timeStyle: 'short',
        timeZone
      }).format(appointment.slotEnd)}`
    });
  }

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) row.alignment = { vertical: 'top', wrapText: true };
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

module.exports = { generateAppointmentsWorkbook };