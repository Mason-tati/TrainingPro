// EWP-01c — Enterprise Workforce Platform — Person & Identity — Routes.
//
// The Person REST surface, built with ONLY the EWP-01a generic-gated-router (the feature-flag gate is
// reused, NOT re-implemented). A declarative route table registers the search / identity-lookup /
// email / passport / national-id / age endpoints alongside CRUD, ordered so literal segments precede the
// parameterised matchers ('/:id'). Created for wiring only; NOT mounted anywhere (server.js unchanged).
// UNWIRED.
'use strict';

const { createGatedRouter } = require('../generic-gated-router');

const MOUNT_PATH = '/api/workforce/person';

// Literal-segment routes precede '/:id' so they are never shadowed.
const ROUTES = [
  { method: 'post', path: '/', handler: 'create' },
  { method: 'get', path: '/search', handler: 'search' },
  { method: 'post', path: '/duplicates', handler: 'duplicates' },
  { method: 'get', path: '/active', handler: 'listActive' },
  { method: 'get', path: '/email', handler: 'byEmail' },
  { method: 'get', path: '/passport', handler: 'byPassport' },
  { method: 'get', path: '/national-id', handler: 'byNationalId' },
  { method: 'get', path: '/uuid/:uuid', handler: 'byUuid' },
  { method: 'get', path: '/number/:personNumber', handler: 'byPersonNumber' },
  { method: 'get', path: '/:id/age', handler: 'age' },
  { method: 'get', path: '/:id', handler: 'get' },
  { method: 'get', path: '/', handler: 'list' },
  { method: 'put', path: '/:id', handler: 'update' },
  { method: 'post', path: '/:id/archive', handler: 'archive' },
  { method: 'post', path: '/:id/restore', handler: 'restore' },
  { method: 'delete', path: '/:id', handler: 'remove' },
];

function createPersonRoutes(controller, options) {
  const opts = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};
  return createGatedRouter(controller, { routes: ROUTES, featureFlag: opts.featureFlag });
}

module.exports = { createPersonRoutes, MOUNT_PATH, ROUTES: ROUTES.map((r) => Object.assign({}, r)) };
