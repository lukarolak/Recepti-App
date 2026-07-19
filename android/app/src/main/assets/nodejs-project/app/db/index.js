// Picks the storage backend: Postgres (central docker-compose deployment, default)
// or SQLite (the Android build's local, on-device database). Both expose the same
// { query, transaction, ping } shape so server.js's route/helper logic is identical
// either way. Shared SQL is written with SQLite-style `?` placeholders.
module.exports = process.env.DB_DRIVER === 'sqlite'
  ? require('./sqlite-adapter')
  : require('./pg-adapter');
