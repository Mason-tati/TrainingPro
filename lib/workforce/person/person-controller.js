// EWP-01c — Enterprise Workforce Platform — Person & Identity — Controller.
//
// Built from the EWP-01a generic controller: the standard CRUD/lifecycle handlers come from
// createResourceController (the never-throw + status mapping is reused, NOT re-implemented), and the
// Person-specific lookup/search/duplicate/age handlers are added with the same exported `handler`
// factory. Each handler maps a request to a single person-service call. UNWIRED.
'use strict';

const { createResourceController, handler } = require('../generic-resource-controller');

function createPersonController(service) {
  const base = createResourceController(service, { paramId: 'id' });
  return Object.assign({}, base, {
    search: handler((req) => service.search(req.query), 200),
    duplicates: handler((req) => service.detectDuplicates(req.body), 200),
    byUuid: handler((req) => service.findByUuid(req.params.uuid), 200),
    byPersonNumber: handler((req) => service.findByPersonNumber(req.params.personNumber), 200),
    byEmail: handler((req) => service.findByEmail(req.query.email), 200),
    byPassport: handler((req) => service.findByPassport(req.query.passportNumber), 200),
    byNationalId: handler((req) => service.findByNationalId(req.query.nationalId), 200),
    age: handler((req) => service.getAge(Number(req.params.id), req.query.asOf), 200),
  });
}

module.exports = { createPersonController };
