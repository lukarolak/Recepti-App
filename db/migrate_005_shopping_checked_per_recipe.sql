-- Shopping checklist now tracks bought state per (ingredient, recipe) pair,
-- so a partially-shopped ingredient can be checked off for just the recipes
-- you've bought it for. Keyed on ingredient_id + recipe_id (both stable),
-- not recipe_ingredients.id, since editing a recipe deletes and recreates
-- its recipe_ingredients rows with new ids.
-- The old checklist is just transient shopping state, safe to drop.
DROP TABLE IF EXISTS shopping_checked;

CREATE TABLE shopping_checked (
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  PRIMARY KEY (ingredient_id, recipe_id)
);
