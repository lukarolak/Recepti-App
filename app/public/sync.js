// Global sync engine: shows connectivity/sync status, pings the server to
// verify real connectivity (navigator.onLine alone is unreliable), and runs
// page-registered handlers to push locally-queued offline changes.
(function () {
  const PING_INTERVAL_MS = 20000;
  const handlers = {}; // kind -> async function, called when dirty
  let remoteChangeHandler = null;

  const clientId = window.crypto && window.crypto.randomUUID
    ? window.crypto.randomUUID()
    : 'c' + Date.now() + Math.random().toString(16).slice(2);

  const statusEl = document.getElementById('sync-status');
  const labelEl = statusEl ? statusEl.querySelector('.sync-label') : null;

  function isDirty(kind) {
    return localStorage.getItem('sync:dirty:' + kind) === 'true';
  }

  function markDirty(kind) {
    localStorage.setItem('sync:dirty:' + kind, 'true');
    updateIndicatorFromState();
  }

  function clearDirty(kind) {
    localStorage.removeItem('sync:dirty:' + kind);
    updateIndicatorFromState();
  }

  function anyDirty() {
    return Object.keys(handlers).some(isDirty);
  }

  function getCache(key) {
    const raw = localStorage.getItem('sync:cache:' + key);
    return raw ? JSON.parse(raw) : null;
  }

  function setCache(key, value) {
    localStorage.setItem('sync:cache:' + key, JSON.stringify(value));
  }

  function setStatus(state, detail) {
    if (!statusEl) return;
    statusEl.dataset.state = state;
    const labels = {
      synced: window.t('syncBrowser.synced'),
      syncing: window.t('syncBrowser.syncing'),
      offline: anyDirty() ? window.t('syncBrowser.offlinePending') : window.t('syncBrowser.offline'),
    };
    const text = detail || labels[state] || state;
    if (labelEl) labelEl.textContent = text;
    statusEl.title = text;
  }

  function updateIndicatorFromState() {
    if (!statusEl) return;
    // Don't clobber an in-flight "syncing" state just because a handler marked dirty.
    if (statusEl.dataset.state === 'syncing') return;
    if (!navigator.onLine) {
      setStatus('offline');
    } else if (anyDirty()) {
      // Online but not yet confirmed synced this session; a ping/attempt will resolve it.
      setStatus('offline');
    } else {
      setStatus('synced');
    }
  }

  async function ping() {
    try {
      const res = await fetch('/api/ping', { cache: 'no-store' });
      return res.ok;
    } catch (err) {
      return false;
    }
  }

  let syncing = false;

  async function attemptSync() {
    if (syncing) return;
    syncing = true;
    try {
      const reachable = await ping();
      if (!reachable) {
        setStatus('offline');
        return;
      }

      const dirtyKinds = Object.keys(handlers).filter(isDirty);
      if (dirtyKinds.length === 0) {
        setStatus('synced');
        return;
      }

      setStatus('syncing');
      for (const kind of dirtyKinds) {
        try {
          await handlers[kind]();
          clearDirty(kind);
        } catch (err) {
          console.error('[sync] handler failed for', kind, err);
          // leave marked dirty, will retry on next attempt
        }
      }

      setStatus(anyDirty() ? 'offline' : 'synced');
    } finally {
      syncing = false;
    }
  }

  function showUpdateBanner() {
    if (document.getElementById('live-update-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'live-update-banner';
    banner.className = 'live-update-banner';

    const text = document.createElement('span');
    text.textContent = window.t('syncBrowser.updatedElsewhere');
    banner.appendChild(text);

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = window.t('syncBrowser.refresh');
    button.addEventListener('click', () => location.reload());
    banner.appendChild(button);

    document.body.prepend(banner);
  }

  // Other tabs/devices connect over SSE; any successful write anywhere pings
  // everyone else so views stay live without polling. Pages that register a
  // handler via onRemoteChange decide their own reaction (e.g. auto-reload
  // when safe); pages that don't just get a manual "refresh" banner, since
  // silently reloading a page mid-edit (e.g. the Add Recipe form) would lose
  // whatever the user was typing.
  let liveUpdatesSource = null;

  function connectLiveUpdates() {
    if (!('EventSource' in window) || liveUpdatesSource) return;
    const es = new EventSource('/api/events?clientId=' + encodeURIComponent(clientId));
    es.addEventListener('data-changed', () => {
      if (remoteChangeHandler) {
        remoteChangeHandler();
      } else {
        showUpdateBanner();
      }
    });
    liveUpdatesSource = es;
  }

  function disconnectLiveUpdates() {
    if (liveUpdatesSource) {
      liveUpdatesSource.close();
      liveUpdatesSource = null;
    }
  }

  // Every full-page navigation calls connectLiveUpdates() again, opening a fresh
  // EventSource. Browsers don't reliably tear down the previous page's connection
  // right away — most notably when the old page is frozen into the back/forward
  // cache instead of unloaded — so without an explicit close here, connections pile
  // up across navigations. This app is plain HTTP/1.1, which caps concurrent
  // connections per origin at 6, so enough leaked SSE connections eventually stall
  // every subsequent page load queuing behind them. Reopen on pageshow so a page
  // restored from bfcache still gets live updates.
  window.addEventListener('pagehide', disconnectLiveUpdates);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) connectLiveUpdates();
  });

  window.SyncEngine = {
    clientId,
    registerHandler(kind, fn) {
      handlers[kind] = fn;
      updateIndicatorFromState();
    },
    onRemoteChange(fn) {
      remoteChangeHandler = fn;
    },
    markDirty,
    clearDirty,
    isDirty,
    getCache,
    setCache,
    attemptSync,
  };

  window.addEventListener('online', attemptSync);
  window.addEventListener('offline', () => setStatus('offline'));

  updateIndicatorFromState();
  attemptSync();
  setInterval(attemptSync, PING_INTERVAL_MS);
  connectLiveUpdates();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // insecure context (plain http on a non-localhost address) or unsupported —
      // offline editing/sync still works via localStorage, just not cold page loads.
    });
  }
})();
