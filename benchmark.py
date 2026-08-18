#!/usr/bin/env python3
"""Capture canonical views or bounded routes and write a performance report."""
import argparse
import json
import os
import platform
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ROUTES_FILE = ROOT / "routes.json"
ENDURANCE_ROUTES_FILE = ROOT / "terrain-endurance-routes.json"
ROUTE_MODES = {"drive", "hike"}
CERTIFICATION_TARGETS = {
    "highway", "paved-junction", "park-road", "gravel", "two-track",
    "road-bridge", "bridge-approach", "maintained-trail", "primitive-trail",
    "trail-bridge", "boardwalk", "steps", "steep-switchback",
    "road-trail-intersection", "off-road", "barrier-impact", "water-approach",
    "recovery",
}
ENDURANCE_KINDS = {"linear", "turns", "altitude-cycle", "teleports", "rotation",
                   "target", "tile-boundary"}


def derive_tile_boundary(manifest, zoom, axis, boundary_index, start_along=0):
    """Materialize a world-space tile edge from the terrain manifest's dyadic grid."""
    if axis not in ("x", "z") or not isinstance(zoom, int) or zoom < 0:
        raise ValueError("tile boundary needs x/z axis and a non-negative zoom")
    tile_size = manifest["tileSize"]
    max_zoom = manifest["maxZoom"]
    pixel_size = manifest["geoTransform"][1]
    root_span = tile_size * (2 ** max_zoom) * pixel_size
    tile_span = root_span / (2 ** zoom)
    extent = manifest["width"] * pixel_size if axis == "x" else manifest["height"] * pixel_size
    count = (manifest["width"] if axis == "x" else manifest["height"])
    count = (count + tile_size - 1) // tile_size if zoom == max_zoom else int(
        (extent + tile_span - 1) // tile_span)
    if not isinstance(boundary_index, int) or not 1 <= boundary_index < count:
        raise ValueError("tile boundary index must identify an interior edge")
    coordinate = -extent / 2 + boundary_index * tile_span
    return {"axis": axis, "zoom": zoom, "boundaryIndex": boundary_index,
            "coordinate": coordinate, "startAlong": start_along, "tileSpan": tile_span}


def load_endurance_routes(path=ENDURANCE_ROUTES_FILE, tiles_path=None):
    with Path(path).open() as source:
        document = json.load(source)
    if (document.get("schema") != "grand-teton-terrain-endurance-routes/v1"
            or document.get("version") != 1 or document.get("repetitions") != 2
            or document.get("telemetryHz") != 4 or not isinstance(document.get("routes"), list)):
        raise ValueError("terrain endurance manifest must be version 1, 4 Hz, and two repetitions")
    ids = set()
    for route in document["routes"]:
        route_id, kind = route.get("id"), route.get("kind")
        duration = route.get("durationSeconds")
        if (not route_id or route_id in ids or kind not in ENDURANCE_KINDS
                or not isinstance(duration, (int, float)) or duration not in (30, 60)):
            raise ValueError("each endurance route needs a unique id, valid kind, and 30/60s duration")
        ids.add(route_id)
        speed = route.get("speedMps")
        if kind == "linear" and (duration != 60 or speed != 350):
            raise ValueError("linear endurance route must be 60s at 350 m/s")
        if kind == "turns" and (duration != 30 or speed != 300
                                or route.get("turnPeriodSeconds") != 5):
            raise ValueError("turn endurance route must be 30s at 300 m/s with 5s reversals")
        if kind == "altitude-cycle" and (duration != 30
                                          or route.get("maximumAglMeters") != 3000):
            raise ValueError("altitude endurance route must cycle to 3 km AGL for 30s")
        if kind == "rotation" and (duration != 30 or route.get("origin", [None, None])[1] != 1500):
            raise ValueError("rotation endurance route must be stationary at 1.5 km AGL for 30s")
        if kind == "target" and (duration != 30 or speed != 220):
            raise ValueError("Cathedral target route must be 30s at the 220 m/s application maximum")
        if kind == "tile-boundary" and (duration != 60 or speed != 300 or route.get("zoom") != 7):
            raise ValueError("tile-boundary route must follow z7 for 60s at 300 m/s")
        if kind == "teleports":
            points = route.get("points")
            if not isinstance(points, list) or len(points) < 2:
                raise ValueError("teleport endurance route needs two or more points")
            distances = []
            for index, point in enumerate(points):
                next_point = points[(index + 1) % len(points)]
                if (not isinstance(point, list) or len(point) != 2
                        or not all(isinstance(value, (int, float)) for value in point)):
                    raise ValueError("teleport endurance points must be x/z number pairs")
                distances.append(((point[0] - next_point[0]) ** 2
                                  + (point[1] - next_point[1]) ** 2) ** 0.5)
            if not all(20000 <= distance <= 30000 for distance in distances):
                raise ValueError("teleport endurance hops must be approximately 25 km")
    if set(route["kind"] for route in document["routes"]) != ENDURANCE_KINDS:
        raise ValueError("terrain endurance manifest must cover all seven pathological movement kinds")
    tiles_file = Path(tiles_path) if tiles_path else ROOT / "terrain/public/tiles.json"
    with tiles_file.open() as source:
        tiles = json.load(source)
    materialized = []
    for route in document["routes"]:
        route = dict(route)
        if route["kind"] == "tile-boundary":
            route["boundary"] = derive_tile_boundary(
                tiles, route["zoom"], route["axis"], route["boundaryIndex"],
                route.get("startAlong", 0))
        materialized.append(route)
    return {**document, "routes": materialized}


def run_terrain_endurance(args, manifest):
    selected = manifest["routes"]
    if args.endurance_route:
        selected = [route for route in selected if route["id"] == args.endurance_route]
        if not selected:
            raise ValueError(f"unknown endurance route: {args.endurance_route}")
    if args.dry_run:
        for route in selected:
            suffix = " (two consecutive runs)"
            print(f"{route['id']} ({route['kind']}, {route['durationSeconds']}s){suffix}")
        return None

    server = None
    if not wait_for_server(args.port, timeout=0.3):
        server = subprocess.Popen(
            [sys.executable, str(ROOT / "serve.py"), str(args.port)], cwd=ROOT,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        if not wait_for_server(args.port):
            server.terminate()
            raise RuntimeError("benchmark server did not start")
    from snap import find_chrome
    chrome = find_chrome()
    output = ROOT / "benchmark-results/terrain-endurance.json"
    error_output = ROOT / "benchmark-results/terrain-endurance-error.json"
    output.unlink(missing_ok=True)
    error_output.unlink(missing_ok=True)
    query = {
        "terrainEndurance": "1", "quality": args.quality, "noautoquality": "1",
        "gpums": "1", "nosw": "1",
        "enduranceRoutes": ",".join(route["id"] for route in selected),
        "captureCommit": command_output(["git", "rev-parse", "HEAD"]),
        "captureBrowser": command_output([chrome, "--version"]),
    }
    url = f"http://localhost:{args.port}/grand-teton-3d.html?{urllib.parse.urlencode(query)}"
    profile = tempfile.mkdtemp(prefix="teton-endurance-")
    command = [chrome, "--headless=new", f"--user-data-dir={profile}",
               "--window-size=1600,900", "--hide-scrollbars", "--mute-audio",
               "--no-first-run", "--disable-extensions", url]
    started = time.time()
    chrome_log = tempfile.NamedTemporaryFile(prefix="teton-endurance-chrome-", suffix=".log",
                                              delete=False)
    chrome_log_path = Path(chrome_log.name)
    proc = subprocess.Popen(command, stdout=chrome_log, stderr=chrome_log)
    # Route time is deterministic; prewarm and settled-memory waits receive bounded headroom.
    timeout = (sum(route["durationSeconds"] for route in selected) * manifest["repetitions"]
               + len(selected) * manifest["repetitions"] * 70 + 180)
    try:
        while time.time() - started < timeout:
            if proc.poll() is not None:
                chrome_log.flush()
                detail = chrome_log_path.read_text(errors="replace")[-4000:]
                raise RuntimeError(
                    f"terrain endurance Chrome exited with status {proc.returncode}"
                    + (f"\n{detail}" if detail else ""))
            if output.exists() and output.stat().st_mtime >= started:
                report = json.loads(output.read_text())
                print(f"terrain endurance report: {output}")
                print(json.dumps(report["gate"], indent=2))
                if not report["gate"]["passed"]:
                    raise RuntimeError("terrain endurance hard gate failed")
                return report
            if error_output.exists() and error_output.stat().st_mtime >= started:
                failure = json.loads(error_output.read_text())
                raise RuntimeError("terrain endurance page failed:\n" + failure.get("error", "unknown"))
            time.sleep(1)
        raise RuntimeError("terrain endurance browser exited or timed out before reporting")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)
        chrome_log.close()
        chrome_log_path.unlink(missing_ok=True)
        if server and not args.keep_server:
            os.killpg(server.pid, signal.SIGTERM)


def wait_for_server(port, timeout=10):
    deadline = time.time() + timeout
    url = f"http://127.0.0.1:{port}/views.json"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=0.5) as response:
                return response.status == 200
        except Exception:
            time.sleep(0.1)
    return False


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(len(ordered) * fraction))]


def command_output(command):
    try:
        return subprocess.check_output(command, cwd=ROOT, text=True, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def load_routes(path=ROUTES_FILE):
    with Path(path).open() as source:
        document = json.load(source)
    if document.get("schemaVersion") != 2 or not isinstance(document.get("routes"), list):
        raise ValueError("routes.json must contain a schemaVersion 2 routes list")
    routes = {}
    for route in document["routes"]:
        route_id = route.get("id")
        waypoints = route.get("waypoints")
        duration = route.get("durationSeconds")
        targets = route.get("certificationTargets")
        if (not route_id or route_id in routes or route.get("mode") not in ROUTE_MODES
                or not isinstance(waypoints, list)
                or len(waypoints) < 2 or not isinstance(duration, (int, float))
                or not 6 <= duration <= 300 or not isinstance(targets, list) or not targets
                or len(set(targets)) != len(targets)
                or not set(targets) <= CERTIFICATION_TARGETS):
            raise ValueError("each route needs a unique id, drive/hike mode, 2+ waypoints, "
                             "a 6-300s durationSeconds, and valid certificationTargets")
        for waypoint in waypoints:
            if not isinstance(waypoint, dict) or not isinstance(waypoint.get("view"), str):
                raise ValueError(f"route {route_id!r} has an invalid waypoint")
            for key in ("offset",):
                value = waypoint.get(key, [0, 0, 0])
                if (not isinstance(value, list) or len(value) != 3
                        or not all(isinstance(item, (int, float)) for item in value)):
                    raise ValueError(f"route {route_id!r} waypoint {key} must be three numbers")
            for key in ("yawOffset", "pitchOffset"):
                if key in waypoint and not isinstance(waypoint[key], (int, float)):
                    raise ValueError(f"route {route_id!r} waypoint {key} must be numeric")
        routes[route_id] = route
    covered = set().union(*(set(route["certificationTargets"]) for route in routes.values()))
    missing = CERTIFICATION_TARGETS - covered
    if missing:
        raise ValueError("route certification coverage is incomplete: " + ", ".join(sorted(missing)))
    return routes


def waypoint_names(route):
    return [waypoint["view"] if isinstance(waypoint, dict) else waypoint
            for waypoint in route["waypoints"]]


def materialize_routes(routes, views, time_of_day="day", camera_mode="far-chase"):
    views_by_name = {view["name"]: view for view in views}
    times = {"day": 0.5, "golden-hour": 0.73, "night": 0.05}
    cameras = {"far-chase": 0, "near-chase": 1, "first-person": 2}
    def capture_name(route):
        camera = camera_mode if route["mode"] == "drive" else "first-person"
        cycle = route.get("_captureCycle")
        suffix = f"-cycle-{cycle:02d}" if cycle is not None else ""
        scale = route.get("_durationScale", 1)
        if scale != 1:
            scale_token = f"{scale:g}".replace(".", "p")
            suffix += f"-duration-{scale_token}x"
        return f"{route['id']}-{time_of_day}-{camera}{suffix}"

    def resolve(waypoint):
        source = views_by_name[waypoint["view"]]
        offset = waypoint.get("offset", [0, 0, 0])
        return {
            "pos": [source["pos"][axis] + offset[axis] for axis in range(3)],
            "yaw": source["yaw"] + waypoint.get("yawOffset", 0),
            "pitch": source["pitch"] + waypoint.get("pitchOffset", 0),
        }

    return [
        {
            "name": capture_name(route),
            "routeId": route["id"],
            "mode": route["mode"],
            "durationSeconds": route["durationSeconds"] * route.get("_durationScale", 1),
            "certificationTargets": route["certificationTargets"],
            "time": times[time_of_day],
            "cameraMode": cameras[camera_mode],
            "waypoints": [resolve(waypoint) for waypoint in route["waypoints"]],
        }
        for route in routes
    ]


def summarize(records):
    frame_times = [record["meanFrameMs"] for record in records if record.get("meanFrameMs")]
    return {
        "views": len(records),
        "medianFrameMs": round(percentile(frame_times, 0.5), 2) if frame_times else None,
        "worstOnePercentLowFps": min(
            (r["onePercentLowFps"] for r in records if r.get("onePercentLowFps") is not None),
            default=None,
        ),
        "maxSettleMs": max((r.get("settleMs", 0) for r in records), default=0),
        "maxCalls": max((r.get("calls", 0) for r in records), default=0),
        "maxTriangles": max((r.get("tris", 0) for r in records), default=0),
        "consoleErrors": sum(len(r.get("consoleErrors", [])) for r in records),
        "failedRequests": sum(len(r.get("failedRequests", [])) for r in records),
        "incompleteTerrainViews": sum(
            not (r.get("visibleTerrainCoverage") or {}).get("complete", False)
            for r in records
        ),
    }


def summarize_route(record):
    """Keep route telemetry stable and machine-readable."""
    keys = (
        "routeDurationMs", "coldStartInteractiveMs", "meanFrameMs", "p99FrameMs", "maxFrameMs", "averageFps",
        "onePercentLowFps", "frameSpikes50ms", "visibleTilePops", "streamingBusyFrames",
        "peakTextures", "peakCalls", "peakTris", "settleMs",
        "visibleTerrainCoverage",
    )
    summary = {key: record.get(key) for key in keys}
    summary.update({
        "consoleErrors": len(record.get("consoleErrors", [])),
        "failedRequests": len(record.get("failedRequests", [])),
    })
    return summary


def summarize_routes(records):
    def maximum(key):
        values = [record[key] for record in records if record.get(key) is not None]
        return max(values) if values else None

    return {
        "routes": len(records),
        "totalRouteDurationMs": sum(record.get("routeDurationMs", 0) for record in records),
        "maxColdStartInteractiveMs": maximum("coldStartInteractiveMs"),
        "totalFrameSpikes50ms": sum(record.get("frameSpikes50ms", 0) for record in records),
        "totalVisibleTilePops": sum(record.get("visibleTilePops", 0) for record in records),
        "totalStreamingBusyFrames": sum(record.get("streamingBusyFrames", 0) for record in records),
        "peakTextures": maximum("peakTextures"),
        "peakCalls": maximum("peakCalls"),
        "peakTris": maximum("peakTris"),
    }


def evaluate_route_gate(record, quality):
    """Evaluate the published High/Accessible transport route budgets."""
    accessible = quality in ("accessible", "low")
    limits = {
        "averageFps": 30 if accessible else 45,
        "onePercentLowFps": 24 if accessible else 30,
        "maxFrameMs": 350 if accessible else 250,
        "coldStartInteractiveMs": 5000 if accessible else 4000,
    }
    checks = {
        "averageFps": (record.get("averageFps") or 0) >= limits["averageFps"],
        "onePercentLowFps": (record.get("onePercentLowFps") or 0) >= limits["onePercentLowFps"],
        "maxFrameMs": (record.get("maxFrameMs") or record.get("p99FrameMs") or float("inf"))
                      <= limits["maxFrameMs"],
        "coldStartInteractiveMs": (record.get("coldStartInteractiveMs") or float("inf"))
                                  <= limits["coldStartInteractiveMs"],
        "consoleErrors": not record.get("consoleErrors"),
        "failedRequests": not record.get("failedRequests"),
        "settled": not record.get("settleTimedOut", False),
        "visibleTerrainCoverage": (
            (record.get("visibleTerrainCoverage") or {}).get("complete", False)
        ),
    }
    return {"tier": "accessible" if accessible else "high", "limits": limits,
            "checks": checks, "passed": all(checks.values())}


def read_records(names):
    records = []
    for name in names:
        sidecar = ROOT / "shots" / f"auto-{name}.json"
        with sidecar.open() as source:
            records.append(json.load(source))
    return records


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8123)
    parser.add_argument("--quality", choices=("ultra", "high", "balanced", "low"), default="ultra")
    parser.add_argument("--suite", default="benchmark")
    parser.add_argument("--route", action="append", default=[], metavar="ID",
                        help="capture a bounded route; repeat to capture multiple routes")
    parser.add_argument("--list-routes", action="store_true", help="list route ids and exit")
    parser.add_argument("--dry-run", action="store_true", help="print the selected capture plan and exit")
    parser.add_argument("--keep-server", action="store_true", help="leave the server running")
    parser.add_argument("--time-of-day", choices=("day", "golden-hour", "night"), default="day",
                        help="lighting condition for route certification")
    parser.add_argument("--camera", choices=("far-chase", "near-chase", "first-person"),
                        default="far-chase", help="driving camera used by route certification")
    parser.add_argument("--cycles", type=int, default=1,
                        help="repeat the selected route set in one browser (1-10)")
    parser.add_argument("--duration-scale", type=float, default=1,
                        help="multiply each selected route duration (1-10)")
    parser.add_argument("--terrain-endurance", action="store_true",
                        help="run the local two-pass pathological terrain movement gate")
    parser.add_argument("--endurance-route", metavar="ID",
                        help="run one terrain endurance scenario (still twice consecutively)")
    args = parser.parse_args()
    if not 1 <= args.cycles <= 10:
        parser.error("--cycles must be between 1 and 10")
    if not 1 <= args.duration_scale <= 10:
        parser.error("--duration-scale must be between 1 and 10")
    if args.endurance_route and not args.terrain_endurance:
        parser.error("--endurance-route requires --terrain-endurance")

    if args.terrain_endurance:
        if args.route or args.list_routes:
            parser.error("terrain endurance cannot be combined with transport route options")
        try:
            manifest = load_endurance_routes()
            run_terrain_endurance(args, manifest)
        except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
            sys.exit(str(error))
        return

    try:
        routes = load_routes()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        sys.exit(str(error))
    if args.list_routes:
        for route in routes.values():
            print(f"{route['id']} ({route['mode']}, {route['durationSeconds']}s): "
                  + " -> ".join(waypoint_names(route)))
        return
    unknown_routes = [route_id for route_id in args.route if route_id not in routes]
    if unknown_routes:
        parser.error("unknown route(s): " + ", ".join(unknown_routes))

    with (ROOT / "views.json").open() as source:
        all_views = json.load(source)
    available_views = {view["name"] for view in all_views}
    selected_routes = [routes[route_id] for route_id in args.route]
    if args.duration_scale != 1:
        selected_routes = [
            dict(route, _durationScale=args.duration_scale)
            for route in selected_routes
        ]
    if args.cycles > 1:
        selected_routes = [
            dict(route, _captureCycle=cycle)
            for cycle in range(1, args.cycles + 1)
            for route in selected_routes
        ]
    for route in selected_routes:
        missing = set(waypoint_names(route)) - available_views
        if missing:
            sys.exit(f"route {route['id']!r} references unknown view(s): {', '.join(sorted(missing))}")
    if args.dry_run:
        if selected_routes:
            for route in selected_routes:
                duration = route["durationSeconds"] * route.get("_durationScale", 1)
                print(f"{route['id']} ({duration:g}s): "
                      + " -> ".join(waypoint_names(route)))
        else:
            views = [view["name"] for view in all_views
                     if args.suite in view.get("suites", ["full"])]
            print(f"suite {args.suite}: " + ", ".join(views))
        return

    server = None
    if not wait_for_server(args.port, timeout=0.3):
        server = subprocess.Popen(
            [sys.executable, str(ROOT / "serve.py"), str(args.port)],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        if not wait_for_server(args.port):
            server.terminate()
            sys.exit("benchmark server did not start")

    env = os.environ.copy()
    extra = env.get("GT_EXTRA", "")
    env["GT_EXTRA"] = extra + f"&quality={args.quality}&noautoquality&gpums&nosw"
    started = time.time()
    route_reports = []
    try:
        if selected_routes:
            captures = materialize_routes(
                selected_routes, all_views, args.time_of_day, args.camera)
            deferred = args.duration_scale > 1 and len(captures) > 1
            if deferred:
                for capture in captures[:-1]:
                    capture["deferCapture"] = True
                (ROOT / "benchmark-results" / "route-batch.json").unlink(missing_ok=True)
            transient_file = ROOT / "routes.auto-subset.json"
            transient_file.write_text(json.dumps(captures, indent=2) + "\n")
            command = [
                sys.executable, str(ROOT / "snap.py"), transient_file.name,
                "--port", str(args.port),
            ]
            try:
                subprocess.run(command, cwd=ROOT, env=env, check=True)
            finally:
                transient_file.unlink(missing_ok=True)
            if deferred:
                final_record = read_records([captures[-1]["name"]])[0]
                batch_file = ROOT / "benchmark-results" / "route-batch.json"
                try:
                    batch = json.loads(batch_file.read_text())
                except (OSError, json.JSONDecodeError):
                    batch = []
                if len(batch) != len(captures):
                    sys.exit("deferred endurance capture returned an incomplete routeBatch")
                common = dict(final_record)
                records = [dict(common, **entry) for entry in batch]
            else:
                records = read_records([capture["name"] for capture in captures])
            for route, capture, record in zip(selected_routes, captures, records):
                route_reports.append({
                    "id": route["id"],
                    "captureName": capture["name"],
                    "mode": route["mode"],
                    "durationSeconds": capture["durationSeconds"],
                    "timeOfDay": args.time_of_day,
                    "camera": args.camera if route["mode"] == "drive" else "first-person",
                    "waypoints": waypoint_names(route),
                    "certificationTargets": route["certificationTargets"],
                    "summary": summarize_route(record),
                    "performanceGate": evaluate_route_gate(record, args.quality),
                })
        else:
            command = [
                sys.executable, str(ROOT / "snap.py"), "--port", str(args.port),
                "--suite", args.suite,
            ]
            subprocess.run(command, cwd=ROOT, env=env, check=True)
            views = [view for view in all_views if args.suite in view.get("suites", ["full"])]
            records = read_records([view["name"] for view in views])
    finally:
        if server and not args.keep_server:
            os.killpg(server.pid, signal.SIGTERM)

    report = {
        "schemaVersion": 2 if selected_routes else 1,
        "suite": None if selected_routes else args.suite,
        "quality": args.quality,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "commitSha": records[0].get("commitSha") if records else "unknown",
        "browserVersion": records[0].get("browserVersion") if records else "unknown",
        "environment": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "processor": platform.processor() or "unknown",
            "logicalCpuCount": os.cpu_count(),
            "dirtyWorktree": bool(command_output(["git", "status", "--porcelain"])),
            "headless": records[0].get("headless") if records else None,
            "hardwareConcurrency": records[0].get("hardwareConcurrency") if records else None,
            "deviceMemoryGB": records[0].get("deviceMemoryGB") if records else None,
            "webgl": records[0].get("webgl") if records else None,
        },
        "durationSeconds": round(time.time() - started, 2),
        "summary": summarize(records),
        "views": records,
    }
    if route_reports:
        report["routes"] = route_reports
        report["summary"].update(summarize_routes(records))
    output_dir = ROOT / "benchmark-results"
    output_dir.mkdir(exist_ok=True)
    output = output_dir / "report.json"
    document = json.dumps(report, indent=2) + "\n"
    output.write_text(document)
    if selected_routes:
        repeat = f"-{args.cycles}x" if args.cycles > 1 else ""
        duration = (
            f"-duration-{f'{args.duration_scale:g}'.replace('.', 'p')}x"
            if args.duration_scale != 1 else "")
        variant = output_dir / (
            f"report-{args.quality}-{args.time_of_day}-{args.camera}{repeat}{duration}.json")
        variant.write_text(document)
        print(f"benchmark report: {output} (archived as {variant.name})")
    else:
        print(f"benchmark report: {output}")
    print(json.dumps(report["summary"], indent=2))


if __name__ == "__main__":
    main()
