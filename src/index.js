
const express = require('express');
const app = express();
const port = 3000;

const healthRouter = require('./features/health/health.routes');

app.use('/', healthRouter);

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});
