// Main-process audio features. Owned by the audio workstream (Phase 2A).
//
// 1. System audio capture without BlackHole: the renderer calls getDisplayMedia(),
//    and we answer with `audio: 'loopback'`. On macOS, Chromium only implements
//    loopback behind feature flags (Core Audio taps on 14.2+, ScreenCaptureKit
//    before that), so we switch those on here. This must happen before the app is
//    ready; main.js requires this module at load time, so the top level runs early enough.
// 2. ⌘⇧L toggles continuous listen mode (handled in audio-renderer.js).
const { app, session, desktopCapturer, globalShortcut } = require('electron');

function enableMacLoopbackFeatures() {
  if (process.platform !== 'darwin') return;
  const [major, minor] = String(process.getSystemVersion ? process.getSystemVersion() : '0')
    .split('.')
    .map(Number);
  const catap = major > 14 || (major === 14 && minor >= 2);
  const wanted = catap
    ? ['MacCatapLoopbackAudioForScreenShare']
    : ['MacLoopbackAudioForScreenShare', 'MacSckSystemAudioLoopbackOverride'];
  // Merge with any flags another module already set; the last --enable-features wins.
  const existing = app.commandLine.getSwitchValue('enable-features');
  const merged = [...new Set([...existing.split(',').filter(Boolean), ...wanted])].join(',');
  app.commandLine.appendSwitch('enable-features', merged);
}

try {
  enableMacLoopbackFeatures();
} catch (err) {
  console.error('[audio] could not enable loopback features:', err);
}

module.exports = function setupAudio({ win, ipcMain, loadSettings }) {
  // Keep VAD timers running at full speed while the overlay is hidden.
  win.webContents.setBackgroundThrottling(false);

  // getDisplayMedia() from our renderer → grant a screen video track (the renderer
  // drops it immediately) plus system audio loopback. No picker is shown.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const streams = {};
        if (request.audioRequested) streams.audio = 'loopback';
        if (request.videoRequested) {
          let video = null;
          try {
            const sources = await desktopCapturer.getSources({
              types: ['screen'],
              thumbnailSize: { width: 0, height: 0 },
            });
            video = sources[0] || null;
          } catch (err) {
            console.error('[audio] desktopCapturer failed:', err.message);
          }
          // Without Screen Recording permission there may be no screen source;
          // our own frame is a valid video source too (the track is discarded anyway).
          if (!video && request.frame) video = request.frame;
          if (video) streams.video = video;
        }
        callback(streams);
      } catch (err) {
        console.error('[audio] display media handler error:', err);
        callback({});
      }
    },
    { useSystemPicker: false }
  );

  const fs = require('fs');
  const path = require('path');
  const log = (msg) => {
    try {
      fs.appendFileSync(path.join(app.getPath('userData'), 'ghost.log'), `[${new Date().toISOString()}] ${msg}\n`);
    } catch {}
  };
  const ok = globalShortcut.register('CommandOrControl+Shift+L', () => {
    log('hotkey -> audio-toggle-live');
    if (!win.isVisible()) win.showInactive();
    win.webContents.send('audio-toggle-live');
  });
  if (!ok) log('SHORTCUT NOT AVAILABLE: CommandOrControl+Shift+L (another app has it)');
};
