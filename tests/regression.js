// DEPRECATED (WP-07 C13).
//
// The old live-server regression suite that ran against http://localhost:3000 and
// the real database/traintrack.db has been RETIRED. Its useful checks were
// migrated into the isolated node:test framework, which runs against throwaway
// temporary databases and an ephemeral in-process server — never production:
//
//   • auth / permissions ....... tests/api/auth.test.js            (C7)
//   • staff CRUD + reports ..... tests/api/staff.test.js, reports.test.js, lookup.test.js (C8)
//   • exams / forms / workflows  tests/api/exams.test.js, forms.test.js, workflows.test.js (C9)
//   • translator mechanics ..... tests/unit/translate.test.js, tests/docgen/translate-roundtrip.test.js (C4/C11)
//   • GET-surface liveness ..... tests/regression/get-surfaces.test.js (C13)
//   • data-hygiene invariants .. tests/regression/data-hygiene.test.js (C13)
//
// This shim intentionally performs NO network or database access so it can never
// touch port 3000 or the production database. Run the safe suite instead:
//
//   npm test              # full isolated suite
//   npm run test:unit     # unit tests only
//   npm run test:coverage # with coverage
//
// See tests/helpers/README.md for the full test map.
'use strict';
console.log('[deprecated] tests/regression.js has been retired — run "npm test" (isolated node:test suite).');
console.log('See tests/helpers/README.md for how to run each test group.');
process.exit(0);
