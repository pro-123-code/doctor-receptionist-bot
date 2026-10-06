// One-off clinic settings maintenance.
//
// Updates only the fields you name, for one doctor, and prints what changed.
// It never prints the connection string or any patient data.
//
// Usage:
//   MONGODB_URI="mongodb+srv://..." node scripts/update-clinic-settings.js \
//     --doctor apna-city-clinic-f33735cd \
//     --set appointmentLookaheadDays=7 \
//     --set clinicTimingName=hemoglobin
//
// Run it from the project root so it can resolve the installed dependencies.
require('dotenv').config();

const mongoose = require('mongoose');

function parseArguments(argv) {
  const options = { doctorId: null, fields: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--doctor') {
      options.doctorId = argv[index + 1];
      index += 1;
    } else if (argument === '--set') {
      const assignment = argv[index + 1] || '';
      const separator = assignment.indexOf('=');
      if (separator < 1) throw new Error(`--set expects key=value, received "${assignment}"`);
      const key = assignment.slice(0, separator).trim();
      const value = assignment.slice(separator + 1).trim();
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new Error(`Unsupported field name "${key}"`);
      options.fields[key] = value;
      index += 1;
    } else if (argument === '--uri') {
      options.uri = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

// clinicTimingName corrects a single facility or treatment name in place,
// keeping its category and price.
const SPECIAL_FIELDS = new Set(['clinicTimingName']);

function numericFields() {
  return new Set(['appointmentLookaheadDays', 'appointmentDurationMinutes', 'officeStartHour', 'officeEndHour']);
}

function describeUriProblem(uri) {
  if (typeof uri !== 'string' || !uri.trim()) return 'No connection string was provided.';
  const value = uri.trim();
  if (!/^mongodb(\+srv)?:\/\//.test(value)) return 'The connection string must start with mongodb:// or mongodb+srv://';
  const authority = value.replace(/^mongodb(\+srv)?:\/\//, '').split('/')[0];
  const hostPart = authority.slice(authority.lastIndexOf('@') + 1);
  if (!hostPart.includes('.')) {
    return 'The connection string looks truncated. It should look like '
      + 'mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/DATABASE';
  }
  if (value.startsWith('mongodb+srv://') && /^[^@]*@[^:/?]+:\d+/.test(value)) {
    return 'A mongodb+srv connection string must not include a port number.';
  }
  if (!value.includes('@') && !/^mongodb:\/\//.test(value)) {
    return 'The connection string has no credentials section. Expected USER:PASSWORD@HOST';
  }
  return null;
}

async function run() {
  const options = parseArguments(process.argv.slice(2));
  const uri = options.uri || process.env.MONGODB_URI;
  const uriProblem = describeUriProblem(uri);
  if (uriProblem) {
    console.error(`Connection string problem: ${uriProblem}`);
    console.error('Pass a valid value with --uri, or set MONGODB_URI in your shell.');
    process.exit(1);
  }
  if (!options.doctorId) {
    console.error('--doctor <doctorId> is required.');
    process.exit(1);
  }
  if (!Object.keys(options.fields).length) {
    console.error('Nothing to change. Use --set key=value.');
    process.exit(1);
  }

  // Validate every requested field before opening a connection.
  const update = {};
  for (const [key, rawValue] of Object.entries(options.fields)) {
    if (SPECIAL_FIELDS.has(key)) continue;
    if (key === 'facilitiesList' || key === 'servicesList') {
      update[key] = rawValue.split('|').map((value) => value.trim()).filter(Boolean);
    } else if (numericFields().has(key)) {
      const value = Number(rawValue);
      if (!Number.isInteger(value)) throw new Error(`${key} must be a whole number, received "${rawValue}"`);
      update[key] = value;
    } else {
      throw new Error(`Unsupported field "${key}".`);
    }
  }
  if (!Object.keys(update).length && !Object.keys(options.fields).some((key) => SPECIAL_FIELDS.has(key))) {
    throw new Error('No supported fields were provided.');
  }

  const doctorSchema = new mongoose.Schema({
    doctorId: String,
    clinicName: String,
    doctorName: String,
    facilitiesList: [String],
    servicesList: [String],
    facilityPricing: [{ category: String, name: String, price: Number }],
    appointmentLookaheadDays: Number,
    appointmentDurationMinutes: Number,
    officeStartHour: Number,
    officeEndHour: Number
  }, { versionKey: false, strict: false });
  const Doctor = mongoose.models.MaintenanceDoctor || mongoose.model('MaintenanceDoctor', doctorSchema);

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });

  const before = await Doctor.findOne({ doctorId: options.doctorId }).lean();
  if (!before) {
    console.error(`No doctor found with id "${options.doctorId}".`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const update2 = update;
  for (const [key, newName] of Object.entries(options.fields)) {
    if (!SPECIAL_FIELDS.has(key)) continue;
    const priced = (before.facilityPricing || []).find((item) => item.name === newName)
      || (before.facilityPricing || []).find((item) => String(item.name).toLowerCase() === newName.toLowerCase());
    if (!priced) throw new Error(`No priced item named "${newName}" on ${before.clinicName}.`);
    const previousName = priced.name;
    update.facilityPricing = (before.facilityPricing || []).map((item) => (
      item.name === priced.name ? { ...item, name: newName } : item
    ));
    update.facilitiesList = (before.facilitiesList || []).map((name) => (name === previousName ? newName : name));
    update.servicesList = (before.servicesList || []).map((name) => (name === previousName ? newName : name));
  }

  if (!Object.keys(update2).length) {
    console.error('Nothing to change.');
    await mongoose.disconnect();
    process.exit(1);
  }

  await Doctor.updateOne({ doctorId: options.doctorId }, { $set: update2 });

  const after = await Doctor.findOne({ doctorId: options.doctorId }).lean();
  console.log(`Updated doctor "${options.doctorId}" (${after.clinicName}).\n`);
  for (const key of Object.keys(update2)) {
    console.log(`  ${key}: ${JSON.stringify(before[key])} -> ${JSON.stringify(after[key])}`);
  }
  console.log('\nNo other fields were touched.');

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((error) => {
  console.error(`Update failed: ${error.message}`);
  process.exit(1);
});