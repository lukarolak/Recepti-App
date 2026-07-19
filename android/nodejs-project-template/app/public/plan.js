// Weekly Plan page: edits work offline (queued + applied optimistically), and get
// pushed as a full overwrite of the selected week once the server is reachable again.
// The cache is scoped per week (see weekMonday/cacheKey below) so switching weeks via
// the navigator never mixes up a pending edit from one week with another.
//
// Each day can now have more than one recipe (duplicates allowed). Adding/removing a
// single entry POSTs immediately when online for low latency; if that fails (or the
// device is offline), the edit stays applied locally and the row is marked pending --
// the periodic full-overwrite sync (syncPlan, driven by SyncEngine) reconciles it later
// by PUTting the whole cached week, so no per-entry offline queue is needed.
(function () {
  const weekMonday = document.getElementById('plan-table').dataset.weekMonday;
  const cacheKey = 'plan:' + weekMonday;

  function buildPlanCacheFromDom() {
    const dayEls = document.querySelectorAll('#plan-table .plan-day[data-date]');
    const planByDate = {};
    let recipes = [];

    dayEls.forEach((dayEl) => {
      const date = dayEl.dataset.date;
      planByDate[date] = Array.from(dayEl.querySelectorAll('.plan-recipe-list li[data-entry-id]')).map((li) => ({
        id: li.dataset.entryId,
        recipe_id: parseInt(li.dataset.recipeId, 10),
        recipe_name: li.querySelector('.plan-recipe-name').textContent.trim(),
      }));

      if (recipes.length === 0) {
        const select = dayEl.querySelector('.plan-add-form select[name="recipe_id"]');
        recipes = Array.from(select.options)
          .filter((o) => o.value)
          .map((o) => ({ id: parseInt(o.value, 10), name: o.textContent.trim() }));
      }
    });

    return { planByDate, recipes };
  }

  function makeEntryLi(entry) {
    const li = document.createElement('li');
    li.dataset.entryId = String(entry.id);
    li.dataset.recipeId = String(entry.recipe_id);

    const name = document.createElement('span');
    name.className = 'plan-recipe-name';
    name.textContent = entry.recipe_name;
    li.appendChild(name);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-entry-btn';
    removeBtn.title = window.t('plan.remove');
    removeBtn.setAttribute('aria-label', window.t('plan.remove'));
    removeBtn.textContent = '×';
    li.appendChild(removeBtn);

    return li;
  }

  function renderRecipeList(dayEl, entries) {
    const container = dayEl.querySelector('.recipe-display');
    const list = container.querySelector('.plan-recipe-list');
    list.textContent = '';

    let emptySpan = container.querySelector('.empty');
    if (entries.length === 0) {
      if (!emptySpan) {
        emptySpan = document.createElement('span');
        emptySpan.className = 'empty';
        emptySpan.textContent = window.t('plan.nothingPlanned');
        container.insertBefore(emptySpan, list);
      }
    } else if (emptySpan) {
      emptySpan.remove();
    }

    entries.forEach((entry) => list.appendChild(makeEntryLi(entry)));
  }

  function applyCacheToDom(cache) {
    if (!cache) return;
    document.querySelectorAll('#plan-table .plan-day[data-date]').forEach((dayEl) => {
      const date = dayEl.dataset.date;
      renderRecipeList(dayEl, cache.planByDate[date] || []);
    });
  }

  function setRowPending(dayEl, pending) {
    const badge = dayEl.querySelector('.row-sync-badge');
    if (badge) badge.hidden = !pending;
  }

  async function syncPlan() {
    // getCache() has been observed to intermittently return null moments after a
    // setCache() call on the very same key (a WebView localStorage read/write timing
    // quirk on the Android build) -- falling back to the DOM instead of trusting it's
    // always non-null keeps this from silently no-op'ing (which left the dirty flag
    // cleared and the "pending sync" badge stuck forever with nothing left to retry).
    const cache = window.SyncEngine.getCache(cacheKey) || buildPlanCacheFromDom();

    const plan = {};
    Object.keys(cache.planByDate).forEach((date) => {
      plan[date] = cache.planByDate[date].map((entry) => entry.recipe_id);
    });

    const res = await fetch('/api/plan', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': window.SyncEngine.clientId },
      body: JSON.stringify({ start: weekMonday, days: 7, plan }),
    });
    if (!res.ok) throw new Error('plan sync failed');

    const fresh = await res.json();
    window.SyncEngine.setCache(cacheKey, { planByDate: fresh.planByDate, recipes: cache.recipes });
    applyCacheToDom(window.SyncEngine.getCache(cacheKey));
    document.querySelectorAll('.row-sync-badge').forEach((b) => { b.hidden = true; });
  }

  function attachAddHandler() {
    document.querySelectorAll('.plan-add-form').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const dayEl = form.closest('.plan-day');
        const date = form.dataset.date;
        const select = form.querySelector('select[name="recipe_id"]');
        const selectedOption = select.options[select.selectedIndex];
        if (!selectedOption.value) return;

        const recipeId = parseInt(selectedOption.value, 10);
        const recipeName = selectedOption.textContent.trim();
        const tempEntry = { id: 'local-' + Math.random().toString(36).slice(2), recipe_id: recipeId, recipe_name: recipeName };

        const cache = window.SyncEngine.getCache(cacheKey) || buildPlanCacheFromDom();
        cache.planByDate[date] = (cache.planByDate[date] || []).concat([tempEntry]);
        window.SyncEngine.setCache(cacheKey, cache);
        renderRecipeList(dayEl, cache.planByDate[date]);
        select.value = '';

        try {
          const body = new URLSearchParams({ date, recipe_id: String(recipeId) });
          const res = await fetch('/plan/add', {
            method: 'POST',
            headers: { 'X-Client-Id': window.SyncEngine.clientId },
            body,
          });
          if (!res.ok) throw new Error('bad status');
          const data = await res.json();

          // See syncPlan()'s comment -- getCache() can return null here even though
          // this same handler just set it, so never trust it's non-null.
          const latestCache = window.SyncEngine.getCache(cacheKey) || buildPlanCacheFromDom();
          latestCache.planByDate[date] = data.entries;
          window.SyncEngine.setCache(cacheKey, latestCache);
          renderRecipeList(dayEl, data.entries);
          setRowPending(dayEl, false);
        } catch (err) {
          console.error('[plan] add failed', err);
          window.SyncEngine.markDirty('plan');
          setRowPending(dayEl, true);
        }
      });
    });
  }

  function attachRemoveHandler() {
    document.getElementById('plan-table').addEventListener('click', async (e) => {
      const btn = e.target.closest('.remove-entry-btn');
      if (!btn) return;

      const li = btn.closest('li');
      const dayEl = btn.closest('.plan-day');
      const date = dayEl.dataset.date;
      const entryId = li.dataset.entryId;

      const cache = window.SyncEngine.getCache(cacheKey) || buildPlanCacheFromDom();
      cache.planByDate[date] = (cache.planByDate[date] || []).filter((entry) => String(entry.id) !== String(entryId));
      window.SyncEngine.setCache(cacheKey, cache);
      renderRecipeList(dayEl, cache.planByDate[date]);

      if (String(entryId).startsWith('local-')) return; // never reached the server, nothing to undo remotely

      try {
        const res = await fetch('/plan/' + encodeURIComponent(entryId) + '/remove', {
          method: 'POST',
          headers: { 'X-Client-Id': window.SyncEngine.clientId },
        });
        if (!res.ok) throw new Error('bad status');
        const data = await res.json();

        // See syncPlan()'s comment -- getCache() can return null here even though
        // this same handler just set it, so never trust it's non-null.
        const latestCache = window.SyncEngine.getCache(cacheKey) || buildPlanCacheFromDom();
        latestCache.planByDate[date] = data.entries;
        window.SyncEngine.setCache(cacheKey, latestCache);
        renderRecipeList(dayEl, data.entries);
        setRowPending(dayEl, false);
      } catch (err) {
        console.error('[plan] remove failed', err);
        window.SyncEngine.markDirty('plan');
        setRowPending(dayEl, true);
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (window.SyncEngine.isDirty('plan')) {
      applyCacheToDom(window.SyncEngine.getCache(cacheKey));
      document.querySelectorAll('#plan-table .plan-day[data-date]').forEach((dayEl) => setRowPending(dayEl, true));
    } else {
      window.SyncEngine.setCache(cacheKey, buildPlanCacheFromDom());
      fetch('/api/plan?start=' + encodeURIComponent(weekMonday) + '&days=7')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data) window.SyncEngine.setCache(cacheKey, { planByDate: data.planByDate, recipes: buildPlanCacheFromDom().recipes });
        })
        .catch(() => {});
    }

    attachAddHandler();
    attachRemoveHandler();
    window.SyncEngine.registerHandler('plan', syncPlan);
    window.SyncEngine.onRemoteChange(() => {
      if (!window.SyncEngine.isDirty('plan')) location.reload();
    });
  });
})();
