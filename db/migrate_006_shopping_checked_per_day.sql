-- A recipe scheduled on multiple days is now shown as separate shopping-list
-- entries per occurrence (day-suffixed name), so bought-state needs the day
-- as part of its key too. The checklist is transient, safe to drop and recreate.
DROP TABLE IF EXISTS shopping_checked;

CREATE TABLE shopping_checked (
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  day_of_week TEXT NOT NULL,
  PRIMARY KEY (ingredient_id, recipe_id, day_of_week)
);
