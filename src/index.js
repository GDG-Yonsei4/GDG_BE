
// Load project-local environment variables from .env (if present)
require('dotenv').config();

const express = require('express');
const { initDb } = require('./db/connection'); // DB 초기화 함수 임포트
const app = express();
const port = process.env.PORT || 3000;

// DB 테이블 초기화 (서버 시작 시 실행)
initDb().then(() => {
  console.log('Database initialized');
}).catch(err => {
  console.error('Database initialization failed:', err);
});

// middleware
app.use(express.json());

// routers
const healthRouter = require('./features/health/health.routes');
const planningRouter = require('./features/planning/planning.routes');
const uploadRouter = require('./features/upload/route');

app.use('/', healthRouter);
app.use('/api', planningRouter);
app.use('/api/upload', uploadRouter); 

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});
