-- Adds shopping-list metadata to ingredients: the unit you'd buy it in,
-- and whether it's perishable. Safe to run more than once.
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS default_unit TEXT;
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS is_perishable BOOLEAN NOT NULL DEFAULT false;
