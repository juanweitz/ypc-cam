# YPC camera web UI

A single-page, dependency-free controller for the **YPC99** Wi-Fi camera, built
because the vendor app doesn't work. It talks straight to the camera's built-in
web API — no cloud, no account, no server-side code.

The same camera works two ways:

* **Wi-Fi** — the page talks to `http://192.168.1.1:36299` (the camera's own
  access point). Slower, and the firmware's snapshot engine is fragile.
* **USB** — plugged in by USB the camera enumerates as an ordinary **UVC
  webcam**, so it can be read at full frame rate with no Wi-Fi at all. The page
  uses the browser's camera API for this, and `capture.py` records from it from
  the command line.

```
ypc-cam/
├── index.html            markup
├── style.css             styling
├── app.js                camera API + video pipeline (Wi-Fi and USB)
├── capture.py            command-line capture over USB
├── manifest.webmanifest  PWA metadata
└── sw.js                 offline app shell
```

## Running it

Serve the folder over plain HTTP — the browser needs this for both the Wi-Fi
API and for USB camera access:

```bash
cd ypc-cam
python3 -m http.server 8000
```

Then visit <http://localhost:8000>.

Then choose the source in **Settings → Source**: *Wi-Fi camera* or *USB camera*.
The choice is remembered.

### Install it as an app

The page is a PWA (`manifest.webmanifest` + `sw.js`). With the local server
running, open <http://localhost:8000> and press **Install** in the header (or
the install icon in the address bar). It gets its own window, icon and entry in
your app launcher.

The service worker caches the UI, so the installed app still opens when the
local server is not running; camera traffic is never intercepted.

Install it from `http://localhost`. Cameras are per-origin, so the installed app
keeps the camera permission you granted, and the USB source works there just as
it does in a tab.

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

## USB camera mode

Plugged in over USB the camera presents itself as a standard UVC webcam
(`038f:6001`, "USB 2.0 Camera" by lihappe8 Corp.), so Linux drives it with
`uvcvideo` and nothing proprietary is involved.

Two quirks of this device are worth knowing:

* **It defaults to uncompressed video.** YUYV at 1280×960 and a claimed 30 fps
  is ~74 MB/s, more than a USB 2.0 port can carry. `capture.py` asks for MJPEG
  instead (about a tenth of the data for the same picture), and falls back to
  raw if a camera has no JPEG mode.
* **It really runs at about 8 fps**, whatever mode or resolution you ask for —
  the 30 fps in its descriptors is not true.

**In the page:** Settings → Source → *USB camera* → Connect. Frame size is
selectable (640×480, 1280×720, 1280×960). The video is drawn to the same canvas
as the Wi-Fi path, so Snapshot, Record and Fullscreen work unchanged; recording
uses the camera stream directly.

**From the command line:** `capture.py` drives GStreamer, so there is nothing to
install if `gst-launch-1.0` is present.

```bash
./capture.py list            # what video devices exist
./capture.py diagnose        # why a plugged-in camera has no frames
./capture.py snap            # one JPEG
./capture.py record          # MP4 until Ctrl-C
./capture.py record --seconds 60 --size 1280x720 --bitrate 6000
./capture.py preview         # live window
```

Files are written next to the script as `ypc-<date>-<time>.jpg` / `.mp4`;
use `-o` to choose a name, or `--device /dev/video2` / `--name "USB 2.0
Camera"` to pick the device. `--format raw` forces uncompressed video.

USB is the better path when the Wi-Fi module misbehaves: no access point to
join, no snapshot engine to overflow, and no polling.

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

`canvas.captureStream()` (Wi-Fi) or the camera's own `MediaStream` (USB) feeds
`MediaRecorder`, producing a WebM file. Snapshots are saved as JPEG — taken from
the frame already on screen, which avoids asking the Wi-Fi camera for a second
image. Everything happens locally in the browser.

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

**USB: "Cannot enable. Maybe the USB cable is bad?"** The kernel sees the camera
announce itself and then fails to bring it up. Two causes, both worth fixing:

* *Not enough power or bus bandwidth.* Other USB devices on the same controller
  were enough to make this camera drop out. Unplug hubs, docks and network
  adapters while using it — that is what made it stable here.
* *The cable.* Use one that carries data; many micro-USB cables are charge-only.

Check with `./capture.py diagnose`.

**USB: nothing happens / permission denied.** The page must be opened from
`http://localhost:8000`; browsers refuse camera access on `file://` and over
plain HTTP on a non-localhost address. If the browser asks for camera
permission, allow it and press Connect again.

## Hosting

The UI has to be served over plain HTTP on your own machine, because the camera
itself only speaks HTTP on a private address. Do not host it over HTTPS (GitHub
Pages, Netlify, etc.): the browser blocks every request to the camera as mixed
content and Private Network Access then rejects the local address.

If your browser ever reports that block, open
`chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add
`http://192.168.1.1:36299`, enable it and restart Chrome.

