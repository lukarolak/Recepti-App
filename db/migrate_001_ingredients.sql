-- Splits the old free-text recipes.ingredients column into normalized
-- ingredients + recipe_ingredients tables. Safe to run more than once.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'recipes' AND column_name = 'ingredients'
  ) THEN
    CREATE TABLE IF NOT EXISTS ingredients (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS recipe_ingredients (
      id SERIAL PRIMARY KEY,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
      quantity TEXT,
      unit TEXT
    );

    INSERT INTO ingredients (name)
    SELECT DISTINCT trim(part)
    FROM recipes, unnest(string_to_array(ingredients, ',')) AS part
    WHERE trim(part) <> ''
    ON CONFLICT (name) DO NOTHING;

    INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity, unit)
    SELECT r.id, i.id, NULL, NULL
    FROM recipes r, unnest(string_to_array(r.ingredients, ',')) AS part
    JOIN ingredients i ON i.name = trim(part)
    WHERE trim(part) <> '';

    ALTER TABLE recipes DROP COLUMN ingredients;
  ELSE
    CREATE TABLE IF NOT EXISTS ingredients (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS recipe_ingredients (
      id SERIAL PRIMARY KEY,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
      quantity TEXT,
      unit TEXT
    );
  END IF;
END $$;
