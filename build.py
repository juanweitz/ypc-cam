#!/usr/bin/env python3
"""Inline style.css and app.js into a single portable ypc-cam.html.

The result has no external dependencies and works when opened directly from
disk (file://), from a local server, or from any static host.
"""
from pathlib import Path

here = Path(__file__).parent
html = (here / "index.html").read_text()
css = (here / "style.css").read_text()
js = (here / "app.js").read_text()

html = html.replace(
    '<link rel="stylesheet" href="style.css">',
    "<style>\n" + css + "\n</style>",
)
html = html.replace(
    '<script src="app.js"></script>',
    "<script>\n" + js + "\n</script>",
)

out = here / "ypc-cam.html"
out.write_text(html)
print(f"wrote {out} ({out.stat().st_size/1024:.1f} KB)")
