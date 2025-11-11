
// Load project-local environment variables from .env (if present)
require('dotenv').config();

const express = require('express');
const app = express();
const port = 3000;

// middleware
app.use(express.json());

// routers
const healthRouter = require('./features/health/health.routes');
const summarizeRouter = require('./features/summarize/summarize.routes');

app.use('/', healthRouter);
app.use('/api', summarizeRouter);

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});
