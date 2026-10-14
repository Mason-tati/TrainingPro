// WP-09 · M1 — Monitoring endpoints (probe-facing).
//
// GET /health       → health summary (status, uptimeSec, startedAt, timestamp)
// GET /health/live  → pure liveness   (status, timestamp)
//
// Unauthenticated by design (load balancers / probes), always HTTP 200 JSON,
// never HTML, never a redirect. No middleware, no logging, no request
// inspection — the router only serializes the monitoring snapshots.
const express = require('express');
const router = express.Router();
const { getHealthSummary, getLiveness, getReadiness, getMetrics } = require('../lib/monitoring');

router.get('/live', (req, res) => res.status(200).json(getLiveness()));
// WP-09 M2 — readiness: 200 when the app can do useful work now, 503 otherwise.
// Fully fenced: a readiness failure yields a 503 JSON, never a thrown error.
router.get('/ready', async (req, res) => {
  try {
    const r = await getReadiness();
    res.status(r.status === 'ready' ? 200 : 503).json(r);
  } catch {
    res.status(503).json({ status: 'not-ready', timestamp: new Date().toISOString(), checks: {} });
  }
});
router.get('/', (req, res) => res.status(200).json(getHealthSummary()));

// WP-09 M3 — ADMIN-ONLY runtime metrics. This lives on a SEPARATE router that
// server.js mounts AFTER the session middleware (the probe router above is
// mounted before it, so probes never touch the session store). Unauthenticated
// → 401; non-admin → 403 (which also emits the L5 SECURITY_ACCESS_DENIED event).
const metricsRouter = express.Router();
metricsRouter.get('/metrics', (req, res) => {
  if (!(req.session && req.session.user)) return res.status(401).json({ error: 'Not authenticated' });
  if (!req.session.user.admin) return res.status(403).json({ error: 'Admin access required' });
  res.status(200).json(getMetrics());
});

module.exports = router;
module.exports.metricsRouter = metricsRouter;
