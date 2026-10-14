// EWP-01a — Enterprise Workforce Platform — Foundation Framework — Generic Gated Router.
//
// The reusable, feature-flag-GATED Express router for EVERY future Workforce entity. When the Workforce
// runtime flag is disabled (the default) every request short-circuits to 503 and no controller/service/
// repository runs — the platform is invisible by default. A declarative route table (default: the CRUD +
// lifecycle set, specific routes before '/:id') is registered against an injected controller; entities
// supply extra relationship routes through the same table. Created for wiring only; NOT mounted anywhere.
// No business logic. UNWIRED.
'use strict';

const express = require('express');
const defaultFeatureFlag = require('./runtime-feature-flag');

// The standard route table. Specific GET routes are declared BEFORE '/:id' so the id matcher never
// shadows them. Each entry: { method, path, handler }.
const DEFAULT_ROUTES = [
  { method: 'post', path: '/', handler: 'create' },
  { method: 'get', path: '/active', handler: 'listActive' },
  { method: 'get', path: '/', handler: 'list' },
  { method: 'get', path: '/:id', handler: 'get' },
  { method: 'put', path: '/:id', handler: 'update' },
  { method: 'post', path: '/:id/archive', handler: 'archive' },
  { method: 'post', path: '/:id/restore', handler: 'restore' },
  { method: 'delete', path: '/:id', handler: 'remove' },
];

function createGatedRouter(controller, options) {
  const opts = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};
  const featureFlag = opts.featureFlag && typeof opts.featureFlag.isEnabled === 'function'
    ? opts.featureFlag
    : defaultFeatureFlag;
  // Custom routes (e.g. relationship GETs) are registered BEFORE the default table so they precede
  // '/:id'. When opts.routes is provided it REPLACES the default table entirely.
  const routes = Array.isArray(opts.routes) ? opts.routes : DEFAULT_ROUTES;

  const router = express.Router();

  router.use((req, res, next) => {
    if (!featureFlag.isEnabled()) {
      return res.status(503).json({ ok: false, error: 'workforce platform disabled', code: 'DISABLED' });
    }
    return next();
  });

  for (const route of routes) {
    const fn = controller[route.handler];
    if (typeof fn !== 'function') {
      throw new Error(`createGatedRouter: controller has no handler '${route.handler}'`);
    }
    router[route.method](route.path, fn);
  }

  return router;
}

module.exports = { createGatedRouter, DEFAULT_ROUTES: DEFAULT_ROUTES.map((r) => Object.assign({}, r)) };
