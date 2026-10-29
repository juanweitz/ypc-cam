/* YPC camera controller — dependency-free.
 *
 * The camera runs a Boa web server (default TCP 36299) exposing a small
 * Tenvis/Instar-style CGI API:
 *   /check_user.cgi     verify credentials
 *   /get_status.cgi     device status
 *   /get_params.cgi     full configuration
 *   /set_params.cgi     change configuration
 *   /snapshot.cgi       single JPEG frame
 *   /decoder_control.cgi  PTZ (if the model has motors)
 *   /camera_control.cgi   brightness / contrast / flip / resolution
 *
 * Boa answers with `Access-Control-Allow-Origin: *`, so a page from any
 * origin (e.g. http://localhost:8000) can talk to it directly.
 */

'use strict';

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */

const DEFAULTS = {
  host: '192.168.1.1',
  port: '36299',
  user: 'admin',
  pwd: '',
  source: 'wifi',
  usbDevice: '',
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const el = {
  dot: $('dot'),
  hostLabel: $('hostLabel'),
  overlay: $('overlay'),
  overlayText: $('overlayText'),
  mjpeg: $('mjpeg'),
  usb: $('usb'),
  canvas: $('canvas'),
  modeBadge: $('modeBadge'),
  recDot: $('recDot'),
  fps: $('fps'),
  latency: $('latency'),
  resStat: $('resStat'),
  log: $('log'),
  paramsRaw: $('paramsRaw'),
  statusList: $('statusList'),
  debugPath: $('debugPath'),
  debugOut: $('debugOut'),
  settingsDlg: $('settingsDlg'),
};

function log(msg, level = 'info') {
  const t = new Date().toLocaleTimeString();
  const line = `[${t}] ${msg}`;
  el.log.textContent += (el.log.textContent ? '\n' : '') + line;
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
/* transport                                                           */
/* ------------------------------------------------------------------ */

function base() {
  return `http://${cfg.host}:${cfg.port}`;
}

function buildUrl(path, extra = {}) {
  const q = new URLSearchParams({ user: cfg.user, pwd: cfg.pwd, ...extra });
  return `${base()}${path}?${q.toString()}`;
}

/** Text request. Resolves with {status, ok, text}. Never throws except on network error. */
async function api(path, extra = {}, timeout = 7000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(buildUrl(path, extra), {
      cache: 'no-store',
      signal: ctrl.signal,
      mode: 'cors',
    });
    const text = await res.text();
    const denied = /^\s*(Permission denied|File not found)/i.test(text);
    const ok = res.ok && !denied;
    if (!ok) log(`${path} → ${res.status} ${text.slice(0, 60)}`, 'error');
    return { status: res.status, ok, text };
  } catch (err) {
    log(`${path} → network error: ${err.name === 'AbortError' ? 'timeout' : err.message}`, 'error');
    return { status: 0, ok: false, text: '', error: err };
  } finally {
    clearTimeout(timer);
  }
}

/** True when an endpoint exists (404 "File not found" means it does not). */
async function exists(path, extra = {}) {
  const r = await api(path, extra, 4000);
  return r.status !== 0 && !/File not found/i.test(r.text);
}

/** Parse `var key=value;` / `key=value` responses into an object. */
function parseVars(text) {
  const out = {};
  const re = /(?:var\s+)?([A-Za-z0-9_.]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;\n]*);?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* single-viewer guard                                                 */
/* ------------------------------------------------------------------ */

// This camera can only sustain one snapshot client. Tabs coordinate through
// localStorage: only the tab holding a fresh lease may poll.
const TAB_ID = Math.random().toString(36).slice(2);
const LEASE = 'ypc.viewer';

function readLease() {
  try { return JSON.parse(localStorage.getItem(LEASE) || 'null'); } catch { return null; }
}
function writeLease() {
  try { localStorage.setItem(LEASE, JSON.stringify({ id: TAB_ID, ts: Date.now() })); } catch {}
}
function releaseLease() {
  const l = readLease();
  if (l && l.id === TAB_ID) { try { localStorage.removeItem(LEASE); } catch {} }
}
function claimViewer() {
  const l = readLease();
  if (l && l.id !== TAB_ID && Date.now() - l.ts < 6000) return false;
  writeLease();
  return true;
}

setInterval(() => { if (state.running) writeLease(); }, 2000);
window.addEventListener('pagehide', releaseLease);

/* ------------------------------------------------------------------ */
/* connection                                                          */
/* ------------------------------------------------------------------ */

const state = {
  mode: null,          // 'mjpeg' | 'poll' | 'usb' | null
  source: 'wifi',      // 'wifi' | 'usb'
  streamUrl: null,
  usbStream: null,
  running: false,
  pollTimer: null,
  rafId: null,
  lastFrameAt: 0,
  fpsAvg: 0,
  lastLatency: 0,
  failCount: 0,
  gotFrame: false,
  targetFps: Number(localStorage.getItem('ypc.fps') || 4),
  caps: {},
  params: {},
  recording: null,
  recorder: null,
  chunks: [],
  canRecord: true,
};

async function connect() {
  disconnect();
  state.source = cfg.source === 'usb' ? 'usb' : 'wifi';
  document.body.classList.toggle('usb', state.source === 'usb');

  if (state.source === 'usb') return connectUsb();

  setDot('connecting', `${cfg.host}:${cfg.port}`);

  // A page served over HTTPS cannot reach an http:// camera on a private
  // address: mixed content plus Private Network Access both block it.
  if (location.protocol === 'https:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(cfg.host)) {
    showOverlay(
      'This page is loaded over HTTPS, so the browser blocks requests to the camera at ' +
      `${base()}. Open the page over http://localhost:8000 instead, or allow this origin via ` +
      'chrome://flags/#unsafely-treat-insecure-origin-as-secure.',
      true,
    );
    setDot('offline');
    log('Blocked: HTTPS page cannot call the HTTP camera (mixed content / Private Network Access).', 'error');
    return false;
  }

  showOverlay('Connecting…');
  log(`Connecting to ${base()} as "${cfg.user}"`);

  const check = await api('/check_user.cgi');
  if (!check.ok) {
    if (check.status === 401) {
      showOverlay('Permission denied. Wrong password, or the camera is temporarily blocking logins after too many attempts (wait ~10 min).', true);
      setDot('offline');
    } else if (check.status === 0) {
      showOverlay('Camera unreachable. Are you connected to the YPC_… Wi-Fi?', true);
      setDot('offline');
    } else {
      showOverlay(`Unexpected reply from camera (HTTP ${check.status}).`, true);
      setDot('offline');
    }
    return false;
  }

  setDot('online');
  const cu = parseVars(check.text);
  log(`Authenticated${cu.pri ? ` (privilege ${cu.pri})` : ''}`);

  if (!claimViewer()) {
    showOverlay('Another tab is already viewing this camera. Close it, wait a few seconds, then press Reconnect.', true);
    setDot('offline');
    return false;
  }

  await loadStatus();
  await loadParams();
  await detectCapabilities();
  await startVideo();
  return true;
}

function disconnect() {
  state.running = false;
  releaseLease();
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  state.streamAbort?.abort();
  state.streamAbort = null;
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;
  if (state.usbStream) {
    state.usbStream.getTracks().forEach((t) => t.stop());
    state.usbStream = null;
  }
  el.usb.srcObject = null;
  if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
  state.recorder = null;
  state.recording = null;
  el.recDot.hidden = true;
  el.mjpeg.removeAttribute('src');
  el.mjpeg.hidden = true;
  const ctx = el.canvas.getContext('2d');
  ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
  state.mode = null;
  state.streamUrl = null;
  state.gotFrame = false;
  state.fpsAvg = 0;
  state.lastFrameAt = 0;
  el.fps.textContent = '0';
  el.latency.textContent = '–';
}

/* ------------------------------------------------------------------ */
/* USB (UVC webcam) path                                               */
/* ------------------------------------------------------------------ */

// Plugged in over USB this camera is an ordinary UVC webcam, so the browser's
// own camera API reads it — full frame rate, no HTTP, no firmware quirks.

function usbSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

async function listUsbCameras(askPermission = false) {
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

function fillUsbChoices(select, devs, current) {
  const rows = ['<option value="">Default camera</option>'];
  devs.forEach((d, i) => {
    const label = d.label || `Camera ${i + 1}`;
    rows.push(`<option value="${escapeHtml(d.deviceId)}">${escapeHtml(label)}</option>`);
  });
  select.innerHTML = rows.join('');
  if (current && [...select.options].some((o) => o.value === current)) select.value = current;
}

async function connectUsb() {
  if (!usbSupported()) {
    showOverlay(
      'This browser will not let the page open the USB camera. Serve the page from ' +
      'http://localhost:8000 (Chrome or Firefox); camera access is refused on file:// and on plain http:// addresses.',
      true,
    );
    setDot('offline');
    log('getUserMedia unavailable: camera access needs https:// or http://localhost.', 'error');
    return false;
  }

  showOverlay('Opening USB camera…');
  setDot('connecting', 'USB');

  const video = el.usb;
  const constraints = {
    audio: false,
    video: cfg.usbDevice
      ? { deviceId: { exact: cfg.usbDevice } }
      : { width: { ideal: 1280 }, height: { ideal: 720 } },
  };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    const msg = {
      NotAllowedError: 'Camera permission was denied. Allow it for this site, then press Reconnect.',
      NotFoundError: 'No camera found. Plug the camera in by USB, then press Reconnect.',
      NotReadableError: 'The camera could not be opened. This is usually a bad cable or port — try another port directly on the computer.',
      OverconstrainedError: 'That camera is no longer connected. Pick another one in Settings.',
      SecurityError: 'Camera access needs https:// or http://localhost.',
      AbortError: 'The camera was disconnected while opening it.',
    }[err.name] || `Could not open the camera: ${err.message}`;
    showOverlay(msg, true);
    setDot('offline');
    log(`getUserMedia → ${err.name}: ${err.message}`, 'error');
    return false;
  }

  state.usbStream = stream;
  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings ? track.getSettings() : {};

  video.srcObject = stream;
  try { await video.play(); } catch { /* autoplay is muted, so this rarely fails */ }

  const label = track.label || 'USB camera';
  state.mode = 'usb';
  state.running = true;
  state.failCount = 0;
  state.gotFrame = false;
  el.canvas.hidden = false;
  el.mjpeg.hidden = true;
  el.modeBadge.hidden = false;
  el.modeBadge.classList.remove('stalled');
  el.modeBadge.textContent = 'USB';
  setDot('online', label.replace(/^.*?:\s*/, '') || 'USB camera');
  log(`USB camera: ${label}` +
      (settings.width ? ` — ${settings.width}×${settings.height}` : '') +
      (settings.frameRate ? ` @ ${Math.round(settings.frameRate)} fps` : ''));

  track.addEventListener('ended', () => {
    if (state.mode !== 'usb') return;
    state.running = false;
    setDot('offline');
    showOverlay('The camera was disconnected. Plug it back in and press Reconnect.', true);
    log('USB camera disconnected.', 'error');
  });

  el.usb.hidden = true;
  startUsbPaint(video);
  return true;
}

function startUsbPaint(video) {
  const ctx = el.canvas.getContext('2d', { alpha: false });

  const paint = () => {
    if (!state.running || state.mode !== 'usb') return;
    if (video.readyState >= 2 && video.videoWidth) {
      if (el.canvas.width !== video.videoWidth || el.canvas.height !== video.videoHeight) {
        el.canvas.width = video.videoWidth;
        el.canvas.height = video.videoHeight;
      }
      ctx.drawImage(video, 0, 0);
      el.resStat.textContent = `${video.videoWidth}×${video.videoHeight}`;
      $('frameSize').textContent = `${video.videoWidth}×${video.videoHeight}`;
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
      if (!state.running || state.mode !== 'usb') return;
      noteFrame();
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
  } else {
    const iv = setInterval(() => {
      if (state.running && state.mode === 'usb') noteFrame(); else clearInterval(iv);
    }, 33);
  }
}

/* ------------------------------------------------------------------ */
/* status + params                                                     */
/* ------------------------------------------------------------------ */

async function loadStatus() {
  const r = await api('/get_status.cgi');
  if (!r.ok) return;
  const s = parseVars(r.text);
  const epoch = s.now || s.time;
  const rows = [
    ['Name', s.alias],
    ['Device ID', s.id],
    ['Firmware', s.sys_ver],
    ['Web UI', s.app_ver],
    ['Camera time', epoch ? new Date(Number(epoch) * 1000).toLocaleString() : ''],
    ['Alarm', s.alarm_status !== undefined ? s.alarm_status : s.alarm],
    ['DDNS', s.ddns_status],
    ['UPnP', s.upnp_status],
  ].filter(([, v]) => v !== undefined && v !== '');

  el.statusList.innerHTML = rows
    .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`)
    .join('');

  if (s.alias) document.title = `${s.alias} — YPC Camera`;
}

async function loadParams() {
  const r = await api('/get_params.cgi');
  if (!r.ok) { el.paramsRaw.textContent = 'Not available for this account.'; return; }
  state.params = parseVars(r.text);
  el.paramsRaw.textContent = r.text.trim();
  applyParamsToForm(state.params);
}

function applyParamsToForm(p) {
  if (p.alias !== undefined) $('alias').value = p.alias;
  if (p.brightness !== undefined) setRange('brightness', p.brightness);
  if (p.contrast !== undefined) setRange('contrast', p.contrast);
  if (p.flip !== undefined) $('flip').value = p.flip;
  if (p.powerfreq !== undefined && ['0', '1', '2'].includes(p.powerfreq)) $('mode').value = p.powerfreq;
  if (p.led !== undefined) $('led').checked = p.led === '1';
}

function setRange(id, v) {
  const input = $(id);
  input.value = v;
  const out = $(id + 'Val');
  if (out) out.textContent = v;
}

/* ------------------------------------------------------------------ */
/* capability probing                                                  */
/* ------------------------------------------------------------------ */

async function detectCapabilities() {
  // Probe one at a time — this Boa server is easily overwhelmed.
  // Never probe /reboot.cgi: on some firmware a GET reboots the camera.
  const ptz = await exists('/decoder_control.cgi', { command: '1', onestep: '1' });
  await sleep(120);
  const camCtrl = await exists('/camera_control.cgi', { param: '1', value: state.params.brightness || '0' });
  await sleep(120);
  const setParams = await exists('/set_params.cgi');
  state.caps = { ptz, camCtrl, setParams, image: camCtrl || setParams, reboot: false };
  log(`Capabilities: PTZ=${ptz} camera_control=${camCtrl} set_params=${setParams}`);

  $('dpad').classList.toggle('unsupported', !ptz);
  $('ptzHint').textContent = ptz
    ? 'Hold a direction to move, release to stop.'
    : 'This model has no pan/tilt motors.';
  document.querySelectorAll('#dpad .pad').forEach((b) => { b.disabled = !ptz; });
  $('btnReboot').style.display = 'none';

  const imageInputs = ['brightness', 'contrast', 'flip', 'mode', 'led'];
  imageInputs.forEach((id) => { $(id).disabled = !state.caps.image; });
}

/* ------------------------------------------------------------------ */
/* video                                                               */
/* ------------------------------------------------------------------ */

const STREAM_CANDIDATES = [
  { path: '/videostream.cgi', extra: { resolution: '32', rate: '0' } },
];

async function startVideo() {
  showOverlay('Starting video…');
  const stream = await findMjpeg();
  if (stream) {
    startMjpegStream(stream);
  } else {
    log('No MJPEG endpoint found — falling back to snapshot polling.');
    startPolling();
  }
}

/** Probe stream endpoints. Returns a URL whose response is multipart MJPEG. */
async function findMjpeg() {
  for (const cand of STREAM_CANDIDATES) {
    const url = buildUrl(cand.path, cand.extra);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal, mode: 'cors' });
      const type = (res.headers.get('content-type') || '').toLowerCase();
      const ok = res.ok && (type.includes('multipart') || type.includes('mjpeg'));
      log(`probe ${cand.path} → ${res.status} ${type || '(no type)'}`);
      if (ok) return url;
    } catch (err) {
      log(`probe ${cand.path} → ${err.name === 'AbortError' ? 'timeout' : err.message}`);
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
  }
  return null;
}

/* ---- MJPEG: read the multipart stream ourselves so we get every frame,
 *      true fps, and a canvas we can record from. ---------------------- */

function findByte(buf, a, b, from = 0) {
  for (let i = from; i < buf.length - 1; i++) if (buf[i] === a && buf[i + 1] === b) return i;
  return -1;
}

function startMjpegStream(url) {
  state.mode = 'mjpeg';
  state.streamUrl = url;
  state.running = true;
  el.modeBadge.hidden = false;
  el.modeBadge.textContent = 'MJPEG';
  el.mjpeg.hidden = true;
  el.canvas.hidden = false;

  const ctx = el.canvas.getContext('2d');
  const ctrl = new AbortController();
  state.streamAbort = ctrl;
  let busy = false;

  const draw = async (bytes) => {
    if (busy) return;              // drop frames while the decoder is behind
    busy = true;
    try {
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      if (el.canvas.width !== bmp.width || el.canvas.height !== bmp.height) {
        el.canvas.width = bmp.width;
        el.canvas.height = bmp.height;
      }
      el.resStat.textContent = `${bmp.width}×${bmp.height}`;
      $('frameSize').textContent = `${bmp.width}×${bmp.height}`;
      ctx.drawImage(bmp, 0, 0);
      bmp.close?.();
      hideOverlay();
      state.gotFrame = true;
      noteFrame();
    } catch (err) {
      log(`frame decode failed: ${err.message}`, 'error');
    } finally {
      busy = false;
    }
  };

  const read = async () => {
    let status = 0;
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal, mode: 'cors' });
      status = res.status;
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      let buf = new Uint8Array(0);

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        const merged = new Uint8Array(buf.length + value.length);
        merged.set(buf, 0);
        merged.set(value, buf.length);
        buf = merged;

        // Extract every complete JPEG (SOI … EOI). 0xFFD9 cannot occur inside
        // entropy-coded data, so this is safe for baseline/progressive JPEG.
        for (;;) {
          const start = findByte(buf, 0xff, 0xd8);
          if (start < 0) break;
          const end = findByte(buf, 0xff, 0xd9, start + 2);
          if (end < 0) break;
          const jpg = buf.slice(start, end + 2);
          buf = buf.slice(end + 2);
          draw(jpg);
        }
        // Guard against unbounded growth if the stream is not what we think.
        if (buf.length > 4_000_000) buf = new Uint8Array(0);
      }
    } catch (err) {
      if (ctrl.signal.aborted || !state.running) return;
      log(`MJPEG stream ended: ${err.message}`, 'error');
      if (status === 401) {
        showOverlay('Permission denied. The camera is blocking logins — wait ~10 minutes, then press Reconnect.', true);
        setDot('offline');
        return;
      }
      showOverlay('Stream interrupted — retrying…', true);
      setTimeout(() => {
        if (state.running && state.mode === 'mjpeg') startMjpegStream(url + '&_=' + Date.now());
      }, 1500);
    }
  };
  read();
}

function startPolling() {
  state.mode = 'poll';
  el.modeBadge.hidden = false;
  el.modeBadge.classList.remove('stalled');
  el.modeBadge.textContent = 'SNAPSHOT POLL';
  el.mjpeg.hidden = true;
  el.canvas.hidden = false;

  const ctx = el.canvas.getContext('2d');
  state.running = true;
  state.failCount = 0;
  state.gotFrame = false;

  const grab = async () => {
    if (!state.running) return;

    // Never poll from a background tab: this camera cannot take extra load.
    if (document.hidden) {
      state.pollTimer = setTimeout(grab, 1000);
      return;
    }

    const t0 = performance.now();
    let delay = 250;
    let status = 0;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    try {
      // No cache-buster params: this firmware rejects unknown query keys.
      const res = await fetch(buildUrl('/snapshot.cgi'), {
        cache: 'no-store',
        mode: 'cors',
        signal: ctrl.signal,
      });
      status = res.status;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        const msg = new TextDecoder().decode(bytes.slice(0, 60)).trim();
        throw new Error(msg || 'response was not a JPEG');
      }

      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      if (el.canvas.width !== bmp.width || el.canvas.height !== bmp.height) {
        el.canvas.width = bmp.width;
        el.canvas.height = bmp.height;
      }
      el.resStat.textContent = `${bmp.width}×${bmp.height}`;
      $('frameSize').textContent = `${bmp.width}×${bmp.height}`;
      ctx.drawImage(bmp, 0, 0);
      bmp.close?.();

      hideOverlay();
      state.failCount = 0;
      state.gotFrame = true;
      el.modeBadge.classList.remove('stalled');
      el.modeBadge.textContent = 'SNAPSHOT POLL';

      const took = performance.now() - t0;
      state.lastLatency = Math.round(took);
      el.latency.textContent = state.lastLatency;
      noteFrame();

      // Pace requests so the camera is never saturated.
      const target = 1000 / (state.targetFps || 4);
      delay = Math.max(50, Math.min(2000, target - took));
    } catch (err) {
      clearTimeout(timer);
      state.failCount += 1;
      const backoff = Math.min(5000, 400 * 2 ** Math.max(0, state.failCount - 1));
      delay = backoff;

      if (status === 401) {
        showOverlay('Permission denied. Wait ~60 minutes for the camera to stop blocking logins, then press Reconnect.', true);
        setDot('offline');
        return;
      }

      log(`snapshot → ${err.name === 'AbortError' ? 'timed out' : err.message} (retry in ${backoff} ms)`, 'error');
      el.modeBadge.textContent = 'RECONNECTING';
      el.modeBadge.classList.add('stalled');

      // After a few failures the camera's capture engine is usually wedged.
      // Stop entirely rather than hammering it — that only makes it worse.
      if (state.failCount >= 5) {
        state.running = false;
        setDot('offline');
        showOverlay(
          'The camera stopped sending frames and is not recovering. ' +
          'Unplug it for a few seconds, then press Reconnect.',
          true,
        );
        return;
      }

      if (!state.gotFrame) {
        showOverlay(
          state.failCount < 3
            ? 'Waiting for the camera to send a frame…'
            : 'The camera is not returning frames. It may need a power cycle.',
          state.failCount >= 3,
        );
      }
    } finally {
      clearTimeout(timer);
    }
    state.pollTimer = setTimeout(grab, delay);
  };
  grab();
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
  if (state.mode === 'mjpeg') el.latency.textContent = '–';
}, 500);

/* ------------------------------------------------------------------ */
/* controls                                                            */
/* ------------------------------------------------------------------ */

async function ptzCommand(command, onestep = 0) {
  if (!state.caps.ptz) return;
  await api('/decoder_control.cgi', { command: String(command), onestep: String(onestep) }, 4000);
}

function wireDpad() {
  const pads = document.querySelectorAll('#dpad .pad');
  pads.forEach((btn) => {
    const cmd = btn.dataset.cmd;
    const stop = btn.dataset.stop;

    const press = (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      btn.classList.add('pressed');
      if (cmd === 'stopall') {
        [1, 3, 5, 7].forEach((c) => ptzCommand(c, 1));
      } else {
        ptzCommand(cmd, 0);
      }
    };
    const release = (e) => {
      if (e) e.preventDefault();
      btn.classList.remove('pressed');
      if (stop) ptzCommand(stop, 1);
    };

    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointerleave', release);
    btn.addEventListener('pointercancel', release);
  });
}

function wireImageControls() {
  let timer = null;

  // Prefer camera_control.cgi; fall back to the same settings via set_params.cgi,
  // which is all this firmware exposes.
  const send = (ctrlParam, key, value) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!state.caps.image) return;
      const r = state.caps.camCtrl
        ? await api('/camera_control.cgi', { param: String(ctrlParam), value: String(value) }, 6000)
        : await api('/set_params.cgi', { [key]: String(value) }, 6000);
      log(`${key}=${value} → ${r.ok ? 'ok' : r.text.slice(0, 50)}`, r.ok ? 'info' : 'error');
    }, 250);
  };

  $('brightness').addEventListener('input', (e) => {
    $('brightnessVal').textContent = e.target.value;
    send(1, 'brightness', e.target.value);
  });
  $('contrast').addEventListener('input', (e) => {
    $('contrastVal').textContent = e.target.value;
    send(2, 'contrast', e.target.value);
  });
  $('flip').addEventListener('change', (e) => send(5, 'flip', e.target.value));
  $('mode').addEventListener('change', (e) => send(3, 'powerfreq', e.target.value));
  $('led').addEventListener('change', (e) => {
    if (!state.caps.image) return;
    const value = e.target.checked ? '1' : '0';
    if (state.caps.camCtrl) api('/camera_control.cgi', { param: '6', value });
    else api('/set_params.cgi', { led: value }).then((r) => log(`led=${value} → ${r.ok ? 'ok' : r.text.slice(0, 50)}`));
  });

  $('refresh').value = String(state.targetFps);
  $('refresh').addEventListener('change', (e) => {
    state.targetFps = Number(e.target.value);
    try { localStorage.setItem('ypc.fps', String(state.targetFps)); } catch {}
    log(`Refresh set to ${state.targetFps} fps`);
  });

  $('btnAlias').addEventListener('click', async () => {
    const name = $('alias').value.trim();
    if (!name) return;
    const r = await api('/set_params.cgi', { alias: name });
    log(`set_params alias="${name}" → ${r.ok ? 'ok' : r.text.slice(0, 60)}`);
    await loadStatus();
  });

  $('btnReboot').addEventListener('click', async () => {
    if (!confirm('Reboot the camera now? Video will drop for about a minute.')) return;
    const r = await api('/reboot.cgi', {}, 4000);
    if (!r.ok) { log('Reboot was refused by the camera.', 'error'); return; }
    log('Reboot requested.');
    showOverlay('Camera rebooting…', true);
    setDot('connecting');
  });
}

/* ------------------------------------------------------------------ */
/* snapshot / record / fullscreen                                      */
/* ------------------------------------------------------------------ */

function canvasBlob() {
  return new Promise((resolve) => el.canvas.toBlob(resolve, 'image/jpeg', 0.92));
}

function wireStageButtons() {
  $('btnSnap').addEventListener('click', async () => {
    try {
      // Take the frame that is already on screen. For the Wi-Fi camera this
      // avoids a second /snapshot.cgi request, which can wedge the capture
      // engine; for USB it is the only sensible source.
      if (state.gotFrame) {
        const blob = await canvasBlob();
        if (!blob || blob.size < 1024) throw new Error('nothing on screen yet');
        downloadBlob(blob, `ypc-${stamp()}.jpg`);
        log('Snapshot saved.');
        return;
      }
      const res = await fetch(buildUrl('/snapshot.cgi'), { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (blob.type !== 'image/jpeg' || blob.size < 1024) {
        throw new Error(await blob.text() || 'camera returned no picture');
      }
      downloadBlob(blob, `ypc-${stamp()}.jpg`);
      log('Snapshot saved.');
    } catch (err) {
      log(`Snapshot failed: ${err.message}`, 'error');
    }
  });

  $('btnRec').addEventListener('click', () => {
    if (state.recording) stopRecording(); else startRecording();
  });

  $('btnFull').addEventListener('click', () => {
    const vp = $('viewport');
    if (document.fullscreenElement) document.exitFullscreen();
    else vp.requestFullscreen?.();
  });
}

function startRecording() {
  if (!state.canRecord) return;

  // USB: record the camera stream itself, at its native rate and size.
  // Wi-Fi: record the canvas the frames are painted into.
  const fromUsb = state.mode === 'usb' && state.usbStream;
  const stream = fromUsb ? state.usbStream : el.canvas.captureStream?.(20);
  if (!stream) {
    log('Recording is not supported by this browser.', 'error');
    return;
  }
  if (typeof MediaRecorder === 'undefined') {
    log('Recording is not supported by this browser.', 'error');
    return;
  }
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) { log('No usable video encoder in this browser.', 'error'); return; }

  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_000_000 });
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
  state.recording = true;
  el.recDot.hidden = false;
  $('btnRec').textContent = 'Stop';
  $('btnRec').classList.add('active');
  log('Recording started.');
}

function stopRecording() {
  state.recording = false;
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

/* ------------------------------------------------------------------ */
/* settings dialog + tabs + debug                                      */
/* ------------------------------------------------------------------ */

function openSettings() {
  $('cfgHost').value = cfg.host;
  $('cfgPort').value = cfg.port;
  $('cfgUser').value = cfg.user;
  $('cfgPwd').value = cfg.pwd;
  $('cfgSource').value = cfg.source;
  syncSourceFields();
  listUsbCameras(false).then((devs) => fillUsbChoices($('cfgUsbDevice'), devs, cfg.usbDevice));
  el.settingsDlg.showModal();
}

function syncSourceFields() {
  const usb = $('cfgSource').value === 'usb';
  $('usbFields').hidden = !usb;
  $('wifiFields').hidden = usb;
  if (usb && !usbSupported()) {
    $('usbHint').textContent = 'This browser blocks camera access on this address. Open the page from http://localhost:8000 instead.';
  }
}

function wireSettings() {
  $('btnSettings').addEventListener('click', openSettings);
  $('cfgSource').addEventListener('change', syncSourceFields);

  $('settingsForm').addEventListener('submit', (e) => {
    const action = e.submitter?.value;
    if (action === 'cancel') return;
    e.preventDefault();
    cfg.source = $('cfgSource').value === 'usb' ? 'usb' : 'wifi';
    cfg.usbDevice = $('cfgUsbDevice').value || '';
    cfg.host = $('cfgHost').value.trim() || DEFAULTS.host;
    cfg.port = $('cfgPort').value.trim() || DEFAULTS.port;
    cfg.user = $('cfgUser').value.trim() || DEFAULTS.user;
    cfg.pwd = $('cfgPwd').value;
    saveCfg();
    el.settingsDlg.close();
    connect();
  });

  $('btnReconnect').addEventListener('click', connect);

  // USB device pickers in the side panel.
  const pick = async (ask) => {
    const devs = await listUsbCameras(ask);
    fillUsbChoices($('usbDevice'), devs, cfg.usbDevice);
    fillUsbChoices($('cfgUsbDevice'), devs, cfg.usbDevice);
    log(`Found ${devs.length} camera${devs.length === 1 ? '' : 's'}.`);
  };
  $('btnRescan').addEventListener('click', () => pick(true));
  $('usbDevice').addEventListener('change', (e) => {
    cfg.usbDevice = e.target.value;
    saveCfg();
    connect();
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tabpane').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $('pane-' + tab.dataset.tab).classList.add('active');
    });
  });

  $('btnSend').addEventListener('click', async () => {
    const path = $('debugPath').value.trim();
    if (!path) return;
    const r = await api(path);
    el.debugOut.textContent = `HTTP ${r.status}\n\n${r.text.slice(0, 8000)}`;
  });
  $('debugPath').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btnSend').click();
  });
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

  // A service worker makes the UI load offline. It only handles same-origin
  // requests; camera traffic is never intercepted.
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
  wireSettings();
  wireDpad();
  wireImageControls();
  wireStageButtons();
  wireInstall();

  // URL overrides: ?host=…&port=…&user=…&pwd=…&source=usb
  const q = new URLSearchParams(location.search);
  let changed = false;
  for (const k of ['host', 'port', 'user', 'pwd', 'usbDevice']) {
    if (q.has(k)) { cfg[k] = q.get(k); changed = true; }
  }
  if (q.get('source') === 'usb') { cfg.source = 'usb'; changed = true; }
  if (changed) saveCfg();

  const hasSaved = !!localStorage.getItem('ypc.cfg');
  if (!hasSaved) {
    openSettings();
    showOverlay('Set the camera address to begin.');
    return;
  }
  connect();
})();
