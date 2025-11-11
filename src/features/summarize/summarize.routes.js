const express = require('express');
const router = express.Router();
const { summarize } = require('./summarize.controller');

// POST /api/summarize
router.post('/summarize', summarize);

module.exports = router;
