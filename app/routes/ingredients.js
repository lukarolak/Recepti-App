const express = require('express');
const db = require('../db');
const asyncRoute = require('../lib/asyncRoute');
const { broadcastChange } = require('../lib/sse');
const { nowIso } = require('../lib/dates');

const router = express.Router();

const UNITS = ['g', 'kg', 'ml', 'l', 'tsp', 'tbsp', 'cup', 'piece', 'clove', 'pinch', 'oz', 'lb'];

// Also used by routes/recipes.js and routes/recipePages.js (the recipe form's
// ingredient autocomplete/picker).
async function getIngredientPickerData() {
  const allIngredients = await db.query('SELECT name, default_unit FROM ingredients ORDER BY name');
  const ingredientUnits = {};
  for (const row of allIngredients.rows) ingredientUnits[row.name] = row.default_unit;
  return {
    ingredientNames: allIngredients.rows.map((r) => r.name),
    ingredientUnits,
    units: UNITS,
  };
}

// Reuses an ingredient by name (case-insensitive) if one already exists.
// Only a genuinely new ingredient gets the unit/perishable metadata from the form,
// since an existing ingredient's metadata is only editable on the Ingredients tab.
// Also used by routes/recipes.js when saving a recipe's ingredient rows.
async function upsertIngredientId(tx, name, defaultUnit, isPerishable) {
  const existing = await tx.query(
    'SELECT id FROM ingredients WHERE lower(name) = lower(?)',
    [name]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  const inserted = await tx.query(
    'INSERT INTO ingredients (name, default_unit, is_perishable, updated_at) VALUES (?, ?, ?, ?) RETURNING id',
    [name, defaultUnit || null, isPerishable, nowIso()]
  );
  return inserted.rows[0].id;
}

// Also used by routes/ingredientPages.js to render ingredients.ejs.
async function getIngredientsData() {
  const ingredients = await db.query(
    'SELECT id, name, default_unit, is_perishable, updated_at FROM ingredients ORDER BY name'
  );
  return { ingredients: ingredients.rows, units: UNITS };
}

// Records a tombstone so the Android build can tell "deleted" apart from "never seen"
// on its next pull -- used by the JSON delete (DELETE /api/ingredients/:id), called
// both when the phone's sync push step deletes an ingredient centrally and when this
// server IS the central deployment processing a delete request.
async function deleteIngredientAsCentral(id) {
  const deletedAt = nowIso();
  await db.transaction(async (tx) => {
    await tx.query('DELETE FROM ingredients WHERE id = ?', [id]);
    await tx.query(
      `INSERT INTO deleted_ingredients (ingredient_id, deleted_at) VALUES (?, ?)
       ON CONFLICT (ingredient_id) DO UPDATE SET deleted_at = excluded.deleted_at`,
      [id, deletedAt]
    );
  });
  return deletedAt;
}

// --- JSON API for offline caching / sync (used by the Android build's local pages via
// public/shopping.js, and by centralSync.js talking to a remote central server) ---

router.get('/api/ingredients', asyncRoute(async (req, res) => {
  res.json(await getIngredientsData());
}));

// Used to sync an ingredient queued while offline (also used by the phone's
// central-sync push step). Same ON CONFLICT DO NOTHING semantics as the Android
// build's form-based POST /ingredients. Includes the row's id (whether newly created
// or reused from an existing case-insensitive name match) for the same reason as
// POST /api/recipes.
router.post('/api/ingredients', asyncRoute(async (req, res) => {
  const { name, default_unit } = req.body || {};
  const isPerishable = !!(req.body && req.body.is_perishable);
  let id = null;
  let updatedAt = null;
  if (name && name.trim()) {
    await db.query(
      'INSERT INTO ingredients (name, default_unit, is_perishable, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO NOTHING',
      [name.trim(), default_unit || null, isPerishable, nowIso()]
    );
    const existing = await db.query('SELECT id, updated_at FROM ingredients WHERE lower(name) = lower(?)', [name.trim()]);
    id = existing.rows[0] ? existing.rows[0].id : null;
    updatedAt = existing.rows[0] ? existing.rows[0].updated_at : null;
    broadcastChange(req.get('X-Client-Id'));
  }
  res.json({ id, updatedAt, ...(await getIngredientsData()) });
}));

// Used by the phone's central-sync push step for an edit to an ingredient already
// linked to a central row. Only default_unit/is_perishable are editable, matching the
// Android build's form-based POST /ingredients/:id (name isn't editable there either).
router.put('/api/ingredients/:id', asyncRoute(async (req, res) => {
  const { default_unit } = req.body || {};
  const isPerishable = !!(req.body && req.body.is_perishable);

  const existing = await db.query('SELECT id FROM ingredients WHERE id = ?', [req.params.id]);
  if (existing.rows.length === 0) {
    return res.status(404).json({ error: 'not found' });
  }

  const updatedAt = nowIso();
  await db.query(
    'UPDATE ingredients SET default_unit = ?, is_perishable = ?, updated_at = ? WHERE id = ?',
    [default_unit || null, isPerishable, updatedAt, req.params.id]
  );
  broadcastChange(req.get('X-Client-Id'));
  res.json({ id: Number(req.params.id), updatedAt, ...(await getIngredientsData()) });
}));

router.delete('/api/ingredients/:id', asyncRoute(async (req, res) => {
  const deletedAt = await deleteIngredientAsCentral(req.params.id);
  broadcastChange(req.get('X-Client-Id'));
  res.json({ ok: true, deletedAt });
}));

// Lets the phone tell "this ingredient was deleted centrally" apart from "I haven't
// pulled it yet" during a sync pull (see app/sync/centralSync.js).
router.get('/api/ingredients/deletions', asyncRoute(async (req, res) => {
  const result = await db.query('SELECT ingredient_id, deleted_at FROM deleted_ingredients');
  res.json({ deletions: result.rows.map((r) => ({ id: r.ingredient_id, deletedAt: r.deleted_at })) });
}));

module.exports = router;
module.exports.getIngredientPickerData = getIngredientPickerData;
module.exports.upsertIngredientId = upsertIngredientId;
module.exports.getIngredientsData = getIngredientsData;
