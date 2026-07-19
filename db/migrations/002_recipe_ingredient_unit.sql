-- One-off migration for existing central deployments (fresh installs get this via
-- init.sql already). Adds a per-recipe unit override on recipe_ingredients, so an
-- ingredient's unit can be set differently per recipe instead of always using the
-- ingredient's global default_unit.
ALTER TABLE recipe_ingredients ADD COLUMN IF NOT EXISTS unit TEXT;
