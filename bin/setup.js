// `ghost setup`: a terminal wizard that asks for the Groq key, a short profile and the resume,
// then saves them to the same settings.json the app reads (merged, never overwritten).
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { readResume } = require('../src/resume');

const GROQ_URL = 'https://api.groq.com/openai/v1';

// Must match Electron's app.getPath('userData') for an app named "ghost-assistant".
function settingsFile() {
  const name = 'ghost-assistant';
  let dir = process.env.GHOST_SETTINGS_DIR; // for testing only
  if (!dir && process.platform === 'darwin') dir = path.join(os.homedir(), 'Library', 'Application Support', name);
  if (!dir && process.platform === 'win32')
    dir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name);
  if (!dir) dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
  return path.join(dir, 'settings.json');
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

// Same rule as main.js: merge into what is on disk and write atomically.
function saveSettings(patch) {
  const file = settingsFile();
  const merged = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(merged, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return merged;
}

// Returns 'ok', 'bad' (rejected) or 'unknown' (offline, or the server said something else).
async function checkKey(baseUrl, key) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return 'ok';
    return res.status === 401 || res.status === 403 ? 'bad' : 'unknown';
  } catch {
    return 'unknown';
  }
}

// A dragged-in file arrives quoted ("C:\a b.pdf", 'a b.pdf'), escaped (a\ b.pdf) or as & 'x' (PowerShell).
function cleanPath(input) {
  let p = input.trim().replace(/^&\s+/, '');
  if (/^(['"]).*\1$/.test(p)) p = p.slice(1, -1);
  else if (process.platform !== 'win32') p = p.replace(/\\(.)/g, '$1');
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return p;
}

const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const green = (s) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s);
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

async function runSetup({ ifNeeded = false } = {}) {
  const current = loadSettings();
  if (ifNeeded && current.apiKey) {
    console.log(`Keeping your saved key and resume. Run ${bold('ghost setup')} any time to change them.`);
    return true;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  // A queue instead of rl.question(): lines that arrive early (a multi-line paste, piped input) are kept, not lost.
  let closed = false;
  const lines = [];
  const waiters = [];
  rl.on('line', (line) => (waiters.length ? waiters.shift()(line) : lines.push(line)));
  rl.on('close', () => {
    closed = true;
    waiters.splice(0).forEach((resolve) => resolve(''));
  });
  const noInputLeft = () => closed && !lines.length;
  rl.on('SIGINT', () => {
    console.log('\nSetup cancelled. Nothing was saved.');
    process.exit(130);
  });
  const nextLine = (prompt) =>
    new Promise((resolve) => {
      if (closed) process.stdout.write(prompt); // rl.prompt() throws after the input has ended
      else {
        rl.setPrompt(prompt);
        rl.prompt();
      }
      if (lines.length) resolve(lines.shift());
      else if (closed) resolve('');
      else waiters.push(resolve);
    });

  const ask = async (question, fallback = '') => {
    const hint = fallback ? dim(` [${fallback}]`) : '';
    return (await nextLine(`${question}${hint}: `)).trim() || fallback;
  };

  // Shows * for each character so a pasted key is visible as "something arrived" but not readable.
  const askSecret = async (question) => {
    const prompt = `${question}: `;
    const original = rl._writeToOutput;
    if (rl.terminal) {
      rl._writeToOutput = (s) => {
        if (s === '\r\n' || s === '\n') return rl.output.write(s);
        readline.clearLine(rl.output, 0);
        readline.cursorTo(rl.output, 0);
        rl.output.write(prompt + '*'.repeat(rl.line.length));
      };
    }
    const answer = await nextLine(prompt);
    rl._writeToOutput = original;
    return answer.trim();
  };

  console.log(`\n${bold('👻 Ghost setup')}  ${dim('(press Enter to keep a value in [brackets])')}\n`);

  // 1. API key
  const baseUrl = current.baseUrl || GROQ_URL;
  const saved = current.apiKey || '';
  if (saved) console.log(dim(`Current key: ${saved.slice(0, 4)}…${saved.slice(-4)}  (press Enter to keep it)`));
  else console.log(`Get a free Groq API key at ${bold('https://console.groq.com/keys')} (sign in, then "Create API Key").`);
  let apiKey = '';
  for (;;) {
    apiKey = (await askSecret('Paste your Groq API key')) || saved;
    if (!apiKey) {
      if (noInputLeft()) break;
      console.log(red('Ghost needs a key to answer. Paste it here (right-click or Ctrl/⌘+V).'));
      continue;
    }
    process.stdout.write(dim('Checking the key… '));
    const result = await checkKey(baseUrl, apiKey);
    if (result === 'ok') {
      console.log(green('✔ key works'));
      break;
    }
    if (result === 'unknown') {
      console.log(dim("couldn't check it right now (no internet?). Saving it anyway."));
      break;
    }
    console.log(red('✖ Groq rejected this key. Copy it again from console.groq.com/keys.'));
    if (noInputLeft()) {
      apiKey = '';
      break;
    }
  }

  // 2. Profile
  const p = current.profile || {};
  console.log(`\n${bold('About you')} ${dim('— Ghost uses this to answer as you')}`);
  const profile = {
    name: await ask('Your name', p.name),
    role: await ask('Job role you are interviewing for (e.g. Data Analyst)', p.role),
    experience: await ask('Years of experience (e.g. Fresher, 2 years)', p.experience),
    skills: await ask('Top skills, comma separated', p.skills),
    notes: await ask('Anything else Ghost should know? (optional)', p.notes),
  };

  // 3. Resume
  console.log(`\n${bold('Resume')} ${dim('— PDF or Word (.docx)')}`);
  const hasResume = String(current.context || '').trim().length > 0;
  let context = current.context || '';
  for (;;) {
    const answer = await ask(
      hasResume
        ? 'Drag your resume into this window and press Enter (Enter alone keeps your current one)'
        : 'Drag your resume into this window and press Enter (Enter alone skips)'
    );
    if (!answer) break;
    const file = cleanPath(answer);
    try {
      if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
      const res = await readResume(file);
      context = res.text;
      console.log(green(`✔ Read ${res.name} (${res.text.length.toLocaleString()} characters${res.truncated ? ', trimmed to fit' : ''})`));
      break;
    } catch (err) {
      console.log(red(`✖ ${err.message}`));
      if (noInputLeft()) break;
    }
  }
  rl.close();

  if (!apiKey) {
    console.log(red('\nNo API key, so nothing was saved. Run "ghost setup" again when you have one.'));
    return false;
  }
  saveSettings({ apiKey, baseUrl, profile, context });
  console.log(`\n${green('✅ All set!')} Saved to ${dim(settingsFile())}`);
  return true;
}

module.exports = { runSetup, loadSettings, settingsFile };

if (require.main === module) {
  runSetup({ ifNeeded: process.argv.includes('--if-needed') }).then((ok) => process.exit(ok ? 0 : 1));
}
