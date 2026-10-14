// WP-18 · E4 — BaseService for the Enterprise Document Engine service layer.
//
// A thin, safe base for the orchestration layer. It validates that a repository
// has been INJECTED and exposes the methods the concrete service will call, then
// stores it. It performs NO SQL, opens NO database, and imports nothing — not
// database/db.js, Express, the request context, the logger, any route, or server.js.
// Services orchestrate repositories; repositories remain the only SQL layer.
// UNWIRED — nothing in production consumes it.
'use strict';

class BaseService {
  // `repository` is injected by the caller; `requiredMethods` is a fixed literal
  // list supplied by the concrete service. The constructor fails loudly if the
  // dependency is missing or does not satisfy the contract.
  constructor(repository, requiredMethods) {
    if (!repository || typeof repository !== 'object') {
      throw new Error('BaseService requires an injected repository');
    }
    for (const method of requiredMethods) {
      if (typeof repository[method] !== 'function') {
        throw new Error(`Injected repository must implement ${method}()`);
      }
    }
    this.repository = repository;
  }
}

module.exports = BaseService;
