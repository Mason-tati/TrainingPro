// EWP-01a — Enterprise Workforce Platform — Foundation Framework — Repository Registry.
//
// A single named container for the platform's repositories, injected as ONE dependency so services pull
// exactly the repositories they need by name — eliminating the fragile 6–7 positional-argument
// constructors and the dead ("held for future integration") injections the WP-17→26 review flagged. It
// is the composition seam: EWP repositories register here, future modules `get`/`require` them by name,
// and certified WP-26 repositories can be registered read-only for outward integration WITHOUT importing
// their internals. No business logic, no I/O, no globals. Copy-on-read (fresh arrays), never mutates its
// inputs. UNWIRED.
'use strict';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function isRepository(value) {
  return !!value && (typeof value === 'object' || typeof value === 'function');
}

class RepositoryRegistry {
  constructor() {
    this._repositories = new Map();
  }

  // Register a repository under a unique name. Rejects duplicates (no silent clobber) and bad inputs.
  register(name, repository) {
    if (!isNonEmptyString(name)) {
      throw new Error('RepositoryRegistry.register requires a non-empty name');
    }
    if (!isRepository(repository)) {
      throw new Error(`RepositoryRegistry.register requires a repository object for '${name}'`);
    }
    if (this._repositories.has(name)) {
      throw new Error(`RepositoryRegistry already has a repository named '${name}'`);
    }
    this._repositories.set(name, repository);
    return this;
  }

  // Non-throwing lookup: the repository, or undefined when absent.
  get(name) {
    return this._repositories.get(name);
  }

  // Strict lookup for dependency validation: the repository, or throw when absent.
  require(name) {
    const repo = this._repositories.get(name);
    if (repo === undefined) {
      throw new Error(`RepositoryRegistry has no repository named '${name}'`);
    }
    return repo;
  }

  has(name) {
    return this._repositories.has(name);
  }

  // A fresh, sorted copy of the registered names (copy-on-read).
  names() {
    return Array.from(this._repositories.keys()).sort();
  }

  size() {
    return this._repositories.size;
  }
}

function createRegistry() {
  return new RepositoryRegistry();
}

module.exports = { RepositoryRegistry, createRegistry };
