// Claude API 도구 사용 루프. 도구는 두 출처를 읽는 4개뿐이다.
const Anthropic = require('@anthropic-ai/sdk');
const sources = require('./sources');

const SYSTEM_PROMPT = `당신은 한국 세무 리서치 에이전트입니다. 사용자는 세무사입니다.

## 근거 원칙 (가장 중요)
- 결론과 판단의 근거는 오직 이번 대화에서 도구로 직접 읽은 자료뿐입니다:
  1) 국세법령정보시스템(taxlaw.nts.go.kr): 법령, 집행기준, 질의회신·예규, 조세심판·판례 등
  2) 대법원 사법정보공개포털(portal.scourt.go.kr)의 판례
- 학습으로 알고 있는 내용은 "어떤 검색어로 찾을지" 정하는 데만 쓰고, 근거로 제시하지 마세요.
  도구로 확인하지 못한 조문·판례·예규는 인용하지 말고 "확인하지 못함"이라고 적으세요.
- 판례 번호, 문서번호, 조문 번호, 날짜, 금액은 도구 결과에 있는 그대로만 적으세요. 추측해서 채우지 마세요.

## 조사 방법
- 질문을 쟁점으로 나누고, 쟁점마다 국세법령정보시스템과 판례를 모두 검색하세요.
- 검색 결과 요약(snippet)만 보고 결론 내리지 말고, 핵심 문서는 read 도구로 본문을 읽으세요.
  긴 문서는 focus(키워드)로 필요한 부분을 찾아 읽으세요.
- 검색어는 짧은 핵심어 2~4개가 잘 맞습니다. 결과가 없거나 엉뚱하면 동의어·법조문 표현으로 바꿔 다시 검색하세요.
- taxlaw_search는 먼저 category 없이 통합검색으로 분포를 보고, 많은 분류는 category를 지정해 다시 검색하세요.
- 사건번호를 알면 scourt_search의 case_number로 바로 찾으세요.
- 해석례·판례의 날짜와 당시 법령을 확인하고, 이후 법 개정으로 달라졌을 수 있으면 반드시 표시하세요.
- 같은 쟁점에 서로 다른 해석이 있으면 양쪽을 모두 제시하고 최신 것과 상위 기관(대법원 > 조세심판원 > 국세청 해석) 순서를 밝히세요.

## 답변 형식 (한국어)
1. **결론** — 2~4문장. 근거가 부족하면 그렇다고 분명히 쓰세요.
2. **쟁점별 검토** — 쟁점마다 근거 자료의 요지와 적용.
3. **근거 자료 목록** — 각 항목: 구분(법령/집행기준/해석례/심판례/판례), 문서번호 또는 사건번호, 날짜, 한 줄 요지, URL.
4. **유의사항** — 개정 가능성, 사실관계에 따라 달라지는 부분, 추가 확인이 필요한 점.
본문에서 근거를 말할 때는 [1], [2]처럼 근거 자료 목록 번호를 붙이세요.`;

const TOOLS = [
  {
    name: 'taxlaw_search',
    description:
      '국세법령정보시스템 통합검색. 법령, 세법해석례(질의회신·예규), 판례·결정례(조세심판 등), 전자도서관(집행기준 책자) 결과를 돌려준다. 각 결과의 url을 taxlaw_read로 읽을 수 있다.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색어 (짧은 핵심어 2~4개)' },
        category: {
          type: 'string',
          enum: ['all', 'statute', 'interpretation', 'precedent', 'library'],
          description:
            'all=통합(분류별 상위 몇 건만), statute=법령, interpretation=세법해석례(질의회신·예규·사전답변), precedent=판례·결정례(조세심판·심사 등), library=전자도서관(집행기준 책자). 분류를 지정하면 최대 30건.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'taxlaw_read',
    description:
      '국세법령정보시스템 문서 본문 읽기. taxlaw_search 결과의 url을 넣는다. 긴 문서는 next_offset으로 이어 읽거나 focus 키워드로 해당 부분만 읽는다.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        offset: { type: 'integer', description: '읽기 시작 위치(글자). 기본 0' },
        focus: { type: 'string', description: '이 키워드 주변만 발췌 (공백으로 여러 개)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'scourt_search',
    description:
      '대법원 사법정보공개포털 판례 검색(대법원·하급심 공개 판례). 판시사항·판결요지 요약과 id를 돌려준다. 본문은 scourt_read로 읽는다.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색어' },
        case_number: { type: 'string', description: '사건번호로 찾을 때 (예: 2019두12345)' },
        reference_law: { type: 'string', description: '참조조문으로 좁히기 (예: 법인세법 제52조)' },
        date_from: { type: 'string', description: '선고일 시작 YYYYMMDD' },
        date_to: { type: 'string', description: '선고일 끝 YYYYMMDD' },
        page: { type: 'integer', description: '결과 페이지(20건씩). 기본 1' },
      },
    },
  },
  {
    name: 'scourt_read',
    description: '판례 전문 읽기. scourt_search 결과의 id를 넣는다. focus 키워드로 필요한 부분만 읽을 수 있다.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'scourt_search 결과의 id' },
        offset: { type: 'integer' },
        focus: { type: 'string' },
      },
      required: ['id'],
    },
  },
];

const HANDLERS = {
  taxlaw_search: sources.taxlawSearch,
  taxlaw_read: sources.taxlawRead,
  scourt_search: sources.scourtSearch,
  scourt_read: sources.scourtRead,
};

class Agent {
  constructor({ apiKey, model, maxSteps = 30 }) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.maxSteps = maxSteps;
    this.messages = [];
    this.aborted = false;
  }

  reset() {
    this.messages = [];
  }

  abort() {
    this.aborted = true;
  }

  // onEvent({type:'tool', name, input} | {type:'tool_result', name, summary} | {type:'text', text} | {type:'usage', ...})
  async ask(question, onEvent) {
    const before = this.messages.length;
    try {
      return await this._ask(question, onEvent);
    } catch (e) {
      // 중간에 실패하면 대화 기록을 질문 전 상태로 되돌려 다음 질문이 깨지지 않게 함
      this.messages.length = before;
      throw e;
    }
  }

  async _ask(question, onEvent) {
    this.aborted = false;
    this.messages.push({ role: 'user', content: question });
    for (let step = 0; step < this.maxSteps; step++) {
      if (this.aborted) throw new Error('사용자가 중지했습니다.');
      const resp = await this.client.messages.create({
        model: this.model,
        max_tokens: 8000,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages: this.messages,
      });
      onEvent({ type: 'usage', usage: resp.usage });
      this.messages.push({ role: 'assistant', content: resp.content });

      const toolUses = resp.content.filter((b) => b.type === 'tool_use');
      for (const b of resp.content) {
        if (b.type === 'text' && b.text.trim() && toolUses.length) onEvent({ type: 'thinking', text: b.text });
      }
      if (resp.stop_reason !== 'tool_use' || !toolUses.length) {
        const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        onEvent({ type: 'answer', text });
        return text;
      }

      const results = [];
      for (const tu of toolUses) {
        if (this.aborted) throw new Error('사용자가 중지했습니다.');
        onEvent({ type: 'tool', name: tu.name, input: tu.input });
        let out;
        try {
          const fn = HANDLERS[tu.name];
          if (!fn) throw new Error('알 수 없는 도구');
          out = await fn(tu.input || {});
        } catch (e) {
          out = { error: String(e.message || e) };
        }
        onEvent({ type: 'tool_result', name: tu.name, summary: summarize(tu.name, out), url: out.url || out.search_url });
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(out),
          is_error: !!out.error,
        });
      }
      this.messages.push({ role: 'user', content: results });
    }
    // 단계 한도 도달: 지금까지 근거로 정리하도록 마지막 요청
    this.messages.push({
      role: 'user',
      content: '조사 단계 한도에 도달했습니다. 더 이상 도구를 쓰지 말고, 지금까지 읽은 자료만으로 답변 형식에 맞춰 정리해 주세요.',
    });
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      tool_choice: { type: 'none' },
      messages: this.messages,
    });
    this.messages.push({ role: 'assistant', content: resp.content });
    const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    onEvent({ type: 'answer', text });
    return text;
  }
}

function summarize(name, out) {
  if (out.error) return '오류: ' + out.error;
  if (name === 'taxlaw_search') return `${out.summary || ''} — 상위 ${out.items?.length || 0}건 수집`;
  if (name === 'scourt_search') return `판례 ${out.total}건 중 ${out.items?.length || 0}건`;
  return `${out.title || ''} (${out.total_chars || 0}자${out.focus ? ', 발췌: ' + out.focus : ''})`;
}

module.exports = { Agent, SYSTEM_PROMPT, TOOLS };
