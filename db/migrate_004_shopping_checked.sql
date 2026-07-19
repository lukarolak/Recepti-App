-- Tracks which ingredients have been checked off on the shopping list.
-- Presence of a row = bought. Safe to run more than once.
CREATE TABLE IF NOT EXISTS shopping_checked (
  ingredient_id INTEGER PRIMARY KEY REFERENCES ingredients(id) ON DELETE CASCADE
);
