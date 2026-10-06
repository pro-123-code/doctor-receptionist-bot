// Catches module-load failures such as referencing an identifier that does not
// exist. `node --check` only validates syntax, so a ReferenceError in the module
// body would otherwise reach production and crash the service on boot.
process.env.MONGODB_URI = '';

try {
  require('../src/server.js');
} catch (error) {
  console.error('smoke: server module failed to load ->', error.message);
  process.exit(1);
}

console.log('smoke: server module loaded successfully');
process.exit(0);