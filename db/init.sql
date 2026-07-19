CREATE TABLE IF NOT EXISTS recipes (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  instructions TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ingredients (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  default_unit TEXT,
  is_perishable BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Tombstones for rows deleted centrally, so the Android build's sync can tell a
-- "gone" central id apart from one it just hasn't seen yet (see app/sync/centralSync.js).
CREATE TABLE IF NOT EXISTS deleted_recipes (
  recipe_id INTEGER PRIMARY KEY,
  deleted_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deleted_ingredients (
  ingredient_id INTEGER PRIMARY KEY,
  deleted_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id SERIAL PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  quantity TEXT,
  -- Per-recipe override of the ingredient's default_unit; NULL means "use the
  -- ingredient's default_unit" (see getRecipesData's COALESCE in server.js).
  unit TEXT
);

-- Sparse: rows only exist for calendar dates that actually have a recipe assigned
-- (see server.js's week-planning routes). plan_date is 'YYYY-MM-DD', always a specific
-- calendar day (not a repeating day-of-week label), so different weeks can have
-- different plans. A date can have more than one row (multiple recipes planned the
-- same day, duplicates allowed) -- id is a surrogate key, not plan_date.
CREATE TABLE IF NOT EXISTS meal_plan (
  id SERIAL PRIMARY KEY,
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

-- example data so the app isn't empty on first run
INSERT INTO recipes (name, instructions) VALUES
  ('Spaghetti Bolognese', 'Cook pasta. Brown beef with onion and garlic. Add tomato sauce and simmer. Combine with pasta.'),
  ('Chicken Stir Fry', 'Cook rice. Stir fry chicken and vegetables. Add soy sauce. Serve over rice.');

INSERT INTO ingredients (name, default_unit, is_perishable) VALUES
  ('Spaghetti', 'g', false),
  ('Ground beef', 'g', true),
  ('Tomato sauce', 'ml', false),
  ('Onion', 'piece', false),
  ('Garlic', 'clove', false),
  ('Chicken breast', 'g', true),
  ('Mixed vegetables', 'g', true),
  ('Soy sauce', 'ml', false),
  ('Rice', 'g', false);

-- quantities are expressed in each ingredient's default_unit (set above)
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity)
SELECT r.id, i.id, v.quantity
FROM (VALUES
  ('Spaghetti Bolognese', 'Spaghetti', '400'),
  ('Spaghetti Bolognese', 'Ground beef', '500'),
  ('Spaghetti Bolognese', 'Tomato sauce', '480'),
  ('Spaghetti Bolognese', 'Onion', '1'),
  ('Spaghetti Bolognese', 'Garlic', '2'),
  ('Chicken Stir Fry', 'Chicken breast', '500'),
  ('Chicken Stir Fry', 'Mixed vegetables', '300'),
  ('Chicken Stir Fry', 'Soy sauce', '45'),
  ('Chicken Stir Fry', 'Rice', '370')
) AS v(recipe_name, ingredient_name, quantity)
JOIN recipes r ON r.name = v.recipe_name
JOIN ingredients i ON i.name = v.ingredient_name;
