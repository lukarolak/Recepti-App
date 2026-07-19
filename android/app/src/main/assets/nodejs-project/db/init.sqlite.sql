-- SQLite mirror of init.sql, for the Android build's local database (see app/db/sqlite-adapter.js).
-- Kept in sync manually with init.sql's table shapes; dialect differences only
-- (SERIAL -> INTEGER PRIMARY KEY AUTOINCREMENT, TIMESTAMP DEFAULT NOW() -> CURRENT_TIMESTAMP).

-- central_id is NULL until this row has been successfully pushed to the central
-- server (see app/sync/centralSync.js), after which it holds the id central assigned.
-- Local FKs (recipe_ingredients, meal_plan, shopping_checked) always reference the
-- local id, never central_id.
-- updated_at is always set explicitly by server.js (new Date().toISOString()), never
-- left to the SQL default below, so it's directly string-comparable against the
-- central server's Postgres updated_at (also ISO 8601 UTC) for last-write-wins sync.
CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  instructions TEXT,
  central_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS ingredients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  default_unit TEXT,
  is_perishable BOOLEAN NOT NULL DEFAULT 0,
  central_id INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Recipes/ingredients deleted locally that were already linked to a central row (had a
-- central_id): the local row is gone immediately, so this is the only record left that
-- a delete still needs to be pushed up on the next sync cycle (see centralSync.js).
CREATE TABLE IF NOT EXISTS pending_recipe_deletes (
  central_id INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS pending_ingredient_deletes (
  central_id INTEGER PRIMARY KEY
);

-- unit is a per-recipe override of the ingredient's default_unit; NULL means "use the
-- ingredient's default_unit" (see getRecipesData's COALESCE in server.js).
CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  quantity TEXT,
  unit TEXT
);

-- Sparse: rows only exist for calendar dates that actually have a recipe assigned.
-- plan_date is 'YYYY-MM-DD', always a specific calendar day (not a repeating
-- day-of-week label), so different weeks can have different plans. A date can have
-- more than one row (multiple recipes planned the same day, duplicates allowed) --
-- id is a surrogate key, not plan_date.
CREATE TABLE IF NOT EXISTS meal_plan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_date TEXT NOT NULL,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_meal_plan_date ON meal_plan(plan_date);

CREATE TABLE IF NOT EXISTS shopping_checked (
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  plan_date TEXT NOT NULL,
  PRIMARY KEY (ingredient_id, recipe_id, plan_date)
);

-- Android-only app config (central server address, etc.) -- has no equivalent in
-- init.sql since the central deployment never syncs to itself.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
