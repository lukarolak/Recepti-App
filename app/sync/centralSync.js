// Phone-only: periodically syncs recipes/ingredients/plan/shopping-checked with the
// central docker-compose server's existing /api/* JSON endpoints (the same ones the
// browser's offline-sync UI already uses). Only wired up by server.js when
// DB_DRIVER=sqlite (see server.js) -- inert/unused on the central deployment itself.
//
// Recipes/ingredients support real bidirectional edit and delete:
//   - Conflicts are resolved by last-write-wins, comparing each row's updated_at (a
//     plain ISO 8601 UTC string set explicitly by server.js on every insert/update, on
//     both the pg and sqlite adapters) against a fresh snapshot fetched at the start of
//     each cycle, so both sides compare against the same central state.
//   - Deletes are terminal: whichever side deleted a row wins outright, regardless of
//     any concurrent edit's timestamp. A local delete of an already-linked row can't
//     push immediately (the local row is already gone by the time sync runs), so it's
//     recorded in pending_recipe_deletes/pending_ingredient_deletes and retried each
//     cycle until the central DELETE succeeds. A central delete is discovered via
//     GET /api/recipes|ingredients/deletions (tombstones -- see deleted_recipes/
//     deleted_ingredients in db/init.sql), which is how the phone tells "deleted
//     centrally" apart from "haven't pulled this one yet".
//
// The weekly plan and shopping-checked state keep the simpler models from v1 (full
// overwrite, additive-only) -- this file only adds real conflict handling for
// recipes/ingredients, which is what actually needed editing on the phone.
const db = require('../db');

async function getSetting(key) {
  const result = await db.query('SELECT value FROM app_settings WHERE key = ?', [key]);
  return result.rows.length > 0 ? result.rows[0].value : null;
}

async function setSetting(key, value) {
  await db.query(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

function getCentralUrl() {
  return getSetting('central_url');
}

function setCentralUrl(url) {
  return setSetting('central_url', (url || '').trim().replace(/\/+$/, ''));
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.json();
}

async function sendJson(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${url} failed: ${res.status}`);
  return res.json();
}

async function deleteJson(url) {
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) throw new Error(`DELETE ${url} failed: ${res.status}`);
  return res.json();
}

// Resolves an ingredient name to a local id, creating it if this is the first time
// it's been seen locally (e.g. only encountered so far as part of a pulled recipe).
async function upsertLocalIngredientIdByName(name, defaultUnit, isPerishable) {
  const existing = await db.query('SELECT id FROM ingredients WHERE lower(name) = lower(?)', [name]);
  if (existing.rows.length > 0) return existing.rows[0].id;
  const inserted = await db.query(
    'INSERT INTO ingredients (name, default_unit, is_perishable, updated_at) VALUES (?, ?, ?, ?) RETURNING id',
    [name, defaultUnit || null, isPerishable ? 1 : 0, new Date().toISOString()]
  );
  return inserted.rows[0].id;
}

async function applyCentralIngredientDeletions(centralUrl) {
  const central = await getJson(`${centralUrl}/api/ingredients/deletions`);
  for (const d of central.deletions) {
    await db.query('DELETE FROM ingredients WHERE central_id = ?', [d.id]);
    await db.query('DELETE FROM pending_ingredient_deletes WHERE central_id = ?', [d.id]);
  }
}

async function applyCentralRecipeDeletions(centralUrl) {
  const central = await getJson(`${centralUrl}/api/recipes/deletions`);
  for (const d of central.deletions) {
    await db.query('DELETE FROM recipes WHERE central_id = ?', [d.id]);
    await db.query('DELETE FROM pending_recipe_deletes WHERE central_id = ?', [d.id]);
  }
}

async function pushPendingIngredientDeletes(centralUrl) {
  const pending = await db.query('SELECT central_id FROM pending_ingredient_deletes');
  for (const row of pending.rows) {
    await deleteJson(`${centralUrl}/api/ingredients/${row.central_id}`);
    await db.query('DELETE FROM pending_ingredient_deletes WHERE central_id = ?', [row.central_id]);
  }
}

async function pushPendingRecipeDeletes(centralUrl) {
  const pending = await db.query('SELECT central_id FROM pending_recipe_deletes');
  for (const row of pending.rows) {
    await deleteJson(`${centralUrl}/api/recipes/${row.central_id}`);
    await db.query('DELETE FROM pending_recipe_deletes WHERE central_id = ?', [row.central_id]);
  }
}

async function syncIngredients(centralUrl) {
  // Deletes are terminal -- resolve both directions before touching edits, so a
  // deleted row never gets pointlessly re-pushed or re-pulled as an edit below.
  await applyCentralIngredientDeletions(centralUrl);
  await pushPendingIngredientDeletes(centralUrl);

  const central = await getJson(`${centralUrl}/api/ingredients`);
  const centralById = new Map(central.ingredients.map((i) => [i.id, i]));

  // New local ingredients never yet linked to a central row.
  const unlinked = await db.query(
    'SELECT id, name, default_unit, is_perishable FROM ingredients WHERE central_id IS NULL'
  );
  for (const ing of unlinked.rows) {
    const result = await sendJson(`${centralUrl}/api/ingredients`, 'POST', {
      name: ing.name,
      default_unit: ing.default_unit,
      is_perishable: !!ing.is_perishable,
    });
    if (result.id) {
      // POST is ON CONFLICT DO NOTHING by name, so this may have matched a
      // pre-existing central ingredient instead of creating a new one -- adopt its
      // real data now rather than leaving a name-collision permanently unresolved:
      // an identical local/central updated_at (see POST /api/ingredients) means the
      // last-write-wins comparison below would never revisit this row again.
      const centralMatch = (result.ingredients || []).find((c) => c.id === result.id);
      await db.query(
        'UPDATE ingredients SET central_id = ?, name = ?, default_unit = ?, is_perishable = ?, updated_at = ? WHERE id = ?',
        [
          result.id,
          centralMatch ? centralMatch.name : ing.name,
          centralMatch ? centralMatch.default_unit : ing.default_unit,
          centralMatch ? (centralMatch.is_perishable ? 1 : 0) : ing.is_perishable ? 1 : 0,
          result.updatedAt,
          ing.id,
        ]
      );
      centralById.delete(result.id);
    }
  }

  // Already-linked ingredients: last-write-wins against this cycle's central snapshot.
  const linked = await db.query(
    'SELECT id, central_id, default_unit, is_perishable, updated_at FROM ingredients WHERE central_id IS NOT NULL'
  );
  for (const ing of linked.rows) {
    const centralIng = centralById.get(ing.central_id);
    if (!centralIng) continue; // deleted centrally just now -- already handled above

    if (ing.updated_at > centralIng.updated_at) {
      const result = await sendJson(`${centralUrl}/api/ingredients/${ing.central_id}`, 'PUT', {
        default_unit: ing.default_unit,
        is_perishable: !!ing.is_perishable,
      });
      await db.query('UPDATE ingredients SET updated_at = ? WHERE id = ?', [result.updatedAt, ing.id]);
    } else if (centralIng.updated_at > ing.updated_at) {
      await db.query(
        'UPDATE ingredients SET name = ?, default_unit = ?, is_perishable = ?, updated_at = ? WHERE id = ?',
        [centralIng.name, centralIng.default_unit, centralIng.is_perishable ? 1 : 0, centralIng.updated_at, ing.id]
      );
    }
  }

  // Central ingredients with no local counterpart at all.
  const knownCentralIds = new Set(linked.rows.map((r) => r.central_id));
  for (const centralIng of centralById.values()) {
    if (knownCentralIds.has(centralIng.id)) continue;
    await db.query(
      `INSERT INTO ingredients (name, default_unit, is_perishable, central_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET
         central_id = excluded.central_id,
         default_unit = excluded.default_unit,
         is_perishable = excluded.is_perishable,
         updated_at = excluded.updated_at`,
      [centralIng.name, centralIng.default_unit, centralIng.is_perishable ? 1 : 0, centralIng.id, centralIng.updated_at]
    );
  }
}

async function recipeIngredientRows(recipeId) {
  const ingredientsResult = await db.query(
    `SELECT i.name, COALESCE(ri.unit, i.default_unit) AS unit, i.is_perishable, ri.quantity
     FROM recipe_ingredients ri
     JOIN ingredients i ON ri.ingredient_id = i.id
     WHERE ri.recipe_id = ?`,
    [recipeId]
  );
  return ingredientsResult.rows.map((r) => ({
    name: r.name,
    quantity: r.quantity,
    unit: r.unit,
    perishable: !!r.is_perishable,
  }));
}

// ing.default_unit is the recipe's effective (possibly overridden) unit -- what gets
// stored as this recipe's unit override locally. ing.ingredientDefaultUnit is the
// ingredient's real default_unit, only used to seed a brand-new local ingredient's own
// metadata correctly (a recipe-specific override must never leak into that).
async function applyPulledRecipeIngredients(localRecipeId, ingredients) {
  await db.query('DELETE FROM recipe_ingredients WHERE recipe_id = ?', [localRecipeId]);
  for (const ing of ingredients) {
    const localIngredientId = await upsertLocalIngredientIdByName(ing.name, ing.ingredientDefaultUnit, false);
    await db.query(
      'INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity, unit) VALUES (?, ?, ?, ?)',
      [localRecipeId, localIngredientId, ing.quantity, ing.default_unit || null]
    );
  }
}

async function syncRecipes(centralUrl) {
  await applyCentralRecipeDeletions(centralUrl);
  await pushPendingRecipeDeletes(centralUrl);

  const central = await getJson(`${centralUrl}/api/recipes`);
  const centralById = new Map(central.recipes.map((r) => [r.id, r]));

  const unlinked = await db.query('SELECT id, name, instructions FROM recipes WHERE central_id IS NULL');
  for (const recipe of unlinked.rows) {
    const rows = await recipeIngredientRows(recipe.id);
    const result = await sendJson(`${centralUrl}/api/recipes`, 'POST', {
      name: recipe.name,
      instructions: recipe.instructions,
      rows,
    });
    if (result.id) {
      await db.query('UPDATE recipes SET central_id = ?, updated_at = ? WHERE id = ?', [
        result.id,
        result.updatedAt,
        recipe.id,
      ]);
      centralById.delete(result.id);
    }
  }

  const linked = await db.query(
    'SELECT id, central_id, name, instructions, updated_at FROM recipes WHERE central_id IS NOT NULL'
  );
  for (const recipe of linked.rows) {
    const centralRecipe = centralById.get(recipe.central_id);
    if (!centralRecipe) continue;

    if (recipe.updated_at > centralRecipe.updated_at) {
      const rows = await recipeIngredientRows(recipe.id);
      const result = await sendJson(`${centralUrl}/api/recipes/${recipe.central_id}`, 'PUT', {
        name: recipe.name,
        instructions: recipe.instructions,
        rows,
      });
      await db.query('UPDATE recipes SET updated_at = ? WHERE id = ?', [result.updatedAt, recipe.id]);
    } else if (centralRecipe.updated_at > recipe.updated_at) {
      await db.query('UPDATE recipes SET name = ?, instructions = ?, updated_at = ? WHERE id = ?', [
        centralRecipe.name,
        centralRecipe.instructions,
        centralRecipe.updated_at,
        recipe.id,
      ]);
      await applyPulledRecipeIngredients(recipe.id, centralRecipe.ingredients);
    }
  }

  const knownCentralIds = new Set(linked.rows.map((r) => r.central_id));
  for (const centralRecipe of centralById.values()) {
    if (knownCentralIds.has(centralRecipe.id)) continue;
    const inserted = await db.query(
      'INSERT INTO recipes (name, instructions, central_id, updated_at) VALUES (?, ?, ?, ?) RETURNING id',
      [centralRecipe.name, centralRecipe.instructions, centralRecipe.id, centralRecipe.updated_at]
    );
    await applyPulledRecipeIngredients(inserted.rows[0].id, centralRecipe.ingredients);
  }
}

// How far ahead the phone keeps its plan in sync with central: today through ~12
// weeks out. Meal plans are a sparse, unbounded-into-the-future table now (see
// db/init.sqlite.sql), so "sync everything" isn't practical -- this generalizes the
// old fixed 7-day-template full-overwrite model to a wider (but still bounded) window,
// rather than adding per-row conflict resolution the rest of this sync deliberately
// doesn't have either (see the file-level comment above).
const PLAN_SYNC_DAYS = 84;

function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function getMondayOf(date) {
  const dayIndex = (date.getDay() + 6) % 7; // Mon=0..Sun=6
  return addDays(date, -dayIndex);
}

async function syncPlan(centralUrl) {
  // Starts from this week's Monday (not just "today") so an earlier-in-the-week edit
  // (e.g. it's Wednesday and you fixed Monday's plan) still syncs, not just the
  // forward-looking horizon.
  const weekStart = getMondayOf(new Date());
  const startDate = toDateKey(weekStart);
  const dates = [];
  for (let i = 0; i < PLAN_SYNC_DAYS; i++) dates.push(toDateKey(addDays(weekStart, i)));

  const localPlan = await db.query(
    `SELECT mp.plan_date, r.central_id AS central_recipe_id
     FROM meal_plan mp
     JOIN recipes r ON mp.recipe_id = r.id
     WHERE mp.plan_date >= ?
     ORDER BY mp.plan_date, mp.id`,
    [startDate]
  );
  const localCentralIdsByDate = new Map();
  for (const row of localPlan.rows) {
    if (!row.central_recipe_id) continue; // not linked centrally yet -- catches up once it syncs
    if (!localCentralIdsByDate.has(row.plan_date)) localCentralIdsByDate.set(row.plan_date, []);
    localCentralIdsByDate.get(row.plan_date).push(row.central_recipe_id);
  }

  // Pulled first (before pushing) and unioned with what's known locally, so a device
  // that hasn't seen a date's plan yet -- e.g. right after a collaboration address is
  // first entered, when the local meal_plan table is still empty -- doesn't blank out
  // that date on central the moment it pushes below. Without this, the phone's empty
  // local window would overwrite whatever was already collaboratively planned.
  const central = await getJson(`${centralUrl}/api/plan?start=${startDate}&days=${PLAN_SYNC_DAYS}`);

  // A date whose local recipe(s) haven't linked centrally yet (central_id still NULL)
  // can't be fully expressed to central at all this cycle -- those entries push as
  // unplanned and catch up once that recipe itself syncs (recipes/ingredients sync
  // first each cycle, see runSyncCycle, so this is usually just one cycle's delay).
  const plan = {};
  for (const date of dates) {
    const centralIds = (central.planByDate[date] || []).map((entry) => entry.recipe_id);
    const localIds = localCentralIdsByDate.get(date) || [];
    plan[date] = [...new Set([...centralIds, ...localIds])];
  }
  await sendJson(`${centralUrl}/api/plan`, 'PUT', { start: startDate, days: PLAN_SYNC_DAYS, plan });

  for (const date of dates) {
    await db.query('DELETE FROM meal_plan WHERE plan_date = ?', [date]);
    for (const centralRecipeId of plan[date]) {
      const localRecipe = await db.query('SELECT id FROM recipes WHERE central_id = ?', [centralRecipeId]);
      if (localRecipe.rows.length === 0) continue; // not linked locally yet -- catch up next cycle
      await db.query('INSERT INTO meal_plan (plan_date, recipe_id) VALUES (?, ?)', [date, localRecipe.rows[0].id]);
    }
  }
}

async function pushShoppingChecked(centralUrl) {
  const checked = await db.query(
    `SELECT i.central_id AS ingredient_central_id, r.central_id AS recipe_central_id, sc.plan_date
     FROM shopping_checked sc
     JOIN ingredients i ON sc.ingredient_id = i.id
     JOIN recipes r ON sc.recipe_id = r.id
     WHERE i.central_id IS NOT NULL AND r.central_id IS NOT NULL`
  );
  const items = checked.rows.map((r) => ({
    ingredientId: r.ingredient_central_id,
    recipeId: r.recipe_central_id,
    planDate: r.plan_date,
  }));
  if (items.length > 0) {
    await sendJson(`${centralUrl}/api/shopping-list/bought`, 'POST', { items });
  }
}

async function pullShoppingChecked(centralUrl) {
  const central = await getJson(`${centralUrl}/api/shopping-list`);
  const lines = [...(central.perishable || []), ...(central.nonPerishable || [])];
  for (const line of lines) {
    for (const r of line.recipes) {
      if (!r.bought) continue;
      const localIngredient = await db.query('SELECT id FROM ingredients WHERE central_id = ?', [line.ingredientId]);
      const localRecipe = await db.query('SELECT id FROM recipes WHERE central_id = ?', [r.recipeId]);
      if (localIngredient.rows.length === 0 || localRecipe.rows.length === 0) continue;
      await db.query(
        'INSERT INTO shopping_checked (ingredient_id, recipe_id, plan_date) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        [localIngredient.rows[0].id, localRecipe.rows[0].id, r.planDate]
      );
    }
  }
}

let status = { state: 'never', label: 'Not yet synced', lastSyncAt: null, lastError: null };
let syncing = false;

async function runSyncCycle() {
  if (syncing) return status;
  syncing = true;
  try {
    const centralUrl = await getCentralUrl();
    if (!centralUrl) {
      status = { state: 'unconfigured', label: 'No collaboration address configured', lastSyncAt: status.lastSyncAt, lastError: null };
      return status;
    }

    try {
      const pingRes = await fetch(`${centralUrl}/api/ping`, { signal: AbortSignal.timeout(3000) });
      if (!pingRes.ok) throw new Error('ping failed: ' + pingRes.status);
    } catch (err) {
      console.log(`[sync] ${centralUrl} unreachable, will retry next cycle`);
      status = { state: 'offline', label: 'Collaboration address unreachable', lastSyncAt: status.lastSyncAt, lastError: null };
      return status;
    }

    console.log(`[sync] starting cycle against ${centralUrl}`);

    await syncIngredients(centralUrl);
    await syncRecipes(centralUrl);
    await syncPlan(centralUrl);
    await pushShoppingChecked(centralUrl);
    await pullShoppingChecked(centralUrl);

    console.log('[sync] cycle complete');
    status = { state: 'synced', label: 'Synced', lastSyncAt: new Date().toISOString(), lastError: null };
  } catch (err) {
    console.log('[sync] cycle failed: ' + err.message);
    status = { state: 'error', label: 'Sync error: ' + err.message, lastSyncAt: status.lastSyncAt, lastError: String(err) };
  } finally {
    syncing = false;
  }
  return status;
}

function getStatus() {
  return status;
}

let intervalHandle = null;
function startPeriodicSync(intervalMs) {
  if (intervalHandle) return;
  runSyncCycle().catch(() => {});
  intervalHandle = setInterval(() => {
    runSyncCycle().catch(() => {});
  }, intervalMs || 30000);
}

module.exports = { getCentralUrl, setCentralUrl, getStatus, runSyncCycle, startPeriodicSync };
