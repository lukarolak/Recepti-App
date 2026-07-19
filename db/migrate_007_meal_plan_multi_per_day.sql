-- meal_plan moves from a single row per plan_date (plan_date PRIMARY KEY) to a
-- surrogate id, so a date can have more than one recipe planned (duplicates allowed).
-- Data-preserving (unlike the shopping_checked migrations, which just drop/recreate
-- a transient table) -- safe to run more than once.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'meal_plan' AND column_name = 'id'
  ) THEN
    CREATE TABLE meal_plan_new (
      id SERIAL PRIMARY KEY,
      plan_date TEXT NOT NULL,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE
    );

    INSERT INTO meal_plan_new (plan_date, recipe_id)
    SELECT plan_date, recipe_id FROM meal_plan;

    DROP TABLE meal_plan;
    ALTER TABLE meal_plan_new RENAME TO meal_plan;
    CREATE INDEX IF NOT EXISTS idx_meal_plan_date ON meal_plan(plan_date);
  END IF;
END $$;
