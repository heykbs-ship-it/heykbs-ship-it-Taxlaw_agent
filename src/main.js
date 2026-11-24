const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { Agent } = require('./agent');
const sources = require('./sources');

const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');
const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'];

let mainWin;
let agent = null;

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'));
    let apiKey = '';
    if (raw.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
      apiKey = safeStorage.decryptString(Buffer.from(raw.apiKeyEnc, 'base64'));
    }
    return { apiKey, model: raw.model || MODELS[0] };
  } catch {
    return { apiKey: '', model: MODELS[0] };
  }
}

function writeConfig({ apiKey, model }) {
  const out = { model };
  if (apiKey && safeStorage.isEncryptionAvailable()) {
    out.apiKeyEnc = safeStorage.encryptString(apiKey).toString('base64');
  }
  fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(out));
}

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1200,
    height: 860,
    title: '세법 근거 에이전트',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWin.setMenuBarVisibility(false);
  mainWin.loadFile(path.join(__dirname, 'index.html'));
  // 화면 안의 링크는 기본 브라우저로 (두 사이트만)
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (sources.isAllowedUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e) => e.preventDefault());
}

ipcMain.handle('config:get', () => {
  const c = readConfig();
  return { hasKey: !!c.apiKey, model: c.model, models: MODELS };
});

ipcMain.handle('config:set', (_e, { apiKey, model }) => {
  const cur = readConfig();
  writeConfig({ apiKey: apiKey || cur.apiKey, model: model || cur.model });
  agent = null; // 새 설정으로 다시 생성
  return true;
});

ipcMain.handle('agent:ask', async (e, question) => {
  const cfg = readConfig();
  if (!cfg.apiKey) throw new Error('설정에서 Anthropic API 키를 먼저 입력하세요.');
  if (!agent) agent = new Agent({ apiKey: cfg.apiKey, model: cfg.model });
  const send = (ev) => {
    if (!e.sender.isDestroyed()) e.sender.send('agent:event', ev);
  };
  return agent.ask(question, send);
});

ipcMain.handle('agent:reset', () => {
  if (agent) agent.reset();
  return true;
});

ipcMain.handle('agent:abort', () => {
  if (agent) agent.abort();
  return true;
});

ipcMain.handle('open:external', (_e, url) => {
  if (sources.isAllowedUrl(url)) shell.openExternal(url);
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  sources.destroy();
  app.quit();
});
