// Android-only: the local ingredients HTML page (list/add/edit/delete forms). Only
// mounted by server.js when isAndroidBuild is true. Reuses getIngredientsData from the
// shared API route file (./ingredients) so there's one source of truth for the query.
const express = require('express');
const db = require('../db');
const asyncRoute = require('../lib/asyncRoute');
const { broadcastChange } = require('../lib/sse');
const { nowIso } = require('../lib/dates');
const { getIngredientsData } = require('./ingredients');

const router = express.Router();

// The local row is gone immediately, so record the central id in a pending-delete
// queue for the sync module to push up later (see app/sync/centralSync.js).
async function deleteIngredientAsAndroid(id) {
  const existing = await db.query('SELECT central_id FROM ingredients WHERE id = ?', [id]);
  const centralId = existing.rows[0] && existing.rows[0].central_id;
  if (centralId) {
    await db.query(
      'INSERT INTO pending_ingredient_deletes (central_id) VALUES (?) ON CONFLICT DO NOTHING',
      [centralId]
    );
  }
  await db.query('DELETE FROM ingredients WHERE id = ?', [id]);
}

router.get('/ingredients', asyncRoute(async (req, res) => {
  res.render('ingredients', await getIngredientsData());
}));

router.post('/ingredients', asyncRoute(async (req, res) => {
  const { name, default_unit } = req.body;
  const isPerishable = req.body.is_perishable === 'on';
  if (name && name.trim()) {
    await db.query(
      'INSERT INTO ingredients (name, default_unit, is_perishable, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO NOTHING',
      [name.trim(), default_unit || null, isPerishable, nowIso()]
    );
    broadcastChange(req.get('X-Client-Id'));
  }
  res.redirect('/ingredients');
}));

router.post('/ingredients/:id', asyncRoute(async (req, res) => {
  const { default_unit } = req.body;
  const isPerishable = req.body.is_perishable === 'on';
  await db.query(
    'UPDATE ingredients SET default_unit = ?, is_perishable = ?, updated_at = ? WHERE id = ?',
    [default_unit || null, isPerishable, nowIso(), req.params.id]
  );
  broadcastChange(req.get('X-Client-Id'));
  res.redirect('/ingredients');
}));

router.post('/ingredients/:id/delete', asyncRoute(async (req, res) => {
  await deleteIngredientAsAndroid(req.params.id);
  broadcastChange(req.get('X-Client-Id'));
  res.redirect('/ingredients');
}));

module.exports = router;
