// Live updates: pushes a "something changed" event to every connected browser tab so
// pages can reload/refetch instead of polling. Shared across every mutating route.
const express = require('express');

const router = express.Router();

const sseClients = new Set();

router.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const client = { res, clientId: req.query.clientId || '' };
  sseClients.add(client);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (err) {
      // write failed synchronously (e.g. socket already torn down) — drop the client
      clearInterval(heartbeat);
      sseClients.delete(client);
    }
  }, 20000);

  function cleanup() {
    clearInterval(heartbeat);
    sseClients.delete(client);
  }

  req.on('close', cleanup);
  // A client that vanishes without a clean TCP close (dropped wifi, sleeping laptop)
  // surfaces as an 'error' on the response stream instead of 'close'. Node crashes
  // the whole process on an unhandled stream error, so this must be handled too.
  res.on('error', cleanup);
});

// TEMP debug endpoint, remove after verifying the SSE connection-leak fix
router.get('/api/debug/sse-count', (req, res) => {
  res.json({ count: sseClients.size, clientIds: [...sseClients].map((c) => c.clientId) });
});

// excludeClientId skips echoing the event back to the tab that made the change —
// that tab already applied the update optimistically, so it doesn't need a reload.
function broadcastChange(excludeClientId) {
  for (const client of sseClients) {
    if (client.clientId && client.clientId === excludeClientId) continue;
    try {
      client.res.write('event: data-changed\ndata: {}\n\n');
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

module.exports = { router, broadcastChange };
