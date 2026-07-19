const express = require('express');
const path = require('path');
const db = require('./db');
const { translate, translations, SUPPORTED_LANGS, LANG_NAMES } = require('./i18n');

// Only the Android build talks to a central server -- inert (never required) for the
// central docker-compose deployment itself.
const isAndroidBuild = process.env.DB_DRIVER === 'sqlite';
const centralSync = isAndroidBuild ? require('./sync/centralSync') : null;

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Express 4 doesn't catch a rejected promise from an `async (req, res) => {...}`
// handler -- it becomes an unhandled promise rejection, and Node's default behavior
// for that (since Node 15) is to crash the whole process. On the Android build this
// embedded server shares a process with the WebView UI, so a single bad request (a
// stale recipe id, two writes racing on node-sqlite3-wasm's mkdir-based file lock,
// anything) took the entire app down instead of just failing that one request. Every
// async route/middleware below is wrapped in this so a thrown error becomes a normal
// 500 response via the error-handling middleware near the bottom of this file, not a
// process-ending crash.
function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// Belt-and-braces backstop for anything that throws outside an asyncRoute-wrapped
// request (e.g. a future setInterval/setTimeout callback with no try/catch of its
// own) -- log it instead of letting Node's default "crash the process" behavior take
// the whole app down with it.
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

// No cookie-parser dependency needed for a single, simple cookie -- Express doesn't
// parse cookies itself.
function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// centralSync.js's status.label is plain English (fine for its own console.log calls),
// so translate for display here based on the stable state enum instead of that raw
// text. The 'error' case's detail (a raw JS/network error message) is left untranslated
// -- it's diagnostic text, not really app chrome.
function translateSyncStatus(t, status) {
  switch (status.state) {
    case 'never': return t('syncCentral.notYetSynced');
    case 'unconfigured': return t('syncCentral.unconfigured');
    case 'offline': return t('syncCentral.unreachable');
    case 'synced': return t('syncCentral.synced');
    case 'error': return t('syncCentral.errorPrefix') + (status.lastError || '');
    default: return status.label;
  }
}

app.use(asyncRoute(async (req, res, next) => {
  const cookieLang = getCookie(req, 'lang');
  const lang = SUPPORTED_LANGS.includes(cookieLang) ? cookieLang : 'en';
  res.locals.lang = lang;
  res.locals.t = (key, params) => translate(lang, key, params);
  // Only what public/*.js needs client-side (see partials/nav.ejs) -- never used for
  // user-entered content, only app chrome text.
  res.locals.i18nDictJson = JSON.stringify(translations[lang]);

  res.locals.isAndroidBuild = isAndroidBuild;
  if (isAndroidBuild) {
    const status = centralSync.getStatus();
    res.locals.syncState = status.state === 'synced' ? 'synced' : 'offline';
    res.locals.syncLabel = translateSyncStatus(res.locals.t, status);
    res.locals.centralConfigured = !!(await centralSync.getCentralUrl());
  }
  next();
}));

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const UNITS = ['g', 'kg', 'ml', 'l', 'tsp', 'tbsp', 'cup', 'piece', 'clove', 'pinch', 'oz', 'lb'];

// Always set explicitly (rather than relying on SQL defaults) so recipes/ingredients'
// updated_at is a plain ISO 8601 UTC string on both the pg and sqlite adapters -- that
// makes it directly string-comparable for the Android build's last-write-wins sync
// (see app/sync/centralSync.js), with no dialect-specific timestamp parsing needed.
function nowIso() {
  return new Date().toISOString();
}

// Calendar-date helpers for the week-planning feature (see getPlanData/computeShoppingList
// below). Plans are keyed by actual calendar dates ('YYYY-MM-DD', local time, never UTC --
// avoids off-by-one days near midnight), not repeating day-of-week labels, so different
// weeks can have different plans.
function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isValidDateKey(key) {
  return typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// Maps JS Date.getDay() (0=Sun..6=Sat) onto our DAYS array order (0=Monday..6=Sunday)
function getDayIndex(date) {
  return (date.getDay() + 6) % 7;
}

function getMondayOf(date) {
  return addDays(date, -getDayIndex(date));
}

function isValidMondayKey(key) {
  return isValidDateKey(key) && toDateKey(getMondayOf(parseDateKey(key))) === key;
}

// ISO 8601 week number, for display only ("Week 38"). The actual identifier used
// everywhere else is the week's Monday date, which sidesteps ISO week-numbering edge
// cases (week 1 vs. 53, year boundaries) entirely.
function getIsoWeekNumber(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - getDayIndex(d) + 3); // nearest Thursday
  const firstThursday = new Date(d.getFullYear(), 0, 4);
  firstThursday.setDate(firstThursday.getDate() - getDayIndex(firstThursday) + 3);
  return 1 + Math.round((d - firstThursday) / (7 * 24 * 3600 * 1000));
}

// The plan-page week navigator (see index.ejs) never allows going before the current
// week; this both resolves which week is selected AND persists it as a cookie so the
// Shopping List page (which has no week selector of its own) can follow along.
function resolveWeekMonday(req, res) {
  const currentMonday = toDateKey(getMondayOf(new Date()));
  let weekMonday = req.query.week || getCookie(req, 'selectedWeek') || currentMonday;
  if (!isValidMondayKey(weekMonday) || weekMonday < currentMonday) {
    weekMonday = currentMonday;
  }
  res.cookie('selectedWeek', weekMonday, { maxAge: 400 * 24 * 3600 * 1000, path: '/' });
  return weekMonday;
}

// Read-only variant for routes that need to know the selected week but shouldn't
// themselves establish/persist a selection (only the plan page's own navigation does).
function getSelectedWeekMonday(req) {
  const currentMonday = toDateKey(getMondayOf(new Date()));
  const cookieWeek = getCookie(req, 'selectedWeek');
  return isValidMondayKey(cookieWeek) && cookieWeek >= currentMonday ? cookieWeek : currentMonday;
}

// --- live updates: push a "something changed" event to every connected browser ---
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const client = { res, clientId: req.query.clientId || '' };
  sseClients.add(client);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (err) {
      // write failed synchronously (e.g. socket already torn down) — drop the client
      clearInterval(heartbeat);
      sseClients.delete(client);
    }
  }, 20000);

  function cleanup() {
    clearInterval(heartbeat);
    sseClients.delete(client);
  }

  req.on('close', cleanup);
  // A client that vanishes without a clean TCP close (dropped wifi, sleeping laptop)
  // surfaces as an 'error' on the response stream instead of 'close'. Node crashes
  // the whole process on an unhandled stream error, so this must be handled too.
  res.on('error', cleanup);
});

// excludeClientId skips echoing the event back to the tab that made the change —
// that tab already applied the update optimistically, so it doesn't need a reload.
function broadcastChange(excludeClientId) {
  for (const client of sseClients) {
    if (client.clientId && client.clientId === excludeClientId) continue;
    try {
      client.res.write('event: data-changed\ndata: {}\n\n');
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

// Fetches meal_plan rows (a sparse table -- only dates with a recipe assigned have any
// rows at all) for exactly `days` consecutive dates starting at `startDateKey`. Used both
// by the plan page (7-day window for the selected week) and the JSON API (arbitrary
// windows -- e.g. the Android build's central-sync horizon). A date can have more than
// one row (multiple recipes planned the same day, duplicates allowed), so planByDate[date]
// is always an array, in the order the recipes were added.
async function getPlanRangeData(startDateKey, days) {
  const start = parseDateKey(startDateKey);
  const dates = [];
  for (let i = 0; i < days; i++) dates.push(toDateKey(addDays(start, i)));

  const placeholders = dates.map(() => '?').join(', ');
  const plan = await db.query(
    `SELECT mp.id, mp.plan_date, r.id AS recipe_id, r.name AS recipe_name
     FROM meal_plan mp
     JOIN recipes r ON mp.recipe_id = r.id
     WHERE mp.plan_date IN (${placeholders})
     ORDER BY mp.plan_date, mp.id`,
    dates
  );

  const planByDate = {};
  for (const date of dates) planByDate[date] = [];
  for (const row of plan.rows) planByDate[row.plan_date].push(row);

  return { startDate: startDateKey, days, dates, planByDate };
}

// Single-date variant used by the add/remove plan-entry routes, which only need to
// return the entries for the one date they just changed.
async function getPlanEntriesForDate(date) {
  const result = await db.query(
    `SELECT mp.id, mp.plan_date, r.id AS recipe_id, r.name AS recipe_name
     FROM meal_plan mp
     JOIN recipes r ON mp.recipe_id = r.id
     WHERE mp.plan_date = ?
     ORDER BY mp.id`,
    [date]
  );
  return result.rows;
}

// Just for the human-readable "Jul 20 – 26" caption under the week-nav badge -- the
// week number alone doesn't tell most people which actual calendar dates it covers,
// which is the whole point of clarifying this isn't necessarily "this week" (see
// partials/week-nav.ejs).
// Hand-rolled instead of Intl.DateTimeFormat.formatRange: nodejs-mobile's embedded
// Node build has no ICU support, so the global Intl object doesn't exist at all
// there, and an uncaught ReferenceError aborts the whole process on the Android build.
const WEEK_RANGE_MONTHS = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  de: ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'],
  hr: ['sij', 'velj', 'ožu', 'tra', 'svi', 'lip', 'srp', 'kol', 'ruj', 'lis', 'stu', 'pro'],
};

function formatDateRangeLabel(start, end, lang) {
  const months = WEEK_RANGE_MONTHS[lang] || WEEK_RANGE_MONTHS.en;
  const startMonth = months[start.getMonth()];
  const endMonth = months[end.getMonth()];
  const d1 = start.getDate();
  const d2 = end.getDate();
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();

  if (lang === 'de') {
    return sameMonth ? `${d1}.–${d2}. ${endMonth}` : `${d1}. ${startMonth} – ${d2}. ${endMonth}`;
  }
  if (lang === 'hr') {
    return sameMonth ? `${d1}. – ${d2}. ${endMonth}` : `${d1}. ${startMonth} – ${d2}. ${endMonth}`;
  }
  return sameMonth ? `${startMonth} ${d1} – ${d2}` : `${startMonth} ${d1} – ${endMonth} ${d2}`;
}

function formatWeekRangeLabel(weekMonday, lang) {
  const start = parseDateKey(weekMonday);
  const end = addDays(start, 6);
  return formatDateRangeLabel(start, end, lang);
}

// Shared by every page that shows the week navigator (see partials/week-nav.ejs) --
// currently the plan page and the shopping list, both of which read/write the same
// "selectedWeek" cookie, so changing the week on either one propagates to the other.
function getWeekNavData(weekMonday, lang) {
  const monday = parseDateKey(weekMonday);
  const currentMonday = toDateKey(getMondayOf(new Date()));
  return {
    weekMonday,
    weekNumber: getIsoWeekNumber(monday),
    weekRangeLabel: formatWeekRangeLabel(weekMonday, lang),
    isCurrentWeek: weekMonday === currentMonday,
    prevWeekMonday: toDateKey(addDays(monday, -7)),
    nextWeekMonday: toDateKey(addDays(monday, 7)),
  };
}

async function getPlanData(weekMonday, lang) {
  const range = await getPlanRangeData(weekMonday, 7);
  const recipes = await db.query('SELECT id, name FROM recipes ORDER BY name');

  return {
    days: DAYS,
    dates: range.dates,
    planByDate: range.planByDate,
    recipes: recipes.rows,
    ...getWeekNavData(weekMonday, lang),
  };
}

app.get('/', asyncRoute(async (req, res) => {
  const weekMonday = resolveWeekMonday(req, res);
  res.render('index', await getPlanData(weekMonday, res.locals.lang));
}));

// Adds one recipe to a date (duplicates allowed). Purely additive, so
// shopping_checked never needs touching here.
app.post('/plan/add', asyncRoute(async (req, res) => {
  const { date, recipe_id } = req.body;
  if (!isValidDateKey(date) || !recipe_id) {
    return res.status(400).json({ error: 'invalid date or recipe_id' });
  }
  await db.query('INSERT INTO meal_plan (plan_date, recipe_id) VALUES (?, ?)', [date, recipe_id]);
  broadcastChange(req.get('X-Client-Id'));
  res.json({ date, entries: await getPlanEntriesForDate(date) });
}));

// Removes one specific plan entry by id. Only clears shopping_checked for its
// (recipe_id, plan_date) pair once no other entry (e.g. a same-day duplicate) still
// needs it, so a remaining duplicate keeps its bought-state.
app.post('/plan/:id/remove', asyncRoute(async (req, res) => {
  const existing = await db.query('SELECT plan_date, recipe_id FROM meal_plan WHERE id = ?', [req.params.id]);
  const row = existing.rows[0];
  if (row) {
    await db.query('DELETE FROM meal_plan WHERE id = ?', [req.params.id]);
    const remaining = await db.query(
      'SELECT 1 FROM meal_plan WHERE plan_date = ? AND recipe_id = ?',
      [row.plan_date, row.recipe_id]
    );
    if (remaining.rows.length === 0) {
      await db.query('DELETE FROM shopping_checked WHERE plan_date = ? AND recipe_id = ?', [row.plan_date, row.recipe_id]);
    }
  }
  broadcastChange(req.get('X-Client-Id'));
  res.json({ date: row ? row.plan_date : null, entries: row ? await getPlanEntriesForDate(row.plan_date) : [] });
}));

async function getIngredientPickerData() {
  const allIngredients = await db.query('SELECT name, default_unit FROM ingredients ORDER BY name');
  const ingredientUnits = {};
  for (const row of allIngredients.rows) ingredientUnits[row.name] = row.default_unit;
  return {
    ingredientNames: allIngredients.rows.map((r) => r.name),
    ingredientUnits,
    units: UNITS,
  };
}

// Reuses an ingredient by name (case-insensitive) if one already exists.
// Only a genuinely new ingredient gets the unit/perishable metadata from the form,
// since an existing ingredient's metadata is only editable on the Ingredients tab.
async function upsertIngredientId(tx, name, defaultUnit, isPerishable) {
  const existing = await tx.query(
    'SELECT id FROM ingredients WHERE lower(name) = lower(?)',
    [name]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  const inserted = await tx.query(
    'INSERT INTO ingredients (name, default_unit, is_perishable, updated_at) VALUES (?, ?, ?, ?) RETURNING id',
    [name, defaultUnit || null, isPerishable, nowIso()]
  );
  return inserted.rows[0].id;
}

function parseIngredientRows(body) {
  const raw = body.rows;
  if (!raw) return [];
  return Object.values(raw).filter(Boolean);
}

async function saveRecipeIngredients(tx, recipeId, rows) {
  for (const row of rows) {
    const ingredientName = (row.name || '').trim();
    if (!ingredientName) continue;

    const ingredientId = await upsertIngredientId(
      tx,
      ingredientName,
      row.unit,
      row.perishable === 'on' || row.perishable === true
    );
    const unitOverride = (row.unit || '').trim() || null;
    await tx.query(
      'INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity, unit) VALUES (?, ?, ?, ?)',
      [recipeId, ingredientId, (row.quantity || '').trim(), unitOverride]
    );
  }
}

async function getRecipesData() {
  const recipesResult = await db.query('SELECT id, name, instructions, updated_at FROM recipes ORDER BY name');
  const ingredientsResult = await db.query(`
    SELECT ri.recipe_id, i.name, i.default_unit, ri.unit AS unit_override, ri.quantity
    FROM recipe_ingredients ri
    JOIN ingredients i ON ri.ingredient_id = i.id
    ORDER BY i.name
  `);

  const ingredientsByRecipe = {};
  for (const row of ingredientsResult.rows) {
    if (!ingredientsByRecipe[row.recipe_id]) ingredientsByRecipe[row.recipe_id] = [];
    ingredientsByRecipe[row.recipe_id].push({
      recipe_id: row.recipe_id,
      name: row.name,
      quantity: row.quantity,
      // default_unit is the effective unit shown in every recipe view (per-recipe
      // override if set, else the ingredient's own default); ingredientDefaultUnit is
      // the ingredient's real default_unit, needed so the phone's sync module doesn't
      // mistake a recipe-specific override for the ingredient's actual global default
      // when it has to create a brand-new local ingredient (see centralSync.js).
      default_unit: row.unit_override || row.default_unit,
      ingredientDefaultUnit: row.default_unit,
    });
  }

  const recipes = recipesResult.rows.map((r) => ({
    ...r,
    ingredients: ingredientsByRecipe[r.id] || [],
  }));

  return { recipes, ...(await getIngredientPickerData()) };
}

async function createRecipe(name, instructions, rows) {
  const updatedAt = nowIso();
  return db.transaction(async (tx) => {
    const recipeResult = await tx.query(
      'INSERT INTO recipes (name, instructions, updated_at) VALUES (?, ?, ?) RETURNING id',
      [name.trim(), instructions || '', updatedAt]
    );
    const recipeId = recipeResult.rows[0].id;
    await saveRecipeIngredients(tx, recipeId, rows);
    return { id: recipeId, updatedAt };
  });
}

// Shared by the form-based delete (POST /recipes/:id/delete) and the JSON delete used
// by the phone's sync push step (DELETE /api/recipes/:id) -- always records a tombstone
// so the Android build can tell "deleted" apart from "never seen" on its next pull.
async function deleteRecipeAsCentral(id) {
  const deletedAt = nowIso();
  await db.transaction(async (tx) => {
    await tx.query('DELETE FROM recipes WHERE id = ?', [id]);
    await tx.query(
      `INSERT INTO deleted_recipes (recipe_id, deleted_at) VALUES (?, ?)
       ON CONFLICT (recipe_id) DO UPDATE SET deleted_at = excluded.deleted_at`,
      [id, deletedAt]
    );
  });
  return deletedAt;
}

// Used only on the Android build: the local row is gone immediately, so record the
// central id in a pending-delete queue for the sync module to push up later.
async function deleteRecipeAsAndroid(id) {
  const existing = await db.query('SELECT central_id FROM recipes WHERE id = ?', [id]);
  const centralId = existing.rows[0] && existing.rows[0].central_id;
  if (centralId) {
    await db.query(
      'INSERT INTO pending_recipe_deletes (central_id) VALUES (?) ON CONFLICT DO NOTHING',
      [centralId]
    );
  }
  await db.query('DELETE FROM recipes WHERE id = ?', [id]);
}

async function deleteIngredientAsCentral(id) {
  const deletedAt = nowIso();
  await db.transaction(async (tx) => {
    await tx.query('DELETE FROM ingredients WHERE id = ?', [id]);
    await tx.query(
      `INSERT INTO deleted_ingredients (ingredient_id, deleted_at) VALUES (?, ?)
       ON CONFLICT (ingredient_id) DO UPDATE SET deleted_at = excluded.deleted_at`,
      [id, deletedAt]
    );
  });
  return deletedAt;
}

async function deleteIngredientAsAndroid(id) {
  const existing = await db.query('SELECT central_id FROM ingredients WHERE id = ?', [id]);
  const centralId = existing.rows[0] && existing.rows[0].central_id;
  if (centralId) {
    await db.query(
      'INSERT INTO pending_ingredient_deletes (central_id) VALUES (?) ON CONFLICT DO NOTHING',
      [centralId]
    );
  }
  await db.query('DELETE FROM ingredients WHERE id = ?', [id]);
}

app.get('/recipes', asyncRoute(async (req, res) => {
  res.render('recipes', await getRecipesData());
}));

app.post('/recipes', asyncRoute(async (req, res) => {
  const { name, instructions } = req.body;
  const rows = parseIngredientRows(req.body);

  if (!name || !name.trim()) {
    return res.redirect('/recipes');
  }

  await createRecipe(name, instructions, rows);

  broadcastChange(req.get('X-Client-Id'));
  res.redirect('/recipes');
}));

app.get('/recipes/:id/edit', asyncRoute(async (req, res) => {
  const recipeResult = await db.query(
    'SELECT id, name, instructions FROM recipes WHERE id = ?',
    [req.params.id]
  );
  if (recipeResult.rows.length === 0) {
    return res.redirect('/recipes');
  }

  const ingredientsResult = await db.query(
    `SELECT i.name, COALESCE(ri.unit, i.default_unit) AS unit, ri.quantity
     FROM recipe_ingredients ri
     JOIN ingredients i ON ri.ingredient_id = i.id
     WHERE ri.recipe_id = ?
     ORDER BY i.name`,
    [req.params.id]
  );

  res.render('edit-recipe', {
    recipe: recipeResult.rows[0],
    ingredients: ingredientsResult.rows,
    ...(await getIngredientPickerData()),
  });
}));

app.post('/recipes/:id', asyncRoute(async (req, res) => {
  const { name, instructions } = req.body;
  const rows = parseIngredientRows(req.body);

  if (!name || !name.trim()) {
    return res.redirect('/recipes/' + req.params.id + '/edit');
  }

  await db.transaction(async (tx) => {
    await tx.query(
      'UPDATE recipes SET name = ?, instructions = ?, updated_at = ? WHERE id = ?',
      [name.trim(), instructions || '', nowIso(), req.params.id]
    );
    await tx.query('DELETE FROM recipe_ingredients WHERE recipe_id = ?', [req.params.id]);
    await saveRecipeIngredients(tx, req.params.id, rows);
  });

  broadcastChange(req.get('X-Client-Id'));
  res.redirect('/recipes');
}));

app.post('/recipes/:id/delete', asyncRoute(async (req, res) => {
  if (isAndroidBuild) await deleteRecipeAsAndroid(req.params.id);
  else await deleteRecipeAsCentral(req.params.id);
  broadcastChange(req.get('X-Client-Id'));
  res.redirect('/recipes');
}));

async function getIngredientsData() {
  const ingredients = await db.query(
    'SELECT id, name, default_unit, is_perishable, updated_at FROM ingredients ORDER BY name'
  );
  return { ingredients: ingredients.rows, units: UNITS };
}

app.get('/ingredients', asyncRoute(async (req, res) => {
  res.render('ingredients', await getIngredientsData());
}));

app.post('/ingredients', asyncRoute(async (req, res) => {
  const { name, default_unit } = req.body;
  const isPerishable = req.body.is_perishable === 'on';
  if (name && name.trim()) {
    await db.query(
      'INSERT INTO ingredients (name, default_unit, is_perishable, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO NOTHING',
      [name.trim(), default_unit || null, isPerishable, nowIso()]
    );
    broadcastChange(req.get('X-Client-Id'));
  }
  res.redirect('/ingredients');
}));

app.post('/ingredients/:id', asyncRoute(async (req, res) => {
  const { default_unit } = req.body;
  const isPerishable = req.body.is_perishable === 'on';
  await db.query(
    'UPDATE ingredients SET default_unit = ?, is_perishable = ?, updated_at = ? WHERE id = ?',
    [default_unit || null, isPerishable, nowIso(), req.params.id]
  );
  broadcastChange(req.get('X-Client-Id'));
  res.redirect('/ingredients');
}));

app.post('/ingredients/:id/delete', asyncRoute(async (req, res) => {
  if (isAndroidBuild) await deleteIngredientAsAndroid(req.params.id);
  else await deleteIngredientAsCentral(req.params.id);
  broadcastChange(req.get('X-Client-Id'));
  res.redirect('/ingredients');
}));

// Perishables are only bought for a near-term window (today through `daysAhead` days,
// user-adjustable up to this cap); non-perishables cover the whole SELECTED week
// regardless of today's date, since they don't need just-in-time buying. The cap on
// daysAhead is "today through the end of the selected week" -- if that week is a future
// one, this can span more than 7 days (the rest of this week plus all of the
// intervening weeks), which is exactly what makes planning ahead useful.
function getMaxDaysAhead(selectedWeekMonday) {
  const today = new Date();
  const daysLeftInCurrentWeek = 7 - getDayIndex(today);
  const currentMonday = getMondayOf(today);
  const weeksAhead = Math.round((parseDateKey(selectedWeekMonday) - currentMonday) / (7 * 24 * 3600 * 1000));
  return daysLeftInCurrentWeek + 7 * Math.max(0, weeksAhead);
}

function clampDays(value, maxDays) {
  const n = parseInt(value, 10);
  if (isNaN(n)) return Math.min(3, maxDays);
  return Math.min(maxDays, Math.max(1, n));
}

function sumQuantities(quantities) {
  const nums = quantities.map((q) => parseFloat(q)).filter((n) => !isNaN(n));
  if (nums.length === 0) return null;
  const total = nums.reduce((a, b) => a + b, 0);
  return Number.isInteger(total) ? String(total) : String(Math.round(total * 100) / 100);
}

// Builds the shopping list. Non-perishable ingredients are pulled from the entire
// span from the CURRENT week's start through the end of the SELECTED week (so
// navigating further ahead accumulates more weeks' worth rather than replacing one
// week with another); perishable ones only from the "buy for the next N days" window
// (today onward). A recipe scheduled on more than one date is treated as separate
// entries per occurrence (not merged), so each occurrence's shopping need can be
// checked off independently; the display name gets a day-name suffix only when that
// recipe actually repeats within the dates being shown.
async function computeShoppingList(daysAhead, selectedWeekMonday, t) {
  const today = new Date();
  const perishableDates = [];
  for (let i = 0; i < daysAhead; i++) perishableDates.push(toDateKey(addDays(today, i)));
  const perishableDateSet = new Set(perishableDates);
  const upcomingDays = perishableDates.map((dateKey) => DAYS[getDayIndex(parseDateKey(dateKey))]);

  const currentWeekStart = getMondayOf(today);
  const selectedWeekStart = parseDateKey(selectedWeekMonday);
  const weekSpanDays = Math.round((selectedWeekStart - currentWeekStart) / (24 * 3600 * 1000)) + 7;
  const weekDates = [];
  for (let i = 0; i < weekSpanDays; i++) weekDates.push(toDateKey(addDays(currentWeekStart, i)));
  const weekDateSet = new Set(weekDates);

  const allDates = Array.from(new Set([...perishableDates, ...weekDates]));
  const placeholders = allDates.map(() => '?').join(', ');
  const planResult = await db.query(
    `SELECT mp.plan_date, r.id AS recipe_id, r.name AS recipe_name
     FROM meal_plan mp
     JOIN recipes r ON mp.recipe_id = r.id
     WHERE mp.plan_date IN (${placeholders})`,
    allDates
  );

  if (planResult.rows.length === 0) {
    return { upcomingDays, perishable: [], nonPerishable: [] };
  }

  const occurrenceCount = new Map();
  for (const row of planResult.rows) {
    occurrenceCount.set(row.recipe_id, (occurrenceCount.get(row.recipe_id) || 0) + 1);
  }

  const recipeIds = [...new Set(planResult.rows.map((r) => r.recipe_id))];
  const recipePlaceholders = recipeIds.map(() => '?').join(', ');
  const ingredientsResult = await db.query(
    `SELECT ri.recipe_id, i.id AS ingredient_id, i.name, COALESCE(ri.unit, i.default_unit) AS default_unit, i.is_perishable, ri.quantity
     FROM recipe_ingredients ri
     JOIN ingredients i ON ri.ingredient_id = i.id
     WHERE ri.recipe_id IN (${recipePlaceholders})`,
    recipeIds
  );

  const ingredientsByRecipeId = new Map();
  for (const row of ingredientsResult.rows) {
    if (!ingredientsByRecipeId.has(row.recipe_id)) ingredientsByRecipeId.set(row.recipe_id, []);
    ingredientsByRecipeId.get(row.recipe_id).push(row);
  }

  const checkedResult = await db.query('SELECT ingredient_id, recipe_id, plan_date FROM shopping_checked');
  const checkedSet = new Set(
    checkedResult.rows.map((r) => r.ingredient_id + ':' + r.recipe_id + ':' + r.plan_date)
  );

  const byIngredient = new Map();

  for (const planRow of planResult.rows) {
    const inPerishableWindow = perishableDateSet.has(planRow.plan_date);
    const inWeekWindow = weekDateSet.has(planRow.plan_date);
    const recipeIngredients = ingredientsByRecipeId.get(planRow.recipe_id) || [];
    const isRepeated = occurrenceCount.get(planRow.recipe_id) > 1;
    const dayName = DAYS[getDayIndex(parseDateKey(planRow.plan_date))];
    const displayName = isRepeated ? `${planRow.recipe_name} (${t('day.' + dayName)})` : planRow.recipe_name;

    for (const ing of recipeIngredients) {
      if (ing.is_perishable) {
        if (!inPerishableWindow) continue;
      } else if (!inWeekWindow) {
        continue;
      }

      if (!byIngredient.has(ing.ingredient_id)) {
        byIngredient.set(ing.ingredient_id, {
          ingredientId: ing.ingredient_id,
          name: ing.name,
          unit: ing.default_unit,
          isPerishable: ing.is_perishable,
          recipes: [],
        });
      }
      byIngredient.get(ing.ingredient_id).recipes.push({
        recipeId: planRow.recipe_id,
        planDate: planRow.plan_date,
        recipeName: displayName,
        quantity: ing.quantity,
        unit: ing.default_unit,
        bought: checkedSet.has(ing.ingredient_id + ':' + planRow.recipe_id + ':' + planRow.plan_date),
      });
    }
  }

  const allLines = Array.from(byIngredient.values())
    .map((line) => {
      line.recipes.sort((a, b) => a.planDate.localeCompare(b.planDate) || a.recipeName.localeCompare(b.recipeName));

      // A per-recipe unit override (see saveRecipeIngredients) means different
      // occurrences of the same ingredient can now be in different units. Summing
      // across units would silently produce a meaningless number, so only merge
      // quantities that share the line's most common unit into a single total;
      // if the occurrences don't all agree on a unit, skip the merged total
      // entirely rather than show a wrong one -- each occurrence still displays
      // its own correct quantity and unit below.
      const unitCounts = new Map();
      for (const r of line.recipes) unitCounts.set(r.unit, (unitCounts.get(r.unit) || 0) + 1);
      let primaryUnit = line.unit;
      let bestCount = -1;
      for (const [unit, count] of unitCounts) {
        if (count > bestCount) {
          bestCount = count;
          primaryUnit = unit;
        }
      }
      const hasMixedUnits = unitCounts.size > 1;
      const matchingQuantities = line.recipes.filter((r) => r.unit === primaryUnit).map((r) => r.quantity);

      return {
        ingredientId: line.ingredientId,
        name: line.name,
        unit: hasMixedUnits ? null : primaryUnit,
        isPerishable: line.isPerishable,
        quantity: hasMixedUnits ? null : sumQuantities(matchingQuantities),
        recipes: line.recipes,
        bought: line.recipes.every((r) => r.bought),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    upcomingDays,
    perishable: allLines.filter((l) => l.isPerishable),
    nonPerishable: allLines.filter((l) => !l.isPerishable),
  };
}

app.get('/shopping-list', asyncRoute(async (req, res) => {
  // Read-write, same as the plan page's own week navigator -- both pages read/write
  // the same "selectedWeek" cookie, so changing the week on either one propagates.
  const weekMonday = resolveWeekMonday(req, res);
  const maxDays = getMaxDaysAhead(weekMonday);
  const daysAhead = clampDays(req.query.days, maxDays);
  const data = await computeShoppingList(daysAhead, weekMonday, res.locals.t);
  const weekNavData = getWeekNavData(weekMonday, res.locals.lang);
  // The non-perishable section spans from the CURRENT week's Monday through the end
  // of the SELECTED week (see computeShoppingList), not just the selected week alone
  // -- so the caption under the widget must reflect that full accumulated span, or it
  // misleadingly implies the list only covers the single selected week shown by the
  // week number.
  const currentWeekStart = getMondayOf(new Date());
  const selectedWeekEnd = addDays(parseDateKey(weekMonday), 6);
  weekNavData.weekRangeLabel = formatDateRangeLabel(currentWeekStart, selectedWeekEnd, res.locals.lang);
  res.render('shopping-list', { daysAhead, maxDays, ...data, ...weekNavData });
}));

async function setBoughtState(triples, bought) {
  if (triples.length === 0) return;

  await db.transaction(async (tx) => {
    for (const t of triples) {
      if (bought) {
        await tx.query(
          `INSERT INTO shopping_checked (ingredient_id, recipe_id, plan_date)
           VALUES (?, ?, ?)
           ON CONFLICT DO NOTHING`,
          [t.ingredientId, t.recipeId, t.planDate]
        );
      } else {
        await tx.query(
          `DELETE FROM shopping_checked
           WHERE ingredient_id = ? AND recipe_id = ? AND plan_date = ?`,
          [t.ingredientId, t.recipeId, t.planDate]
        );
      }
    }
  });
}

app.post('/shopping-list/items/:ingredientId/:recipeId/:planDate', asyncRoute(async (req, res) => {
  const bought = req.body.checked === 'on';
  await setBoughtState(
    [{ ingredientId: req.params.ingredientId, recipeId: req.params.recipeId, planDate: req.params.planDate }],
    bought
  );
  broadcastChange(req.get('X-Client-Id'));
  const weekMonday = getSelectedWeekMonday(req);
  res.redirect('/shopping-list?days=' + clampDays(req.body.days, getMaxDaysAhead(weekMonday)));
}));

// Bulk toggle every recipe's occurrence of one ingredient at once.
app.post('/shopping-list/ingredient/:ingredientId', asyncRoute(async (req, res) => {
  const weekMonday = getSelectedWeekMonday(req);
  const daysAhead = clampDays(req.body.days, getMaxDaysAhead(weekMonday));
  const bought = req.body.checked === 'on';
  const ingredientId = parseInt(req.params.ingredientId, 10);

  const data = await computeShoppingList(daysAhead, weekMonday, res.locals.t);
  const line = [...data.perishable, ...data.nonPerishable].find((l) => l.ingredientId === ingredientId);

  if (line) {
    await setBoughtState(
      line.recipes.map((r) => ({ ingredientId, recipeId: r.recipeId, planDate: r.planDate })),
      bought
    );
    broadcastChange(req.get('X-Client-Id'));
  }

  res.redirect('/shopping-list?days=' + daysAhead);
}));

// --- JSON API for offline caching / sync (used by public/plan.js, public/shopping.js) ---

app.get('/api/ping', (req, res) => {
  res.sendStatus(204);
});

// TEMP debug endpoint, remove after verifying the SSE connection-leak fix
app.get('/api/debug/sse-count', (req, res) => {
  res.json({ count: sseClients.size, clientIds: [...sseClients].map((c) => c.clientId) });
});

// Flexible date-range read, not just "the current week" -- used by the browser's own
// offline-sync (start=<selected week's Monday>&days=7) and the Android build's
// central-sync (start=today&days=84, see app/sync/centralSync.js).
app.get('/api/plan', asyncRoute(async (req, res) => {
  const days = Math.max(1, Math.min(400, parseInt(req.query.days, 10) || 7));
  const start = isValidDateKey(req.query.start) ? req.query.start : toDateKey(getMondayOf(new Date()));
  res.json(await getPlanRangeData(start, days));
}));

app.get('/api/recipes', asyncRoute(async (req, res) => {
  res.json(await getRecipesData());
}));

// Used to sync a recipe queued while offline (also used by the phone's central-sync
// push step). Same validation/creation path as the form-based POST /recipes, just
// JSON in and JSON out. Includes the new row's id (in addition to the full fresh
// list already returned) so a syncing client can record it without name-matching.
app.post('/api/recipes', asyncRoute(async (req, res) => {
  const { name, instructions } = req.body || {};
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name required' });
  }

  const { id, updatedAt } = await createRecipe(name, instructions, rows);

  broadcastChange(req.get('X-Client-Id'));
  res.json({ id, updatedAt, ...(await getRecipesData()) });
}));

// Used by the phone's central-sync push step to send a local edit for a recipe
// already linked to a central row (see app/sync/centralSync.js). Same shape as
// POST /api/recipes, just targeting an existing id.
app.put('/api/recipes/:id', asyncRoute(async (req, res) => {
  const { name, instructions } = req.body || {};
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name required' });
  }

  const existing = await db.query('SELECT id FROM recipes WHERE id = ?', [req.params.id]);
  if (existing.rows.length === 0) {
    return res.status(404).json({ error: 'not found' });
  }

  const updatedAt = nowIso();
  await db.transaction(async (tx) => {
    await tx.query(
      'UPDATE recipes SET name = ?, instructions = ?, updated_at = ? WHERE id = ?',
      [name.trim(), instructions || '', updatedAt, req.params.id]
    );
    await tx.query('DELETE FROM recipe_ingredients WHERE recipe_id = ?', [req.params.id]);
    await saveRecipeIngredients(tx, req.params.id, rows);
  });

  broadcastChange(req.get('X-Client-Id'));
  res.json({ id: Number(req.params.id), updatedAt, ...(await getRecipesData()) });
}));

// Used by the phone's central-sync push step for a locally-deleted recipe that was
// already linked to a central row. Idempotent (a second delete of an already-gone id
// still succeeds) since the phone retries a pending delete until it stops erroring.
app.delete('/api/recipes/:id', asyncRoute(async (req, res) => {
  const deletedAt = await deleteRecipeAsCentral(req.params.id);
  broadcastChange(req.get('X-Client-Id'));
  res.json({ ok: true, deletedAt });
}));

// Lets the phone tell "this recipe was deleted centrally" apart from "I haven't
// pulled it yet" during a sync pull (see app/sync/centralSync.js).
app.get('/api/recipes/deletions', asyncRoute(async (req, res) => {
  const result = await db.query('SELECT recipe_id, deleted_at FROM deleted_recipes');
  res.json({ deletions: result.rows.map((r) => ({ id: r.recipe_id, deletedAt: r.deleted_at })) });
}));

app.get('/api/ingredients', asyncRoute(async (req, res) => {
  res.json(await getIngredientsData());
}));

// Used to sync an ingredient queued while offline (also used by the phone's
// central-sync push step). Same ON CONFLICT DO NOTHING semantics as the form-based
// POST /ingredients. Includes the row's id (whether newly created or reused from an
// existing case-insensitive name match) for the same reason as POST /api/recipes.
app.post('/api/ingredients', asyncRoute(async (req, res) => {
  const { name, default_unit } = req.body || {};
  const isPerishable = !!(req.body && req.body.is_perishable);
  let id = null;
  let updatedAt = null;
  if (name && name.trim()) {
    await db.query(
      'INSERT INTO ingredients (name, default_unit, is_perishable, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO NOTHING',
      [name.trim(), default_unit || null, isPerishable, nowIso()]
    );
    const existing = await db.query('SELECT id, updated_at FROM ingredients WHERE lower(name) = lower(?)', [name.trim()]);
    id = existing.rows[0] ? existing.rows[0].id : null;
    updatedAt = existing.rows[0] ? existing.rows[0].updated_at : null;
    broadcastChange(req.get('X-Client-Id'));
  }
  res.json({ id, updatedAt, ...(await getIngredientsData()) });
}));

// Used by the phone's central-sync push step for an edit to an ingredient already
// linked to a central row. Only default_unit/is_perishable are editable, matching the
// form-based POST /ingredients/:id (name isn't editable there either).
app.put('/api/ingredients/:id', asyncRoute(async (req, res) => {
  const { default_unit } = req.body || {};
  const isPerishable = !!(req.body && req.body.is_perishable);

  const existing = await db.query('SELECT id FROM ingredients WHERE id = ?', [req.params.id]);
  if (existing.rows.length === 0) {
    return res.status(404).json({ error: 'not found' });
  }

  const updatedAt = nowIso();
  await db.query(
    'UPDATE ingredients SET default_unit = ?, is_perishable = ?, updated_at = ? WHERE id = ?',
    [default_unit || null, isPerishable, updatedAt, req.params.id]
  );
  broadcastChange(req.get('X-Client-Id'));
  res.json({ id: Number(req.params.id), updatedAt, ...(await getIngredientsData()) });
}));

app.delete('/api/ingredients/:id', asyncRoute(async (req, res) => {
  const deletedAt = await deleteIngredientAsCentral(req.params.id);
  broadcastChange(req.get('X-Client-Id'));
  res.json({ ok: true, deletedAt });
}));

app.get('/api/ingredients/deletions', asyncRoute(async (req, res) => {
  const result = await db.query('SELECT ingredient_id, deleted_at FROM deleted_ingredients');
  res.json({ deletions: result.rows.map((r) => ({ id: r.ingredient_id, deletedAt: r.deleted_at })) });
}));

// Overwrites exactly the given date range at once, matching how the offline-cached
// plan is synced back (see public/plan.js) and how the Android build's central-sync
// pushes its whole known horizon (see app/sync/centralSync.js).
app.put('/api/plan', asyncRoute(async (req, res) => {
  const days = Math.max(1, Math.min(400, parseInt(req.body && req.body.days, 10) || 7));
  const start = isValidDateKey(req.body && req.body.start) ? req.body.start : toDateKey(getMondayOf(new Date()));
  const plan = (req.body && req.body.plan) || {};

  await db.transaction(async (tx) => {
    const dates = [];
    for (let i = 0; i < days; i++) dates.push(toDateKey(addDays(parseDateKey(start), i)));

    for (const date of dates) {
      const newRecipeIds = Array.isArray(plan[date]) ? plan[date].filter(Boolean) : [];
      const current = await tx.query('SELECT recipe_id FROM meal_plan WHERE plan_date = ? ORDER BY id', [date]);
      const oldRecipeIds = current.rows.map((r) => r.recipe_id);

      const changed = oldRecipeIds.length !== newRecipeIds.length
        || oldRecipeIds.some((id, i) => String(id) !== String(newRecipeIds[i]));
      if (!changed) continue;

      await tx.query('DELETE FROM shopping_checked WHERE plan_date = ?', [date]);
      await tx.query('DELETE FROM meal_plan WHERE plan_date = ?', [date]);
      for (const recipeId of newRecipeIds) {
        await tx.query('INSERT INTO meal_plan (plan_date, recipe_id) VALUES (?, ?)', [date, recipeId]);
      }
    }
  });
  broadcastChange(req.get('X-Client-Id'));
  res.json(await getPlanRangeData(start, days));
}));

app.get('/api/shopping-list', asyncRoute(async (req, res) => {
  const weekMonday = getSelectedWeekMonday(req);
  const maxDays = getMaxDaysAhead(weekMonday);
  const daysAhead = clampDays(req.query.days, maxDays);
  const data = await computeShoppingList(daysAhead, weekMonday, res.locals.t);
  res.json({ daysAhead, maxDays, ...data });
}));

// Adds bought items queued while offline. Additive only, same as the checkbox routes.
app.post('/api/shopping-list/bought', asyncRoute(async (req, res) => {
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  const triples = items
    .filter((it) => it && it.ingredientId && it.recipeId && it.planDate)
    .map((it) => ({ ingredientId: it.ingredientId, recipeId: it.recipeId, planDate: it.planDate }));
  await setBoughtState(triples, true);
  if (triples.length > 0) broadcastChange(req.get('X-Client-Id'));
  res.json({ ok: true, count: triples.length });
}));

// --- Central server sync settings (Android build only) ---

if (isAndroidBuild) {
  app.get('/settings', asyncRoute(async (req, res) => {
    res.render('settings', {
      centralUrl: (await centralSync.getCentralUrl()) || '',
      status: centralSync.getStatus(),
      supportedLangs: SUPPORTED_LANGS,
      langNames: LANG_NAMES,
    });
  }));

  app.post('/settings', asyncRoute(async (req, res) => {
    await centralSync.setCentralUrl(req.body.centralUrl);
    res.redirect('/settings');
  }));

  app.post('/settings/sync-now', asyncRoute(async (req, res) => {
    await centralSync.runSyncCycle();
    res.redirect('/settings');
  }));

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
