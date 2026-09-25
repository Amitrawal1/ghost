const $ = (id) => document.getElementById(id);
const output = $('output');
const input = $('input');
const statusEl = $('status');
const SETTING_KEYS = ['baseUrl', 'apiKey', 'chatModel', 'visionModel', 'sttModel', 'context'];
const MODES = ['interview', 'coding', 'general'];
const MODE_LABELS = { interview: 'Interview', coding: 'Coding', general: 'General' };

// Hotkey labels are written Mac-style (⌘⇧R). On Windows/Linux, rewrite every label to Ctrl+Shift+R,
// including text that other modules set later.
if (!navigator.userAgent.includes('Macintosh')) {
  const winKeys = (s) => s.replace(/⌘⇧/g, 'Ctrl+Shift+').replace(/↩/g, 'Enter');
  const fix = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.data.includes('⌘')) node.data = winKeys(node.data);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.title?.includes('⌘')) node.title = winKeys(node.title);
    if (node.placeholder?.includes('⌘')) node.placeholder = winKeys(node.placeholder);
    node.childNodes.forEach(fix);
  };
  fix(document.body);
  new MutationObserver((changes) =>
    changes.forEach((c) => (c.type === 'childList' ? c.addedNodes.forEach(fix) : fix(c.target)))
  ).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'placeholder'] });
}

let busy = false;
let currentBot = null;
let currentText = '';
let mode = 'interview';

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- Markdown (dependency-free, XSS-safe: every text run is escaped before formatting) ----------

function renderInline(text) {
  const codes = [];
  let html = escapeHtml(text).replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  html = html
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_(?!\s)([^_]+?)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<u>$1</u>'); // links shown as text; nothing clickable
  return html.replace(/\u0000(\d+)\u0000/g, (_m, i) => codes[i]);
}

function renderBlocks(text) {
  let html = '';
  let para = [];
  const lists = []; // stack of { type: 'ul' | 'ol', indent }

  let sayOpen = false; // inside the "Say it" card
  const closeSay = () => {
    if (sayOpen) html += '</div>';
    sayOpen = false;
  };
  const flushPara = () => {
    // A line that is only **Bold** (optionally with ":") is a section label, e.g. "Talking points".
    while (para.length) {
      const label = para[0].match(/^\*\*([^*]{1,40})\*\*:?$/);
      if (!label) break;
      closeSay();
      html += `<div class="section">${renderInline(label[1])}</div>`;
      if (/^say it|^sample answer|^answer$/i.test(label[1].trim())) {
        html += '<div class="say">';
        sayOpen = true;
      }
      para.shift();
    }
    if (para.length) html += `<p>${para.map(renderInline).join('<br>')}</p>`;
    para = [];
  };
  const closeList = () => (html += `</li></${lists.pop().type}>`);
  const closeLists = () => {
    while (lists.length) closeList();
  };

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flushPara(); // lists stay open across blank lines ("1. a\n\n2. b")
      continue;
    }

    const item = line.match(/^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/);
    if (item) {
      flushPara();
      const indent = item[1].replace(/\t/g, '    ').length;
      const type = /\d/.test(item[2]) ? 'ol' : 'ul';
      let top = lists[lists.length - 1];
      while (top && (top.indent > indent || (top.indent === indent && top.type !== type))) {
        closeList();
        top = lists[lists.length - 1];
      }
      if (top && top.indent === indent) {
        html += '</li><li>';
      } else {
        const start = type === 'ol' ? parseInt(item[2], 10) : 1;
        html += type === 'ol' && start !== 1 ? `<ol start="${start}"><li>` : `<${type}><li>`;
        lists.push({ type, indent });
      }
      html += renderInline(item[3]);
      continue;
    }

    // Indented continuation of a list item.
    if (lists.length && /^\s+\S/.test(line)) {
      html += `<br>${renderInline(line.trim())}`;
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*$/);
    if (heading) {
      flushPara();
      closeLists();
      closeSay();
      html += `<div class="h h${heading[1].length}">${renderInline(heading[2])}</div>`;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}$/.test(line)) {
      flushPara();
      closeLists();
      html += '<hr>';
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushPara();
      closeLists();
      html += `<blockquote>${renderInline(quote[1])}</blockquote>`;
      continue;
    }

    closeLists();
    // A bold label line starts a new section even without a blank line before it.
    if (para.length && /^\*\*[^*]{1,40}\*\*:?$/.test(line.trim())) flushPara();
    para.push(line.trim());
  }
  flushPara();
  closeLists();
  closeSay();
  return html;
}

function renderMarkdown(md) {
  // Odd parts are fenced code. An unclosed fence while streaming still renders as code.
  return md
    .split(/^\s*```/m)
    .map((part, i) => {
      if (i % 2 === 0) return renderBlocks(part);
      const lang = (part.match(/^[\w+#.-]*/) || [''])[0];
      const code = part.replace(/^[\w+#.-]*[^\n]*\n?/, '').replace(/\n$/, '');
      return (
        '<div class="code-wrap">' +
        (lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '') +
        '<button class="copy-btn copy-code" title="Copy code">⧉</button>' +
        `<pre><code>${escapeHtml(code)}</code></pre></div>`
      );
    })
    .join('');
}

// ---------- Messages ----------

function addMessage(cls, html) {
  if (cls.includes('error')) {
    expand();
    try { window.ghost.send('log', `shown error: ${String(html).slice(0, 400)}`); } catch {}
  } else if (cls.includes('check')) expand();
  output.querySelector('.hint')?.remove();
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  el.innerHTML = html;
  output.appendChild(el);
  output.scrollTop = output.scrollHeight;
  return el;
}

const rawAnswers = new WeakMap(); // bot message element -> raw markdown

function finalizeBot(msg, text) {
  rawAnswers.set(msg, text);
  const btn = document.createElement('button');
  btn.className = 'copy-btn copy-msg';
  btn.title = 'Copy answer (markdown)';
  btn.textContent = '⧉';
  msg.prepend(btn);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

output.addEventListener('click', async (e) => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  const text = btn.classList.contains('copy-code')
    ? btn.closest('.code-wrap').querySelector('code').textContent
    : rawAnswers.get(btn.closest('.msg')) || '';
  try {
    await copyText(text);
    btn.textContent = '✓';
    btn.classList.add('done');
    setTimeout(() => {
      btn.textContent = '⧉';
      btn.classList.remove('done');
    }, 1200);
  } catch {
    setStatus('Copy failed');
  }
});

window.ghost.on('answer-status', (text) => {
  setStatus(text, 'busy');
  if (currentBot && !currentText) currentBot.innerHTML = `<span class="dots"><i></i><i></i><i></i></span> ${escapeHtml(text)}`;
});

window.ghost.on('answer-chunk', (delta) => {
  if (!currentBot) return;
  currentText += delta;
  currentBot.innerHTML = renderMarkdown(currentText);
  output.scrollTop = output.scrollHeight;
});

async function run(label, fn) {
  if (busy) return;
  expand();
  busy = true;
  setStatus('Thinking…', 'busy');
  if (label) addMessage('user', escapeHtml(label));
  currentText = '';
  const msg = addMessage('bot streaming', '<div class="md"><span class="dots"><i></i><i></i><i></i></span></div>');
  currentBot = msg.querySelector('.md');
  try {
    const answer = await fn();
    if (!currentText && typeof answer === 'string' && answer) {
      currentText = answer;
      currentBot.innerHTML = renderMarkdown(answer);
    }
    if (currentText) finalizeBot(msg, currentText);
    msg.classList.remove('streaming');
    setStatus('Ready');
  } catch (err) {
    msg.remove();
    addMessage('error', escapeHtml(err.message));
    window.ghost.send('log', `run failed: ${err && err.stack ? err.stack : err}`);
    setStatus('Error');
  } finally {
    currentBot = null;
    busy = false;
  }
}

function askText(text) {
  text = text.trim();
  if (!text) return;
  run(text, () => window.ghost.ask(text));
}

function askScreen() {
  const text = input.value.trim();
  input.value = '';
  run(text ? `🖥 ${text}` : '🖥 Reading screen…', () => window.ghost.askScreen(text));
}

function clearAll() {
  output.innerHTML = '';
  window.ghost.clearHistory();
  setStatus('Cleared');
  setCompact(true);
}

// ---------- Answer mode ----------

function renderMode() {
  document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
}

async function setMode(next, announce = true) {
  if (!MODES.includes(next)) return;
  mode = next;
  renderMode();
  if (announce) setStatus(`Mode: ${MODE_LABELS[mode]}`);
  try {
    await window.ghost.saveSettings({ mode });
  } catch (err) {
    setStatus(`Could not save mode: ${err.message}`);
  }
}

function cycleMode() {
  setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
}

document.querySelectorAll('#modes button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

// ---------- Font size (per-device, localStorage) ----------

const FONT_MIN = 10;
const FONT_MAX = 26;
let fontSize = 16;

function applyFontSize(px) {
  fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, px));
  document.documentElement.style.setProperty('--fs', `${fontSize}px`);
  $('font-size-val').textContent = `${fontSize}px`;
  try {
    localStorage.setItem('answerFontSize', String(fontSize));
  } catch {}
}

try {
  const saved = parseInt(localStorage.getItem('answerFontSize'), 10);
  if (saved) fontSize = saved;
} catch {}
applyFontSize(fontSize);
$('btn-font-down').onclick = () => applyFontSize(fontSize - 1);
$('btn-font-up').onclick = () => applyFontSize(fontSize + 1);

// ---------- Stealth ----------

async function checkHidden() {
  $('settings').classList.add('hidden');
  setStatus('Capturing…', 'busy');
  try {
    const res = await window.ghost.invoke('stealth-check');
    const url = res && typeof res.dataUrl === 'string' ? res.dataUrl : '';
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(url)) throw new Error('No image returned');
    const b = res.bounds;
    const size = b ? ` (${Math.round(b.width)}×${Math.round(b.height)} at ${Math.round(b.x)},${Math.round(b.y)})` : '';
    addMessage(
      'check',
      `<div class="check-title">What screen-share viewers see here${escapeHtml(size)}</div>` +
        `<img src="${escapeHtml(url)}" alt="Capture of the area behind this window" />` +
        (res.contentProtection === false
          ? '<div class="check-warn">Content protection is OFF — this window may be visible to viewers.</div>'
          : '') +
        '<div class="check-note">If you can’t see this overlay in the image, it is hidden from screen sharing.</div>'
    );
    setStatus('Ready');
  } catch (err) {
    const msg = /no handler registered/i.test(err.message)
      ? 'Hidden check is not available in this build yet.'
      : `Hidden check failed: ${err.message}`;
    addMessage('error', escapeHtml(msg));
    setStatus('Error');
  }
}

function showStealthStatus(s = {}) {
  document.querySelector('.panel').classList.toggle('click-through', !!s.clickThrough);
  const el = $('stealth-ind');
  const parts = [];
  if (s.clickThrough) parts.push('🖱✕');
  if (typeof s.opacity === 'number' && s.opacity < 0.999) parts.push(`${Math.round(s.opacity * 100)}%`);
  el.textContent = parts.join(' ');
  el.title = `${s.clickThrough ? 'Click-through ON (clicks pass through)' : 'Click-through off'}` +
    (typeof s.opacity === 'number' ? ` · opacity ${Math.round(s.opacity * 100)}%` : '');
  el.title += s.clickThrough ? ' — press ⌘⇧T to turn off' : '';
  el.classList.toggle('hidden', !parts.length);
}
window.ghost.on('stealth-status', showStealthStatus);
window.ghost
  .invoke('stealth-get-status')
  .then((s) => s && showStealthStatus(s))
  .catch(() => {});

// ---------- Audio source / live listen ----------

const SOURCE_LABELS = { system: 'Sys', mic: 'Mic', both: 'Both' };
const SOURCE_NAMES = { system: 'System audio', mic: 'Microphone', both: 'System + mic' };

function showSource(src) {
  if (!SOURCE_LABELS[src]) return;
  $('btn-source').textContent = SOURCE_LABELS[src];
  $('btn-source').title = `Audio source: ${SOURCE_NAMES[src]}. Your mic is never used.`;
}

async function cycleSource() {
  if (typeof window.audio?.cycleSource !== 'function') {
    setStatus('Audio source switching not available yet');
    return;
  }
  try {
    const src = await window.audio.cycleSource();
    showSource(src);
    if (SOURCE_NAMES[src]) setStatus(`Audio source: ${SOURCE_NAMES[src]}`);
  } catch (err) {
    addMessage('error', escapeHtml(`Audio source error: ${err.message}`));
  }
}

function toggleLive() {
  if (typeof window.audio?.toggleLive !== 'function') return setStatus('Live listen not available yet');
  window.audio.toggleLive();
}

// ---------- Compact / expanded window ----------
// Compact = just the header and the mic bar, so it sits quietly on top of your call.
// It expands by itself when an answer (or an error, or settings) needs the space.

let compact = false;

function compactHeight() {
  const panel = document.querySelector('.panel');
  const header = document.querySelector('header');
  const bar = $('micbar');
  const style = getComputedStyle(bar);
  return (
    header.offsetHeight +
    bar.offsetHeight +
    parseFloat(style.marginBottom || 0) +
    2 * parseFloat(getComputedStyle(panel).borderTopWidth || 0)
  );
}

function setCompact(on) {
  compact = on;
  document.body.classList.toggle('compact', on);
  $('btn-size').textContent = on ? '⌃' : '⌄';
  $('btn-size').title = on ? 'Expand the window' : 'Shrink to the bar only';
  requestAnimationFrame(() => {
    window.ghost.send('window-size', on ? 'compact' : 'expand', on ? compactHeight() : 0);
  });
}

function expand() {
  if (compact) setCompact(false);
}

// ---------- Mic status bar ----------

let micSince = 0;

function micTexts({ mode, phase, source }) {
  const src = SOURCE_NAMES[source] || 'Audio';
  if (mode === 'starting') return ['Starting…', `Opening ${src.toLowerCase()}`];
  if (mode === 'recording')
    return [phase === 'speech' ? 'Recording · hearing sound' : 'Recording', `${src} · press ⌘⇧R to stop and answer`];
  if (mode === 'live') {
    const label = phase === 'transcribing' ? 'Listening · transcribing…' : phase === 'speech' ? 'Listening · hearing speech' : 'Listening';
    return [label, `${src} · auto-answers questions · ⌘⇧L to stop`];
  }
  if (phase === 'transcribing') return ['Transcribing…', 'Turning speech into text'];
  return ['Mic off', '⌘⇧L live listen · ⌘⇧R record'];
}

function renderMic(st) {
  const bar = $('micbar');
  bar.dataset.mode = st.mode;
  bar.dataset.phase = st.phase;
  document.querySelector('.panel').dataset.mic = st.mode;
  const [label, sub] = micTexts(st);
  $('mic-label').textContent = label;
  $('mic-sub').textContent = sub;

  const on = st.mode === 'recording' || st.mode === 'live';
  const bars = $('meter').children;
  for (let i = 0; i < bars.length; i++) bars[i].classList.toggle('lit', on && st.level > (i + 0.5) / bars.length);
  micSince = on ? st.since : 0;
  renderMicTime();

  const mic = $('btn-mic');
  mic.classList.toggle('on', st.mode === 'recording');
  mic.querySelector('.lbl').textContent =
    st.mode === 'recording' ? 'Stop' : st.mode === 'live' ? 'Answer now' : 'Record';
  mic.title = st.mode === 'live' ? 'Answer what was just said, now (⌘⇧R)' : 'Record once, then answer (⌘⇧R)';
  const liveBtn = $('btn-live');
  liveBtn.classList.toggle('on', st.mode === 'live');
  liveBtn.querySelector('.lbl').textContent = st.mode === 'live' ? 'Stop' : 'Live';
  if (st.source) showSource(st.source);
}

function renderMicTime() {
  const el = $('mic-time');
  if (!micSince) return (el.textContent = '');
  const sec = Math.max(0, Math.floor((Date.now() - micSince) / 1000));
  el.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
setInterval(renderMicTime, 1000);
window.addEventListener('audio-state', (e) => renderMic(e.detail));

// ---------- Settings ----------

async function openSettings() {
  const panel = $('settings');
  expand();
  panel.classList.toggle('hidden');
  if (panel.classList.contains('hidden')) return;
  const settings = await window.ghost.getSettings();
  SETTING_KEYS.forEach((k) => ($(`s-${k}`).value = settings[k] || ''));
  $('s-source').value = window.audio?.getSource?.() || 'system';
  $('s-autoListen').checked = window.audio?.getAutoListen?.() ?? true;
}

async function saveSettings() {
  const settings = {};
  SETTING_KEYS.forEach((k) => (settings[k] = $(`s-${k}`).value.trim()));
  await window.ghost.saveSettings(settings);
  try {
    window.audio?.setSource?.($('s-source').value);
    window.audio?.setAutoListen?.($('s-autoListen').checked);
    showSource(window.audio?.getSource?.());
  } catch {}
  $('settings').classList.add('hidden');
  setStatus('Settings saved');
}

// ---------- Wiring ----------

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    askText(input.value);
    input.value = '';
  } else if (e.key === 'Escape') {
    input.blur();
  }
});

// Works while the window is focused; the global version arrives as 'hotkey-mode' from main.
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === 'KeyM') {
    e.preventDefault();
    cycleMode();
  }
});

$('btn-mic').onclick = () => window.audio.toggleRecording();
$('btn-source').onclick = cycleSource;
$('btn-live').onclick = toggleLive;
$('btn-screen').onclick = () => {
  expand();
  askScreen();
};
$('btn-settings').onclick = openSettings;
$('btn-save').onclick = saveSettings;
$('btn-resume').onclick = async () => {
  try {
    const res = await window.ghost.invoke('pick-resume');
    if (!res) return;
    $('s-context').value = res.text;
    await window.ghost.saveSettings({ context: res.text });
    setStatus(`Resume loaded: ${res.name}${res.truncated ? ' (trimmed)' : ''}`);
  } catch (err) {
    addMessage('error', escapeHtml(`Resume: ${err.message.replace(/^Error invoking remote method '[^']+': /, '')}`));
  }
};
$('btn-check-hidden').onclick = checkHidden;
$('btn-size').onclick = () => setCompact(!compact);
$('btn-hide').onclick = () => window.ghost.hide();

window.ghost.on('hotkey-record', () => window.audio.toggleRecording());
window.ghost.on('hotkey-screen', askScreen);
window.ghost.on('hotkey-clear', clearAll);
window.ghost.on('hotkey-focus', () => {
  expand();
  input.focus();
});
window.ghost.on('hotkey-mode', cycleMode);

renderMode();
// audio-renderer.js loads after this file, so read the source once everything is parsed.
window.addEventListener('DOMContentLoaded', () => {
  showSource(window.audio?.getSource?.());
  if (window.audio?.getState) renderMic(window.audio.getState());
});
window.addEventListener('load', () => setTimeout(() => setCompact(!output.querySelector('.msg')), 60));
window.ghost.getSettings().then((s) => {
  if (MODES.includes(s.mode)) mode = s.mode;
  renderMode();
  if (!s.apiKey) {
    addMessage('error', 'No API key yet. Paste a free Groq key from console.groq.com/keys below, then click Save.');
    openSettings();
  }
});

// Shared helpers for feature modules (audio-renderer.js etc.).
window.app = { $, run, addMessage, setStatus, escapeHtml, isBusy: () => busy };
