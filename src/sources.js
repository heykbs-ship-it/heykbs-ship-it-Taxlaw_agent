// 두 출처(국세법령정보시스템, 사법정보공개포털 판례)만 읽는 브라우저 계층.
// Electron의 숨겨진 BrowserWindow를 실제 브라우저처럼 사용한다.
const { BrowserWindow, session } = require('electron');

const ALLOWED_HOSTS = ['taxlaw.nts.go.kr', 'portal.scourt.go.kr'];
const TAXLAW = 'https://taxlaw.nts.go.kr';
const PORTAL = 'https://portal.scourt.go.kr';
const MAX_CHARS = 14000;

let win = null;
let lastRequestAt = 0;
let queue = Promise.resolve();

function isAllowedUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && ALLOWED_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

function getWindow() {
  if (win && !win.isDestroyed()) return win;
  const ses = session.fromPartition('persist:sources');
  // 페이지(메인 프레임) 이동은 허용된 두 사이트로만 제한
  ses.webRequest.onBeforeRequest((details, cb) => {
    if (details.resourceType === 'mainFrame' && !isAllowedUrl(details.url)) {
      return cb({ cancel: true });
    }
    cb({});
  });
  win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { partition: 'persist:sources', contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.setAudioMuted(true);
  return win;
}

// 두 사이트에 부담을 주지 않도록 요청을 한 줄로 세우고 간격을 둔다
function serial(fn) {
  const run = queue.then(async () => {
    const wait = 800 - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastRequestAt = Date.now();
    }
  });
  queue = run.catch(() => {});
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function load(url) {
  if (!isAllowedUrl(url)) throw new Error('허용되지 않은 주소입니다: ' + url);
  const w = getWindow();
  try {
    await w.loadURL(url);
  } catch (e) {
    // SPA가 내부적으로 이동하면 ERR_ABORTED가 날 수 있으므로 무시하고 내용으로 판단
    if (!String(e.message).includes('ERR_ABORTED')) throw e;
  }
  return w;
}

async function exec(w, js) {
  return w.webContents.executeJavaScript(js, true);
}

// 조건식이 참이 될 때까지 기다림
async function waitFor(w, conditionJs, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await exec(w, `(()=>{try{return !!(${conditionJs})}catch(e){return false}})()`)) return true;
    } catch {}
    await sleep(400);
  }
  return false;
}

function clip(text, offset = 0, focus) {
  text = (text || '').replace(/ /g, ' ').replace(/\n[ \t]+/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const total = text.length;
  if (focus) {
    // 키워드 주변만 잘라서 돌려줌 (긴 문서에서 필요한 부분 찾기)
    const words = String(focus).split(/\s+/).filter(Boolean);
    const hits = [];
    for (const word of words) {
      let i = text.indexOf(word);
      while (i !== -1 && hits.length < 12) {
        hits.push(i);
        i = text.indexOf(word, i + word.length);
      }
    }
    hits.sort((a, b) => a - b);
    if (hits.length) {
      const parts = [];
      let lastEnd = -1;
      for (const h of hits) {
        const s = Math.max(0, h - 700);
        const e = Math.min(total, h + 1300);
        if (s <= lastEnd) {
          parts[parts.length - 1].e = e;
        } else parts.push({ s, e });
        lastEnd = e;
      }
      let out = parts.map((p) => `[위치 ${p.s}~${p.e}]\n` + text.slice(p.s, p.e)).join('\n…\n');
      if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS);
      return { total_chars: total, focus, excerpt: out };
    }
    return { total_chars: total, focus, excerpt: '(키워드를 찾지 못했습니다. offset으로 앞부분부터 읽으세요)\n' + text.slice(0, 3000) };
  }
  const chunk = text.slice(offset, offset + MAX_CHARS);
  const next = offset + MAX_CHARS < total ? offset + MAX_CHARS : null;
  return { total_chars: total, offset, next_offset: next, text: chunk };
}

// ───────────── 국세법령정보시스템 ─────────────

// 분류 탭 (사이트의 data-collection-type 값)
const TAXLAW_CATEGORIES = {
  all: null,
  statute: 'statute', // 법령
  interpretation: 'question', // 세법해석례 (질의회신·예규·사전답변)
  precedent: 'precedent', // 판례·결정례 (조세심판·심사·국세청 수록 판례)
  library: 'formerLibrary', // 전자도서관 (집행기준 책자 등)
};

async function taxlawSearch({ query, category = 'all' }) {
  return serial(async () => {
    const url = `${TAXLAW}/is/USEISA001M.do?schVcb=${encodeURIComponent(query)}&searchType=totalSearch`;
    const w = await load(url);
    const ok = await waitFor(
      w,
      `/검색 결과 총|검색된 결과가 없|결과가 없습니다/.test(document.body.innerText) && (document.querySelectorAll('a.subs_title').length>0 || /결과가 없/.test(document.body.innerText))`,
      20000
    );
    if (!ok) return { error: '검색 결과를 불러오지 못했습니다(시간 초과).', search_url: url };
    await sleep(500);
    const tab = TAXLAW_CATEGORIES[category];
    if (tab) {
      // 분류 탭을 누르면 그 분류의 결과가 최대 50건까지 나온다
      await exec(w, `(() => { const s = document.querySelector('main [data-collection-type="${tab}"]'); if (s) s.parentElement.click(); return !!s; })()`);
      await sleep(3000);
      await waitFor(w, `document.querySelectorAll('a.subs_title').length > 0 || /결과가 없/.test(document.body.innerText)`, 10000);
    }
    const data = await exec(
      w,
      `(async () => {
        const opened = [];
        window.open = function(u){ opened.push(String(u)); return null; };
        const body = document.querySelector('main') || document.body;
        const summary = (body.innerText.match(/검색 결과 총 [\\d,]+건/) || [''])[0];
        const counts = {};
        for (const s of document.querySelectorAll('main [data-collection-type]')) {
          const label = s.parentElement.innerText.replace(/\\([\\d,]+\\)/, '').trim();
          counts[label] = Number(s.innerText.replace(/\\D/g, '')) || 0;
        }
        const items = [];
        const seen = new Set();
        const links = [...document.querySelectorAll('a.subs_title')];
        for (const a of links) {
          const wrap = a.closest('.substance_wrap') || a.parentElement;
          const tags = [...a.querySelectorAll('ul li')].map(li => li.getAttribute('title') || li.innerText.trim());
          const title = (a.querySelector('strong') || a).innerText.replace(/\\s+/g,' ').trim();
          const detail = wrap.querySelector('.subs_detail');
          const detailText = detail ? detail.innerText.replace(/\\s+/g,' ').trim() : '';
          const snippetEl = wrap.querySelector('.subs_text');
          const snippet = snippetEl ? snippetEl.innerText.replace(/\\s+/g,' ').trim().slice(0, 220) : '';
          const before = opened.length;
          try { a.click(); } catch(e) {}
          await new Promise(r => setTimeout(r, 120));
          const href = opened.length > before ? opened[opened.length-1] : null;
          const full = href ? new URL(href, location.origin).href : null;
          const key = full || (title + detailText);
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({ type: tags.join('/'), title, info: detailText, snippet, url: full });
        }
        return { summary, counts, items };
      })()`
    );
    data.items = data.items.slice(0, 30).map((it, i) => ({ no: i + 1, ...it }));
    const note = tab
      ? '이 분류의 상위 결과입니다. 원하는 문서가 없으면 검색어를 바꾸세요.'
      : '통합검색은 분류별 상위 몇 건만 보입니다. 더 보려면 category를 지정해 다시 검색하세요.';
    return { source: '국세법령정보시스템', query, category, search_url: url, note, ...data };
  });
}

async function taxlawRead({ url, offset = 0, focus }) {
  return serial(async () => {
    const full = new URL(url, TAXLAW).href;
    if (new URL(full).hostname !== 'taxlaw.nts.go.kr') throw new Error('국세법령정보시스템 주소만 읽을 수 있습니다.');
    const w = await load(full);
    await waitFor(w, `document.body && document.body.innerText.length > 300`, 15000);
    await sleep(1500); // 본문 비동기 로딩 대기
    const { title, text } = await exec(
      w,
      `(() => {
        const clone = document.body.cloneNode(true);
        clone.querySelectorAll('script,style,header,footer,nav,.skip,.gnb,.lnb,#header,#footer').forEach(e => e.remove());
        return { title: document.title, text: clone.innerText };
      })()`
    );
    return { source: '국세법령정보시스템', title, url: full, ...clip(text, offset, focus) };
  });
}

// ───────────── 사법정보공개포털 판례 ─────────────

async function ensurePortal() {
  const w = getWindow();
  const cur = w.webContents.getURL();
  if (!cur.startsWith(PORTAL)) {
    await load(`${PORTAL}/pgp/index.on?m=PGP1011M01&l=N&c=900`);
    await waitFor(w, `document.readyState === 'complete'`, 15000);
    await sleep(1500);
  }
  return w;
}

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

async function scourtSearch({ query = '', case_number = '', reference_law = '', date_from = '', date_to = '', page = 1 }) {
  return serial(async () => {
    const w = await ensurePortal();
    const param = {
      srchwd: query,
      sort: 'jis_jdcpc_instn_dvs_cd_s asc, $relevance desc, prnjdg_ymd_o desc, jdcpct_gr_cd_s asc',
      sortType: '정확도',
      searchRange: '', tpcJdcpctCsAlsYn: '',
      csNoLstCtt: case_number, csNmLstCtt: '', prvsRefcCtt: reference_law,
      searchScope: '', jisJdcpcInstnDvsCd: '', jdcpctCdcsCd: '',
      prnjdgYmdFrom: String(date_from).replace(/\D/g, ''), prnjdgYmdTo: String(date_to).replace(/\D/g, ''),
      grpJdcpctGrCd: '', cortNm: '', pageNo: String(page),
      jisJdcpcInstnDvsCdGrp: '', grpJdcpctGrCdGrp: '', jdcpctCdcsCdGrp: '', adjdTypCdGrp: '',
      pageSize: '20', reSrchFlag: '', befSrchwd: '', preSrchConditions: '', initYn: 'N', totalCount: '',
      jdcpctGrCd: '111|112|130|141|180|182|232|235', category: 'jdcpct', isKwdSearch: 'N',
    };
    const res = await exec(
      w,
      `fetch('/pgp/pgp1011/selectJdcpctSrchRsltLst.on', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(${JSON.stringify({ dma_searchParam: param })})
      }).then(r => r.json()).catch(e => ({ error: String(e) }))`
    );
    if (res.error) return { error: '판례 검색 실패: ' + res.error };
    const d = res.data || {};
    if (d.mecroYn === 'Y') {
      return { error: '사법정보공개포털이 자동 접근을 제한했습니다. 잠시 후 다시 시도하거나 사이트에서 직접 확인하세요.' };
    }
    const items = (d.dlt_jdcpctRslt || []).map((x, i) => ({
      no: (page - 1) * 20 + i + 1,
      case: `${x.cortNm} ${fmtDate(x.prnjdgYmd)} 선고 ${x.csNoLstCtt} ${x.adjdTypNm || ''}`.trim(),
      case_name: x.csNmLstCtt,
      kind: x.grpJdcpctGrNm,
      publication: x.jdcpctPublcCtt,
      issues: stripTags(x.dcdcsCtt).slice(0, 500),
      summary: stripTags(x.jdcpctSumrCtt).slice(0, 500),
      id: x.jisCntntsSrno,
      url: `${PORTAL}/pgp/main.on?w2xPath=PGP1011M04&jisCntntsSrno=${x.jisCntntsSrno}&c=900`,
    }));
    return { source: '대법원 사법정보공개포털(판례)', query, case_number, total: Number(d.totalCount || 0), page, items };
  });
}

function fmtDate(ymd) {
  const s = String(ymd || '');
  return s.length === 8 ? `${s.slice(0, 4)}. ${Number(s.slice(4, 6))}. ${Number(s.slice(6))}.` : s;
}

async function scourtRead({ id, offset = 0, focus }) {
  return serial(async () => {
    if (!/^\d+$/.test(String(id))) throw new Error('판례 id(jisCntntsSrno)는 숫자여야 합니다.');
    const url = `${PORTAL}/pgp/main.on?w2xPath=PGP1011M04&jisCntntsSrno=${id}&c=900`;
    const w = await load(url);
    const ok = await waitFor(w, `/【(판시사항|판결요지|전\\s*문|주\\s*문|이\\s*유)】/.test(document.body.innerText)`, 20000);
    if (!ok) return { error: '판례 본문을 불러오지 못했습니다.', url };
    await sleep(800);
    const { title, text } = await exec(
      w,
      `(() => {
        const t = document.body.innerText;
        const i = t.search(/【(판시사항|판결요지|전\\s*문|주\\s*문)】/);
        return { title: document.title, text: i >= 0 ? t.slice(i) : t };
      })()`
    );
    return { source: '대법원 사법정보공개포털(판례)', title, url, ...clip(text, offset, focus) };
  });
}

function destroy() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

module.exports = { taxlawSearch, taxlawRead, scourtSearch, scourtRead, isAllowedUrl, destroy };
