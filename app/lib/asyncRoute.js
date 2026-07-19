// Express 4 doesn't catch a rejected promise from an `async (req, res) => {...}`
// handler -- it becomes an unhandled promise rejection, and Node's default behavior
// for that (since Node 15) is to crash the whole process. On the Android build this
// embedded server shares a process with the WebView UI, so a single bad request (a
// stale recipe id, two writes racing on node-sqlite3-wasm's mkdir-based file lock,
// anything) took the entire app down instead of just failing that one request. Every
// async route/middleware in this app is wrapped in this so a thrown error becomes a
// normal 500 response via server.js's error-handling middleware, not a process-ending
// crash.
function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = asyncRoute;
