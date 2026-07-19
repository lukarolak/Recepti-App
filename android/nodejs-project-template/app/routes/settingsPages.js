// Android-only: only mounted by server.js when isAndroidBuild is true.
const express = require('express');
const asyncRoute = require('../lib/asyncRoute');
const centralSync = require('../sync/centralSync');
const { SUPPORTED_LANGS, LANG_NAMES } = require('../i18n');

const router = express.Router();

router.get('/settings', asyncRoute(async (req, res) => {
  res.render('settings', {
    centralUrl: (await centralSync.getCentralUrl()) || '',
    status: centralSync.getStatus(),
    supportedLangs: SUPPORTED_LANGS,
    langNames: LANG_NAMES,
  });
}));

router.post('/settings', asyncRoute(async (req, res) => {
  await centralSync.setCentralUrl(req.body.centralUrl);
  res.redirect('/settings');
}));

router.post('/settings/sync-now', asyncRoute(async (req, res) => {
  await centralSync.runSyncCycle();
  res.redirect('/settings');
}));

module.exports = router;
