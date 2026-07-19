// Recipes page: adding a new recipe works offline (queued + applied
// optimistically) and gets pushed to the server as soon as it's reachable.
// Editing/deleting existing recipes still requires a connection.
(function () {
  function getPending() {
    return window.SyncEngine.getCache('pendingRecipes') || [];
  }

  function setPending(list) {
    window.SyncEngine.setCache('pendingRecipes', list);
  }

  function renderPendingRecipe(recipe) {
    const container = document.querySelector('.recipes');
    if (!container) return;

    const details = document.createElement('details');
    details.className = 'recipe pending-recipe';
    details.open = true;

    const summary = document.createElement('summary');
    summary.textContent = recipe.name;
    details.appendChild(summary);

    const badge = document.createElement('p');
    badge.className = 'pending-sync-mark';
    badge.textContent = window.t('recipes.pendingSync');
    details.appendChild(badge);

    const ingredientsLabel = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = window.t('recipes.ingredientsLabel');
    ingredientsLabel.appendChild(strong);
    details.appendChild(ingredientsLabel);

    if (recipe.rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = window.t('recipes.noIngredientsListed');
      details.appendChild(empty);
    } else {
      const ul = document.createElement('ul');
      ul.className = 'ingredient-list';
      recipe.rows.forEach((row) => {
        const li = document.createElement('li');
        li.textContent = [row.quantity, row.unit].filter(Boolean).join(' ') + ' ' + row.name;
        ul.appendChild(li);
      });
      details.appendChild(ul);
    }

    const instructionsP = document.createElement('p');
    const instructionsStrong = document.createElement('strong');
    instructionsStrong.textContent = window.t('recipes.instructionsLabel');
    instructionsP.appendChild(instructionsStrong);
    instructionsP.appendChild(document.createElement('br'));
    instructionsP.appendChild(document.createTextNode(recipe.instructions || ''));
    details.appendChild(instructionsP);

    container.appendChild(details);
  }

  function readRowsFromFormData(formData) {
    const rowIndices = new Set();
    for (const key of formData.keys()) {
      const m = key.match(/^rows\[(\d+)\]/);
      if (m) rowIndices.add(m[1]);
    }

    const rows = [];
    rowIndices.forEach((i) => {
      const name = (formData.get(`rows[${i}][name]`) || '').trim();
      if (!name) return;
      rows.push({
        name,
        quantity: (formData.get(`rows[${i}][quantity]`) || '').trim(),
        unit: formData.get(`rows[${i}][unit]`) || '',
        perishable: formData.get(`rows[${i}][perishable]`) === 'on',
      });
    });
    return rows;
  }

  async function syncRecipes() {
    let pending = getPending();
    if (pending.length === 0) return;

    while (pending.length > 0) {
      const recipe = pending[0];
      const res = await fetch('/api/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Id': window.SyncEngine.clientId },
        body: JSON.stringify({ name: recipe.name, instructions: recipe.instructions, rows: recipe.rows }),
      });
      if (!res.ok) throw new Error('recipe sync failed');

      pending = pending.slice(1);
      setPending(pending);
    }

    location.reload();
  }

  function attachFormHandler() {
    const form = document.querySelector('form.add-form[action="/recipes"]');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      const formData = new FormData(form);
      const name = (formData.get('name') || '').trim();
      if (!name) return; // let native required-field validation handle this

      e.preventDefault();

      try {
        const res = await fetch(form.action, {
          method: 'POST',
          headers: { 'X-Client-Id': window.SyncEngine.clientId },
          body: new URLSearchParams(formData),
        });
        if (!res.ok) throw new Error('bad status');
        location.reload();
      } catch (err) {
        const recipe = {
          name,
          instructions: formData.get('instructions') || '',
          rows: readRowsFromFormData(formData),
        };

        const pending = getPending();
        pending.push(recipe);
        setPending(pending);
        window.SyncEngine.markDirty('recipes');

        renderPendingRecipe(recipe);
        form.reset();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    attachFormHandler();
    window.SyncEngine.registerHandler('recipes', syncRecipes);
    window.SyncEngine.onRemoteChange(() => {
      if (!window.SyncEngine.isDirty('recipes')) location.reload();
    });

    // re-apply anything queued from an earlier offline session, in case this
    // is a fresh page load (e.g. served from the service worker cache)
    getPending().forEach(renderPendingRecipe);
  });
})();
