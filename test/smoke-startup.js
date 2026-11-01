// Catches module-load failures such as referencing an identifier that does not
// exist. `node --check` only validates syntax, so a ReferenceError in the module
// body would otherwise reach production and crash the service on boot.
process.env.MONGODB_URI = '';
// CI has no .env file. Supply the one identifier the server refuses to load
// without, so a missing local file cannot be mistaken for a broken build.
process.env.CLINIC_ID = process.env.CLINIC_ID || 'smoke-test-clinic';
process.env.DOCTOR_ID = process.env.DOCTOR_ID || process.env.CLINIC_ID;

try {
  require('../src/server.js');
} catch (error) {
  console.error('smoke: server module failed to load ->', error.message);
  process.exit(1);
}

console.log('smoke: server module loaded successfully');
process.exit(0);