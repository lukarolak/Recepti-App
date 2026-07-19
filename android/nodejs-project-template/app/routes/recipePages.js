// Android-only: the local recipes HTML pages (list/add/edit/delete forms). Only
// mounted by server.js when isAndroidBuild is true. Reuses getRecipesData/createRecipe/
// saveRecipeIngredients from the shared API route file (./recipes) and
// getIngredientPickerData from ./ingredients, so there's one source of truth for each.
const express = require('express');
const db = require('../db');
const asyncRoute = require('../lib/asyncRoute');
const { broadcastChange } = require('../lib/sse');
const { nowIso } = require('../lib/dates');
const { getIngredientPickerData } = require('./ingredients');
const { getRecipesData, createRecipe, saveRecipeIngredients } = require('./recipes');

const router = express.Router();

function parseIngredientRows(body) {
  const raw = body.rows;
  if (!raw) return [];
  return Object.values(raw).filter(Boolean);
}

// The local row is gone immediately, so record the central id in a pending-delete
// queue for the sync module to push up later (see app/sync/centralSync.js).
async function deleteRecipeAsAndroid(id) {
  const existing = await db.query('SELECT central_id FROM recipes WHERE id = ?', [id]);
  const centralId = existing.rows[0] && existing.rows[0].central_id;
  if (centralId) {
    await db.query(
      'INSERT INTO pending_recipe_deletes (central_id) VALUES (?) ON CONFLICT DO NOTHING',
      [centralId]
    );
  }
  await db.query('DELETE FROM recipes WHERE id = ?', [id]);
}

router.get('/recipes', asyncRoute(async (req, res) => {
  res.render('recipes', await getRecipesData());
}));

router.post('/recipes', asyncRoute(async (req, res) => {
  const { name, instructions } = req.body;
  const rows = parseIngredientRows(req.body);

  if (!name || !name.trim()) {
    return res.redirect('/recipes');
  }

  await createRecipe(name, instructions, rows);

  broadcastChange(req.get('X-Client-Id'));
  res.redirect('/recipes');
}));

router.get('/recipes/:id/edit', asyncRoute(async (req, res) => {
  const recipeResult = await db.query(
    'SELECT id, name, instructions FROM recipes WHERE id = ?',
    [req.params.id]
  );
  if (recipeResult.rows.length === 0) {
    return res.redirect('/recipes');
  }

  const ingredientsResult = await db.query(
    `SELECT i.name, COALESCE(ri.unit, i.default_unit) AS unit, ri.quantity
     FROM recipe_ingredients ri
     JOIN ingredients i ON ri.ingredient_id = i.id
     WHERE ri.recipe_id = ?
     ORDER BY i.name`,
    [req.params.id]
  );

  res.render('edit-recipe', {
    recipe: recipeResult.rows[0],
    ingredients: ingredientsResult.rows,
    ...(await getIngredientPickerData()),
  });
}));

router.post('/recipes/:id', asyncRoute(async (req, res) => {
  const { name, instructions } = req.body;
  const rows = parseIngredientRows(req.body);

  if (!name || !name.trim()) {
    return res.redirect('/recipes/' + req.params.id + '/edit');
  }

  await db.transaction(async (tx) => {
    await tx.query(
      'UPDATE recipes SET name = ?, instructions = ?, updated_at = ? WHERE id = ?',
      [name.trim(), instructions || '', nowIso(), req.params.id]
    );
    await tx.query('DELETE FROM recipe_ingredients WHERE recipe_id = ?', [req.params.id]);
    await saveRecipeIngredients(tx, req.params.id, rows);
  });

  broadcastChange(req.get('X-Client-Id'));
  res.redirect('/recipes');
}));

router.post('/recipes/:id/delete', asyncRoute(async (req, res) => {
  await deleteRecipeAsAndroid(req.params.id);
  broadcastChange(req.get('X-Client-Id'));
  res.redirect('/recipes');
}));

module.exports = router;
