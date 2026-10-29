#!/usr/bin/env python3
"""Capture from the YPC camera when it is plugged in over USB.

Connected by USB the camera enumerates as an ordinary UVC webcam, so nothing
bespoke is needed: V4L2 + GStreamer read it directly, at full frame rate and
with no Wi-Fi, no HTTP server and no firmware quirks to fight.

    ./capture.py list                # what devices exist
    ./capture.py preview             # live window
    ./capture.py snap                # one JPEG -> ypc-<time>.jpg
    ./capture.py record              # video -> ypc-<time>.mp4 (Ctrl-C stops)
    ./capture.py record --seconds 30 # record for 30 s
    ./capture.py record --size 640x480 --bitrate 1500

By default the camera is auto-detected by its USB name; use --device
/dev/video2 or --name "USB 2.0 Camera" to override.
"""

from __future__ import annotations

import argparse
import os
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

SYSFS = Path("/sys/class/video4linux")
DEFAULT_HINTS = ("usb 2.0 camera", "lihappe", "ypc", "uvc")


def stamp() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


def devices() -> list[dict]:
    """Enumerate V4L2 nodes with their human-readable names."""
    out = []
    for node in sorted(SYSFS.glob("video*")):
        try:
            name = (node / "name").read_text().strip()
        except OSError:
            name = "?"
        usb = ""
        # Resolve the USB parent so we can show VID:PID and the port path.
        try:
            dev = (node / "device").resolve()
            vid = pid = ""
            for parent in dev.parents:
                if (parent / "idVendor").exists():
                    vid = (parent / "idVendor").read_text().strip()
                    pid = (parent / "idProduct").read_text().strip()
                    usb = f"{vid}:{pid}"
                    bus = parent.name  # e.g. 1-1
                    usb += f" on {bus}"
                    break
        except OSError:
            pass
        index = node.name.removeprefix("video")
        # UVC devices expose an extra node that only carries metadata.
        caps = ""
        try:
            for entry in (node / "device" / "video4linux").glob(f"video{index}/*"):
                pass
        except OSError:
            pass
        out.append({"node": f"/dev/{node.name}", "name": name, "usb": usb, "index": index})
    return out


def find_device(device: str | None, name: str | None) -> str:
    if device:
        if not Path(device).exists():
            sys.exit(f"{device} does not exist.")
        return device

    found = devices()
    if not found:
        sys.exit("No video devices found. Is the camera plugged in?")

    if name:
        needle = name.lower()
        for d in found:
            if needle in d["name"].lower():
                return d["node"]
        sys.exit(f'No device whose name contains "{name}".')

    for d in found:
        if any(h in d["name"].lower() for h in DEFAULT_HINTS):
            return d["node"]

    # Fall back to the first node, but say so.
    print(f'No camera matched the usual names; using {found[0]["node"]} ("{found[0]["name"]}").',
          file=sys.stderr)
    return found[0]["node"]


def cmd_list(_args) -> int:
    found = devices()
    if not found:
        print("No video devices found.")
        return 1
    width = max(len(d["node"]) for d in found)
    for d in found:
        mark = "  <- camera" if any(h in d["name"].lower() for h in DEFAULT_HINTS) else ""
        print(f'{d["node"]:<{width}}  {d["name"]}  {d["usb"]}{mark}')
    return 0


def gst(pipeline: str) -> int:
    """Run a gst-launch pipeline, streaming its errors instead of hiding them."""
    cmd = ["gst-launch-1.0", "-e", "-q"] + pipeline.split()
    try:
        return subprocess.call(cmd)
    except FileNotFoundError:
        sys.exit("gst-launch-1.0 is missing: sudo apt install gstreamer1.0-tools "
                 "gstreamer1.0-plugins-good gstreamer1.0-plugins-bad "
                 "gstreamer1.0-plugins-ugly gstreamer1.0-libav")


def cmd_snap(args) -> int:
    node = find_device(args.device, args.name)
    out = Path(args.out or f"ypc-{stamp()}.jpg")
    # Let auto-exposure settle for a moment, then keep overwriting the file so
    # the last (settled) frame is the one that survives.
    pipeline = (
        f"v4l2src device={node} num-buffers={args.settle} ! "
        f"videoconvert ! jpegenc quality={args.quality} ! "
        f"multifilesink location={out}"
    )
    rc = gst(pipeline)
    if rc == 0 and out.exists() and out.stat().st_size > 1024:
        print(f"Saved {out} ({out.stat().st_size / 1024:.0f} KB)")
        return 0
    print("Capture failed — no frame was produced.", file=sys.stderr)
    return rc or 1


def cmd_record(args) -> int:
    node = find_device(args.device, args.name)
    out = Path(args.out or f"ypc-{stamp()}.mp4")

    caps = "video/x-raw,format=I420"
    if args.size:
        w, h = args.size.lower().split("x")
        caps += f",width={w},height={h}"

    pipeline = (
        f"v4l2src device={node} ! videoconvert ! "
        f"{caps} ! "
        f"x264enc tune=zerolatency speed-preset=veryfast bitrate={args.bitrate} "
        f"key-int-max=30 ! h264parse ! mp4mux ! filesink location={out}"
    )

    if args.seconds:
        print(f"Recording {args.seconds}s to {out} … (Ctrl-C stops early)")

        def stop() -> None:
            subprocess.run(["pkill", "-INT", "-f", "gst-launch-1.0"], check=False)

        timer = threading.Timer(args.seconds, stop)
        timer.daemon = True
        timer.start()
    else:
        print(f"Recording to {out} … press Ctrl-C to stop.")

    rc = gst(pipeline)
    if out.exists() and out.stat().st_size > 1024:
        print(f"Saved {out} ({out.stat().st_size / 1024 / 1024:.1f} MB)")
        return 0
    print("No video was written.", file=sys.stderr)
    return rc or 1


def cmd_preview(args) -> int:
    node = find_device(args.device, args.name)
    sink = args.sink or ("autovideosink" if os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
                         else "autovideosink")
    print(f"Previewing {node} — close the window or press Ctrl-C to stop.")
    pipeline = f"v4l2src device={node} ! videoconvert ! {sink} sync=false"
    rc = gst(pipeline)
    if rc != 0 and not os.environ.get("DISPLAY"):
        print("No display available; try: ./capture.py snap", file=sys.stderr)
    return rc


def cmd_diagnose(_args) -> int:
    """Explain why a plugged-in camera is not producing frames."""
    found = devices()
    print("Video devices:")
    if found:
        for d in found:
            print(f'  {d["node"]}  {d["name"]}  {d["usb"]}')
    else:
        print("  none")

    stuck = [d for d in found if any(h in d["name"].lower() for h in DEFAULT_HINTS)]
    if stuck:
        print("\nThe camera node exists, so USB enumeration worked.")
        print("If capture fails with 'Device or resource busy', another program has it open.")
        return 0

    print("\nNo YPC camera among those devices. Recent USB messages from the kernel:")
    try:
        out = subprocess.run(
            ["journalctl", "-k", "--no-pager", "-n", "200"],
            capture_output=True, text=True, timeout=5,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        out = ""
    lines = [l for l in out.splitlines() if re.search(r"usb|cannot enable|enumerate", l, re.I)][-12:]
    for line in lines:
        print("  " + line.split("kernel: ", 1)[-1])

    if any("Cannot enable" in l or "unable to enumerate" in l for l in lines):
        print("\nThe kernel keeps failing to bring the camera up. That is almost always")
        print("the cable or the port: use a different port (directly on the machine,")
        print("not a hub) and a cable that carries data, not charge-only.")
    return 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--device", help="V4L2 node, e.g. /dev/video2")
    ap.add_argument("--name", help="pick the device whose name contains this text")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="list video devices").set_defaults(func=cmd_list)
    sub.add_parser("diagnose", help="explain a missing/garbled camera").set_defaults(func=cmd_diagnose)

    p = sub.add_parser("snap", help="save one JPEG")
    p.add_argument("-o", "--out")
    p.add_argument("--quality", type=int, default=90)
    p.add_argument("--settle", type=int, default=25, help="frames to discard while exposure settles")
    p.set_defaults(func=cmd_snap)

    p = sub.add_parser("record", help="record video (Ctrl-C to stop)")
    p.add_argument("-o", "--out")
    p.add_argument("--seconds", type=float, help="stop after this many seconds")
    p.add_argument("--size", help="WxH, e.g. 1280x720 (default: camera native)")
    p.add_argument("--bitrate", type=int, default=4000, help="kbit/s")
    p.set_defaults(func=cmd_record)

    p = sub.add_parser("preview", help="live window")
    p.add_argument("--sink", help="gst sink, e.g. xvimagesink")
    p.set_defaults(func=cmd_preview)

    args = ap.parse_args()
    if args.cmd in ("snap", "record", "preview"):
        if not args.device and not args.name:
            pass  # auto-detect happens in find_device
    return args.func(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print()
        sys.exit(130)
