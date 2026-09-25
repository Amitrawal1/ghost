// Renderer-side audio capture. Owned by the audio workstream (Phase 2A).
// Uses shared helpers from renderer.js via window.app.
//
// Source: system audio ONLY — getDisplayMedia() answered with loopback audio by
// audio-main.js. Owner rule: Ghost hears the other people, never the owner's mic.
// There is no mic/both mode and no fallback to the mic.
// Modes:
//   ⌘⇧R  manual push-to-record (window.audio.toggleRecording)
//   ⌘⇧L  continuous listen: voice-activity detection cuts segments on ~1.2s of
//        silence, transcribes them, and auto-answers questions.
(() => {
  const { $, run, addMessage, setStatus, escapeHtml } = window.app;
  const app = window.app;

  const SOURCE_LABELS = { system: 'Other people only' };

  // VAD tuning
  const SILENCE_MS = 1200; // silence after speech that ends a segment
  const MIN_SPEECH_MS = 400; // ignore clicks/coughs shorter than this
  const MAX_SEGMENT_MS = 30000; // force a cut on very long monologues
  const IDLE_ROTATE_MS = 10000; // start a fresh segment if nobody talks, to drop dead air
  const TICK_MS = 50;
  const MIN_THRESHOLD = 0.006; // RMS floor for "speech" (loopback silence is ~0; quiet browser voices sit near 0.01)

  // ---------- mic state broadcast ----------
  // The UI listens for window 'audio-state' events. mode: off | starting | recording | live.
  // phase: idle | speech | transcribing. level: 0..1 loudness for the meter.
  const micState = { mode: 'off', phase: 'idle', source: null, level: 0, since: 0 };
  function emit(patch) {
    Object.assign(micState, patch);
    window.dispatchEvent(new CustomEvent('audio-state', { detail: { ...micState } }));
  }

  // Scale RMS (~0.005 quiet … ~0.2 loud) into 0..1 on a log curve for a readable meter.
  const meterLevel = (r) => Math.max(0, Math.min(1, (Math.log10(Math.max(r, 1e-4)) + 2.6) / 2));

  // ---------- source selection ----------

  function getSource() {
    return 'system';
  }

  // Kept for the UI's sake: any request just re-asserts system audio.
  function setSource() {
    try {
      localStorage.removeItem('audioSource');
    } catch {}
    setStatus(`Audio source: ${SOURCE_LABELS.system} (your mic is never used)`);
    emit({ source: 'system' });
  }

  function cycleSource() {
    setSource();
    return 'system';
  }

  async function getSystemStream() {
    // Chromium requires video for getDisplayMedia; audio-main grants it and we drop it.
    const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    display.getVideoTracks().forEach((t) => {
      t.stop();
      display.removeTrack(t);
    });
    if (!display.getAudioTracks().length) {
      display.getTracks().forEach((t) => t.stop());
      throw new Error('no system audio track was provided');
    }
    return new MediaStream(display.getAudioTracks());
  }

  // Returns { stream, source, stop() } for system audio. Never falls back to the mic.
  async function openSource(quiet = false) {
    let system;
    try {
      system = await getSystemStream();
    } catch (err) {
      if (!quiet) addMessage('error', escapeHtml(
        `System audio capture failed (${err.message || err.name}). ` +
        'On macOS, allow Ghost under System Settings → Privacy & Security → Screen & System Audio Recording. ' +
        'Your microphone is never used as a fallback.'
      ));
      throw new Error('system audio unavailable');
    }
    const stop = () => system.getTracks().forEach((t) => t.stop());
    return { stream: system, source: 'system', stop };
  }

  // ---------- shared answer flow ----------

  function answer(transcript, icon) {
    return run(`${icon} ${transcript}`, () =>
      window.ghost.ask(`This was just said in my conversation:\n"${transcript}"\n\nHelp me respond. Give the answer I should say.`)
    );
  }

  // ---------- manual push-to-record (⌘⇧R) ----------

  // ---------- raw PCM capture (no MediaRecorder) ----------
  // MediaRecorder on the macOS loopback track keeps failing on the owner's Mac
  // ("There was an error starting the MediaRecorder"), so we never use it. Web Audio
  // collects the samples and each segment goes to Whisper as a 16 kHz mono WAV.

  const MAX_BUFFER_S = 300; // hard cap on buffered audio (manual recording)

  function pcmTap(ctx, stream) {
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0; // the node only runs while connected to the output; keep it silent
    let chunks = [];
    let length = 0;
    node.onaudioprocess = (e) => {
      const input = e.inputBuffer;
      const out = new Float32Array(input.length);
      for (let c = 0; c < input.numberOfChannels; c++) {
        const d = input.getChannelData(c);
        for (let i = 0; i < d.length; i++) out[i] += d[i] / input.numberOfChannels;
      }
      chunks.push(out);
      length += out.length;
      while (length > ctx.sampleRate * MAX_BUFFER_S) length -= chunks.shift().length;
    };
    src.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    return {
      src,
      seconds: () => length / ctx.sampleRate,
      take() {
        const all = new Float32Array(length);
        let o = 0;
        for (const c of chunks) {
          all.set(c, o);
          o += c.length;
        }
        chunks = [];
        length = 0;
        return all;
      },
      // Drop old audio but keep the last `keepS` seconds, so a word that starts
      // right at a segment boundary isn't clipped.
      clear(keepS = 0) {
        const keep = Math.round(ctx.sampleRate * keepS);
        while (chunks.length && length - chunks[0].length >= keep) length -= chunks.shift().length;
        if (!keep) {
          chunks = [];
          length = 0;
        }
      },
      stop() {
        node.onaudioprocess = null;
        src.disconnect();
        node.disconnect();
        mute.disconnect();
      },
    };
  }

  function toWav(samples, rate) {
    const TARGET = 16000;
    const ratio = rate / TARGET;
    const n = Math.floor(samples.length / ratio);
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o, t) => [...t].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, 36 + n * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, TARGET, true);
    v.setUint32(28, TARGET * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      // Average each window: a cheap low-pass so downsampling doesn't alias.
      const a = Math.floor(i * ratio);
      const b = Math.min(samples.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = a; j < b; j++) sum += samples[j];
      const x = Math.max(-1, Math.min(1, sum / (b - a || 1)));
      v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return buf;
  }

  // ---------- manual push-to-record (⌘⇧R) ----------

  let manual = null; // { capture, ctx, tap, timer } while manually recording

  async function transcribeAndAnswer(buffer) {
    emit({ mode: 'off', phase: 'transcribing', level: 0 });
    setStatus('Transcribing…', 'busy');
    try {
      const transcript = ((await window.ghost.transcribe(buffer)) || '').trim();
      emit({ phase: 'idle' });
      if (!transcript) return setStatus('No speech detected');
      answer(transcript, '🎙');
    } catch (err) {
      emit({ phase: 'idle' });
      addMessage('error', escapeHtml(err.message));
      setStatus('Error');
    }
  }

  function stopManual() {
    const m = manual;
    manual = null;
    clearInterval(m.timer);
    const samples = m.tap.take();
    m.tap.stop();
    m.ctx.close().catch(() => {});
    m.capture.stop();
    if (samples.length < m.ctx.sampleRate * 0.3) {
      emit({ mode: 'off', phase: 'idle', level: 0 });
      return setStatus('Nothing recorded');
    }
    transcribeAndAnswer(toWav(samples, m.ctx.sampleRate));
  }

  async function toggleRecording() {
    if (live) {
      // In live mode ⌘⇧R means "answer what was just said, now".
      live.forceCut = true;
      cutSegment();
      return;
    }
    if (manual) return stopManual();
    if (app.isBusy() || micState.mode === 'starting') return;
    emit({ mode: 'starting', level: 0 });
    let capture;
    try {
      capture = await openSource();
    } catch {
      emit({ mode: 'off', level: 0 });
      return;
    }
    const ctx = new AudioContext();
    ctx.resume().catch(() => {});
    const tap = pcmTap(ctx, capture.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    tap.src.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const r = Math.sqrt(sum / data.length);
      emit({ level: meterLevel(r), phase: r > MIN_THRESHOLD ? 'speech' : 'idle' });
    }, 80);
    manual = { capture, ctx, tap, timer };
    emit({ mode: 'recording', phase: 'idle', source: capture.source, since: Date.now() });
    setStatus('Recording', 'live');
  }

  // ---------- continuous listen mode (⌘⇧L) ----------

  let live = null; // state object while live mode is on
  let starting = false;
  let pending = null; // at most one queued segment { buffer, force }
  let processing = false;

  function liveStatus(text) {
    if (!live) return;
    if (app.isBusy() || processing) return; // don't clobber Thinking…/Transcribing…
    setStatus(text || `● Live · ${SOURCE_LABELS[live.source]}`, 'live');
  }

  // wantLive = the user wants to be listening (auto-start or ⌘⇧L). While it is true,
  // any capture/recorder failure reconnects on its own instead of turning live off,
  // because the owner can't press anything during an interview.
  let wantLive = false;
  let retries = 0;
  let retryTimer = null;
  const RETRY_MS = [500, 1000, 2000, 4000, 8000]; // then every 8s, forever

  function recover(why) {
    if (!wantLive) return;
    stopLive(true);
    clearTimeout(retryTimer);
    const wait = RETRY_MS[Math.min(retries, RETRY_MS.length - 1)];
    retries++;
    window.ghost.send?.('log', `live: reconnecting (${why}), attempt ${retries}`);
    emit({ mode: 'starting', level: 0 });
    if (!app.isBusy() && !processing) setStatus('Reconnecting audio…', 'busy');
    retryTimer = setTimeout(() => startLive(true), wait);
  }

  async function startLive(quiet = false) {
    if (live || starting) return;
    wantLive = true;
    if (manual) stopManual();
    starting = true;
    emit({ mode: 'starting', level: 0 });
    let capture;
    try {
      capture = await openSource(quiet);
    } catch {
      starting = false;
      recover('no system audio');
      return;
    }
    starting = false;
    if (!wantLive) return capture.stop(); // stopped while we were opening
    const ctx = new AudioContext();
    ctx.resume().catch(() => {});
    const tap = pcmTap(ctx, capture.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    tap.src.connect(analyser);

    const l = {
      tap,
      capture,
      source: capture.source,
      ctx,
      analyser,
      data: new Float32Array(analyser.fftSize),
      noise: 0.005,
      recStart: 0,
      speechMs: 0,
      speaking: false,
      lastVoice: 0,
      forceCut: false,
      timer: null,
    };
    live = l;
    capture.stream.getAudioTracks().forEach((t) =>
      t.addEventListener('ended', () => {
        if (live === l) recover('audio track ended');
      })
    );
    newSegment(l);
    l.timer = setInterval(tick, TICK_MS);
    if (retries) window.ghost.send?.('log', 'live: reconnected');
    retries = 0;
    emit({ mode: 'live', phase: processing ? 'transcribing' : 'idle', source: capture.source, since: Date.now() });
    liveStatus();
  }

  function stopLive(reconnecting = false) {
    if (!reconnecting) {
      wantLive = false;
      clearTimeout(retryTimer);
      retries = 0;
    }
    if (!live) {
      if (!reconnecting) emit({ mode: 'off', level: 0 });
      return;
    }
    const l = live;
    live = null;
    clearInterval(l.timer);
    l.tap.stop(); // the unfinished segment is discarded
    l.ctx.close().catch(() => {});
    l.capture.stop();
    if (reconnecting) return;
    emit({ mode: 'off', phase: processing ? 'transcribing' : 'idle', level: 0 });
    if (!app.isBusy() && !processing) setStatus('Live off');
  }

  async function restartLive() {
    stopLive();
    await startLive();
  }

  function toggleLive() {
    if (starting) return;
    if (live || wantLive) stopLive();
    else startLive();
  }

  // Live-mode diagnostics in userData/ghost.log, so "it heard nothing" can be told
  // apart from "it heard it but chose not to answer".
  const diag = (msg) => window.ghost.send?.('log', `live: ${msg}`);

  function newSegment(l) {
    l.peak = 0;
    l.recStart = performance.now();
    l.speechMs = 0;
    l.speaking = false;
  }

  // Hand the current segment off (if someone spoke) and start the next one.
  function cutSegment() {
    const l = live;
    if (!l) return;
    const hadSpeech = l.speechMs >= MIN_SPEECH_MS;
    const force = l.forceCut;
    l.forceCut = false;
    const secs = ((performance.now() - l.recStart) / 1000).toFixed(1);
    if (l.peak > 0.002 || hadSpeech || force) {
      diag(`segment ${secs}s speech=${l.speechMs}ms peak=${l.peak.toFixed(3)} → ${hadSpeech || force ? 'sent to Whisper' : 'dropped (too little speech)'}`);
    }
    if (hadSpeech || force) {
      const samples = l.tap.take();
      if (samples.length >= l.ctx.sampleRate * 0.3) enqueue({ buffer: toWav(samples, l.ctx.sampleRate), force });
    } else {
      l.tap.clear(0.5);
    }
    newSegment(l);
  }

  function rms() {
    const { analyser, data } = live;
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return Math.sqrt(sum / data.length);
  }

  function tick() {
    const l = live;
    if (!l) return;
    const now = performance.now();
    const level = rms();
    if (level > l.peak) l.peak = level;
    const threshold = Math.max(MIN_THRESHOLD, l.noise * 3);
    const voiced = level > threshold;
    const phase = processing ? 'transcribing' : voiced || l.speaking ? 'speech' : 'idle';
    l.ticks = (l.ticks || 0) + 1; // meter at ~10 fps; phase changes immediately
    if (l.ticks % 2 === 0 || phase !== micState.phase) emit({ level: meterLevel(level), phase });

    if (voiced) {
      l.lastVoice = now;
      l.speechMs += TICK_MS;
      if (!l.speaking && l.speechMs >= MIN_SPEECH_MS) {
        l.speaking = true;
        liveStatus(`● Live · hearing ${SOURCE_LABELS[l.source].toLowerCase()}…`);
      }
    } else {
      // Track the background noise floor: fall fast, rise slowly.
      l.noise = level < l.noise ? level : l.noise * 0.995 + level * 0.005;
    }

    const segAge = now - l.recStart;
    if (l.speaking && now - l.lastVoice >= SILENCE_MS) {
      cutSegment();
      liveStatus();
    } else if (segAge >= MAX_SEGMENT_MS && l.speechMs > 0) {
      cutSegment();
    } else if (!l.speaking && segAge >= IDLE_ROTATE_MS && now - l.lastVoice >= SILENCE_MS) {
      // Nothing (or only blips) said: start over so segments don't carry dead air.
      l.speechMs = 0;
      cutSegment();
    }
  }

  // ---------- segment queue ----------

  function enqueue(item) {
    pending = item; // keep at most one; the newest wins
    pump();
  }

  async function pump() {
    if (processing || !pending) return;
    if (app.isBusy()) {
      setTimeout(pump, 300);
      return;
    }
    const { buffer, force } = pending;
    pending = null;
    processing = true;
    try {
      setStatus('Transcribing…', 'busy');
      emit({ phase: 'transcribing' });
      const transcript = ((await window.ghost.transcribe(buffer)) || '').trim();
      emit({ phase: 'idle' });
      const willAnswer = !!transcript && (force || looksLikePrompt(transcript));
      diag(`heard "${transcript.slice(0, 200)}" → ${willAnswer ? 'answering' : transcript ? 'not a question, shown only' : 'empty'}`);
      if (willAnswer) {
        await answer(transcript, '🎧');
      } else if (transcript && !isNoise(transcript)) {
        addMessage('user', escapeHtml(`🎧 ${transcript}`));
      }
    } catch (err) {
      addMessage('error', escapeHtml(err.message));
    } finally {
      processing = false;
      if (micState.phase === 'transcribing') emit({ phase: 'idle' });
      if (live) liveStatus();
      else if (!app.isBusy()) setStatus('Ready');
      if (pending) pump();
    }
  }

  // Whisper often "hears" these in silence or music.
  const NOISE = /^(thank you|thanks( for watching)?|you|bye|okay|ok|uh+|um+|hmm+|\.+|♪+)[.!?\s]*$/i;
  function isNoise(t) {
    return NOISE.test(t.trim());
  }

  const PROMPT_START =
    /^(what|why|how|when|where|who|which|whose|can|could|would|will|should|do|does|did|is|are|was|were|have|has|tell|explain|describe|walk|give|write|implement|design|compare|talk|share|define|list|name|solve|build|show|imagine|suppose|let's|lets|so,? (what|how|why|tell|can))\b/i;
  // Interview asks that don't start with a question word ("Great. Now please introduce
  // yourself", "Okay, so walk me through your project").
  const ASKS =
    /\b(tell (me|us)|introduce yourself|describe|explain|walk (me|us) through|what|why|how|which|can you|could you|would you|do you|did you|have you|are you|share|give (me|us)|talk (about|me)|your (experience|projects?|strengths?|weakness(es)?|role|background|skills|goals?))\b/i;
  function looksLikePrompt(t) {
    if (isNoise(t)) return false;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length < 3) return false;
    if (/\?/.test(t)) return true;
    if (PROMPT_START.test(t) || ASKS.test(t)) return true;
    return words.length >= 10; // long statements in an interview are usually prompts
  }

  window.ghost.on('audio-toggle-live', toggleLive);

  // Start listening on launch (unless turned off in Settings), so nothing has to be
  // pressed during an interview.
  function autoListen() {
    try {
      return localStorage.getItem('autoListen') !== 'off';
    } catch {
      return true;
    }
  }
  if (autoListen()) setTimeout(() => !live && !wantLive && startLive(), 1500);
  micState.source = getSource();

  window.audio = {
    toggleRecording,
    toggleLive,
    isLive: () => !!live,
    getAutoListen: autoListen,
    setAutoListen: (on) => {
      try {
        localStorage.setItem('autoListen', on ? 'on' : 'off');
      } catch {}
    },
    getState: () => ({ ...micState }),
    cycleSource,
    getSource,
    setSource,
  };
})();
