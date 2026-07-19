-- Units now live only on ingredients.default_unit, not per recipe_ingredient.
-- Backfill any ingredient missing a default_unit from its existing recipe
-- usage before dropping the now-redundant column. Safe to run more than once.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'recipe_ingredients' AND column_name = 'unit'
  ) THEN
    UPDATE ingredients i
    SET default_unit = sub.unit
    FROM (
      SELECT DISTINCT ON (ingredient_id) ingredient_id, unit
      FROM recipe_ingredients
      WHERE unit IS NOT NULL AND unit <> ''
      ORDER BY ingredient_id, id
    ) sub
    WHERE i.id = sub.ingredient_id
      AND (i.default_unit IS NULL OR i.default_unit = '');

    ALTER TABLE recipe_ingredients DROP COLUMN unit;
  END IF;
END $$;
