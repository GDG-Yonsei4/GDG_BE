// 기획(Planning) 관련 컨트롤러
// - 클라이언트 요청을 받아서 서비스 레이어(`planning.service.js`)를 호출하고
//   결과를 JSON으로 반환합니다.
// - structured=true 옵션을 지원하여 구조화된 리스트(배열)를 반환할 수 있습니다.
// - 결과는 로컬 `src/data/responses`에도 저장하여 디버깅/검토에 활용합니다.
const { createPlans, collectFilesForSubject } = require('./planning.service');
const { savePlanToDb } = require('./planning.repository'); // DB 저장 함수 임포트
const fs = require('fs').promises;
const path = require('path');

// Helper: JSON 객체를 로컬 파일로 저장
// 입력:
//  - id: 요청자 ID (파일명에 포함)
//  - subject: 주제 또는 태그 (파일명에 포함)
//  - obj: 저장할 자바스크립트 객체
// 출력/부작용:
//  - 저장된 파일의 절대 경로를 문자열로 반환
//  - 실패 시 null 반환 및 콘솔 경고
async function saveJsonToLocal(id, subject, obj) {
  try {
    const base = path.resolve(__dirname, '../../data/responses');
    await fs.mkdir(base, { recursive: true });
    const name = `${id || 'anon'}_${subject || 'subject'}_${Date.now()}.json`;
    const filePath = path.join(base, name);
    await fs.writeFile(filePath, JSON.stringify(obj, null, 2), 'utf8');
    return filePath;
  } catch (err) {
    console.warn('saveJsonToLocal failed', err.message || err);
    return null;
  }
}

// planning 엔드포인트 핸들러
// 입력(요청 바디): { id: string, subjects: string[], structured?: boolean, sourcePath?: string }
// 동작:
//  - 유효성 검사(id, subjects)
//  - 서비스 레이어 `createPlans`를 호출 (structured 여부, sourcePath 전달)
//  - 결과를 로컬에 저장하고 savedPath를 응답에 포함
//  - (추가) 결과를 MySQL DB에 저장
// 출력(응답): JSON (각 subject별 요약 혹은 구조화된 객체) 또는 에러
const planning = async (req, res) => {
  try {
    const { id, subjects } = req.body;
    if (!id || !Array.isArray(subjects)) {
      return res.status(400).json({ error: 'Request must include `id` and `subjects` array.' });
    }

    const structured = Boolean(req.body.structured);
    const sourcePath = req.body.sourcePath || null; // 로컬 파일 경로 (선택 사항)

    const result = await createPlans(id, subjects, structured, sourcePath);
    
    // 전체 결과를 로컬에 저장(검토용)
    const savedPath = await saveJsonToLocal(id, structured ? 'structured_planning' : 'planning', result);

    // MySQL DB에 저장 (structured 모드이고 에러가 없을 때만)
    let dbSaved = false;
    if (structured && result.plans) {
      try {
        for (const [subject, planData] of Object.entries(result.plans)) {
          if (planData && !planData.error) {
            await savePlanToDb(id, subject, planData);
          }
        }
        dbSaved = true;
      } catch (dbErr) {
        console.error('Failed to save to DB:', dbErr);
        // DB 저장이 실패해도 클라이언트 응답은 성공으로 처리 (로그만 남김)
      }
    }

    // 응답에 savedPath 및 dbSaved 여부 포함
    return res.json(Object.assign({}, result, { savedPath, dbSaved }));
  } catch (err) {
    console.error('planning.controller error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  planning,
};
