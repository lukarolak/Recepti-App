// Wired into server.js as the first app.use(): resolves the request's language from
// the "lang" cookie and exposes translation + (on the Android build) central-sync
// status helpers to every view via res.locals.
const { getCookie } = require('./cookies');
const { translate, translations, SUPPORTED_LANGS } = require('../i18n');
const { isAndroidBuild } = require('./env');

const centralSync = isAndroidBuild ? require('../sync/centralSync') : null;

// centralSync.js's status.label is plain English (fine for its own console.log calls),
// so translate for display here based on the stable state enum instead of that raw
// text. The 'error' case's detail (a raw JS/network error message) is left untranslated
// -- it's diagnostic text, not really app chrome.
function translateSyncStatus(t, status) {
  switch (status.state) {
    case 'never': return t('syncCentral.notYetSynced');
    case 'unconfigured': return t('syncCentral.unconfigured');
    case 'offline': return t('syncCentral.unreachable');
    case 'synced': return t('syncCentral.synced');
    case 'error': return t('syncCentral.errorPrefix') + (status.lastError || '');
    default: return status.label;
  }
}

module.exports = async function i18nMiddleware(req, res, next) {
  const cookieLang = getCookie(req, 'lang');
  const lang = SUPPORTED_LANGS.includes(cookieLang) ? cookieLang : 'en';
  res.locals.lang = lang;
  res.locals.t = (key, params) => translate(lang, key, params);
  // Only what public/*.js needs client-side (see partials/nav.ejs) -- never used for
  // user-entered content, only app chrome text.
  res.locals.i18nDictJson = JSON.stringify(translations[lang]);

  res.locals.isAndroidBuild = isAndroidBuild;
  if (isAndroidBuild) {
    const status = centralSync.getStatus();
    res.locals.syncState = status.state === 'synced' ? 'synced' : 'offline';
    res.locals.syncLabel = translateSyncStatus(res.locals.t, status);
    res.locals.centralConfigured = !!(await centralSync.getCentralUrl());
  }
  next();
};
