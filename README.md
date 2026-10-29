# YPC camera viewer

A single-page, dependency-free viewer for the **YPC99** camera, built because
the vendor app doesn't work.

The camera is used over **USB**, where it presents itself as a standard UVC
webcam (`038f:6001`, "USB 2.0 Camera" by lihappe8 Corp.). That means Linux
drives it with `uvcvideo` and the page only needs the browser's own camera API —
no HTTP, no polling, no firmware quirks, and no Wi-Fi at all.

```
ypc-cam/
├── index.html            markup
├── style.css             styling
├── app.js                camera capture, snapshot, recording
├── capture.py            command-line capture over USB
├── manifest.webmanifest  PWA metadata
└── sw.js                 offline app shell
```

## Running it

Browsers only allow camera access on a secure origin, so serve the folder from
localhost:

```bash
cd ypc-cam
python3 -m http.server 8000
```

Then open <http://localhost:8000>. The camera opens automatically; if it
doesn't, press **Reconnect**.

`file://` will not work — the browser refuses camera access there.

### Install it as an app

The page is a PWA (`manifest.webmanifest` + `sw.js`). With the server running,
open <http://localhost:8000> and press **Install** in the header (or the install
icon in the address bar). It gets its own window, icon and launcher entry, and
keeps the camera permission you granted.

The service worker caches the UI (network-first, cache as fallback), so the
installed app still opens when the local server is stopped.

## Using it

| Control | What it does |
| --- | --- |
| **Snapshot** | saves the current frame as a JPEG |
| **Record** | starts recording; press again to save a WebM |
| **Fullscreen** | fills the screen with the video; the same button exits |
| **Device** | picks between cameras if more than one is plugged in |
| **Frame size** | 640×480, 1280×720 or 1280×960 |
| **Rescan devices** | re-reads the camera list after a replug |

Snapshots and recordings are produced in the browser and land in your normal
downloads folder. Nothing is uploaded anywhere.

## The camera over USB

Two things about this particular device are worth knowing:

* **It defaults to uncompressed video.** YUYV at 1280×960 and a claimed 30 fps
  is ~74 MB/s, more than a USB 2.0 port can carry. `capture.py` asks for MJPEG
  instead (about a tenth of the data for the same picture) and falls back to raw
  if a camera has no JPEG mode.
* **It really runs at about 8 fps**, whatever mode or resolution you ask for —
  the 30 fps in its descriptors is not true. Anything smoother is not possible
  with this hardware.

It also needs the USB power budget more or less to itself: with a hub and a USB
network adapter on the same controller it would enumerate and then drop
(`Cannot enable. Maybe the USB cable is bad?` in the kernel log). Unplugging the
other devices fixed it.

## Command line capture

`capture.py` drives GStreamer, so there is nothing to install if
`gst-launch-1.0` is present:

```bash
./capture.py list            # what video devices exist
./capture.py diagnose        # why a plugged-in camera has no frames
./capture.py snap            # one JPEG
./capture.py record          # MP4 until Ctrl-C
./capture.py record --seconds 60 --size 1280x720 --bitrate 6000
./capture.py preview         # live window
```

Files are written next to the script as `ypc-<date>-<time>.jpg` / `.mp4`; use
`-o` to choose a name, `--device /dev/video2` or `--name "USB 2.0 Camera"` to
pick the device, and `--format raw` to force uncompressed video.

## Troubleshooting

**"No camera found".** Check the cable and the port:

```bash
./capture.py diagnose
```

If it reports `Cannot enable. Maybe the USB cable is bad?`, the port is failing
to power the camera: use a data cable, plug straight into the machine rather
than a hub, and unplug other USB devices.

**"The USB camera is already in use".** Another tab or program has it open.
Close it — a camera can only be streamed by one program at a time — then press
Reconnect.

**Permission denied.** Allow camera access for `http://localhost:8000` in the
browser's site settings, then press Reconnect.

## Hosting

The page runs from any HTTPS static host. The original Wi-Fi version could not
be hosted: it had to `fetch()` a private `http://192.168.1.1:36299` address,
which browsers block from an HTTPS page (mixed content, Private Network Access).
This version has no such requests — the camera is opened by the browser itself,
so the page's origin is irrelevant as long as it is a secure context.

`https://juanweitz.github.io/ypc-cam/` is live and is built from `main`;
pushing to `main` redeploys it. Camera permission is per origin, so granting it
to the Pages URL is separate from granting it to `http://localhost:8000`.

Serving it from plain `http://` on your LAN will not work: `getUserMedia`
requires a secure context (`https://` or `localhost`).
