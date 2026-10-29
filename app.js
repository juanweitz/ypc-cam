/* YPC camera viewer — dependency-free.
 *
 * The camera is plugged in over USB, where it enumerates as a standard UVC
 * webcam (038f:6001 "USB 2.0 Camera"). So this is only the browser's camera
 * API plus a canvas: no HTTP, no polling, no firmware quirks.
 *
 * It has to be served from http://localhost:8000 — browsers refuse camera
 * access on file:// and over plain HTTP on any other host.
 */

'use strict';

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */

const DEFAULTS = {
  deviceId: '',          // '' = whatever the browser offers first
  size: '1280x720',      // width x height requested from the camera
};

const cfg = { ...DEFAULTS, ...readCfg() };

function readCfg() {
  try { return JSON.parse(localStorage.getItem('ypc.cfg') || '{}'); }
  catch { return {}; }
}
function saveCfg() {
  try { localStorage.setItem('ypc.cfg', JSON.stringify(cfg)); } catch {}
}

/* ------------------------------------------------------------------ */
/* dom helpers                                                         */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const el = {
  dot: $('dot'),
  hostLabel: $('hostLabel'),
  overlay: $('overlay'),
  overlayText: $('overlayText'),
  usb: $('usb'),
  canvas: $('canvas'),
  modeBadge: $('modeBadge'),
  recDot: $('recDot'),
  fps: $('fps'),
  resStat: $('resStat'),
  log: $('log'),
};

function log(msg, level = 'info') {
  const t = new Date().toLocaleTimeString();
  el.log.textContent += (el.log.textContent ? '\n' : '') + `[${t}] ${msg}`;
  el.log.scrollTop = el.log.scrollHeight;
  if (level === 'error') console.error(msg); else console.log(msg);
}

function setDot(state, label) {
  el.dot.className = 'dot ' + state;
  if (label) el.hostLabel.textContent = label;
}

function showOverlay(text, isError = false) {
  el.overlay.classList.remove('hide');
  el.overlayText.textContent = text;
  el.overlayText.className = isError ? 'err' : '';
}

function hideOverlay() {
  el.overlay.classList.add('hide');
}

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

const state = {
  running: false,
  gen: 0,               // bumped on every connect; stops stale capture loops
  stream: null,
  rafId: null,
  gotFrame: false,
  lastFrameAt: 0,
  fpsAvg: 0,
  recording: false,
  recorder: null,
  chunks: [],
};

/* ------------------------------------------------------------------ */
/* camera                                                              */
/* ------------------------------------------------------------------ */

function usbSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

/** Camera constraints for a given device and the configured frame size. */
function constraints(deviceId) {
  const video = {};
  if (deviceId) video.deviceId = { exact: deviceId };
  const [w, h] = (cfg.size || DEFAULTS.size).split('x').map(Number);
  if (w && h) {
    video.width = { ideal: w };
    video.height = { ideal: h };
  }
  return { audio: false, video };
}

async function listCameras(askPermission = false) {
  if (!usbSupported()) return [];
  const onlyVideo = (list) => list.filter((d) => d.kind === 'videoinput');
  let devs = onlyVideo(await navigator.mediaDevices.enumerateDevices());

  // Labels stay empty until the user has granted camera access once.
  if (askPermission && devs.length && devs.every((d) => !d.label)) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true });
      probe.getTracks().forEach((t) => t.stop());
      devs = onlyVideo(await navigator.mediaDevices.enumerateDevices());
    } catch (err) {
      log(`Camera permission: ${err.name}`, 'error');
    }
  }
  return devs;
}

function fillChoices(select, devs, current) {
  const rows = ['<option value="">Default camera</option>'];
  devs.forEach((d, i) => {
    const label = d.label || `Camera ${i + 1}`;
    rows.push(`<option value="${escapeHtml(d.deviceId)}">${escapeHtml(label)}</option>`);
  });
  select.innerHTML = rows.join('');
  if (current && [...select.options].some((o) => o.value === current)) select.value = current;
}

/** Open a camera, retrying briefly: a just-closed device can report "busy". */
async function openCamera(deviceId, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints(deviceId));
    } catch (err) {
      const transient = err.name === 'NotReadableError' || err.name === 'AbortError';
      if (!transient || attempt >= tries) throw err;
      log(`Camera busy (${err.name}), retrying…`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

async function connect() {
  disconnect();

  if (!usbSupported()) {
    showOverlay(
      'This browser will not let the page open the camera. Serve the page from ' +
      'http://localhost:8000 (Chrome or Firefox); camera access is refused on file:// ' +
      'and on plain http:// addresses.',
      true,
    );
    setDot('offline');
    log('getUserMedia unavailable: camera access needs https:// or http://localhost.', 'error');
    return false;
  }

  showOverlay('Opening the camera…');
  setDot('connecting', 'USB');
  $('usbDevice').value = cfg.deviceId || '';
  $('usbSize').value = cfg.size || DEFAULTS.size;

  let stream;
  try {
    stream = await openCamera(cfg.deviceId);
  } catch (err) {
    const msg = {
      NotAllowedError: 'Camera permission was denied. Allow it for this site, then press Reconnect.',
      NotFoundError: 'No camera found. Plug the camera in by USB, then press Reconnect.',
      NotReadableError: 'The camera could not be opened. Try another USB port directly on the computer.',
      OverconstrainedError: 'That camera or frame size is no longer available. Pick another one.',
      SecurityError: 'Camera access needs https:// or http://localhost.',
      AbortError: 'The camera was disconnected while opening it.',
    }[err.name] || `Could not open the camera: ${err.message}`;
    showOverlay(msg, true);
    setDot('offline');
    log(`getUserMedia → ${err.name}: ${err.message}`, 'error');
    return false;
  }

  // With no camera chosen the browser opens the system default, which is
  // usually the laptop's own webcam. Prefer the YPC when it is plugged in.
  if (!cfg.deviceId) {
    try {
      const devs = await listCameras(false);
      const want = devs.find((d) => /usb 2\.0 camera|lihappe|ypc/i.test(d.label));
      const current = stream.getVideoTracks()[0]?.getSettings?.().deviceId;
      if (want && want.deviceId && want.deviceId !== current) {
        const better = await openCamera(want.deviceId);
        stream.getTracks().forEach((t) => t.stop());
        stream = better;
        cfg.deviceId = want.deviceId;
        saveCfg();
        fillChoices($('usbDevice'), devs, cfg.deviceId);
        log(`Using ${want.label} (not the default camera).`);
      }
    } catch (err) {
      // Do not quietly stream the laptop webcam instead of the camera asked for.
      if (err.name === 'NotReadableError' || err.name === 'AbortError') {
        stream.getTracks().forEach((t) => t.stop());
        showOverlay(
          'The USB camera is already in use — usually another browser tab or program. ' +
          'Close it, then press Reconnect.',
          true,
        );
        setDot('offline');
        log(`The USB camera is busy (${err.name}); another tab or program has it open.`, 'error');
        return false;
      }
      log(`Camera auto-select failed: ${err.name}`, 'error');
    }
  }

  state.stream = stream;
  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings ? track.getSettings() : {};
  const gen = state.gen;          // this connection's generation
  const label = track.label || 'USB camera';

  el.usb.srcObject = stream;
  try { await el.usb.play(); } catch { /* muted, so this rarely fails */ }

  state.running = true;
  state.gotFrame = false;
  el.modeBadge.hidden = false;
  el.modeBadge.textContent = 'USB';
  setDot('online', label.replace(/^.*?:\s*/, '') || 'USB camera');
  log(`Camera: ${label}` +
      (settings.width ? ` — ${settings.width}×${settings.height}` : '') +
      (settings.frameRate ? ` @ ${Math.round(settings.frameRate)} fps` : ''));

  track.addEventListener('ended', () => {
    if (gen !== state.gen) return;
    state.running = false;
    setDot('offline');
    showOverlay('The camera was disconnected. Plug it back in and press Reconnect.', true);
    log('Camera disconnected.', 'error');
  });

  startPaint(el.usb, gen);
  return true;
}

function disconnect() {
  state.running = false;
  state.gen += 1;              // stops any capture loop from an older connection
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  el.usb.srcObject = null;
  if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
  state.recorder = null;
  state.recording = false;
  el.recDot.hidden = true;
  $('btnRec').textContent = 'Record';
  $('btnRec').classList.remove('active');
  const ctx = el.canvas.getContext('2d');
  ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
  state.gotFrame = false;
  state.fpsAvg = 0;
  state.lastFrameAt = 0;
  el.fps.textContent = '0';
  el.resStat.textContent = '–';
}

/** Paint the video into the canvas, which is what Snapshot and Record use. */
function startPaint(video, gen) {
  const ctx = el.canvas.getContext('2d', { alpha: false });
  const alive = () => state.running && gen === state.gen;

  const paint = () => {
    if (!alive()) return;
    if (video.readyState >= 2 && video.videoWidth) {
      if (el.canvas.width !== video.videoWidth || el.canvas.height !== video.videoHeight) {
        el.canvas.width = video.videoWidth;
        el.canvas.height = video.videoHeight;
      }
      ctx.drawImage(video, 0, 0);
      el.resStat.textContent = `${video.videoWidth}×${video.videoHeight}`;
      if (!state.gotFrame) {
        state.gotFrame = true;
        hideOverlay();
      }
    }
    state.rafId = requestAnimationFrame(paint);
  };
  state.rafId = requestAnimationFrame(paint);

  // Count real frames for the fps readout, not screen repaints.
  if (video.requestVideoFrameCallback) {
    const tick = () => {
      if (!alive()) return;
      noteFrame();
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
  } else {
    const iv = setInterval(() => {
      if (alive()) noteFrame(); else clearInterval(iv);
    }, 33);
  }
}

function noteFrame() {
  const now = performance.now();
  if (state.lastFrameAt) {
    const dt = now - state.lastFrameAt;
    if (dt > 0) {
      const inst = 1000 / dt;
      state.fpsAvg = state.fpsAvg ? state.fpsAvg * 0.85 + inst * 0.15 : inst;
    }
  }
  state.lastFrameAt = now;
}

setInterval(() => {
  el.fps.textContent = state.fpsAvg ? state.fpsAvg.toFixed(1) : '0';
}, 500);

/* ------------------------------------------------------------------ */
/* snapshot / record / fullscreen                                      */
/* ------------------------------------------------------------------ */

function canvasBlob() {
  return new Promise((resolve) => el.canvas.toBlob(resolve, 'image/jpeg', 0.92));
}

function startRecording() {
  if (!state.recording || !state.stream) return;
  if (typeof MediaRecorder === 'undefined') {
    log('Recording is not supported by this browser.', 'error');
    return;
  }
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) { log('No usable video encoder in this browser.', 'error'); return; }

  const rec = new MediaRecorder(state.stream, { mimeType: mime, videoBitsPerSecond: 2_000_000 });
  state.chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) state.chunks.push(e.data); };
  rec.onstop = () => {
    const blob = new Blob(state.chunks, { type: mime });
    downloadBlob(blob, `ypc-${stamp()}.webm`);
    state.chunks = [];
    log('Recording saved.');
  };
  rec.start(1000);
  state.recorder = rec;
  el.recDot.hidden = false;
  $('btnRec').textContent = 'Stop';
  $('btnRec').classList.add('active');
  log('Recording started.');
}

function stopRecording() {
  el.recDot.hidden = true;
  $('btnRec').textContent = 'Record';
  $('btnRec').classList.remove('active');
  if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function toggleFullscreen() {
  const vp = $('viewport');
  if (document.fullscreenElement) document.exitFullscreen();
  else vp.requestFullscreen?.().catch((err) => log(`Fullscreen failed: ${err.message}`, 'error'));
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

function wire() {
  $('btnReconnect').addEventListener('click', connect);
  $('btnFull').addEventListener('click', toggleFullscreen);

  document.addEventListener('fullscreenchange', () => {
    $('btnFull').textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
  });

  $('btnSnap').addEventListener('click', async () => {
    try {
      if (!state.gotFrame) throw new Error('no frame on screen yet');
      const blob = await canvasBlob();
      if (!blob || blob.size < 1024) throw new Error('no frame on screen yet');
      downloadBlob(blob, `ypc-${stamp()}.jpg`);
      log('Snapshot saved.');
    } catch (err) {
      log(`Snapshot failed: ${err.message}`, 'error');
    }
  });

  $('btnRec').addEventListener('click', () => {
    if (state.recording) {
      state.recording = false;
      stopRecording();
    } else {
      state.recording = true;
      startRecording();
    }
  });

  $('usbSize').addEventListener('change', (e) => {
    cfg.size = e.target.value;
    saveCfg();
    connect();
  });

  $('usbDevice').addEventListener('change', (e) => {
    cfg.deviceId = e.target.value;
    saveCfg();
    connect();
  });

  $('btnRescan').addEventListener('click', async () => {
    const devs = await listCameras(true);
    fillChoices($('usbDevice'), devs, cfg.deviceId);
    log(`Found ${devs.length} camera${devs.length === 1 ? '' : 's'}.`);
    if (!devs.length) log('Nothing plugged in? Check the cable and the USB port.', 'error');
  });

  // Replugging the camera changes the list of devices.
  navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
    const devs = await listCameras(false);
    fillChoices($('usbDevice'), devs, cfg.deviceId);
  });

  wireInstall();
}

/* ------------------------------------------------------------------ */
/* installable app (PWA)                                               */
/* ------------------------------------------------------------------ */

let installPrompt = null;

function wireInstall() {
  const btn = $('btnInstall');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    btn.hidden = false;
    log('Ready to install. Use the Install button or your browser menu.');
  });

  btn.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    log(`Install ${outcome}.`);
    installPrompt = null;
    btn.hidden = true;
  });

  window.addEventListener('appinstalled', () => {
    btn.hidden = true;
    log('Installed as an app.');
  });

  // The service worker caches the UI so the installed app still opens while
  // the local server is stopped. Camera access is a browser permission and
  // works the same installed or in a tab.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      log(`Service worker failed: ${err.message} (install unavailable)`, 'error');
    });
  }
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

(function boot() {
  wire();

  // ?size=1280x960 and ?device=… override the saved choice.
  const q = new URLSearchParams(location.search);
  if (q.get('size')) { cfg.size = q.get('size'); saveCfg(); }
  if (q.has('device')) { cfg.deviceId = q.get('device'); saveCfg(); }

  $('usbSize').value = cfg.size || DEFAULTS.size;
  listCameras(false).then((devs) => fillChoices($('usbDevice'), devs, cfg.deviceId));

  connect();
})();
