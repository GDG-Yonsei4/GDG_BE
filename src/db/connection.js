const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '1234',
  database: process.env.DB_NAME || 'plan',
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// 테이블 초기화 스크립트
const initDb = async () => {
  try {
    const connection = await pool.getConnection();
    
    // subjects 테이블 생성
    await connection.query(`
      CREATE TABLE IF NOT EXISTS subjects (
        id INT AUTO_INCREMENT PRIMARY KEY,
        subject_name VARCHAR(255) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // plans 테이블 생성 (subject_id 추가)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        subject_id INT,
        subject VARCHAR(255) NOT NULL,
        summary TEXT,
        difficulty VARCHAR(50),
        key_concepts JSON,
        code_examples JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE SET NULL
      )
    `);

    // plan_todos 테이블 생성 (Big Todo - Small Todo 구조 저장 + percentage + reference + is_completed 추가)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS plan_todos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        plan_id INT NOT NULL,
        big_todo VARCHAR(255),
        small_todo VARCHAR(255),
        duration_minutes INT DEFAULT 30,
        percentage INT DEFAULT 0,
        reference VARCHAR(255),
        is_completed BOOLEAN DEFAULT FALSE,
        FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
      )
    `);

    // 기존 테이블에 컬럼이 없을 경우를 대비한 ALTER 문 (개발 편의상 추가)
    try {
      await connection.query(`ALTER TABLE plans ADD COLUMN subject_id INT`);
      await connection.query(`ALTER TABLE plans ADD CONSTRAINT fk_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE SET NULL`);
    } catch (e) { /* 컬럼이 이미 있으면 무시 */ }

    try {
      await connection.query(`ALTER TABLE plan_todos ADD COLUMN percentage INT DEFAULT 0`);
    } catch (e) { /* 컬럼이 이미 있으면 무시 */ }

    try {
      await connection.query(`ALTER TABLE plan_todos ADD COLUMN reference VARCHAR(255)`);
    } catch (e) { /* 컬럼이 이미 있으면 무시 */ }

    try {
      await connection.query(`ALTER TABLE plan_todos ADD COLUMN is_completed BOOLEAN DEFAULT FALSE`);
    } catch (e) { /* 컬럼이 이미 있으면 무시 */ }

    console.log('Database tables initialized successfully.');
    connection.release();
  } catch (err) {
    console.error('Error initializing database:', err);
  }
};

module.exports = {
  pool,
  initDb
};
