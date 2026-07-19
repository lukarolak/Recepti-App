const express = require('express');
const path = require('path');
const db = require('./db');
const asyncRoute = require('./lib/asyncRoute');
const { isAndroidBuild } = require('./lib/env');
const i18nMiddleware = require('./lib/i18nMiddleware');
const sse = require('./lib/sse');

// Only the Android build talks to a central server -- inert (never required) for the
// central docker-compose deployment itself.
const centralSync = isAndroidBuild ? require('./sync/centralSync') : null;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Belt-and-braces backstop for anything that throws outside an asyncRoute-wrapped
// request (e.g. a future setInterval/setTimeout callback with no try/catch of its
// own) -- log it instead of letting Node's default "crash the process" behavior take
// the whole app down with it.
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

app.use(asyncRoute(i18nMiddleware));

app.use(sse.router);
app.use(require('./routes/plan'));
app.use(require('./routes/recipes'));
app.use(require('./routes/ingredients'));
app.use(require('./routes/shoppingList'));

app.get('/api/ping', (req, res) => {
  res.sendStatus(204);
});

if (isAndroidBuild) {
  // Only the Android build renders HTML -- the central deployment is a pure JSON API
  // (see docs/android-app.md). views/ and these page-only public assets only exist in
  // Android's bundled copy (added by android/nodejs-project-template/ at build time),
  // same for the *Pages route files below.
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.static(path.join(__dirname, 'public')));

  app.use(require('./routes/planPages'));
  app.use(require('./routes/recipePages'));
  app.use(require('./routes/ingredientPages'));
  app.use(require('./routes/shoppingListPages'));
  app.use(require('./routes/settingsPages'));
  centralSync.startPeriodicSync();
}

// Catches whatever asyncRoute() forwarded via next(err) (see its comment above) and
// turns it into a normal response instead of a hung connection. Must be registered
// after every route. Express recognizes an error handler by its 4-arg signature.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal server error' });
});

const PORT = process.env.PORT || 3000;
// The Android build sets this to 127.0.0.1 (via its entry-android.js wrapper) since
// it never needs to accept incoming connections from other devices, only serve its
// own WebView; the docker-compose deployment needs the default 0.0.0.0 to be reachable
// through the container's port mapping.
const HOST = process.env.HOST || '0.0.0.0';

async function start() {
  // the db container may still be starting up when this container boots, so retry
  for (let i = 0; i < 20; i++) {
    try {
      await db.ping();
      break;
    } catch (err) {
      console.log('Waiting for database...');
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  app.listen(PORT, HOST, () => console.log(`Server running on ${HOST}:${PORT}`));
}

start();
