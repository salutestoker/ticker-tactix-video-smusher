const { start } = require('./lib/app');

if (require.main === module) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
