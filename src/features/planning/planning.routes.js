const express = require('express');
const router = express.Router();
const { planning } = require('./planning.controller');

// POST /api/planning
router.post('/planning', planning);

module.exports = router;
