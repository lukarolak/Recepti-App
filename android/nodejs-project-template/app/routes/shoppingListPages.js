// Android-only: the local shopping-list HTML page and its checkbox-toggle routes. Only
// mounted by server.js when isAndroidBuild is true. Reuses getMaxDaysAhead/clampDays/
// computeShoppingList/setBoughtState from the shared API route file (./shoppingList) so
// there's one source of truth for each.
const express = require('express');
const asyncRoute = require('../lib/asyncRoute');
const { broadcastChange } = require('../lib/sse');
const {
  parseDateKey, addDays, getMondayOf, resolveWeekMonday, getSelectedWeekMonday,
  getWeekNavData, formatDateRangeLabel,
} = require('../lib/dates');
const { getMaxDaysAhead, clampDays, computeShoppingList, setBoughtState } = require('./shoppingList');

const router = express.Router();

router.get('/shopping-list', asyncRoute(async (req, res) => {
  // Read-write, same as the plan page's own week navigator -- both pages read/write
  // the same "selectedWeek" cookie, so changing the week on either one propagates.
  const weekMonday = resolveWeekMonday(req, res);
  const maxDays = getMaxDaysAhead(weekMonday);
  const daysAhead = clampDays(req.query.days, maxDays);
  const data = await computeShoppingList(daysAhead, weekMonday, res.locals.t);
  const weekNavData = getWeekNavData(weekMonday, res.locals.lang);
  // The non-perishable section spans from the CURRENT week's Monday through the end
  // of the SELECTED week (see computeShoppingList), not just the selected week alone
  // -- so the caption under the widget must reflect that full accumulated span, or it
  // misleadingly implies the list only covers the single selected week shown by the
  // week number.
  const currentWeekStart = getMondayOf(new Date());
  const selectedWeekEnd = addDays(parseDateKey(weekMonday), 6);
  weekNavData.weekRangeLabel = formatDateRangeLabel(currentWeekStart, selectedWeekEnd, res.locals.lang);
  res.render('shopping-list', { daysAhead, maxDays, ...data, ...weekNavData });
}));

router.post('/shopping-list/items/:ingredientId/:recipeId/:planDate', asyncRoute(async (req, res) => {
  const bought = req.body.checked === 'on';
  await setBoughtState(
    [{ ingredientId: req.params.ingredientId, recipeId: req.params.recipeId, planDate: req.params.planDate }],
    bought
  );
  broadcastChange(req.get('X-Client-Id'));
  const weekMonday = getSelectedWeekMonday(req);
  res.redirect('/shopping-list?days=' + clampDays(req.body.days, getMaxDaysAhead(weekMonday)));
}));

// Bulk toggle every recipe's occurrence of one ingredient at once.
router.post('/shopping-list/ingredient/:ingredientId', asyncRoute(async (req, res) => {
  const weekMonday = getSelectedWeekMonday(req);
  const daysAhead = clampDays(req.body.days, getMaxDaysAhead(weekMonday));
  const bought = req.body.checked === 'on';
  const ingredientId = parseInt(req.params.ingredientId, 10);

  const data = await computeShoppingList(daysAhead, weekMonday, res.locals.t);
  const line = [...data.perishable, ...data.nonPerishable].find((l) => l.ingredientId === ingredientId);

  if (line) {
    await setBoughtState(
      line.recipes.map((r) => ({ ingredientId, recipeId: r.recipeId, planDate: r.planDate })),
      bought
    );
    broadcastChange(req.get('X-Client-Id'));
  }

  res.redirect('/shopping-list?days=' + daysAhead);
}));

module.exports = router;
