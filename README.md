# YPC camera web UI

A single-page, dependency-free controller for the **YPC99** Wi-Fi camera, built
because the vendor app doesn't work. It talks straight to the camera's built-in
web API — no cloud, no account, no server-side code.

```
ypc-cam/
├── index.html   markup
├── style.css    styling
└── app.js       camera API + video pipeline
```

## Running it

The camera serves its API over plain HTTP, so open the page over HTTP too
(a page loaded from `https://` would be blocked as mixed content):

```bash
cd ypc-cam
python3 -m http.server 8000
```

Then visit <http://localhost:8000>.

### Install it as an app

The page is a PWA (`manifest.webmanifest` + `sw.js`). With the local server
running, open <http://localhost:8000> and press **Install** in the header (or
the install icon in the address bar). It gets its own window, icon and entry in
your app launcher.

The service worker caches the UI, so the installed app still opens when the
local server is not running; camera traffic is never intercepted.

Install it from `http://localhost`, not from the GitHub Pages URL: an app
installed from Pages runs at an HTTPS origin and hits the same mixed-content
block described below.

On first load you get a connection dialog. Defaults are already correct for
this camera:

| Field    | Value         |
| -------- | ------------- |
| Address  | `192.168.1.1` |
| Port     | `36299`       |
| Username | `admin`       |
| Password | *(empty)*     |

You can also pass them in the URL:

```
http://localhost:8000/?host=192.168.1.1&port=36299&user=admin&pwd=
```

## How it works

The camera runs **Boa 0.94** on TCP **36299** and speaks a Tenvis/Instar-style
CGI dialect:

| Endpoint               | Purpose                              |
| ---------------------- | ------------------------------------ |
| `/check_user.cgi`      | verify credentials, report privilege |
| `/get_status.cgi`      | device id, firmware, clock, alarms   |
| `/get_params.cgi`      | full configuration dump              |
| `/set_params.cgi`      | write configuration (e.g. name)      |
| `/snapshot.cgi`        | one JPEG frame                       |
| `/decoder_control.cgi` | pan/tilt (only on motorised models)  |
| `/camera_control.cgi`  | brightness, contrast, flip, mode     |
| `/reboot.cgi`          | restart                              |

Every request authenticates with `?user=…&pwd=…`.

Critically, Boa returns `Access-Control-Allow-Origin: *`, so the browser is
allowed to call the camera from a page on any origin. That is what makes a
plain static site possible.

### Video pipeline

1. The page probes `/videostream.cgi` (and `.asf`) and checks the response
   `Content-Type`.
2. If it is `multipart/x-mixed-replace`, the stream is parsed in JavaScript:
   complete JPEGs are sliced out on their SOI/EOI markers, decoded with
   `createImageBitmap`, and painted to a `<canvas>`. This gives accurate fps,
   clean recovery after a drop, and a canvas that can be recorded.
3. If no MJPEG endpoint exists, it falls back to **snapshot polling** —
   repeatedly fetching `/snapshot.cgi` and drawing each frame. On this camera
   that sustains roughly 10 fps at 31 ms per frame over Wi-Fi.

### Recording

`canvas.captureStream()` + `MediaRecorder` produce a WebM file. Snapshots are
saved as JPEG. Everything happens locally in the browser.

## Notes

- The camera's clock is wrong (it reports 2019); the status tab shows what the
  device thinks the time is.
- The camera is its own access point (`YPC_09F449`). While you are connected to
  it you have no internet — that's normal.

## Troubleshooting

**"Permission denied" / HTTP 401.** Either the password is wrong, or the camera
is temporarily refusing logins after too many failed attempts. Stop sending
requests and wait; hammering it can extend the ban. A power cycle of the camera
clears it immediately.

**"Camera unreachable".** You are probably not joined to the camera's Wi-Fi, or
the camera moved to a different address. Check with:

```bash
nmcli -t -f ACTIVE,SSID dev wifi | grep '^yes'
ip route | grep default
```

**Blank video but controls work.** This firmware may not have a MJPEG endpoint;
the page then polls `/snapshot.cgi`, which is slower but works.

**"The camera stopped sending frames".** The capture engine is wedged. Unplug
the camera for a few seconds and plug it back in. It happens when two clients
poll snapshots at the same time — the page now pauses background tabs and only
lets one tab hold the camera, but a phone app or a second device can still
trigger it.

## GitHub Pages

`https://juanweitz.github.io/ypc-cam/` serves this UI, but the browser blocks its
requests to the camera. Chrome logs:

```
Mixed Content: ... insecure resource 'http://192.168.1.1:36299/...'
Access to fetch ... blocked by CORS policy:
Permission was denied for this request to access the `local` address space.
```

Two rules are involved: Pages is HTTPS while the camera is HTTP (mixed content),
and a public page may not reach a private address without the server opting in
(Private Network Access) — which Boa cannot do.

Workaround for Chrome desktop: open
`chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add
`http://192.168.1.1:36299`, enable it and restart Chrome. The hosted page then
works; this is a per-browser setting, not something the site can control.

