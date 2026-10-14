// EWP-01a — Workforce Foundation Framework — repository-registry tests.
// The single named container injected as one dependency; register/get/require/has/names/size, with
// duplicate and bad-input guards.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const WDIR = path.join(__dirname, '..', 'lib', 'workforce');
const { RepositoryRegistry, createRegistry } = require(path.join(WDIR, 'repository-registry.js'));

const repoStub = () => ({ findById() {} });

test('EWP-REG-1. register / get / has / size; register returns the registry (chainable)', () => {
  const reg = createRegistry();
  assert.equal(reg.size(), 0);
  const chained = reg.register('person', repoStub());
  assert.equal(chained, reg, 'chainable');
  assert.equal(reg.has('person'), true);
  assert.equal(reg.has('missing'), false);
  assert.ok(reg.get('person'));
  assert.equal(reg.get('missing'), undefined);
  assert.equal(reg.size(), 1);
});

test('EWP-REG-2. require returns the repo or throws when absent', () => {
  const reg = new RepositoryRegistry();
  reg.register('org', repoStub());
  assert.ok(reg.require('org'));
  assert.throws(() => reg.require('nope'), /no repository named 'nope'/);
});

test('EWP-REG-3. duplicate registration is rejected (no silent clobber)', () => {
  const reg = new RepositoryRegistry();
  reg.register('position', repoStub());
  assert.throws(() => reg.register('position', repoStub()), /already has a repository named 'position'/);
});

test('EWP-REG-4. bad name and bad repository are rejected', () => {
  const reg = new RepositoryRegistry();
  assert.throws(() => reg.register('', repoStub()), /non-empty name/);
  assert.throws(() => reg.register('   ', repoStub()), /non-empty name/);
  assert.throws(() => reg.register(5, repoStub()), /non-empty name/);
  assert.throws(() => reg.register('x', null), /requires a repository object/);
  assert.throws(() => reg.register('x', 42), /requires a repository object/);
});

test('EWP-REG-5. a function-valued repository is accepted (class or factory)', () => {
  const reg = new RepositoryRegistry();
  const fnRepo = function repo() {};
  reg.register('factoryRepo', fnRepo);
  assert.equal(reg.get('factoryRepo'), fnRepo);
});

test('EWP-REG-6. names() returns a sorted defensive copy', () => {
  const reg = new RepositoryRegistry();
  reg.register('zebra', repoStub());
  reg.register('alpha', repoStub());
  reg.register('mike', repoStub());
  const names = reg.names();
  assert.deepEqual(names, ['alpha', 'mike', 'zebra']);
  names.push('HACK');
  assert.deepEqual(reg.names(), ['alpha', 'mike', 'zebra'], 'internal map not mutated');
});
