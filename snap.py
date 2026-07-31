#!/usr/bin/env python3
"""
Headless review shots: fly the views in views.json and save shots/auto-<name>.png for each.

Requires serve.py running (it receives the PNGs). Chrome does the WebGL rendering headlessly;
the page itself flies to each view, waits for terrain/imagery streams to settle, and POSTs the
frame — so no window, no pointer lock, no human.

Usage:
    python3 snap.py                          # full suite through Vite on localhost:8130
    python3 snap.py --suite smoke            # fast representative checks
    python3 snap.py --suite full             # every canonical visual state
    python3 snap.py --list-suites             # print suite names and their views
    python3 snap.py myviews.json --port 8124
    python3 snap.py --views sage-ground,treeline   # subset by name
"""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    shutil.which("google-chrome") or "",
    shutil.which("chromium") or "",
]


def find_chrome():
    for c in CHROME_CANDIDATES:
        if c and os.path.exists(c):
            return c
    sys.exit("no Chrome/Chromium binary found")


def command_output(cmd):
    try:
        return subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def suite_names(views):
    """Return declared suite names in first-use order."""
    names = []
    for view in views:
        for name in view.get("suites", ["full"]):
            if name not in names:
                names.append(name)
    return names


def select_suite(views, name):
    selected = [view for view in views if name in view.get("suites", ["full"])]
    if not selected:
        available = ", ".join(suite_names(views)) or "(none)"
        sys.exit(f"unknown or empty suite {name!r}; available suites: {available}")
    return selected


def main():
    args = sys.argv[1:]
    views_file = "views.json"
    port = 8130
    subset = None
    suite = None
    quality = None
    list_suites = False
    selected = False
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--port":
            port = int(args[i + 1]); i += 2
        elif a == "--views":
            subset = args[i + 1].split(","); i += 2
        elif a == "--suite":
            suite = args[i + 1]; i += 2
        elif a == "--list-suites":
            list_suites = True; i += 1
        elif a == "--quality":
            quality = args[i + 1]
            if quality not in ("ultra", "high", "balanced", "low"):
                sys.exit("--quality must be ultra, high, balanced, or low")
            i += 2
        elif a.endswith(".json"):
            views_file = a; i += 1
        else:
            sys.exit(f"unknown arg {a}")

    with open(os.path.join(ROOT, views_file)) as f:
        views = json.load(f)
    if not isinstance(views, list):
        sys.exit(f"{views_file} must contain a JSON list of views")
    if list_suites:
        for name in suite_names(views):
            print(f"{name}: " + ", ".join(v["name"] for v in select_suite(views, name)))
        return
    # No selector remains backwards compatible: it is the comprehensive suite.
    if suite:
        views = select_suite(views, suite)
        selected = True
    if subset:
        views = [v for v in views if v["name"] in subset]
        if not views:
            sys.exit(f"no views match {subset}")
    if selected or subset:
        # The page receives a plain list, so materialize every CLI selection beside the source.
        views_file = "views.auto-subset.json"
        with open(os.path.join(ROOT, views_file), "w") as f:
            json.dump(views, f)

    # Long endurance runs defer intermediate PNG encoding so capture allocation cannot pollute
    # later route timings. The final sidecar carries the complete routeBatch telemetry.
    expected = [
        os.path.join(ROOT, "shots", f"auto-{v['name']}.png")
        for v in views if not v.get("deferCapture")
    ]
    chrome = find_chrome()
    commit_sha = command_output(["git", "-C", ROOT, "rev-parse", "HEAD"])
    worktree_dirty = bool(command_output(
        ["git", "-C", ROOT, "status", "--porcelain", "--untracked-files=normal"]
    ))
    browser_version = command_output([chrome, "--version"])
    start = time.time()
    url = f"http://localhost:{port}/grand-teton-3d.html?auto={views_file}"
    url += "&" + urllib.parse.urlencode({
        "captureCommit": commit_sha,
        "captureDirty": "1" if worktree_dirty else "0",
        "captureBrowser": browser_version,
    })
    if quality:
        url += "&" + urllib.parse.urlencode({"quality": quality}) + "&noautoquality"
    # GT_TILES=<baseurl> forces the height/imagery tile source (e.g. the R2 CDN) so a local
    # capture can validate off-origin tile serving. Unset → tiles load from ./terrain/public.
    tiles = os.environ.get("GT_TILES")
    if tiles:
        url += f"&tiles={tiles}"
    if os.environ.get("GT_EXTRA"):
        url += os.environ["GT_EXTRA"]   # extra URL flags, e.g. "&dotpoc"

    profile = tempfile.mkdtemp(prefix="teton-headless-")
    cmd = [
        chrome, "--headless=new", f"--user-data-dir={profile}",
        "--window-size=" + os.environ.get("GT_WIN", "1600,900"), "--hide-scrollbars", "--mute-audio",
        "--no-first-run", "--disable-extensions", url,
    ]
    suite_label = suite or "full"
    print(f"capturing {len(views)} view(s) from {suite_label} via {url}")
    chrome_output = None if os.environ.get("GT_CHROME_LOG") else subprocess.DEVNULL
    proc = subprocess.Popen(cmd, stdout=chrome_output, stderr=chrome_output)

    timeout = 45 * len(views) + 90
    ok = False
    try:
        while time.time() - start < timeout:
            if proc.poll() is not None:
                break  # chrome died — report whatever landed
            fresh = [p for p in expected if os.path.exists(p) and os.path.getmtime(p) >= start]
            if len(fresh) == len(expected):
                ok = True
                break
            time.sleep(1.0)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)

    invalid = []
    required_meta = ("browserVersion", "commitSha", "worktreeDirty", "viewport", "route", "query",
                     "consoleErrors", "failedRequests", "applicationReady",
                     "visibleTerrainCoverage")
    for p in expected:
        fresh = os.path.exists(p) and os.path.getmtime(p) >= start
        print(("  ok  " if fresh else " MISS ") + os.path.relpath(p, ROOT))
        if not fresh:
            continue
        sidecar = os.path.splitext(p)[0] + ".json"
        try:
            with open(sidecar) as f:
                meta = json.load(f)
            missing = [key for key in required_meta if key not in meta]
            if missing:
                invalid.append(f"{os.path.relpath(sidecar, ROOT)} missing {', '.join(missing)}")
            elif not meta["applicationReady"]:
                invalid.append(f"{os.path.relpath(sidecar, ROOT)} reports application not ready")
            elif meta["consoleErrors"]:
                invalid.append(f"{os.path.relpath(sidecar, ROOT)} reports browser errors")
            elif (meta.get("coverageRequired", True)
                  and not (meta.get("visibleTerrainCoverage") or {}).get("complete", False)):
                missing_leaves = (meta.get("visibleTerrainCoverage") or {}).get("missingLeaves", [])
                invalid.append(
                    f"{os.path.relpath(sidecar, ROOT)} has incomplete visible terrain "
                    f"coverage ({', '.join(missing_leaves[:4]) or 'no drawable leaves'})"
                )
        except (OSError, ValueError, TypeError) as err:
            invalid.append(f"{os.path.relpath(sidecar, ROOT)} is invalid: {err}")
    for message in invalid:
        print("  FAIL " + message)
    if not ok or invalid:
        sys.exit("timed out (or Chrome exited) before every view was captured")


if __name__ == "__main__":
    main()
