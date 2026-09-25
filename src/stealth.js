// Main-process window/stealth features. Owned by the stealth workstream (Phase 2B).
//
// - ⌘⇧T toggles click-through (mouse events pass to apps beneath).
// - ⌘⇧O / ⌘⇧P decrease / increase opacity (0.3 – 1.0).
// - ipc 'stealth-check' returns a crop of a real screen capture over the window's
//   area, so the user can see what screen-share viewers see there.
// - Content protection is re-asserted on show/focus/display changes.
// - Opacity and window bounds persist in userData/window-state.json.
const { desktopCapturer, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const MIN_OPACITY = 0.3;
const MAX_OPACITY = 1.0;
const STEP = 0.1;
const MIN_W = 240;
const MIN_H = 160;

module.exports = function setupStealth({ win, app, globalShortcut, ipcMain }) {
  const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
  let clickThrough = false;
  let opacity = 1.0;
  let saveTimer = null;

  const alive = () => win && !win.isDestroyed();
  const round1 = (n) => Math.round(n * 10) / 10;
  const clampOpacity = (n) => round1(Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, n)));

  // ---------- persistence ----------
  function readState() {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
    } catch {
      return {};
    }
  }

  function writeState() {
    if (!alive()) return;
    try {
      const state = { opacity, bounds: win.getBounds() };
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('[stealth] failed to save window state:', err.message);
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeState, 500);
  }

  // ---------- bounds helpers ----------
  // Returns bounds adjusted so the window lies fully inside some display's work area.
  function fitToScreen(bounds) {
    const display = screen.getDisplayMatching(bounds);
    const wa = display.workArea;
    const width = Math.max(MIN_W, Math.min(bounds.width, wa.width));
    const height = Math.max(MIN_H, Math.min(bounds.height, wa.height));
    const x = Math.min(Math.max(bounds.x, wa.x), wa.x + wa.width - width);
    const y = Math.min(Math.max(bounds.y, wa.y), wa.y + wa.height - height);
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  }

  function keepOnScreen() {
    if (!alive()) return;
    const current = win.getBounds();
    const fitted = fitToScreen(current);
    if (
      fitted.x !== current.x ||
      fitted.y !== current.y ||
      fitted.width !== current.width ||
      fitted.height !== current.height
    ) {
      win.setBounds(fitted);
    }
  }

  // ---------- renderer feedback ----------
  function notify(message) {
    if (!alive()) return;
    const wc = win.webContents;
    wc.send('stealth-status', { clickThrough, opacity });
    if (message) {
      wc.executeJavaScript(
        `window.app && window.app.setStatus && window.app.setStatus(${JSON.stringify(String(message))})`
      ).catch(() => {});
    }
  }

  // ---------- content protection ----------
  function protect() {
    if (alive()) win.setContentProtection(true);
  }

  // ---------- features ----------
  function toggleClickThrough() {
    if (!alive()) return;
    clickThrough = !clickThrough;
    if (clickThrough) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(false);
    notify(clickThrough ? 'Click-through ON (⌘⇧T to exit)' : 'Click-through OFF');
  }

  function changeOpacity(delta) {
    if (!alive()) return;
    opacity = clampOpacity(opacity + delta);
    win.setOpacity(opacity);
    notify(`Opacity ${Math.round(opacity * 100)}%`);
    writeState();
  }

  async function stealthCheck() {
    if (!alive()) throw new Error('Window not available');
    protect();
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const sf = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * sf),
        height: Math.round(display.size.height * sf),
      },
    });
    const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error('No screen capture available. Grant Screen Recording permission in System Settings.');
    }
    const thumb = source.thumbnail;
    const size = thumb.getSize();
    // The thumbnail may not be exactly native size; derive the actual scale per axis.
    const sx = size.width / display.size.width;
    const sy = size.height / display.size.height;
    // Window bounds relative to the display origin, clipped to the display.
    const relX = Math.max(0, bounds.x - display.bounds.x);
    const relY = Math.max(0, bounds.y - display.bounds.y);
    const relW = Math.min(bounds.width, display.bounds.width - relX);
    const relH = Math.min(bounds.height, display.bounds.height - relY);
    const rect = {
      x: Math.max(0, Math.round(relX * sx)),
      y: Math.max(0, Math.round(relY * sy)),
      width: Math.round(relW * sx),
      height: Math.round(relH * sy),
    };
    rect.width = Math.max(1, Math.min(rect.width, size.width - rect.x));
    rect.height = Math.max(1, Math.min(rect.height, size.height - rect.y));
    const crop = thumb.crop(rect);
    return {
      dataUrl: crop.toDataURL(),
      bounds,
      display: { id: display.id, bounds: display.bounds, scaleFactor: sf },
      crop: rect,
      contentProtection: true,
    };
  }

  // ---------- restore saved state ----------
  const saved = readState();
  if (typeof saved.opacity === 'number' && Number.isFinite(saved.opacity)) {
    opacity = clampOpacity(saved.opacity);
  }
  win.setOpacity(opacity);
  const b = saved.bounds;
  if (b && [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n))) {
    try {
      win.setBounds(fitToScreen(b));
    } catch (err) {
      console.error('[stealth] failed to restore bounds:', err.message);
    }
  }
  protect();

  // ---------- events ----------
  win.on('show', protect);
  win.on('focus', protect);
  win.on('moved', scheduleSave);
  win.on('resized', scheduleSave);
  // 'moved'/'resized' fire at end of drag on macOS; also catch programmatic moves.
  win.on('move', scheduleSave);
  win.on('resize', scheduleSave);
  win.on('close', () => {
    clearTimeout(saveTimer);
    writeState();
  });
  win.webContents.on('did-finish-load', () => notify());

  const onDisplayChange = () => {
    protect();
    keepOnScreen();
    scheduleSave();
  };
  screen.on('display-metrics-changed', onDisplayChange);
  screen.on('display-added', onDisplayChange);
  screen.on('display-removed', onDisplayChange);
  win.on('closed', () => {
    screen.removeListener('display-metrics-changed', onDisplayChange);
    screen.removeListener('display-added', onDisplayChange);
    screen.removeListener('display-removed', onDisplayChange);
  });

  // ---------- IPC ----------
  ipcMain.handle('stealth-check', () => stealthCheck());
  ipcMain.handle('stealth-get-status', () => ({ clickThrough, opacity }));

  // ---------- hotkeys (reserved for 2B: T, O, P) ----------
  const reg = (accel, fn) => {
    if (!globalShortcut.register(accel, fn)) console.warn(`[stealth] could not register ${accel}`);
  };
  reg('CommandOrControl+Shift+T', toggleClickThrough);
  reg('CommandOrControl+Shift+O', () => changeOpacity(-STEP));
  reg('CommandOrControl+Shift+P', () => changeOpacity(STEP));
};
