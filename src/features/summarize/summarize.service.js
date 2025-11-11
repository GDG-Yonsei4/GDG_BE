const fs = require('fs').promises; // 파일시스템 비동기 API
const path = require('path');
const OpenAI = require('openai');
const Ajv = require('ajv');

const CONTENT_ROOT = path.resolve(__dirname, '../../content');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ajv = new Ajv();

// 재귀적으로 디렉토리 탐색
// 입력:
//  - dir: 시작 디렉토리 절대 경로
//  - collected: 파일 정보를 쌓을 배열(참조로 전달)
// 동작/출력:
//  - 허용된 확장자(.md, .txt 등)를 가진 파일을 찾아서
//    { path, content } 형태로 collected에 push 합니다.
//  - 파일 읽기 실패 시 경고 로그를 남기고 계속 진행합니다.

async function walkDir(dir, collected) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await walkDir(p, collected);
    } else {
      const ext = path.extname(ent.name).toLowerCase();
      const allowed = ['.md', '.txt', '.js', '.json', '.py', '.java', '.c', '.cpp'];
      if (allowed.includes(ext)) {
        try {
          const content = await fs.readFile(p, 'utf8');
          collected.push({ path: path.relative(CONTENT_ROOT, p), content });
        } catch (e) {
          console.warn('Could not read file', p, e.message);
        }
      }
    }
  }
}

// 주제 폴더에서 텍스트 파일 수집
// 입력:
//  - subject: src/content 하위의 주제 디렉토리 이름
// 출력:
//  - [{ path, content }, ...] 형식의 배열을 반환합니다.
// 예외/에러:
//  - 디렉토리가 없으면 빈 배열을 반환합니다.

async function collectFilesForSubject(subject) {
  const subjectDir = path.join(CONTENT_ROOT, subject);
  const collected = [];

  try {
    const stat = await fs.stat(subjectDir);
    if (!stat.isDirectory()) return collected;
  } catch (e) {
    // 경로가 없는 경우
    return collected;
  }

  // 재귀적으로 디렉토리 탐색 (분리된 walkDir 사용)
  await walkDir(subjectDir, collected);
  return collected;
}

// 프롬프트 조립기
// 입력:
//  - id: 사용자/요청자 식별자
//  - subject: 주제 문자열
//  - files: collectFilesForSubject가 반환한 [{path, content}] 배열
// 출력:
//  - { system, user } 형태의 메시지 조합을 반환합니다.
// 비고:
//  - 파일 내용을 합쳐 토큰/문자 수 상한(MAX_CHARS)까지 잘라서 전송합니다.
function buildPrompt(id, subject, files) {
  let combined = files
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join("\n\n");

  const MAX_CHARS = 15000;
  if (combined.length > MAX_CHARS) {
    combined = combined.slice(0, MAX_CHARS) + '\n\n[TRUNCATED]';
  }

  const system = 'You are a helpful assistant that reads source or text files and returns a concise study-oriented summary in Korean.';
  const user = `User ID: ${id}\nSubject: ${subject}\nFiles:\n${combined}\n\nPlease produce a concise, structured summary (in Korean) that includes: key concepts, important code snippets or examples if relevant, and a short study plan (3-5 bullets). Keep the response focused and numbered where appropriate.`;
  return { system, user };
}

// 단일 주제에 대해 간단 텍스트 요약을 얻는 함수
// 입력: id, subject, files
// 출력: 모델이 반환한 원시 텍스트 요약 문자열
// 오류: OPENAI_API_KEY 미설정 시 예외를 던집니다.

async function summarizeSingleSubject(id, subject, files) {

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY environment variable not set.');
  }

  const { system, user } = buildPrompt(id, subject, files);

  const resp = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: 800,
  });

  const text = resp?.choices?.[0]?.message?.content ?? '';
  return text;
}

// 구조화된 요약을 요청하는 함수 (배열/리스트를 반환하도록 모델에 지시)
// 입력: id, subject, files
// 출력: { summary: string, key_concepts: string[], code_examples: string[], plan: [{step,duration_minutes,resources},...], difficulty }
// 동작:
//  - OpenAI function-calling을 이용하여 구조화된 JSON을 요청합니다.
//  - AJV로 스키마 검증을 수행하고 실패하면 한 번 재요청(repair)을 시도합니다.
//  - 실패 시 휴리스틱(텍스트 기반)으로 리스트를 추출하여 반환합니다.
// 오류/부작용:
//  - OPENAI_API_KEY 미설정 시 예외를 던집니다.
//  - 모델 호출 실패는 로그에 남기고 폴백으로 처리합니다.
async function summarizeSingleSubjectStructured(id, subject, files) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY environment variable not set.');
  }

  const { system, user } = buildPrompt(id, subject, files);

  const functions = [
    {
      name: 'create_structured_summary',
      description: 'Return structured summary fields: summary, key_concepts (array), code_examples (array), plan (array of 3 steps), difficulty',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          key_concepts: { type: 'array', items: { type: 'string' } },
          code_examples: { type: 'array', items: { type: 'string' } },
          plan: {
            type: 'array',
            minItems: 3,
            maxItems: 3,
            items: {
              type: 'object',
              properties: {
                step: { type: 'string' },
                duration_minutes: { type: 'integer' },
                resources: { type: 'array', items: { type: 'string' } }
              },
              required: ['step']
            }
          },
          difficulty: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] }
        },
        required: ['summary', 'key_concepts', 'plan', 'difficulty']
      }
    }
  ];

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user + '\n\nPlease produce structured fields and invoke the function create_structured_summary with arguments matching the schema.' }
  ];

  // 검증용 스키마 정의
  const structuredSchema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      key_concepts: { type: 'array', items: { type: 'string' } },
      code_examples: { type: 'array', items: { type: 'string' } },
      plan: {
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            step: { type: 'string' },
            duration_minutes: { type: 'integer' },
            resources: { type: 'array', items: { type: 'string' } }
          },
          required: ['step']
        }
      },
      difficulty: { type: 'string' }
    },
    required: ['summary', 'key_concepts', 'plan', 'difficulty']
  };

  const validateStructured = ajv.compile(structuredSchema);

  // 최대 2회 시도: 처음 함수 호출, 검증 실패 시 수리(repair) 재시도
  let attempts = 0;
  while (attempts < 2) {
    attempts += 1;
    try {
      const resp = await openai.chat.completions.create({
        model: 'gpt-4',
        messages,
        functions,
        function_call: { name: 'create_structured_summary' },
        temperature: 0,
        max_tokens: 1000
      });

  // 디버그를 위한 원시 응답 로그 출력
      try { console.log('DEBUG: summarizeSingleSubjectStructured response:', JSON.stringify(resp.choices?.[0]?.message, null, 2).slice(0, 2000)); } catch (e) {}

      const funcCall = resp?.choices?.[0]?.message?.function_call;
      if (funcCall && funcCall.arguments) {
        try {
          const parsed = JSON.parse(funcCall.arguments);
          // AJV로 유효성 검증
          const valid = validateStructured(parsed);
          if (!valid) {
            console.warn('validateStructured failed:', validateStructured.errors);
            if (attempts === 1) {
              // 수리 시도: 모델에 스키마에 맞는 유효한 JSON만 반환하도록 요청
              messages.push({ role: 'user', content: 'Your previous response did not match the schema. Return ONLY the JSON arguments for create_structured_summary that validate against the schema.' });
              continue;
            }
          } else {
            // plan을 정확히 3개 항목으로 정규화
            if (!Array.isArray(parsed.plan)) parsed.plan = [];
            parsed.plan = parsed.plan.slice(0, 3).map(p => ({
              step: String(p.step || p || '').trim(),
              duration_minutes: Number.isInteger(p.duration_minutes) ? p.duration_minutes : (parseInt(p.duration_minutes) || 30),
              resources: Array.isArray(p.resources) ? p.resources.map(String) : []
            }));
            while (parsed.plan.length < 3) parsed.plan.push({ step: '추가 복습 및 연습', duration_minutes: 30, resources: [] });
            if (!parsed.key_concepts) parsed.key_concepts = [];
            if (!parsed.code_examples) parsed.code_examples = [];
            if (!parsed.difficulty) parsed.difficulty = 'intermediate';
            if (!parsed.summary) parsed.summary = '';
            return parsed;
          }
        } catch (e) {
          console.warn('summarizeSingleSubjectStructured: failed to parse function_call.arguments', e.message);
        }
      }
    } catch (err) {
      console.error('summarizeSingleSubjectStructured: openai request failed', err.message || err);
      break;
    }
  }

  // 폴백: 일반 요약을 호출한 뒤 휴리스틱으로 리스트 추출 시도
  const text = await summarizeSingleSubject(id, subject, files);
  printf('Fallback text for structured summary:\n', text);
  // 핵심 개념(라인) 추출
  const keyConcepts = [];
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const l of lines) {
    const m = l.match(/^(?:\d+\.|\d+\)|[-–•]\s*)(.*)$/);
    if (m && m[1].length < 200) keyConcepts.push(m[1]);
    if (keyConcepts.length >= 5) break;
  }
  // 기존 휴리스틱을 사용한 계획 단계 추출
  function extractStepsFromTextLocal(t) {
    const s = [];
    const ls = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of ls) {
      const mm = line.match(/^(?:\-|•|\*|\d+\.|\d+\))\s*(.*)$/);
      if (mm) s.push(mm[1]);
    }
    if (s.length === 0) {
      for (const l of ls) if (l.length > 20 && s.length < 3) s.push(l);
    }
    return s.slice(0, 3);
  }
  const extracted = extractStepsFromTextLocal(text);
  const plan = extracted.map(s => ({ step: s, duration_minutes: 30, resources: [] }));
  while (plan.length < 3) plan.push({ step: '추가 복습 및 연습', duration_minutes: 30, resources: [] });

  return { summary: text.split(/\r?\n\r?\n/)[0] || '', key_concepts: keyConcepts, code_examples: [], plan, difficulty: 'intermediate' };
}

// 여러 주제를 한 번에 요약해서 반환하는 함수
// 입력:
//  - id: 사용자/요청자 ID
//  - subjects: ['subject1','subject2',...]
//  - structured: true면 summarizeSingleSubjectStructured를 호출하여 배열/객체를 반환
// 출력:
//  - { id, summaries: { subject: summaryOrObject, ... } }

async function summarizeSubjects(id, subjects, structured = false) {

  const result = { id, summaries: {} };
  for (const subject of subjects) {
    const files = await collectFilesForSubject(subject);
    if (!files || files.length === 0) {
      result.summaries[subject] = structured ? { error: 'No files found for this subject.' } : 'No files found for this subject.';
      continue;
    }

    try {
      if (structured) {
        const structuredObj = await summarizeSingleSubjectStructured(id, subject, files);
        result.summaries[subject] = structuredObj;
      } else {
        const summary = await summarizeSingleSubject(id, subject, files);
        result.summaries[subject] = summary;
      }
    } catch (err) {
      console.error(`Error summarizing subject ${subject}:`, err.message || err);
      result.summaries[subject] = structured ? { error: err.message || 'Failed to summarize.' } : `Error: ${err.message || 'Failed to summarize.'}`;
    }
  }
  return result;
}
module.exports = {
  summarizeSubjects,
  collectFilesForSubject,
};
