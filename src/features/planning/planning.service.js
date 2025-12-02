const fs = require('fs').promises; // 파일시스템 비동기 API
const path = require('path');
const OpenAI = require('openai');
const Ajv = require('ajv');
const pdf = require('pdf-parse');

const CONTENT_ROOT = path.resolve(__dirname, '../../content');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ajv = new Ajv();

// 재귀적으로 디렉토리 탐색
// 입력:
//  - dir: 현재 탐색 중인 디렉토리
//  - collected: 파일 정보를 쌓을 배열(참조로 전달)
//  - rootDir: 상대 경로 계산을 위한 루트 디렉토리
// 동작/출력:
//  - 허용된 확장자(.md, .txt, .pdf 등)를 가진 파일을 찾아서
//    { path, content } 형태로 collected에 push 합니다.
//  - 파일 읽기 실패 시 경고 로그를 남기고 계속 진행합니다.

async function walkDir(dir, collected, rootDir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await walkDir(p, collected, rootDir);
    } else {
      const ext = path.extname(ent.name).toLowerCase();
      const allowed = ['.md', '.txt', '.js', '.json', '.py', '.java', '.c', '.cpp', '.pdf'];
      if (allowed.includes(ext)) {
        try {
          let content = '';
          if (ext === '.pdf') {
            const dataBuffer = await fs.readFile(p);
            const data = await pdf(dataBuffer);
            content = data.text;
          } else {
            content = await fs.readFile(p, 'utf8');
          }
          // rootDir 기준 상대 경로 사용
          collected.push({ path: path.relative(rootDir, p), content });
        } catch (e) {
          console.warn('Could not read file', p, e.message);
        }
      }
    }
  }
}

// 주제 폴더에서 텍스트 파일 수집
// 입력:
//  - subject: src/content 하위의 주제 디렉토리 이름 (sourcePath가 없을 때 사용)
//  - sourcePath: (선택) 외부 절대 경로. 제공되면 subject 대신 이 경로를 사용.
// 출력:
//  - [{ path, content }, ...] 형식의 배열을 반환합니다.
// 예외/에러:
//  - 디렉토리가 없으면 빈 배열을 반환합니다.

async function collectFilesForSubject(subject, sourcePath = null) {
  const targetPath = sourcePath ? sourcePath : path.join(CONTENT_ROOT, subject);
  const collected = [];

  try {
    const stat = await fs.stat(targetPath);
    if (stat.isDirectory()) {
      // 재귀적으로 디렉토리 탐색 (rootDir로 targetPath 전달)
      await walkDir(targetPath, collected, targetPath);
    } else if (stat.isFile()) {
      // 단일 파일인 경우 처리
      const p = targetPath;
      const ext = path.extname(p).toLowerCase();
      const allowed = ['.md', '.txt', '.js', '.json', '.py', '.java', '.c', '.cpp', '.pdf'];
      if (allowed.includes(ext)) {
        try {
          let content = '';
          if (ext === '.pdf') {
            const dataBuffer = await fs.readFile(p);
            const data = await pdf(dataBuffer);
            content = data.text;
          } else {
            content = await fs.readFile(p, 'utf8');
          }
          // 단일 파일은 파일명만 경로로 사용
          collected.push({ path: path.basename(p), content });
        } catch (e) {
          console.warn('Could not read file', p, e.message);
        }
      }
    }
  } catch (e) {
    // 경로가 없는 경우
    return collected;
  }

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
    .map((f) => `--- File: ${f.path} ---\n${f.content}`)
    .join("\n\n");

  // GPT-4 사용을 가정하여 제한을 늘림 (약 60000자)
  const MAX_CHARS = 60000;
  if (combined.length > MAX_CHARS) {
    combined = combined.slice(0, MAX_CHARS) + '\n\n[TRUNCATED]';
  }

  const system = 'You are a helpful assistant that reads source or text files and returns a concise study-oriented plan in Korean.';
  const user = `User ID: ${id}\nSubject: ${subject}\nFiles:\n${combined}\n\nPlease produce a concise, structured study plan (in Korean) that includes: key concepts, important code snippets or examples if relevant, and a short study plan (3-5 bullets). Keep the response focused and numbered where appropriate.`;
  return { system, user };
}

// 단일 주제에 대해 간단 텍스트 계획을 얻는 함수
// 입력: id, subject, files
// 출력: 모델이 반환한 원시 텍스트 계획 문자열
// 오류: OPENAI_API_KEY 미설정 시 예외를 던집니다.

async function createPlanSingle(id, subject, files) {

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

// 구조화된 계획을 요청하는 함수 (배열/리스트를 반환하도록 모델에 지시)
// 입력: id, subject, files
// 출력: { summary: string, key_concepts: string[], code_examples: string[], plan: [{big_todo, small_todos: [{todo, duration_minutes}, ...]}, ...], difficulty }
// 동작:
//  - OpenAI function-calling을 이용하여 구조화된 JSON을 요청합니다.
//  - AJV로 스키마 검증을 수행하고 실패하면 한 번 재요청(repair)을 시도합니다.
//  - 실패 시 휴리스틱(텍스트 기반)으로 리스트를 추출하여 반환합니다.
// 오류/부작용:
//  - OPENAI_API_KEY 미설정 시 예외를 던집니다.
//  - 모델 호출 실패는 로그에 남기고 폴백으로 처리합니다.
async function createPlanSingleStructured(id, subject, files) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY environment variable not set.');
  }

  const { system, user } = buildPrompt(id, subject, files);

  const functions = [
    {
      name: 'create_structured_plan',
      description: 'Return structured planning fields: summary, key_concepts (array), code_examples (array), plan (hierarchical array), difficulty',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          key_concepts: { type: 'array', items: { type: 'string' } },
          code_examples: { type: 'array', items: { type: 'string' } },
          plan: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                big_todo: { type: 'string', description: 'Main goal or phase' },
                small_todos: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      todo: { type: 'string' },
                      duration_minutes: { type: 'integer' },
                      percentage: { type: 'integer', description: 'Estimated percentage of the big todo that this small todo represents (0-100)' },
                      reference: { type: 'string', description: 'Reference to the specific lecture note or file name relevant to this todo' }
                    },
                    required: ['todo', 'percentage']
                  }
                }
              },
              required: ['big_todo', 'small_todos']
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
    { role: 'user', content: user + '\n\nPlease produce structured fields and invoke the function create_structured_plan with arguments matching the schema. The plan should be hierarchical (Big Todo -> Small Todos) and flexible in length. For each small todo, please specify the "reference" field with the filename (e.g., "lecture1.pdf") that is most relevant to that task.' }
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
        items: {
          type: 'object',
          properties: {
            big_todo: { type: 'string' },
            small_todos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  todo: { type: 'string' },
                  duration_minutes: { type: 'integer' },
                  percentage: { type: 'integer' },
                  reference: { type: 'string' }
                },
                required: ['todo', 'percentage']
              }
            }
          },
          required: ['big_todo', 'small_todos']
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
        function_call: { name: 'create_structured_plan' },
        temperature: 0,
        max_tokens: 1500
      });

  // 디버그를 위한 원시 응답 로그 출력
      try { console.log('DEBUG: createPlanSingleStructured response:', JSON.stringify(resp.choices?.[0]?.message, null, 2).slice(0, 2000)); } catch (e) {}

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
              messages.push({ role: 'user', content: 'Your previous response did not match the schema. Return ONLY the JSON arguments for create_structured_plan that validate against the schema.' });
              continue;
            }
          } else {
            // plan 정규화 (유연한 길이 허용)
            if (!Array.isArray(parsed.plan)) parsed.plan = [];
            parsed.plan = parsed.plan.map(p => ({
              big_todo: String(p.big_todo || '').trim(),
              small_todos: Array.isArray(p.small_todos) ? p.small_todos.map(st => ({
                todo: String(st.todo || '').trim(),
                duration_minutes: Number.isInteger(st.duration_minutes) ? st.duration_minutes : (parseInt(st.duration_minutes) || 30)
              })) : []
            }));
            
            if (!parsed.key_concepts) parsed.key_concepts = [];
            if (!parsed.code_examples) parsed.code_examples = [];
            if (!parsed.difficulty) parsed.difficulty = 'intermediate';
            if (!parsed.summary) parsed.summary = '';
            return parsed;
          }
        } catch (e) {
          console.warn('createPlanSingleStructured: failed to parse function_call.arguments', e.message);
        }
      }
    } catch (err) {
      console.error('createPlanSingleStructured: openai request failed', err.message || err);
      break;
    }
  }

  // 폴백: 일반 요약을 호출한 뒤 휴리스틱으로 리스트 추출 시도
  const text = await createPlanSingle(id, subject, files);
  console.log('Fallback text for structured plan:\n', text);
  // 핵심 개념(라인) 추출
  const keyConcepts = [];
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const l of lines) {
    const m = l.match(/^(?:\d+\.|\d+\)|[-–•]\s*)(.*)$/);
    if (m && m[1].length < 200) keyConcepts.push(m[1]);
    if (keyConcepts.length >= 5) break;
  }
  
  // 폴백 시에는 단순 리스트를 Big Todo 하나에 몰아넣음
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
    return s;
  }
  const extracted = extractStepsFromTextLocal(text);
  const plan = [{
    big_todo: "학습 계획 (자동 추출됨)",
    small_todos: extracted.map(s => ({ todo: s, duration_minutes: 30 }))
  }];

  return { summary: text.split(/\r?\n\r?\n/)[0] || '', key_concepts: keyConcepts, code_examples: [], plan, difficulty: 'intermediate' };
}

// 여러 주제를 한 번에 계획해서 반환하는 함수
// 입력:
//  - id: 사용자/요청자 ID
//  - subjects: ['subject1','subject2',...]
//  - structured: true면 createPlanSingleStructured를 호출하여 배열/객체를 반환
//  - sourcePath: (선택) 외부 절대 경로. 제공되면 subjects 배열의 각 항목에 대해 이 경로를 사용하거나,
//                단일 경로로 처리할 수 있음. 현재 구현은 sourcePath가 있으면 subjects[0]에 대해 해당 경로를 사용.
// 출력:
//  - { id, plans: { subject: planOrObject, ... } }

async function createPlans(id, subjects, structured = false, sourcePath = null) {

  const result = { id, plans: {} };
  
  // sourcePath가 있으면 첫 번째 subject에 대해서만 처리 (또는 모든 subject가 같은 경로 공유?)
  // 사용자가 "로컬 파일 내에서 주소 따로 파라미터로 받아서"라고 했으므로,
  // sourcePath가 있으면 subjects 배열을 무시하고 sourcePath의 파일들로 하나의 요약을 생성할 수도 있지만,
  // 기존 구조(subject key)를 유지하기 위해 subjects[0]을 키로 사용합니다.
  
  const targetSubjects = sourcePath ? [subjects[0]] : subjects;

  for (const subject of targetSubjects) {
    const files = await collectFilesForSubject(subject, sourcePath);
    if (!files || files.length === 0) {
      result.plans[subject] = structured ? { error: 'No files found for this subject.' } : 'No files found for this subject.';
      continue;
    }

    try {
      if (structured) {
        // 파일별로 개별 요청 후 병합
        let combinedPlan = {
          summary: '',
          key_concepts: [],
          code_examples: [],
          plan: [],
          difficulty: 'intermediate'
        };

        const summaries = [];
        const difficulties = [];

        for (const file of files) {
          // 단일 파일에 대해 구조화된 계획 생성
          const singleRes = await createPlanSingleStructured(id, subject, [file]);
          
          // 요약 병합
          if (singleRes.summary) {
            summaries.push(`[${file.path}] ${singleRes.summary}`);
          }
          
          // 핵심 개념 병합 (중복 제거는 나중에 고려, 일단 합침)
          if (Array.isArray(singleRes.key_concepts)) {
            combinedPlan.key_concepts.push(...singleRes.key_concepts);
          }
          
          // 코드 예제 병합
          if (Array.isArray(singleRes.code_examples)) {
            combinedPlan.code_examples.push(...singleRes.code_examples);
          }
          
          // 난이도 수집
          if (singleRes.difficulty) {
            difficulties.push(singleRes.difficulty);
          }

          // Plan 병합 및 Reference 주입
          if (Array.isArray(singleRes.plan)) {
            for (const bigItem of singleRes.plan) {
              // Big Todo 제목에 파일명 추가 (선택 사항, 여기서는 유지)
              // bigItem.big_todo = `${bigItem.big_todo} (${file.path})`;
              
              if (Array.isArray(bigItem.small_todos)) {
                for (const smallItem of bigItem.small_todos) {
                  // Reference 강제 주입 (파일명)
                  smallItem.reference = file.path;
                }
              }
              combinedPlan.plan.push(bigItem);
            }
          }
        }

        // 최종 병합된 결과 정리
        combinedPlan.summary = summaries.join('\n\n');
        // 난이도는 가장 많이 나온 것 또는 첫 번째 것 사용 (여기서는 첫 번째)
        combinedPlan.difficulty = difficulties.length > 0 ? difficulties[0] : 'intermediate';
        // 중복 제거 (Set 이용)
        combinedPlan.key_concepts = [...new Set(combinedPlan.key_concepts)];
        combinedPlan.code_examples = [...new Set(combinedPlan.code_examples)];

        result.plans[subject] = combinedPlan;
      } else {
        const summary = await createPlanSingle(id, subject, files);
        result.plans[subject] = summary;
      }
    } catch (err) {
      console.error(`Error planning subject ${subject}:`, err.message || err);
      result.plans[subject] = structured ? { error: err.message || 'Failed to plan.' } : `Error: ${err.message || 'Failed to plan.'}`;
    }
  }
  return result;
}
module.exports = {
  createPlans,
  collectFilesForSubject,
};
