// EWP-01b — Enterprise Workforce Platform — Reference & Organisation — Routes.
//
// The organisation hierarchy REST surface, built with ONLY the EWP-01a generic-gated-router (the
// feature-flag gate is reused, NOT re-implemented). A declarative route table registers the hierarchy /
// tree / breadcrumb / children / ancestors / descendants / lookup endpoints alongside CRUD, ordered so
// literal segments ('/hierarchy', '/:level/lookup') precede the parameterised matchers ('/:level',
// '/:level/:id'). Base path is provided; the router is created for wiring only and is NOT mounted
// anywhere (server.js unchanged). UNWIRED.
'use strict';

const { createGatedRouter } = require('../generic-gated-router');

const MOUNT_PATH = '/api/workforce/organisation';

// Literal-segment routes are declared BEFORE the parameterised matchers at the same depth so they are
// never shadowed: '/hierarchy' before '/:level'; '/:level/lookup' before '/:level/:id'.
const ROUTES = [
  { method: 'post', path: '/:level', handler: 'create' },
  { method: 'get', path: '/hierarchy', handler: 'hierarchy' },
  { method: 'get', path: '/:level/lookup', handler: 'lookup' },
  { method: 'get', path: '/:level/:id/children', handler: 'children' },
  { method: 'get', path: '/:level/:id/parent', handler: 'parent' },
  { method: 'get', path: '/:level/:id/ancestors', handler: 'ancestors' },
  { method: 'get', path: '/:level/:id/descendants', handler: 'descendants' },
  { method: 'get', path: '/:level/:id/tree', handler: 'tree' },
  { method: 'get', path: '/:level/:id/breadcrumb', handler: 'breadcrumb' },
  { method: 'get', path: '/:level/:id', handler: 'get' },
  { method: 'get', path: '/:level', handler: 'list' },
  { method: 'put', path: '/:level/:id', handler: 'update' },
  { method: 'post', path: '/:level/:id/archive', handler: 'archive' },
  { method: 'post', path: '/:level/:id/restore', handler: 'restore' },
  { method: 'delete', path: '/:level/:id', handler: 'remove' },
];

function createOrganisationRoutes(controller, options) {
  const opts = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};
  return createGatedRouter(controller, { routes: ROUTES, featureFlag: opts.featureFlag });
}

module.exports = { createOrganisationRoutes, MOUNT_PATH, ROUTES: ROUTES.map((r) => Object.assign({}, r)) };
