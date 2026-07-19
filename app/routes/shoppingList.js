const express = require('express');
const db = require('../db');
const asyncRoute = require('../lib/asyncRoute');
const { broadcastChange } = require('../lib/sse');
const {
  DAYS, toDateKey, parseDateKey, addDays, getDayIndex, getMondayOf, getSelectedWeekMonday,
} = require('../lib/dates');

const router = express.Router();

// Perishables are only bought for a near-term window (today through `daysAhead` days,
// user-adjustable up to this cap); non-perishables cover the whole SELECTED week
// regardless of today's date, since they don't need just-in-time buying. The cap on
// daysAhead is "today through the end of the selected week" -- if that week is a future
// one, this can span more than 7 days (the rest of this week plus all of the
// intervening weeks), which is exactly what makes planning ahead useful.
// Also used by routes/shoppingListPages.js.
function getMaxDaysAhead(selectedWeekMonday) {
  const today = new Date();
  const daysLeftInCurrentWeek = 7 - getDayIndex(today);
  const currentMonday = getMondayOf(today);
  const weeksAhead = Math.round((parseDateKey(selectedWeekMonday) - currentMonday) / (7 * 24 * 3600 * 1000));
  return daysLeftInCurrentWeek + 7 * Math.max(0, weeksAhead);
}

// Also used by routes/shoppingListPages.js.
function clampDays(value, maxDays) {
  const n = parseInt(value, 10);
  if (isNaN(n)) return Math.min(3, maxDays);
  return Math.min(maxDays, Math.max(1, n));
}

function sumQuantities(quantities) {
  const nums = quantities.map((q) => parseFloat(q)).filter((n) => !isNaN(n));
  if (nums.length === 0) return null;
  const total = nums.reduce((a, b) => a + b, 0);
  return Number.isInteger(total) ? String(total) : String(Math.round(total * 100) / 100);
}

// Builds the shopping list. Non-perishable ingredients are pulled from the entire
// span from the CURRENT week's start through the end of the SELECTED week (so
// navigating further ahead accumulates more weeks' worth rather than replacing one
// week with another); perishable ones only from the "buy for the next N days" window
// (today onward). A recipe scheduled on more than one date is treated as separate
// entries per occurrence (not merged), so each occurrence's shopping need can be
// checked off independently; the display name gets a day-name suffix only when that
// recipe actually repeats within the dates being shown. Also used by
// routes/shoppingListPages.js.
async function computeShoppingList(daysAhead, selectedWeekMonday, t) {
  const today = new Date();
  const perishableDates = [];
  for (let i = 0; i < daysAhead; i++) perishableDates.push(toDateKey(addDays(today, i)));
  const perishableDateSet = new Set(perishableDates);
  const upcomingDays = perishableDates.map((dateKey) => DAYS[getDayIndex(parseDateKey(dateKey))]);

  const currentWeekStart = getMondayOf(today);
  const selectedWeekStart = parseDateKey(selectedWeekMonday);
  const weekSpanDays = Math.round((selectedWeekStart - currentWeekStart) / (24 * 3600 * 1000)) + 7;
  const weekDates = [];
  for (let i = 0; i < weekSpanDays; i++) weekDates.push(toDateKey(addDays(currentWeekStart, i)));
  const weekDateSet = new Set(weekDates);

  const allDates = Array.from(new Set([...perishableDates, ...weekDates]));
  const placeholders = allDates.map(() => '?').join(', ');
  const planResult = await db.query(
    `SELECT mp.plan_date, r.id AS recipe_id, r.name AS recipe_name
     FROM meal_plan mp
     JOIN recipes r ON mp.recipe_id = r.id
     WHERE mp.plan_date IN (${placeholders})`,
    allDates
  );

  if (planResult.rows.length === 0) {
    return { upcomingDays, perishable: [], nonPerishable: [] };
  }

  const occurrenceCount = new Map();
  for (const row of planResult.rows) {
    occurrenceCount.set(row.recipe_id, (occurrenceCount.get(row.recipe_id) || 0) + 1);
  }

  const recipeIds = [...new Set(planResult.rows.map((r) => r.recipe_id))];
  const recipePlaceholders = recipeIds.map(() => '?').join(', ');
  const ingredientsResult = await db.query(
    `SELECT ri.recipe_id, i.id AS ingredient_id, i.name, COALESCE(ri.unit, i.default_unit) AS default_unit, i.is_perishable, ri.quantity
     FROM recipe_ingredients ri
     JOIN ingredients i ON ri.ingredient_id = i.id
     WHERE ri.recipe_id IN (${recipePlaceholders})`,
    recipeIds
  );

  const ingredientsByRecipeId = new Map();
  for (const row of ingredientsResult.rows) {
    if (!ingredientsByRecipeId.has(row.recipe_id)) ingredientsByRecipeId.set(row.recipe_id, []);
    ingredientsByRecipeId.get(row.recipe_id).push(row);
  }

  const checkedResult = await db.query('SELECT ingredient_id, recipe_id, plan_date FROM shopping_checked');
  const checkedSet = new Set(
    checkedResult.rows.map((r) => r.ingredient_id + ':' + r.recipe_id + ':' + r.plan_date)
  );

  const byIngredient = new Map();

  for (const planRow of planResult.rows) {
    const inPerishableWindow = perishableDateSet.has(planRow.plan_date);
    const inWeekWindow = weekDateSet.has(planRow.plan_date);
    const recipeIngredients = ingredientsByRecipeId.get(planRow.recipe_id) || [];
    const isRepeated = occurrenceCount.get(planRow.recipe_id) > 1;
    const dayName = DAYS[getDayIndex(parseDateKey(planRow.plan_date))];
    const displayName = isRepeated ? `${planRow.recipe_name} (${t('day.' + dayName)})` : planRow.recipe_name;

    for (const ing of recipeIngredients) {
      if (ing.is_perishable) {
        if (!inPerishableWindow) continue;
      } else if (!inWeekWindow) {
        continue;
      }

      if (!byIngredient.has(ing.ingredient_id)) {
        byIngredient.set(ing.ingredient_id, {
          ingredientId: ing.ingredient_id,
          name: ing.name,
          unit: ing.default_unit,
          isPerishable: ing.is_perishable,
          recipes: [],
        });
      }
      byIngredient.get(ing.ingredient_id).recipes.push({
        recipeId: planRow.recipe_id,
        planDate: planRow.plan_date,
        recipeName: displayName,
        quantity: ing.quantity,
        unit: ing.default_unit,
        bought: checkedSet.has(ing.ingredient_id + ':' + planRow.recipe_id + ':' + planRow.plan_date),
      });
    }
  }

  const allLines = Array.from(byIngredient.values())
    .map((line) => {
      line.recipes.sort((a, b) => a.planDate.localeCompare(b.planDate) || a.recipeName.localeCompare(b.recipeName));

      // A per-recipe unit override (see saveRecipeIngredients) means different
      // occurrences of the same ingredient can now be in different units. Summing
      // across units would silently produce a meaningless number, so only merge
      // quantities that share the line's most common unit into a single total;
      // if the occurrences don't all agree on a unit, skip the merged total
      // entirely rather than show a wrong one -- each occurrence still displays
      // its own correct quantity and unit below.
      const unitCounts = new Map();
      for (const r of line.recipes) unitCounts.set(r.unit, (unitCounts.get(r.unit) || 0) + 1);
      let primaryUnit = line.unit;
      let bestCount = -1;
      for (const [unit, count] of unitCounts) {
        if (count > bestCount) {
          bestCount = count;
          primaryUnit = unit;
        }
      }
      const hasMixedUnits = unitCounts.size > 1;
      const matchingQuantities = line.recipes.filter((r) => r.unit === primaryUnit).map((r) => r.quantity);

      return {
        ingredientId: line.ingredientId,
        name: line.name,
        unit: hasMixedUnits ? null : primaryUnit,
        isPerishable: line.isPerishable,
        quantity: hasMixedUnits ? null : sumQuantities(matchingQuantities),
        recipes: line.recipes,
        bought: line.recipes.every((r) => r.bought),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    upcomingDays,
    perishable: allLines.filter((l) => l.isPerishable),
    nonPerishable: allLines.filter((l) => !l.isPerishable),
  };
}

// Also used by routes/shoppingListPages.js.
async function setBoughtState(triples, bought) {
  if (triples.length === 0) return;

  await db.transaction(async (tx) => {
    for (const t of triples) {
      if (bought) {
        await tx.query(
          `INSERT INTO shopping_checked (ingredient_id, recipe_id, plan_date)
           VALUES (?, ?, ?)
           ON CONFLICT DO NOTHING`,
          [t.ingredientId, t.recipeId, t.planDate]
        );
      } else {
        await tx.query(
          `DELETE FROM shopping_checked
           WHERE ingredient_id = ? AND recipe_id = ? AND plan_date = ?`,
          [t.ingredientId, t.recipeId, t.planDate]
        );
      }
    }
  });
}

// --- JSON API for offline caching / sync (used by the Android build's local pages via
// public/shopping.js) ---

router.get('/api/shopping-list', asyncRoute(async (req, res) => {
  const weekMonday = getSelectedWeekMonday(req);
  const maxDays = getMaxDaysAhead(weekMonday);
  const daysAhead = clampDays(req.query.days, maxDays);
  const data = await computeShoppingList(daysAhead, weekMonday, res.locals.t);
  res.json({ daysAhead, maxDays, ...data });
}));

// Adds bought items queued while offline. Additive only, same as the checkbox routes.
router.post('/api/shopping-list/bought', asyncRoute(async (req, res) => {
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  const triples = items
    .filter((it) => it && it.ingredientId && it.recipeId && it.planDate)
    .map((it) => ({ ingredientId: it.ingredientId, recipeId: it.recipeId, planDate: it.planDate }));
  await setBoughtState(triples, true);
  if (triples.length > 0) broadcastChange(req.get('X-Client-Id'));
  res.json({ ok: true, count: triples.length });
}));

module.exports = router;
module.exports.getMaxDaysAhead = getMaxDaysAhead;
module.exports.clampDays = clampDays;
module.exports.computeShoppingList = computeShoppingList;
module.exports.setBoughtState = setBoughtState;
