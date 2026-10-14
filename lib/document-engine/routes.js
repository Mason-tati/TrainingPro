// WP-19 · E5 — Enterprise Express Route Foundation (isolated router).
//
// An ISOLATED Express Router whose handlers delegate to the controller. This is NOT production
// wiring: the router is NEVER imported by production, NEVER registered, NEVER connected to
// server.js, and NEVER modifies any existing route. There is NO middleware, NO authentication,
// NO validation, NO persistence, and NO business logic — each handler simply reads the relevant
// request field and returns the controller result. Its only imports are `express` and
// `./controller`. UNWIRED.
'use strict';

const express = require('express');
const controller = require('./controller');

const router = express.Router();

// document operations
router.post('/', (req, res) => res.json(controller.create(req.body)));
router.put('/:id', (req, res) => res.json(controller.update(req.body)));
router.delete('/:id', (req, res) => res.json(controller.delete(req.params.id)));

// specific GET paths registered before the parameterized GET /:id (Express-correct ordering)
router.get('/health', (req, res) => res.json(controller.health()));
router.get('/capabilities', (req, res) => res.json(controller.capabilities()));
router.get('/snapshot/:id', (req, res) => res.json(controller.snapshot(req.params.id)));
router.get('/', (req, res) => res.json(controller.list(req.query)));
router.get('/:id', (req, res) => res.json(controller.get(req.params.id)));

// action operations
router.post('/search', (req, res) => res.json(controller.search(req.body)));
router.post('/validate', (req, res) => res.json(controller.validate(req.body)));
router.post('/clone', (req, res) => res.json(controller.clone(req.body)));
router.post('/archive', (req, res) => res.json(controller.archive(req.body)));
router.post('/restore', (req, res) => res.json(controller.restore(req.body)));

// component operations
router.post('/version', (req, res) => res.json(controller.version(req.body)));
router.post('/approve', (req, res) => res.json(controller.approve(req.body)));
router.post('/review', (req, res) => res.json(controller.review(req.body)));
router.post('/access', (req, res) => res.json(controller.access(req.body)));
router.post('/storage', (req, res) => res.json(controller.storage(req.body)));
router.post('/compliance', (req, res) => res.json(controller.compliance(req.body)));

module.exports = router;
