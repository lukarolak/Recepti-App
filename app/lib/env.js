// Only the Android build talks to a central server -- inert (never required) for the
// central docker-compose deployment itself.
const isAndroidBuild = process.env.DB_DRIVER === 'sqlite';

module.exports = { isAndroidBuild };
