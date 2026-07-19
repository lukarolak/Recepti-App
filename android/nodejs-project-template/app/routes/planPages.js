// Android-only: the local weekly-plan HTML page and its form-style mutation routes.
// Only mounted by server.js when isAndroidBuild is true. Reuses getPlanRangeData from
// the shared API route file (./plan) rather than re-querying, so there's one source of
// truth for "what's planned on these dates."
const express = require('express');
const db = require('../db');
const asyncRoute = require('../lib/asyncRoute');
const { broadcastChange } = require('../lib/sse');
const { DAYS, isValidDateKey, resolveWeekMonday, getWeekNavData } = require('../lib/dates');
const { getPlanRangeData } = require('./plan');

const router = express.Router();

// Single-date variant used by the add/remove plan-entry routes, which only need to
// return the entries for the one date they just changed.
async function getPlanEntriesForDate(date) {
  const result = await db.query(
    `SELECT mp.id, mp.plan_date, r.id AS recipe_id, r.name AS recipe_name
     FROM meal_plan mp
     JOIN recipes r ON mp.recipe_id = r.id
     WHERE mp.plan_date = ?
     ORDER BY mp.id`,
    [date]
  );
  return result.rows;
}

async function getPlanData(weekMonday, lang) {
  const range = await getPlanRangeData(weekMonday, 7);
  const recipes = await db.query('SELECT id, name FROM recipes ORDER BY name');

  return {
    days: DAYS,
    dates: range.dates,
    planByDate: range.planByDate,
    recipes: recipes.rows,
    ...getWeekNavData(weekMonday, lang),
  };
}

router.get('/', asyncRoute(async (req, res) => {
  const weekMonday = resolveWeekMonday(req, res);
  res.render('index', await getPlanData(weekMonday, res.locals.lang));
}));

// Adds one recipe to a date (duplicates allowed). Purely additive, so
// shopping_checked never needs touching here.
router.post('/plan/add', asyncRoute(async (req, res) => {
  const { date, recipe_id } = req.body;
  if (!isValidDateKey(date) || !recipe_id) {
    return res.status(400).json({ error: 'invalid date or recipe_id' });
  }
  await db.query('INSERT INTO meal_plan (plan_date, recipe_id) VALUES (?, ?)', [date, recipe_id]);
  broadcastChange(req.get('X-Client-Id'));
  res.json({ date, entries: await getPlanEntriesForDate(date) });
}));

// Removes one specific plan entry by id. Only clears shopping_checked for its
// (recipe_id, plan_date) pair once no other entry (e.g. a same-day duplicate) still
// needs it, so a remaining duplicate keeps its bought-state.
router.post('/plan/:id/remove', asyncRoute(async (req, res) => {
  const existing = await db.query('SELECT plan_date, recipe_id FROM meal_plan WHERE id = ?', [req.params.id]);
  const row = existing.rows[0];
  if (row) {
    await db.query('DELETE FROM meal_plan WHERE id = ?', [req.params.id]);
    const remaining = await db.query(
      'SELECT 1 FROM meal_plan WHERE plan_date = ? AND recipe_id = ?',
      [row.plan_date, row.recipe_id]
    );
    if (remaining.rows.length === 0) {
      await db.query('DELETE FROM shopping_checked WHERE plan_date = ? AND recipe_id = ?', [row.plan_date, row.recipe_id]);
    }
  }
  broadcastChange(req.get('X-Client-Id'));
  res.json({ date: row ? row.plan_date : null, entries: row ? await getPlanEntriesForDate(row.plan_date) : [] });
}));

module.exports = router;
