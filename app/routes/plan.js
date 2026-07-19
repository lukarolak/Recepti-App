const express = require('express');
const db = require('../db');
const asyncRoute = require('../lib/asyncRoute');
const { broadcastChange } = require('../lib/sse');
const { toDateKey, parseDateKey, isValidDateKey, addDays, getMondayOf } = require('../lib/dates');

const router = express.Router();

// Fetches meal_plan rows (a sparse table -- only dates with a recipe assigned have any
// rows at all) for exactly `days` consecutive dates starting at `startDateKey`. Used both
// by the Android build's local page (7-day window for the selected week, see
// routes/planPages.js) and this JSON API (arbitrary windows -- e.g. the Android build's
// central-sync horizon). A date can have more than one row (multiple recipes planned the
// same day, duplicates allowed), so planByDate[date] is always an array, in the order the
// recipes were added.
async function getPlanRangeData(startDateKey, days) {
  const start = parseDateKey(startDateKey);
  const dates = [];
  for (let i = 0; i < days; i++) dates.push(toDateKey(addDays(start, i)));

  const placeholders = dates.map(() => '?').join(', ');
  const plan = await db.query(
    `SELECT mp.id, mp.plan_date, r.id AS recipe_id, r.name AS recipe_name
     FROM meal_plan mp
     JOIN recipes r ON mp.recipe_id = r.id
     WHERE mp.plan_date IN (${placeholders})
     ORDER BY mp.plan_date, mp.id`,
    dates
  );

  const planByDate = {};
  for (const date of dates) planByDate[date] = [];
  for (const row of plan.rows) planByDate[row.plan_date].push(row);

  return { startDate: startDateKey, days, dates, planByDate };
}

// --- JSON API for offline caching / sync (used by the Android build's local pages via
// public/plan.js, and by centralSync.js talking to a remote central server) ---

// Flexible date-range read, not just "the current week" -- used by the Android build's
// local-page offline-sync (start=<selected week's Monday>&days=7) and its central-sync
// (start=today&days=84, see app/sync/centralSync.js).
router.get('/api/plan', asyncRoute(async (req, res) => {
  const days = Math.max(1, Math.min(400, parseInt(req.query.days, 10) || 7));
  const start = isValidDateKey(req.query.start) ? req.query.start : toDateKey(getMondayOf(new Date()));
  res.json(await getPlanRangeData(start, days));
}));

// Overwrites exactly the given date range at once, matching how the Android build's
// local-page offline-cached plan is synced back (see public/plan.js) and how its
// central-sync pushes its whole known horizon (see app/sync/centralSync.js).
router.put('/api/plan', asyncRoute(async (req, res) => {
  const days = Math.max(1, Math.min(400, parseInt(req.body && req.body.days, 10) || 7));
  const start = isValidDateKey(req.body && req.body.start) ? req.body.start : toDateKey(getMondayOf(new Date()));
  const plan = (req.body && req.body.plan) || {};

  await db.transaction(async (tx) => {
    const dates = [];
    for (let i = 0; i < days; i++) dates.push(toDateKey(addDays(parseDateKey(start), i)));

    for (const date of dates) {
      const newRecipeIds = Array.isArray(plan[date]) ? plan[date].filter(Boolean) : [];
      const current = await tx.query('SELECT recipe_id FROM meal_plan WHERE plan_date = ? ORDER BY id', [date]);
      const oldRecipeIds = current.rows.map((r) => r.recipe_id);

      const changed = oldRecipeIds.length !== newRecipeIds.length
        || oldRecipeIds.some((id, i) => String(id) !== String(newRecipeIds[i]));
      if (!changed) continue;

      await tx.query('DELETE FROM shopping_checked WHERE plan_date = ?', [date]);
      await tx.query('DELETE FROM meal_plan WHERE plan_date = ?', [date]);
      for (const recipeId of newRecipeIds) {
        await tx.query('INSERT INTO meal_plan (plan_date, recipe_id) VALUES (?, ?)', [date, recipeId]);
      }
    }
  });
  broadcastChange(req.get('X-Client-Id'));
  res.json(await getPlanRangeData(start, days));
}));

module.exports = router;
module.exports.getPlanRangeData = getPlanRangeData;
