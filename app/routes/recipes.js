const express = require('express');
const db = require('../db');
const asyncRoute = require('../lib/asyncRoute');
const { broadcastChange } = require('../lib/sse');
const { nowIso } = require('../lib/dates');
const { getIngredientPickerData, upsertIngredientId } = require('./ingredients');

const router = express.Router();

// Also used by routes/recipePages.js's page-based edit route (POST /recipes/:id).
async function saveRecipeIngredients(tx, recipeId, rows) {
  for (const row of rows) {
    const ingredientName = (row.name || '').trim();
    if (!ingredientName) continue;

    const ingredientId = await upsertIngredientId(
      tx,
      ingredientName,
      row.unit,
      row.perishable === 'on' || row.perishable === true
    );
    const unitOverride = (row.unit || '').trim() || null;
    await tx.query(
      'INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity, unit) VALUES (?, ?, ?, ?)',
      [recipeId, ingredientId, (row.quantity || '').trim(), unitOverride]
    );
  }
}

// Also used by routes/recipePages.js to render recipes.ejs.
async function getRecipesData() {
  const recipesResult = await db.query('SELECT id, name, instructions, updated_at FROM recipes ORDER BY name');
  const ingredientsResult = await db.query(`
    SELECT ri.recipe_id, i.name, i.default_unit, ri.unit AS unit_override, ri.quantity
    FROM recipe_ingredients ri
    JOIN ingredients i ON ri.ingredient_id = i.id
    ORDER BY i.name
  `);

  const ingredientsByRecipe = {};
  for (const row of ingredientsResult.rows) {
    if (!ingredientsByRecipe[row.recipe_id]) ingredientsByRecipe[row.recipe_id] = [];
    ingredientsByRecipe[row.recipe_id].push({
      recipe_id: row.recipe_id,
      name: row.name,
      quantity: row.quantity,
      // default_unit is the effective unit shown in every recipe view (per-recipe
      // override if set, else the ingredient's own default); ingredientDefaultUnit is
      // the ingredient's real default_unit, needed so the phone's sync module doesn't
      // mistake a recipe-specific override for the ingredient's actual global default
      // when it has to create a brand-new local ingredient (see centralSync.js).
      default_unit: row.unit_override || row.default_unit,
      ingredientDefaultUnit: row.default_unit,
    });
  }

  const recipes = recipesResult.rows.map((r) => ({
    ...r,
    ingredients: ingredientsByRecipe[r.id] || [],
  }));

  return { recipes, ...(await getIngredientPickerData()) };
}

// Also used by routes/recipePages.js's page-based create route (POST /recipes).
async function createRecipe(name, instructions, rows) {
  const updatedAt = nowIso();
  return db.transaction(async (tx) => {
    const recipeResult = await tx.query(
      'INSERT INTO recipes (name, instructions, updated_at) VALUES (?, ?, ?) RETURNING id',
      [name.trim(), instructions || '', updatedAt]
    );
    const recipeId = recipeResult.rows[0].id;
    await saveRecipeIngredients(tx, recipeId, rows);
    return { id: recipeId, updatedAt };
  });
}

// Records a tombstone so the Android build can tell "deleted" apart from "never seen"
// on its next pull -- used by the JSON delete (DELETE /api/recipes/:id), called both
// when the phone's sync push step deletes a recipe centrally and when this server IS
// the central deployment processing a delete request.
async function deleteRecipeAsCentral(id) {
  const deletedAt = nowIso();
  await db.transaction(async (tx) => {
    await tx.query('DELETE FROM recipes WHERE id = ?', [id]);
    await tx.query(
      `INSERT INTO deleted_recipes (recipe_id, deleted_at) VALUES (?, ?)
       ON CONFLICT (recipe_id) DO UPDATE SET deleted_at = excluded.deleted_at`,
      [id, deletedAt]
    );
  });
  return deletedAt;
}

// --- JSON API for offline caching / sync (used by the Android build's local pages via
// public/plan.js, and by centralSync.js talking to a remote central server) ---

router.get('/api/recipes', asyncRoute(async (req, res) => {
  res.json(await getRecipesData());
}));

// Used to sync a recipe queued while offline (also used by the phone's central-sync
// push step). Same validation/creation path as the Android build's form-based
// POST /recipes, just JSON in and JSON out. Includes the new row's id (in addition to
// the full fresh list already returned) so a syncing client can record it without
// name-matching.
router.post('/api/recipes', asyncRoute(async (req, res) => {
  const { name, instructions } = req.body || {};
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name required' });
  }

  const { id, updatedAt } = await createRecipe(name, instructions, rows);

  broadcastChange(req.get('X-Client-Id'));
  res.json({ id, updatedAt, ...(await getRecipesData()) });
}));

// Used by the phone's central-sync push step to send a local edit for a recipe
// already linked to a central row (see app/sync/centralSync.js). Same shape as
// POST /api/recipes, just targeting an existing id.
router.put('/api/recipes/:id', asyncRoute(async (req, res) => {
  const { name, instructions } = req.body || {};
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name required' });
  }

  const existing = await db.query('SELECT id FROM recipes WHERE id = ?', [req.params.id]);
  if (existing.rows.length === 0) {
    return res.status(404).json({ error: 'not found' });
  }

  const updatedAt = nowIso();
  await db.transaction(async (tx) => {
    await tx.query(
      'UPDATE recipes SET name = ?, instructions = ?, updated_at = ? WHERE id = ?',
      [name.trim(), instructions || '', updatedAt, req.params.id]
    );
    await tx.query('DELETE FROM recipe_ingredients WHERE recipe_id = ?', [req.params.id]);
    await saveRecipeIngredients(tx, req.params.id, rows);
  });

  broadcastChange(req.get('X-Client-Id'));
  res.json({ id: Number(req.params.id), updatedAt, ...(await getRecipesData()) });
}));

// Used by the phone's central-sync push step for a locally-deleted recipe that was
// already linked to a central row. Idempotent (a second delete of an already-gone id
// still succeeds) since the phone retries a pending delete until it stops erroring.
router.delete('/api/recipes/:id', asyncRoute(async (req, res) => {
  const deletedAt = await deleteRecipeAsCentral(req.params.id);
  broadcastChange(req.get('X-Client-Id'));
  res.json({ ok: true, deletedAt });
}));

// Lets the phone tell "this recipe was deleted centrally" apart from "I haven't
// pulled it yet" during a sync pull (see app/sync/centralSync.js).
router.get('/api/recipes/deletions', asyncRoute(async (req, res) => {
  const result = await db.query('SELECT recipe_id, deleted_at FROM deleted_recipes');
  res.json({ deletions: result.rows.map((r) => ({ id: r.recipe_id, deletedAt: r.deleted_at })) });
}));

module.exports = router;
module.exports.getRecipesData = getRecipesData;
module.exports.createRecipe = createRecipe;
module.exports.saveRecipeIngredients = saveRecipeIngredients;
