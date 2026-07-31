#!/usr/bin/env python3
"""
Dev server for the Grand Teton world: static files + screenshot inbox.

POST /shot?meta=<json>  (body = PNG bytes) saves a versioned screenshot into shots/:
    shots/shot-004.png   the frame
    shots/shot-004.json  camera pos/yaw/pitch, fly mode, time of day — enough to reproduce the view

Usage: python3 serve.py [port]     (default 8123)
"""
import json, os, re, sys, urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(ROOT, "shots")


def next_index():
    os.makedirs(SHOTS, exist_ok=True)
    idx = 0
    for f in os.listdir(SHOTS):
        m = re.match(r"shot-(\d+)\.png$", f)
        if m:
            idx = max(idx, int(m.group(1)))
    return idx + 1


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Everything must revalidate EXCEPT the bulk height/imagery tile pyramids (huge, immutable
        # per build). Chrome's heuristic caching otherwise serves stale JS after edits ("I can't see
        # the new changes") AND — the subtler trap — stale re-baked PNGs (forestmask/groundtint/
        # veg-atlas): the URL is constant so the browser keeps the old bytes and trees mis-place /
        # ground mis-tints. So no-cache all app files; only /imagery/ + /tiles/ + /height/ stay cached.
        p = self.path.split("?")[0]
        cacheable_tiles = any(seg in p for seg in ("/imagery/", "/tiles/", "/height/"))
        if not cacheable_tiles:
            self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_POST(self):
        if self.path.startswith("/route-batch"):
            length = int(self.headers.get("Content-Length", 0))
            if not (0 < length < 8 * 1024 * 1024):
                self.send_error(400, "bad route batch length")
                return
            try:
                document = json.loads(self.rfile.read(length))
                if not isinstance(document, list):
                    raise ValueError("route batch must be a list")
            except (ValueError, TypeError) as error:
                self.send_error(400, str(error))
                return
            output_dir = os.path.join(ROOT, "benchmark-results")
            os.makedirs(output_dir, exist_ok=True)
            with open(os.path.join(output_dir, "route-batch.json"), "w") as output:
                json.dump(document, output, indent=1)
            body = b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if not self.path.startswith("/shot"):
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        if not (0 < length < 64 * 1024 * 1024):
            self.send_error(400, "bad length")
            return
        body = self.rfile.read(length)
        if body[:8] != b"\x89PNG\r\n\x1a\n":
            self.send_error(400, "not a png")
            return
        q = urllib.parse.urlparse(self.path).query
        meta_raw = urllib.parse.parse_qs(q).get("meta", [None])[0]
        meta = None
        if meta_raw:
            try:
                meta = json.loads(meta_raw)
            except ValueError:
                pass
        # named shots (auto-capture) overwrite in place: same viewpoint -> same file across runs
        if isinstance(meta, dict) and meta.get("name"):
            # Certification variants include route, lighting, and camera in the deterministic
            # name. Keep enough of it to avoid collisions (the old 40-character cap silently
            # truncated "first-person" and made snap.py wait for a filename that could not exist).
            safe = re.sub(r"[^A-Za-z0-9_-]", "", str(meta["name"]))[:96] or "view"
            name = f"auto-{safe}"
        else:
            name = f"shot-{next_index():03d}"
        os.makedirs(SHOTS, exist_ok=True)
        with open(os.path.join(SHOTS, name + ".png"), "wb") as f:
            f.write(body)
        if meta is not None:
            json.dump(meta, open(os.path.join(SHOTS, name + ".json"), "w"), indent=1)
        out = json.dumps({"name": name + ".png"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, fmt, *args):     # quiet tile spam; keep shots visible
        if "/shot" in (str(args[0]) if args else ""):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    os.chdir(ROOT)
    print(f"serving {ROOT} on http://localhost:{port}  (screenshots -> shots/)")
    ThreadingHTTPServer(("", port), Handler).serve_forever()
