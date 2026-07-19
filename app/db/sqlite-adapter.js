const fs = require('fs');
const path = require('path');
const { Database } = require('node-sqlite3-wasm');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data.sqlite3');
const db = new Database(dbPath);
db.run('PRAGMA foreign_keys = ON');

// Postgres gets its schema from db/init.sql via docker-entrypoint-initdb.d on first
// container start; SQLite has no equivalent hook, so apply it here. Every statement
// in init.sqlite.sql is CREATE-IF-NOT-EXISTS / INSERT-ON-CONFLICT-DO-NOTHING, so
// running it on every startup (not just the first) is safe.
const schemaPath = path.join(__dirname, '..', '..', 'db', 'init.sqlite.sql');
db.exec(fs.readFileSync(schemaPath, 'utf8'));

// CREATE TABLE IF NOT EXISTS never retrofits new columns onto an already-installed
// app's existing database (this has already broken an existing install once, when
// updated_at was added -- see docs/android-app.md). Rather than requiring a reinstall
// every time init.sqlite.sql gains a column, add any that are missing here.
function ensureColumn(table, column, ddlType) {
  const existingColumns = db.all(`PRAGMA table_info(${table})`).map((c) => c.name);
  if (!existingColumns.includes(column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
  }
}

ensureColumn('recipes', 'updated_at', "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");
ensureColumn('ingredients', 'updated_at', "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");
ensureColumn('recipe_ingredients', 'unit', 'TEXT');

// meal_plan/shopping_checked moved from a single evergreen day-of-week template to
// sparse calendar-dated rows (see db/init.sqlite.sql and the mirrored migration in
// db/migrations/003_calendar_plan.js for the central Postgres deployment). Unlike the
// ensureColumn cases above, this is a full table restructure, not just an added
// column, so it needs its own one-time migration for any install that predates it.
function migrateToCalendarPlan() {
  const columns = db.all('PRAGMA table_info(meal_plan)').map((c) => c.name);
  if (!columns.includes('day_of_week')) return; // already on the new schema, or fresh install

  function toDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(monday.getDate() - ((today.getDay() + 6) % 7));
  const dateForDay = {};
  DAYS.forEach((day, i) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    dateForDay[day] = toDateKey(d);
  });

  db.run(`
    CREATE TABLE meal_plan_new (
      plan_date TEXT PRIMARY KEY,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE
    );
  `);
  db.run(`
    CREATE TABLE shopping_checked_new (
      ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      plan_date TEXT NOT NULL,
      PRIMARY KEY (ingredient_id, recipe_id, plan_date)
    );
  `);

  for (const row of db.all('SELECT day_of_week, recipe_id FROM meal_plan WHERE recipe_id IS NOT NULL')) {
    const date = dateForDay[row.day_of_week];
    if (!date) continue;
    db.run(
      `INSERT INTO meal_plan_new (plan_date, recipe_id) VALUES (?, ?)
       ON CONFLICT (plan_date) DO UPDATE SET recipe_id = excluded.recipe_id`,
      [date, row.recipe_id]
    );
  }

  for (const row of db.all('SELECT ingredient_id, recipe_id, day_of_week FROM shopping_checked')) {
    const date = dateForDay[row.day_of_week];
    if (!date) continue;
    db.run(
      'INSERT INTO shopping_checked_new (ingredient_id, recipe_id, plan_date) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      [row.ingredient_id, row.recipe_id, date]
    );
  }

  db.run('DROP TABLE meal_plan');
  db.run('ALTER TABLE meal_plan_new RENAME TO meal_plan');
  db.run('DROP TABLE shopping_checked');
  db.run('ALTER TABLE shopping_checked_new RENAME TO shopping_checked');
}

migrateToCalendarPlan();

// meal_plan moves from a single row per plan_date (plan_date PRIMARY KEY) to a
// surrogate id, so a date can have more than one recipe planned (duplicates allowed).
// Mirrors db/migrate_007_meal_plan_multi_per_day.sql for the central Postgres deployment.
function migrateMealPlanToMultiPerDay() {
  const columns = db.all('PRAGMA table_info(meal_plan)').map((c) => c.name);
  if (columns.includes('id')) return; // already on the new schema, or fresh install

  db.run(`
    CREATE TABLE meal_plan_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_date TEXT NOT NULL,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE
    );
  `);
  db.run('INSERT INTO meal_plan_new (plan_date, recipe_id) SELECT plan_date, recipe_id FROM meal_plan');
  db.run('DROP TABLE meal_plan');
  db.run('ALTER TABLE meal_plan_new RENAME TO meal_plan');
  db.run('CREATE INDEX IF NOT EXISTS idx_meal_plan_date ON meal_plan(plan_date)');
}

migrateMealPlanToMultiPerDay();

// node-sqlite3-wasm's db.run() executes a statement but doesn't surface a RETURNING
// result set, even though SQLite itself supports RETURNING on INSERT/UPDATE/DELETE.
// db.all() does surface it, so route anything with RETURNING (or a plain SELECT/WITH)
// through db.all() and everything else through db.run().
function isSelectLike(sql) {
  return /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
}

// pg accepts JS booleans directly for boolean columns; node-sqlite3-wasm's bind layer
// expects primitive SQLite types, so coerce booleans to 0/1 here rather than pushing
// that detail onto every call site.
function normalizeParams(params) {
  return params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

async function query(sql, params = []) {
  const boundParams = normalizeParams(params);
  if (isSelectLike(sql)) {
    return { rows: db.all(sql, boundParams) };
  }
  db.run(sql, boundParams);
  return { rows: [] };
}

// A single-process, single-connection embedded database has no concurrent-transaction
// concerns, so a plain BEGIN/COMMIT/ROLLBACK around the callback is sufficient.
async function transaction(fn) {
  db.run('BEGIN');
  try {
    const result = await fn({ query });
    db.run('COMMIT');
    return result;
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

async function ping() {
  db.all('SELECT 1');
}

module.exports = { query, transaction, ping };
