// Ingredients page: adding a new ingredient works offline (queued + applied
// optimistically) and gets pushed to the server as soon as it's reachable.
// Editing/deleting existing ingredients still requires a connection.
(function () {
  function getPending() {
    return window.SyncEngine.getCache('pendingIngredients') || [];
  }

  function setPending(list) {
    window.SyncEngine.setCache('pendingIngredients', list);
  }

  function renderPendingIngredient(ingredient) {
    const tbody = document.querySelector('.ingredients-table tbody');
    if (!tbody) return;

    const emptyMsg = document.querySelector('.empty');
    if (emptyMsg) emptyMsg.hidden = true;

    const tr = document.createElement('tr');
    tr.className = 'pending-ingredient';

    const nameTd = document.createElement('td');
    nameTd.textContent = ingredient.name + ' ';
    const mark = document.createElement('span');
    mark.className = 'pending-sync-mark';
    mark.textContent = window.t('ingredients.pendingSync');
    nameTd.appendChild(mark);
    tr.appendChild(nameTd);

    const unitTd = document.createElement('td');
    unitTd.textContent = ingredient.default_unit || '—';
    tr.appendChild(unitTd);

    const perishableTd = document.createElement('td');
    perishableTd.className = 'center';
    perishableTd.textContent = ingredient.is_perishable ? window.t('ingredients.yes') : '';
    tr.appendChild(perishableTd);

    tr.appendChild(document.createElement('td'));

    tbody.appendChild(tr);
  }

  async function syncIngredients() {
    let pending = getPending();
    if (pending.length === 0) return;

    while (pending.length > 0) {
      const ingredient = pending[0];
      const res = await fetch('/api/ingredients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Id': window.SyncEngine.clientId },
        body: JSON.stringify({
          name: ingredient.name,
          default_unit: ingredient.default_unit,
          is_perishable: ingredient.is_perishable,
        }),
      });
      if (!res.ok) throw new Error('ingredient sync failed');

      pending = pending.slice(1);
      setPending(pending);
    }

    location.reload();
  }

  function attachFormHandler() {
    const form = document.querySelector('form.add-form[action="/ingredients"]');
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
        const ingredient = {
          name,
          default_unit: formData.get('default_unit') || '',
          is_perishable: formData.get('is_perishable') === 'on',
        };

        const pending = getPending();
        pending.push(ingredient);
        setPending(pending);
        window.SyncEngine.markDirty('ingredients');

        renderPendingIngredient(ingredient);
        form.reset();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    attachFormHandler();
    window.SyncEngine.registerHandler('ingredients', syncIngredients);
    window.SyncEngine.onRemoteChange(() => {
      if (!window.SyncEngine.isDirty('ingredients')) location.reload();
    });

    // re-apply anything queued from an earlier offline session, in case this
    // is a fresh page load (e.g. served from the service worker cache)
    getPending().forEach(renderPendingIngredient);
  });
})();
