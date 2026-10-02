const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  desktopCapturer,
  screen,
  dialog,
  nativeImage,
  systemPreferences,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
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
  language: 'auto', // auto | en | hi | hinglish — what the other people speak
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

function logLine(msg) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'ghost.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
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

// ---------- Screen capture (ONLY on an explicit ask: ⌘⇧Return or the 🖥 button) ----------
// Nothing here runs on a timer or from live listening. The image lives only in memory for
// the one request and is never written into history, settings or the log.

// One desktopCapturer.getSources() at a time. The live-audio handler (audio-main.js) and
// the stealth self-test also call it; overlapping calls can fail with "Failed to get sources."
let captureChain = Promise.resolve();
function getScreenSources(opts) {
  const run = async () => {
    try {
      return await desktopCapturer.getSources(opts);
    } catch (err) {
      await new Promise((r) => setTimeout(r, 400)); // transient ScreenCaptureKit failure: try once more
      return desktopCapturer.getSources(opts);
    }
  };
  const p = captureChain.then(run, run);
  captureChain = p.catch(() => {});
  return p;
}

// Which app macOS asks about: when started with `npm start` it is the terminal, not Ghost.
function captureAppName() {
  if (app.isPackaged) return 'Ghost';
  const t = process.env.TERM_PROGRAM || '';
  if (/vscode/i.test(t)) return 'Visual Studio Code';
  if (/Apple_Terminal/i.test(t)) return 'Terminal';
  if (/iTerm/i.test(t)) return 'iTerm';
  if (t) return t;
  return 'the app you started Ghost from (Terminal, VS Code…)';
}

function screenPermissionError() {
  const who = captureAppName();
  return new Error(
    `Ghost can't see your screen yet. Open System Settings → Privacy & Security → ` +
      `Screen & System Audio Recording, turn on "${who}", then quit Ghost (⌘⇧Q) and open it again.`
  );
}

function screenPermission() {
  if (process.platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch {
    return 'unknown';
  }
}

// Last resort on macOS: the built-in screencapture tool into a private temp file, deleted at once.
// It honours content protection, so the Ghost window is left out here too.
function captureWithScreencaptureTool() {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-'));
    const file = path.join(dir, 'screen.jpg');
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    execFile('/usr/sbin/screencapture', ['-x', '-m', '-t', 'jpg', file], { timeout: 10000 }, (err) => {
      try {
        if (err) throw err;
        const img = nativeImage.createFromBuffer(fs.readFileSync(file));
        if (img.isEmpty()) throw new Error('screencapture returned an empty image');
        resolve(img);
      } catch (e) {
        reject(e);
      } finally {
        cleanup();
      }
    });
  });
}

// Groq shrinks every image to a fixed pixel budget, so on a busy screen the question becomes
// tiny text. Cropping to the window the user is working in gives the question more detail
// (and costs fewer tokens: ~1.4k instead of ~2.5k for a typical browser window).
const SCREEN_MAX = 1600; // longest side sent to the API
const CAPTURE_MAX = 2560; // longest side captured, so a crop keeps enough detail

// macOS: bounds (in screen points) of the frontmost normal window that isn't Ghost.
// CGWindowListCopyWindowInfo lists on-screen windows front to back, and reading bounds
// needs no Accessibility permission.
const FRONT_WINDOW_JXA = `
ObjC.import('CoreGraphics');
const pid = Number($.NSProcessInfo.processInfo.environment.objectForKey('GHOST_PID').js);
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
const w = list.find((w) => w.kCGWindowLayer === 0 && w.kCGWindowAlpha > 0 && w.kCGWindowOwnerPID !== pid &&
  w.kCGWindowBounds.Width >= 300 && w.kCGWindowBounds.Height >= 200);
JSON.stringify(w ? { x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, width: w.kCGWindowBounds.Width,
  height: w.kCGWindowBounds.Height, app: w.kCGWindowOwnerName } : null);`;

function frontWindowBounds() {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', FRONT_WINDOW_JXA],
      { timeout: 2000, env: { ...process.env, GHOST_PID: String(process.pid) } },
      (err, out) => {
        try {
          resolve(err ? null : JSON.parse(out));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

// Crop img (a capture of `display`) to the front window. Small windows (a Zoom thumbnail,
// a mini player) are not worth trusting, so they keep the whole screen.
function cropToWindow(img, display, win) {
  if (!win) return null;
  const d = display.bounds;
  const x0 = Math.max(win.x, d.x);
  const y0 = Math.max(win.y, d.y);
  const x1 = Math.min(win.x + win.width, d.x + d.width);
  const y1 = Math.min(win.y + win.height, d.y + d.height);
  if (x1 <= x0 || y1 <= y0) return null;
  const share = ((x1 - x0) * (y1 - y0)) / (d.width * d.height);
  if (share < 0.2 || share > 0.95) return null;
  const { width, height } = img.getSize();
  const sx = width / d.width;
  const sy = height / d.height;
  const rect = {
    x: Math.round((x0 - d.x) * sx),
    y: Math.round((y0 - d.y) * sy),
    width: Math.round((x1 - x0) * sx),
    height: Math.round((y1 - y0) * sy),
  };
  rect.width = Math.min(rect.width, width - rect.x);
  rect.height = Math.min(rect.height, height - rect.y);
  return img.crop(rect);
}

async function captureScreen() {
  const permission = screenPermission();
  if (permission === 'denied' || permission === 'restricted') throw screenPermissionError();

  // The display the user is working on (where the mouse is), not always the primary one.
  let display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const frontWindow = frontWindowBounds(); // runs while the screen is captured
  let img = null;
  let firstError = null;
  try {
    // Ask for the size we need directly: a full-size Retina thumbnail can be ~5k×3k and slow to make.
    const pixels = Math.min(CAPTURE_MAX, Math.max(display.size.width, display.size.height) * display.scaleFactor);
    const sources = await getScreenSources({
      types: ['screen'],
      thumbnailSize: { width: pixels, height: pixels },
    });
    const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (source && !source.thumbnail.isEmpty()) img = source.thumbnail;
  } catch (err) {
    firstError = err;
  }
  if (!img && process.platform === 'darwin') {
    try {
      img = await captureWithScreencaptureTool();
      display = screen.getPrimaryDisplay(); // screencapture -m takes the main display
      logLine(`screen: desktopCapturer failed (${firstError ? firstError.message : 'no source'}), used screencapture`);
    } catch (err) {
      logLine(`screen: capture failed: ${firstError ? firstError.message : 'no source'} / ${err.message}`);
    }
  }
  if (!img) {
    if (screenPermission() !== 'granted') throw screenPermissionError();
    throw new Error(
      "Couldn't capture the screen just now. Try again in a moment. If it keeps failing, quit Ghost (⌘⇧Q) and open it again."
    );
  }
  const win = await frontWindow;
  const cropped = cropToWindow(img, display, win);
  if (cropped && !cropped.isEmpty()) img = cropped;
  logLine(`screen: ${cropped ? `cropped to ${win.app} window` : 'whole screen'} ${img.getSize().width}×${img.getSize().height}`);
  const { width, height } = img.getSize();
  if (Math.max(width, height) > SCREEN_MAX) {
    img = img.resize(width >= height ? { width: SCREEN_MAX, quality: 'good' } : { height: SCREEN_MAX, quality: 'good' });
  }
  return `data:image/jpeg;base64,${img.toJPEG(75).toString('base64')}`;
}

// The default ask when the user didn't type anything. A busy screen has many question-like
// things (chat, comments, ads, emails), so tell the model to find the one that matters.
const SCREEN_ASK =
  'This is a screenshot of my screen. Find the ONE question or task I need to answer right now. ' +
  'It is usually the main, biggest or most central question: an interview question, a test or quiz question, ' +
  'or a coding problem. Ignore everything else on the screen: menus, tabs, sidebars, chat messages, comments, ' +
  'ads, emails, unrelated code and other windows. Do not describe the screen or list what you see. ' +
  'Read that question and any options, examples or constraints carefully, then answer it. ' +
  'If it is multiple choice, say which option is right and why. ' +
  'If there is no question at all, say in one short line what is on the screen.';

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

// Groq's free tier also caps OUTPUT tokens per minute (1,000 for qwen3.8-27b), and it checks
// max_tokens against that cap BEFORE answering. With no max_tokens it assumes 2,048 and
// rejects every request ("Request too large ... OTPM: Limit 1000, Requested 2048").
// Answers are short anyway, so ask for a small, mode-sized budget.
const MAX_TOKENS = { interview: 400, general: 600, coding: 900 };
function maxTokensFor(settings) {
  const n = Number(settings.maxTokens);
  if (Number.isFinite(n) && n >= 50) return Math.round(n);
  const base = MAX_TOKENS[settings.mode] || 600;
  // Devanagari costs ~3x the tokens of English, so Hindi answers need more room.
  return settings.language === 'hi' ? Math.max(base, 550) : base;
}

// "OTPM: Limit 1000, Used 600, Requested 900" -> a smaller max_tokens that fits now (or 0).
function outputBudgetLeft(body, current) {
  if (!/output tokens per minute|OTPM/i.test(body)) return 0;
  const limit = Number((/Limit (\d+)/i.exec(body) || [])[1]);
  const used = Number((/Used (\d+)/i.exec(body) || [])[1]) || 0;
  if (!limit) return 0;
  const room = Math.min(limit - used - 20, current - 1);
  return room >= 200 ? room : 0;
}

function friendlyError(status, body) {
  if (status === 429) {
    if (/output tokens per minute|OTPM/i.test(body)) {
      return (
        'Groq free limit reached (1,000 answer tokens per minute). ' +
        'Wait about a minute and try again.'
      );
    }
    if (/request too large/i.test(body)) {
      return 'That question is too big for the Groq free tier. Shorten your background text in ⚙ and try again.';
    }
    const wait = retryDelay(body);
    return (
      'Groq free limit reached (8,000 input tokens per minute). ' +
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
  let maxTokens = maxTokensFor(settings);
  const post = () =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: model || settings.chatModel,
        messages,
        stream: true,
        temperature: 0.3,
        max_tokens: maxTokens,
      }),
    });

  // Free-tier per-minute limits. If only the answer budget is too big, shrink it and retry at
  // once; otherwise wait out the window and retry, twice at most. A 429 that waiting can't fix
  // ("Request too large") is reported straight away.
  let res = await post();
  let shrinks = 0;
  let waits = 0;
  while (res.status === 429) {
    const body = await res.text();
    const fits = shrinks < 2 ? outputBudgetLeft(body, maxTokens) : 0;
    if (fits) {
      shrinks++;
      maxTokens = fits;
      res = await post();
      continue;
    }
    if (waits >= 2 || /request too large/i.test(body)) throw new Error(friendlyError(429, body));
    waits++;
    const wait = retryDelay(body);
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

// The ONLY path that sends the screen anywhere. It runs when the user asks (⌘⇧Return / 🖥).
ipcMain.handle('ask-screen', async (_e, text) => {
  const t0 = Date.now();
  const image = await captureScreen();
  logLine(`screen: captured on request in ${Date.now() - t0}ms`);
  const settings = loadSettings();
  return streamChat(
    [
      { type: 'text', text: text || SCREEN_ASK },
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
  // Whisper's prompt steers spelling and script. Hindi speech is often mis-detected as Urdu
  // (Arabic script), and Hinglish comes out cleaner in Roman letters with a Hinglish example.
  const HINGLISH_HINT = 'Interview. Tell me about yourself. Aap apne baare mein batao. Aapka project kya tha?';
  if (settings.language === 'en') form.append('language', 'en');
  else if (settings.language === 'hi') {
    form.append('language', 'hi');
    form.append('prompt', 'इंटरव्यू। अपने बारे में बताइए। आपका प्रोजेक्ट क्या था?');
  } else form.append('prompt', HINGLISH_HINT); // auto and hinglish
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
  // Both modules share one serialized getSources() with main.js (see getScreenSources).
  setupAudio({ win, ipcMain, loadSettings, getSources: getScreenSources });
  setupStealth({ win, app, globalShortcut, ipcMain, getSources: getScreenSources });

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
