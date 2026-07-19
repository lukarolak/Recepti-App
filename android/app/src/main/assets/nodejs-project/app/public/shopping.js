// Shopping List page: checking an item off works offline (queued + applied
// optimistically) and gets pushed to the server as soon as it's reachable.
// Only "bought" additions are synced back, matching the offline spec —
// unchecking something offline just updates the local view.
(function () {
  function keyOf(t) {
    return t.ingredientId + ':' + t.recipeId + ':' + t.planDate;
  }

  function getPending() {
    return window.SyncEngine.getCache('pendingBought') || [];
  }

  function setPending(list) {
    window.SyncEngine.setCache('pendingBought', list);
  }

  function addPending(triples) {
    const pending = getPending();
    const seen = new Set(pending.map(keyOf));
    triples.forEach((t) => {
      if (!seen.has(keyOf(t))) {
        pending.push(t);
        seen.add(keyOf(t));
      }
    });
    setPending(pending);
    window.SyncEngine.markDirty('shopping');
  }

  function removePending(triples) {
    const removeKeys = new Set(triples.map(keyOf));
    const pending = getPending().filter((t) => !removeKeys.has(keyOf(t)));
    setPending(pending);
    if (pending.length === 0) window.SyncEngine.clearDirty('shopping');
  }

  function markPendingUI(recipeLi) {
    if (recipeLi.querySelector('.pending-sync-mark')) return;
    const mark = document.createElement('span');
    mark.className = 'pending-sync-mark';
    mark.textContent = window.t('shoppingList.pendingSync');
    recipeLi.querySelector('label').appendChild(mark);
  }

  async function syncShopping() {
    const pending = getPending();
    if (pending.length === 0) return;

    const res = await fetch('/api/shopping-list/bought', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': window.SyncEngine.clientId },
      body: JSON.stringify({ items: pending }),
    });
    if (!res.ok) throw new Error('shopping sync failed');

    setPending([]);
    document.querySelectorAll('.pending-sync-mark').forEach((el) => el.remove());
  }

  function updateIngredientRowBoughtState(itemLi) {
    const allChecked = Array.from(itemLi.querySelectorAll('.item-recipes input[type="checkbox"]'))
      .every((cb) => cb.checked);
    itemLi.classList.toggle('bought', allChecked);
    const masterCheckbox = itemLi.querySelector('.item-check');
    if (masterCheckbox) masterCheckbox.checked = allChecked;
  }

  function attachRecipeCheckboxHandlers() {
    document.querySelectorAll('.item-recipes li[data-recipe-id]').forEach((li) => {
      const checkbox = li.querySelector('input[type="checkbox"]');
      const form = checkbox.closest('form');
      const itemLi = li.closest('li[data-ingredient-id]');
      const ingredientId = parseInt(itemLi.dataset.ingredientId, 10);
      const recipeId = parseInt(li.dataset.recipeId, 10);
      const planDate = li.dataset.planDate;

      checkbox.addEventListener('change', async () => {
        const checked = checkbox.checked;
        const labelSpan = li.querySelector('label span');
        labelSpan.classList.toggle('recipe-bought', checked);
        updateIngredientRowBoughtState(itemLi);

        try {
          const body = new URLSearchParams(new FormData(form));
          const res = await fetch(form.action, {
            method: 'POST',
            headers: { 'X-Client-Id': window.SyncEngine.clientId },
            body,
          });
          if (!res.ok) throw new Error('bad status');
        } catch (err) {
          const triple = { ingredientId, recipeId, planDate };
          if (checked) {
            addPending([triple]);
            markPendingUI(li);
          } else {
            removePending([triple]);
          }
        }
      });
    });
  }

  function attachMasterCheckboxHandlers() {
    document.querySelectorAll('li[data-ingredient-id] > .item-main .item-check').forEach((checkbox) => {
      const form = checkbox.closest('form');
      const itemLi = checkbox.closest('li[data-ingredient-id]');
      const ingredientId = parseInt(itemLi.dataset.ingredientId, 10);

      checkbox.addEventListener('change', async () => {
        const checked = checkbox.checked;
        const recipeLis = Array.from(itemLi.querySelectorAll('.item-recipes li[data-recipe-id]'));
        recipeLis.forEach((li) => {
          const cb = li.querySelector('input[type="checkbox"]');
          cb.checked = checked;
          li.querySelector('label span').classList.toggle('recipe-bought', checked);
        });
        itemLi.classList.toggle('bought', checked);

        try {
          const body = new URLSearchParams(new FormData(form));
          const res = await fetch(form.action, {
            method: 'POST',
            headers: { 'X-Client-Id': window.SyncEngine.clientId },
            body,
          });
          if (!res.ok) throw new Error('bad status');
        } catch (err) {
          const triples = recipeLis.map((li) => ({
            ingredientId,
            recipeId: parseInt(li.dataset.recipeId, 10),
            planDate: li.dataset.planDate,
          }));
          if (checked) {
            addPending(triples);
            recipeLis.forEach(markPendingUI);
          } else {
            removePending(triples);
          }
        }
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    attachRecipeCheckboxHandlers();
    attachMasterCheckboxHandlers();
    window.SyncEngine.registerHandler('shopping', syncShopping);
    window.SyncEngine.onRemoteChange(() => {
      if (!window.SyncEngine.isDirty('shopping')) location.reload();
    });

    // re-apply anything queued from an earlier offline session, in case this
    // is a fresh page load (e.g. served from the service worker cache)
    const pending = getPending();
    if (pending.length > 0) {
      window.SyncEngine.markDirty('shopping');
      pending.forEach((t) => {
        const li = document.querySelector(
          'li[data-ingredient-id="' + t.ingredientId + '"] .item-recipes li[data-recipe-id="' + t.recipeId + '"][data-plan-date="' + t.planDate + '"]'
        );
        if (!li) return;
        const cb = li.querySelector('input[type="checkbox"]');
        if (cb) cb.checked = true;
        li.querySelector('label span').classList.add('recipe-bought');
        markPendingUI(li);
        updateIngredientRowBoughtState(li.closest('li[data-ingredient-id]'));
      });
    }
  });
})();
