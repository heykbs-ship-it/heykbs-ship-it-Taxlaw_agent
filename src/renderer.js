const $ = (id) => document.getElementById(id);
const chat = $('chat');
const log = $('log');
let busy = false;
let tokens = { in: 0, out: 0 };

const TOOL_LABEL = {
  taxlaw_search: '국세법령 검색',
  taxlaw_read: '국세법령 열람',
  scourt_search: '판례 검색',
  scourt_read: '판례 열람',
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 간단하고 안전한 마크다운 변환 (HTML은 모두 이스케이프)
function md(src) {
  const lines = esc(src).split('\n');
  let html = '';
  let list = null;
  const inline = (t) =>
    t
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a data-href="$2">$1</a>')
      .replace(/(^|[\s(])(https:\/\/(?:taxlaw\.nts\.go\.kr|portal\.scourt\.go\.kr)[^\s)<]*)/g, '$1<a data-href="$2">$2</a>');
  const closeList = () => {
    if (list) html += `</${list}>`;
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) {
      closeList();
      html += `<h${Math.min(m[1].length + 1, 4)}>${inline(m[2])}</h${Math.min(m[1].length + 1, 4)}>`;
    } else if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
      if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
      html += `<li>${inline(m[1])}</li>`;
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return html;
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-href]');
  if (a) {
    e.preventDefault();
    window.api.openExternal(a.dataset.href);
  }
});

function addMsg(role, content) {
  $('empty')?.remove();
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const b = document.createElement('div');
  b.className = 'b';
  if (role === 'bot') {
    b.innerHTML = md(content);
    const tools = document.createElement('div');
    tools.className = 'tools';
    const copy = document.createElement('button');
    copy.textContent = '복사';
    copy.onclick = () => {
      navigator.clipboard.writeText(content);
      copy.textContent = '복사됨';
      setTimeout(() => (copy.textContent = '복사'), 1500);
    };
    tools.appendChild(copy);
    div.appendChild(b);
    div.appendChild(tools);
  } else {
    b.textContent = content;
    div.appendChild(b);
  }
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

function addLog(html, cls = '') {
  const d = document.createElement('div');
  d.className = 'ev ' + cls;
  d.innerHTML = html;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

let statusEl = null;
function setStatus(t) {
  if (!statusEl) {
    statusEl = document.createElement('div');
    statusEl.className = 'status';
    chat.appendChild(statusEl);
  }
  statusEl.textContent = t;
  chat.scrollTop = chat.scrollHeight;
}
function clearStatus() {
  statusEl?.remove();
  statusEl = null;
}

window.api.onEvent((ev) => {
  if (ev.type === 'tool') {
    const label = TOOL_LABEL[ev.name] || ev.name;
    const arg = ev.input.query || ev.input.case_number || ev.input.focus || ev.input.url || ev.input.id || '';
    addLog(`<span class="n">${esc(label)}</span> ${esc(arg)}`, 'tool');
    setStatus(`${label} 중… ${arg}`);
  } else if (ev.type === 'tool_result') {
    const link = ev.url ? ` <a data-href="${esc(ev.url)}">열기</a>` : '';
    addLog(`→ ${esc(ev.summary)}${link}`, ev.summary.startsWith('오류') ? 'err' : '');
  } else if (ev.type === 'thinking') {
    addLog(`💭 ${esc(ev.text.slice(0, 400))}`);
  } else if (ev.type === 'usage') {
    const u = ev.usage || {};
    tokens.in += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    tokens.out += u.output_tokens || 0;
    $('cost').textContent = `토큰 입력 ${tokens.in.toLocaleString()} · 출력 ${tokens.out.toLocaleString()}`;
  }
});

async function ask() {
  const q = $('q').value.trim();
  if (!q || busy) return;
  busy = true;
  $('btnAsk').disabled = true;
  $('btnStop').disabled = false;
  $('q').value = '';
  addMsg('user', q);
  addLog(`<b>질문</b> ${esc(q.slice(0, 120))}`);
  setStatus('조사 계획 중…');
  try {
    const answer = await window.api.ask(q);
    clearStatus();
    addMsg('bot', answer);
  } catch (e) {
    clearStatus();
    const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    addMsg('bot', '**오류:** ' + msg);
    addLog(esc(msg), 'err');
  } finally {
    busy = false;
    $('btnAsk').disabled = false;
    $('btnStop').disabled = true;
  }
}

$('btnAsk').onclick = ask;
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey) ask();
});
$('btnStop').onclick = () => window.api.abort();
$('btnNew').onclick = async () => {
  if (busy) return;
  await window.api.reset();
  chat.innerHTML = '';
  log.innerHTML = '<h2>조사 기록</h2>';
  tokens = { in: 0, out: 0 };
  $('cost').textContent = '';
};

async function openSettings() {
  const c = await window.api.getConfig();
  $('model').innerHTML = c.models.map((m) => `<option ${m === c.model ? 'selected' : ''}>${m}</option>`).join('');
  $('key').value = '';
  $('key').placeholder = c.hasKey ? '저장된 키 있음 (바꾸려면 새 키 입력)' : 'sk-ant-...';
  $('dlg').showModal();
}
$('btnSettings').onclick = openSettings;
$('dlgCancel').onclick = () => $('dlg').close();
$('dlgSave').onclick = async () => {
  await window.api.setConfig({ apiKey: $('key').value.trim(), model: $('model').value });
  $('dlg').close();
};

window.api.getConfig().then((c) => {
  if (!c.hasKey) openSettings();
});
