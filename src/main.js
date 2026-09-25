const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, screen, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { systemPrompt } = require('./prompts');
const setupAudio = require('./audio-main');
const setupStealth = require('./stealth');
const { readResume, EXTENSIONS } = require('./resume');

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = {
  // Any OpenAI-compatible API works. Groq has a free tier: https://console.groq.com/keys
  // For fully offline/free use Ollama: baseUrl http://localhost:11434/v1, apiKey "ollama".
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: '',
  chatModel: 'qwen/qwen3.8-27b',
  visionModel: 'qwen/qwen3.8-27b',
  sttModel: 'whisper-large-v3-turbo',
  context: '',
  mode: 'interview',
  expandedHeight: 400,
};

let win;

// One Ghost at a time: two copies fight over the system-audio capture.
if (!app.requestSingleInstanceLock()) {
  app.exit(0); // immediately, before any window or hotkey is created
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) win.showInactive();
  });
}
let history = [];

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// Always merges into the file on disk: a partial patch can never drop other keys (e.g. the API key).
function saveSettings(patch) {
  const merged = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE); // atomic: a crash mid-write can't truncate settings
  return merged;
}

function createWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: 600,
    height: 400,
    x: width - 620,
    y: 40,
    frame: false,
    transparent: true,
    resizable: true,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // The key part: excludes this window from screenshots and screen sharing
  // (NSWindowSharingNone on macOS, WDA_EXCLUDEFROMCAPTURE on Windows).
  // Diagnostics: renderer errors and failures land in userData/ghost.log for debugging.
  const LOG = path.join(app.getPath('userData'), 'ghost.log');
  const log = (...parts) => {
    try {
      fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${parts.join(' ')}\n`);
    } catch {}
  };
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') log(`console.${e.level}:`, e.message);
  });
  win.webContents.on('render-process-gone', (_e, d) => log('renderer gone:', JSON.stringify(d)));
  process.on('uncaughtException', (err) => log('main uncaught:', err.stack || err.message));
  ipcMain.on('log', (_e, msg) => log('renderer:', msg));
  log('--- started ---');

  win.setContentProtection(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'index.html'));
}

function toggleWindow() {
  if (win.isVisible()) win.hide();
  else win.showInactive();
}

function moveWindow(dx, dy) {
  const [x, y] = win.getPosition();
  win.setPosition(x + dx, y + dy);
}

async function captureScreen() {
  const display = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    },
  });
  const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!source) throw new Error('No screen source. Grant Screen Recording permission in System Settings.');
  // Keep the image small: Groq's free tier allows ~7k input tokens/minute and a
  // full-size screenshot alone costs ~3.8k. 1024px still reads code and questions fine.
  const img = source.thumbnail.resize({ width: Math.min(1024, source.thumbnail.getSize().width) });
  return `data:image/jpeg;base64,${img.toJPEG(65).toString('base64')}`;
}

// Free tiers are billed per input token, so a screenshot question drops the resume
// and the chat history: the image is the context that matters there.
function buildMessages(userContent, settings) {
  const hasImage = Array.isArray(userContent);
  const system = hasImage ? systemPrompt({ ...settings, context: '' }) : systemPrompt(settings);
  return [
    { role: 'system', content: system },
    ...(hasImage ? [] : history.slice(-6)),
    { role: 'user', content: userContent },
  ];
}

// "Please try again in 13.02s" -> 13020. Groq does not always say, so fall back to a fixed wait.
const DEFAULT_RETRY_MS = 12000;
function retryDelay(body) {
  const m = /try again in ([\d.]+)\s*s/i.exec(body);
  return m ? Math.min(25000, Math.ceil(parseFloat(m[1]) * 1000) + 400) : DEFAULT_RETRY_MS;
}

function friendlyError(status, body) {
  if (status === 429) {
    const wait = retryDelay(body);
    return (
      'Groq free limit reached (7,000 input tokens per minute). ' +
      (wait ? `Wait about ${Math.ceil(wait / 1000)} seconds and try again. ` : 'Wait a minute and try again. ') +
      'Screen questions cost the most, so use them less often, or shorten your background text in ⚙.'
    );
  }
  if (status === 401) return 'Your API key was rejected. Paste a fresh key in ⚙ (console.groq.com/keys).';
  if (status === 413) return 'That request was too large. Try a smaller screenshot or a shorter background text.';
  try {
    const msg = JSON.parse(body)?.error?.message;
    if (msg) return `API error ${status}: ${msg}`;
  } catch {}
  return `API error ${status}: ${body.slice(0, 300)}`;
}

async function streamChat(userContent, model) {
  const settings = loadSettings();
  if (!settings.apiKey) throw new Error('Add your API key in Settings (⚙).');

  const messages = buildMessages(userContent, settings);
  const url = `${settings.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const post = () =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({ model: model || settings.chatModel, messages, stream: true, temperature: 0.3 }),
    });

  // Free-tier tokens-per-minute limit: wait out the window and retry, twice at most.
  let res = await post();
  for (let attempt = 0; attempt < 2 && res.status === 429; attempt++) {
    const wait = retryDelay(await res.text());
    for (let left = Math.ceil(wait / 1000); left > 0; left--) {
      win.webContents.send('answer-status', `Groq free limit reached — retrying in ${left}s…`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    win.webContents.send('answer-status', 'Retrying…');
    res = await post();
  }
  if (!res.ok) throw new Error(friendlyError(res.status, await res.text()));

  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const data = line.replace(/^data: /, '').trim();
      if (!data || data === '[DONE]') continue;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) {
          answer += delta;
          win.webContents.send('answer-chunk', delta);
        }
      } catch {
        // partial or keep-alive line
      }
    }
  }

  // Store text only in history; images are too large to resend every turn.
  const textOnly = Array.isArray(userContent)
    ? userContent.filter((p) => p.type === 'text').map((p) => p.text).join('\n') + '\n[screenshot]'
    : userContent;
  history.push({ role: 'user', content: textOnly }, { role: 'assistant', content: answer });
  return answer;
}

ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('save-settings', (_e, settings) => saveSettings(settings));
ipcMain.handle('pick-resume', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose your resume',
    properties: ['openFile'],
    filters: [
      { name: 'Resume', extensions: EXTENSIONS },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (canceled || !filePaths.length) return null;
  return readResume(filePaths[0]);
});

ipcMain.handle('clear-history', () => {
  history = [];
});

ipcMain.handle('ask', async (_e, text) => streamChat(text));

ipcMain.handle('ask-screen', async (_e, text) => {
  const image = await captureScreen();
  const settings = loadSettings();
  return streamChat(
    [
      { type: 'text', text: text || 'Look at this screen. If there is a question or coding problem, solve it. Otherwise summarize what matters.' },
      { type: 'image_url', image_url: { url: image } },
    ],
    settings.visionModel
  );
});

ipcMain.handle('transcribe', async (_e, audioBuffer) => {
  const settings = loadSettings();
  if (!settings.apiKey) throw new Error('Add your API key in Settings (⚙).');
  const form = new FormData();
  // The renderer sends 16 kHz WAV (it no longer uses MediaRecorder); keep webm as a fallback.
  const isWav = Buffer.from(audioBuffer.slice(0, 4)).toString('ascii') === 'RIFF';
  form.append(
    'file',
    new Blob([audioBuffer], { type: isWav ? 'audio/wav' : 'audio/webm' }),
    isWav ? 'audio.wav' : 'audio.webm'
  );
  form.append('model', settings.sttModel);
  const res = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(friendlyError(res.status, await res.text()));
  return (await res.json()).text;
});

ipcMain.on('hide', () => win.hide());

// Compact bar while listening; full height once an answer arrives. The top edge stays put.
let expandedHeight = null;
ipcMain.on('window-size', (_e, mode, compactHeight) => {
  if (!win || win.isDestroyed()) return;
  const { x, y, width, height } = win.getBounds();
  if (mode === 'compact') {
    const target = Math.max(60, Math.round(compactHeight || 110));
    if (height > target + 40) {
      expandedHeight = height;
      saveSettings({ expandedHeight: height });
    }
    win.setBounds({ x, y, width, height: target });
  } else {
    const target = expandedHeight || loadSettings().expandedHeight || 400;
    if (height >= target) return;
    const maxH = screen.getDisplayMatching(win.getBounds()).workArea.height - 20;
    win.setBounds({ x, y, width, height: Math.min(target, maxH) });
  }
});

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide(); // no Dock icon, not in Cmd+Tab
  createWindow();
  setupAudio({ win, ipcMain, loadSettings });
  setupStealth({ win, app, globalShortcut, ipcMain });

  const log = (msg) => {
    try {
      fs.appendFileSync(path.join(app.getPath('userData'), 'ghost.log'), `[${new Date().toISOString()}] ${msg}\n`);
    } catch {}
  };
  const send = (channel) => () => {
    log(`hotkey -> ${channel}`);
    if (!win.isVisible()) win.showInactive();
    win.webContents.send(channel);
  };
  // A shortcut another app already owns silently fails to register, so record the result.
  const register = (accel, fn) => {
    const ok = globalShortcut.register(accel, fn);
    if (!ok) log(`SHORTCUT NOT AVAILABLE: ${accel} (another app has it)`);
    return ok;
  };
  register('CommandOrControl+Shift+Space', toggleWindow);
  register('CommandOrControl+Shift+Return', send('hotkey-screen'));
  register('CommandOrControl+Shift+R', send('hotkey-record'));
  register('CommandOrControl+Shift+K', send('hotkey-clear'));
  register('CommandOrControl+Shift+M', send('hotkey-mode'));
  register('CommandOrControl+Shift+I', () => {
    win.show();
    win.focus();
    win.webContents.send('hotkey-focus');
  });
  register('CommandOrControl+Shift+Up', () => moveWindow(0, -40));
  register('CommandOrControl+Shift+Down', () => moveWindow(0, 40));
  register('CommandOrControl+Shift+Left', () => moveWindow(-40, 0));
  register('CommandOrControl+Shift+Right', () => moveWindow(40, 0));
  register('CommandOrControl+Shift+Q', () => app.quit());
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
