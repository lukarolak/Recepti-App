// Android build's replacement for public/sync.js (swapped in at asset-bundle time,
// see app/build.gradle's bundleNodeProject task). The real sync.js exists to survive
// two things that don't apply here: this browser tab losing its own server (the
// Express server is embedded in this same app and is always up while foregrounded),
// and other tabs/devices concurrently editing the same central DB (this local SQLite
// database has exactly one writer: this app). So every page's fetch() to its own
// local server just always succeeds, and this stub only needs to satisfy the
// window.SyncEngine surface that plan.js/shopping.js/recipes.js/ingredients.js call
// into, as safe no-ops -- no localStorage queue, no service worker, no SSE.
(function () {
  window.SyncEngine = {
    clientId: 'android',
    registerHandler() {},
    onRemoteChange() {},
    markDirty() {},
    clearDirty() {},
    isDirty() {
      return false;
    },
    getCache() {
      return null;
    },
    setCache() {},
    attemptSync() {
      return Promise.resolve();
    },
  };
})();
