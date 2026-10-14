// EWP-01a — Enterprise Workforce Platform — Foundation Framework — Generic Resource Controller.
//
// The reusable, thin HTTP controller for EVERY future Workforce entity. Maps a request to a single
// service call and maps the result's { ok, code } to an HTTP status — the exact status table every
// certified engine hand-copied 18 times, defined ONCE. Never-throw: any unexpected error becomes a 500
// JSON response. NO business logic. The default CRUD/lifecycle handler set is provided; `listByParam`
// builds relationship handlers, and `handler`/`ERROR_STATUS` are exported so entities can add bespoke
// handlers without re-implementing the mapping. UNWIRED.
'use strict';

const ERROR_STATUS = {
  VALIDATION: 400,
  CONFLICT: 409,
  NOT_FOUND: 404,
  ERROR: 500,
};

// Wrap a (req)->Promise<result> mapper into an Express handler with never-throw + status mapping.
function handler(map, okStatus) {
  return async function resourceHandler(req, res) {
    try {
      const result = await map(req);
      const status = result.ok ? okStatus : (ERROR_STATUS[result.code] || 500);
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' });
    }
  };
}

function createResourceController(service, options) {
  const opts = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};
  const paramId = typeof opts.paramId === 'string' && opts.paramId ? opts.paramId : 'id';
  const idFrom = (req) => Number(req.params[paramId]);

  const controller = {
    create: handler((req) => service.create(req.body), 201),
    get: handler((req) => service.get(idFrom(req)), 200),
    update: handler((req) => service.update(idFrom(req), req.body), 200),
    list: handler((req) => service.list(req.query), 200),
    listActive: handler(() => service.listActive(), 200),
    archive: handler((req) => service.archive(idFrom(req)), 200),
    restore: handler((req) => service.restore(idFrom(req)), 200),
    remove: handler((req) => service.remove(idFrom(req)), 200),
  };

  // Build a relationship handler: parses a numeric path param and calls service.listBy(column, value).
  controller.listByParam = function listByParam(column, paramName) {
    const name = typeof paramName === 'string' && paramName ? paramName : column;
    return handler((req) => service.listBy(column, Number(req.params[name])), 200);
  };

  return controller;
}

module.exports = { createResourceController, handler, ERROR_STATUS };
