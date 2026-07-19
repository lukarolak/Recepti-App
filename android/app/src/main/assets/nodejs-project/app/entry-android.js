// Android-only bootstrap: sets the env vars server.js already reads to pick a
// backend and bind address, then defers to the real (shared) server.
const path = require('path');

process.env.DB_DRIVER = 'sqlite';
// __dirname is <filesDir>/nodejs-project/app, which MainActivity wipes and recopies
// from assets on every APK update. Two levels up is <filesDir> itself, stable across
// updates -- that's where the persistent SQLite file needs to live.
process.env.DB_PATH = path.join(__dirname, '..', '..', 'data.sqlite3');
// Never accept incoming connections from other devices -- this app only ever needs
// to talk to its own WebView over loopback.
process.env.HOST = '127.0.0.1';

require('./server.js');
