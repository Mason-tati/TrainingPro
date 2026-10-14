// EWP-01b — Enterprise Workforce Platform — Reference & Organisation — Controller.
//
// A thin HTTP controller for the organisation hierarchy, built from the EWP-01a generic controller's
// exported `handler` factory (the never-throw + { ok, code } → HTTP status mapping is reused, NOT
// re-implemented). Each handler maps a request to a single organisation-service call, extracting the
// level, id, and code from the request. Only organisation-specific endpoints are implemented. UNWIRED.
'use strict';

const { handler } = require('../generic-resource-controller');

function levelFrom(req) {
  return req.params.level;
}
function idFrom(req) {
  return Number(req.params.id);
}
function codeFrom(req) {
  return req.query.code;
}

function createOrganisationController(service) {
  return {
    // CRUD
    create: handler((req) => service.createNode(levelFrom(req), req.body), 201),
    get: handler((req) => service.getNode(levelFrom(req), idFrom(req)), 200),
    update: handler((req) => service.updateNode(levelFrom(req), idFrom(req), req.body), 200),
    list: handler((req) => service.listLevel(levelFrom(req), req.query), 200),
    archive: handler((req) => service.archiveNode(levelFrom(req), idFrom(req)), 200),
    restore: handler((req) => service.restoreNode(levelFrom(req), idFrom(req)), 200),
    remove: handler((req) => service.removeNode(levelFrom(req), idFrom(req)), 200),
    // Hierarchy
    children: handler((req) => service.children(levelFrom(req), idFrom(req)), 200),
    parent: handler((req) => service.parent(levelFrom(req), idFrom(req)), 200),
    ancestors: handler((req) => service.ancestors(levelFrom(req), idFrom(req)), 200),
    descendants: handler((req) => service.descendants(levelFrom(req), idFrom(req)), 200),
    tree: handler((req) => service.tree(levelFrom(req), idFrom(req)), 200),
    breadcrumb: handler((req) => service.breadcrumb(levelFrom(req), idFrom(req)), 200),
    lookup: handler((req) => service.lookupByCode(levelFrom(req), codeFrom(req)), 200),
    hierarchy: handler(() => service.hierarchy(), 200),
  };
}

module.exports = { createOrganisationController };
