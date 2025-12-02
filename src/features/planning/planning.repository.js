const { pool } = require('../../db/connection');

// 계획 저장 함수
// 입력:
//  - userId: 사용자 ID
//  - subject: 주제
//  - data: planning.service.js에서 반환된 구조화된 데이터 객체
// 출력:
//  - 저장된 planId
async function savePlanToDb(userId, subject, data) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 0. Subject 처리 (없으면 생성, 있으면 ID 조회)
    let subjectId = null;
    if (subject) {
      const [rows] = await connection.query('SELECT id FROM subjects WHERE subject_name = ?', [subject]);
      if (rows.length > 0) {
        subjectId = rows[0].id;
      } else {
        const [res] = await connection.query('INSERT INTO subjects (subject_name) VALUES (?)', [subject]);
        subjectId = res.insertId;
      }
    }

    // 1. plans 테이블에 메인 정보 저장
    const [result] = await connection.query(
      `INSERT INTO plans (user_id, subject, subject_id, summary, difficulty, key_concepts, code_examples)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        subject,
        subjectId,
        data.summary || '',
        data.difficulty || 'intermediate',
        JSON.stringify(data.key_concepts || []),
        JSON.stringify(data.code_examples || [])
      ]
    );

    const planId = result.insertId;

    // 2. plan_todos 테이블에 상세 계획 저장
    // data.plan 구조: [{ big_todo, small_todos: [{todo, duration_minutes, percentage}, ...] }, ...]
    if (Array.isArray(data.plan)) {
      for (const bigItem of data.plan) {
        const bigTodo = bigItem.big_todo || 'General';
        if (Array.isArray(bigItem.small_todos)) {
          for (const smallItem of bigItem.small_todos) {
            await connection.query(
              `INSERT INTO plan_todos (plan_id, big_todo, small_todo, duration_minutes, percentage, reference, is_completed)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                planId,
                bigTodo,
                smallItem.todo,
                smallItem.duration_minutes || 30,
                smallItem.percentage || 0,
                smallItem.reference || null,
                false
              ]
            );
          }
        }
      }
    }

    await connection.commit();
    return planId;
  } catch (err) {
    await connection.rollback();
    console.error('savePlanToDb failed:', err);
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = {
  savePlanToDb
};
