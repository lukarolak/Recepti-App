-- One-off migration for existing central deployments (fresh installs get this via
-- init.sql already). Adds edit/delete-sync support: an updated_at column for
-- last-write-wins conflict resolution, and tombstone tables so the Android build's
-- sync can tell a deleted central row apart from one it hasn't seen yet.
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS deleted_recipes (
  recipe_id INTEGER PRIMARY KEY,
  deleted_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deleted_ingredients (
  ingredient_id INTEGER PRIMARY KEY,
  deleted_at TIMESTAMP NOT NULL DEFAULT NOW()
);
