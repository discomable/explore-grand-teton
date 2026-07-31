#!/usr/bin/env python3
"""Create, validate and assemble isolated multi-agent hero-building draft runs.

This script owns deterministic files and gates. Codex owns agent scheduling; see the
`hero-building-batch` skill. All run output stays below the ignored pipeline work directory.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import json
import re
from pathlib import Path


REPO = Path(__file__).resolve().parents[3]
DEFAULT_MANIFEST = Path(__file__).with_name("hero-batch.json")
PACKAGE_FILES = ("candidate.json", "reference-sources.json", "architecture.json", "README.md")
FINAL_STATUSES = {
    "draft_passed",
    "quarantined_sources",
    "quarantined_geometry",
    "quarantined_visual",
    "quarantined_performance",
}
ALL_STATUSES = FINAL_STATUSES | {"pending", "running", "retrying"}
SAFE_RUN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
QUARANTINE_STATUSES = FINAL_STATUSES - {"draft_passed"}


def read_json(path: Path):
    with path.open(encoding="utf-8") as source:
        return json.load(source)


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def manifest(path: Path):
    doc = read_json(path)
    if doc.get("schemaVersion") != 1:
        raise ValueError("batch manifest must have schemaVersion 1")
    ids = [item.get("id") for item in doc.get("candidates", [])]
    if not ids or len(ids) != len(set(ids)):
        raise ValueError("candidate ids must be present and unique")
    return doc


def effective_limit(doc, item):
    """Per-candidate retry budget, falling back to the manifest default.

    A candidate may carry ``retryLimitOverride`` to authorize an extra
    targeted retry wave for that candidate alone, without perturbing the
    frozen global ``retryLimit`` contract. Existing quarantines produced
    under the global default remain valid because ``audit`` validates them
    against the limit recorded at quarantine time (see ``quarantineUnderLimit``).
    """
    override = item.get("retryLimitOverride") if isinstance(item, dict) else None
    if isinstance(override, int) and override >= doc["retryLimit"]:
        return override
    return doc["retryLimit"]


def repo_path(value: str):
    path = (REPO / value).resolve()
    if REPO not in path.parents and path != REPO:
        raise ValueError(f"path escapes repository: {value}")
    return path


def run_root(doc, run_id: str):
    if not SAFE_RUN.fullmatch(run_id):
        raise ValueError("run id must be 1-64 lowercase URL-safe characters")
    return repo_path(doc["runRoot"]) / run_id


def package_errors(item):
    root = repo_path(item["package"])
    errors = [f"{item['id']}: missing {name}" for name in PACKAGE_FILES
              if not (root / name).is_file()]
    if errors:
        return errors
    try:
        candidate = read_json(root / "candidate.json")
        refs = read_json(root / "reference-sources.json")
        architecture = read_json(root / "architecture.json")
    except (OSError, json.JSONDecodeError) as error:
        return [f"{item['id']}: invalid JSON: {error}"]
    candidate_id = candidate.get("id") or candidate.get("slug")
    if candidate_id != item["id"]:
        errors.append(f"{item['id']}: candidate id is {candidate_id!r}")
    references = refs.get("references")
    if not isinstance(references, list) or not references:
        errors.append(f"{item['id']}: references must be a non-empty list")
    else:
        for index, ref in enumerate(references):
            if not ref.get("source") and not ref.get("url"):
                errors.append(f"{item['id']}: reference {index} has no source URL")
            if not ref.get("license"):
                errors.append(f"{item['id']}: reference {index} has no license")
        reference_ids = {ref.get("id") or ref.get("source_id") for ref in references}
        used_refs = set()
        def collect(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    if key == "source_refs" and isinstance(child, list):
                        used_refs.update(child)
                    else:
                        collect(child)
            elif isinstance(value, list):
                for child in value:
                    collect(child)
        collect(architecture)
        unknown = sorted(used_refs - reference_ids)
        if unknown:
            errors.append(f"{item['id']}: architecture has unknown source refs: {unknown}")
    if not architecture.get("structures"):
        errors.append(f"{item['id']}: architecture has no structures")
    if not candidate.get("placement"):
        errors.append(f"{item['id']}: candidate has no placement contract")
    return errors


def validate_packages(doc):
    return [error for item in doc["candidates"] for error in package_errors(item)]


def init_run(doc, run_id: str):
    root = run_root(doc, run_id)
    if (root / "state.json").exists():
        raise FileExistsError(f"run already exists: {run_id}")
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    state = {
        "schemaVersion": 1,
        "runId": run_id,
        "createdAt": now,
        "updatedAt": now,
        "retryLimit": doc["retryLimit"],
        "candidates": {
            item["id"]: {
                "status": "pending",
                "stage": "package",
                "attempt": 0,
                "reason": None,
                "artifacts": [],
                "artifactSha256": {},
                "owner": None,
                "verification": None,
                "history": [{
                    "at": now,
                    "actor": "coordinator",
                    "from": None,
                    "to": "pending",
                    "stage": "package",
                    "attempt": 0,
                    "reason": None,
                }],
            } for item in doc["candidates"]
        },
    }
    for item in doc["candidates"]:
        (root / "candidates" / item["id"]).mkdir(parents=True, exist_ok=True)
    write_json(root / "state.json", state)
    assemble(doc, root)
    return root


def normalize_record(value, now):
    """Read schema-v1 snapshots produced before history/provenance was added."""
    value.setdefault("artifactSha256", {})
    value.setdefault("owner", None)
    value.setdefault("verification", None)
    value.setdefault("history", [{
        "at": now,
        "actor": "legacy-import",
        "from": None,
        "to": value.get("status", "pending"),
        "stage": value.get("stage", "unknown"),
        "attempt": value.get("attempt", 0),
        "reason": value.get("reason"),
        "legacySnapshot": True,
    }])
    return value


def allowed_transition(previous, status):
    return (
        (previous == "pending" and status == "running")
        or (previous == "running" and status in {"running", "retrying", "draft_passed"})
        or (previous in QUARANTINE_STATUSES and status == "retrying")
        or (previous == "retrying" and status in FINAL_STATUSES)
    )


def quarantine_errors(candidate_id, candidate_root, attempt):
    path = candidate_root / "quarantine-report.json"
    if not path.is_file():
        return ["missing quarantine-report.json"]
    try:
        report = read_json(path)
    except (OSError, json.JSONDecodeError) as error:
        return [f"invalid quarantine-report.json: {error}"]
    errors = []
    if report.get("schemaVersion") != 1 or report.get("candidateId") != candidate_id:
        errors.append("quarantine report schema/candidate mismatch")
    if report.get("attempt") != attempt:
        errors.append("quarantine report attempt does not match state")
    if not report.get("blockers") or not report.get("reason"):
        errors.append("quarantine report needs blockers and reason")
    evidence = report.get("evidence", [])
    if not isinstance(evidence, list) or not evidence:
        errors.append("quarantine report needs evidence")
    else:
        for index, item in enumerate(evidence):
            try:
                value = item.get("path")
                if not value or "://" in value:
                    raise ValueError(f"evidence {index}: path must be repository-local")
                path = repo_path(value.lstrip("/"))
                if not path.is_file():
                    raise ValueError(f"evidence {index}: file is missing: {value}")
                if artifact_digest(path) != item.get("sha256"):
                    errors.append(f"evidence {index} SHA-256 does not match file")
            except ValueError as error:
                errors.append(str(error))
    return errors


def record(doc, run_id, candidate_id, status, stage, reason, artifacts, actor):
    if status not in ALL_STATUSES:
        raise ValueError(f"unsupported status: {status}")
    if not actor:
        raise ValueError("record requires an actor")
    root = run_root(doc, run_id)
    state_path = root / "state.json"
    state = read_json(state_path)
    if candidate_id not in state["candidates"]:
        raise ValueError(f"unknown candidate: {candidate_id}")
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    record_doc = normalize_record(state["candidates"][candidate_id], now)
    configured = next(item for item in doc["candidates"] if item["id"] == candidate_id)
    limit = effective_limit(doc, configured)
    previous = record_doc["status"]
    if not allowed_transition(previous, status):
        raise ValueError(f"{candidate_id}: invalid transition {previous} -> {status}")
    if status == "running" and previous == "pending":
        record_doc["attempt"] = 1
        record_doc["owner"] = actor
    elif status == "running" and not record_doc.get("owner"):
        record_doc["owner"] = actor
    elif status == "retrying":
        record_doc["attempt"] += 1
        record_doc["owner"] = actor
        record_doc["verification"] = None
    if record_doc["attempt"] > limit + 1:
        raise ValueError(f"{candidate_id}: retry limit exceeded")
    candidate_root = (root / "candidates" / candidate_id).resolve()
    for artifact in artifacts:
        path = repo_path(artifact)
        if candidate_root not in path.parents and path != candidate_root:
            raise ValueError(f"{candidate_id}: artifact is outside its isolated run folder: {artifact}")
        if not path.exists():
            raise FileNotFoundError(artifact)
        relative = path.relative_to(REPO).as_posix()
        if relative not in record_doc["artifacts"]:
            record_doc["artifacts"].append(relative)
        if path.is_file():
            record_doc["artifactSha256"][relative] = artifact_digest(path)
    # A legacy snapshot may already list artifacts without digests. An explicit
    # subsequent record is the reconciliation point and snapshots every file.
    for artifact in record_doc["artifacts"]:
        path = repo_path(artifact)
        if path.is_file():
            record_doc["artifactSha256"][artifact] = artifact_digest(path)
    if status == "draft_passed":
        if record_doc["attempt"] < 1 or previous not in {"running", "retrying"}:
            raise ValueError(f"{candidate_id}: pass requires a recorded build attempt")
        verification = record_doc.get("verification") or {}
        if verification.get("verdict") != "passed":
            raise ValueError(f"{candidate_id}: pass requires independent verification")
        if verification.get("actor") in {None, record_doc.get("owner")}:
            raise ValueError(f"{candidate_id}: worker cannot self-approve")
        failures = draft_errors(doc, configured, candidate_root)
        if failures:
            raise ValueError(f"{candidate_id}: draft gates failed:\n" + "\n".join(failures))
    if status in QUARANTINE_STATUSES:
        if previous != "retrying" or record_doc["attempt"] != limit + 1:
            raise ValueError(f"{candidate_id}: quarantine requires the configured targeted retry")
        failures = quarantine_errors(candidate_id, candidate_root, record_doc["attempt"])
        if failures:
            raise ValueError(f"{candidate_id}: quarantine gates failed:\n" + "\n".join(failures))
        record_doc["quarantineUnderLimit"] = limit
    record_doc.update(status=status, stage=stage, reason=reason)
    record_doc["history"].append({
        "at": now,
        "actor": actor,
        "from": previous,
        "to": status,
        "stage": stage,
        "attempt": record_doc["attempt"],
        "reason": reason,
        "artifacts": list(artifacts),
    })
    state["updatedAt"] = now
    write_json(state_path, state)
    assemble(doc, root)


def verify(doc, run_id, candidate_id, actor, verdict, reason, evidence):
    if verdict not in {"passed", "failed"}:
        raise ValueError("verification verdict must be passed or failed")
    root = run_root(doc, run_id)
    state_path = root / "state.json"
    state = read_json(state_path)
    if candidate_id not in state["candidates"]:
        raise ValueError(f"unknown candidate: {candidate_id}")
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    value = normalize_record(state["candidates"][candidate_id], now)
    if value["status"] not in {"running", "retrying"}:
        raise ValueError(f"{candidate_id}: verify only an active attempt")
    if not actor or actor == value.get("owner"):
        raise ValueError(f"{candidate_id}: verification actor must differ from owner")
    candidate_root = (root / "candidates" / candidate_id).resolve()
    checked = []
    for artifact in evidence:
        path = repo_path(artifact)
        if candidate_root not in path.parents or not path.is_file():
            raise ValueError(f"{candidate_id}: verification evidence is outside candidate")
        checked.append({
            "path": path.relative_to(REPO).as_posix(),
            "sha256": artifact_digest(path),
        })
    value["verification"] = {
        "at": now,
        "actor": actor,
        "verdict": verdict,
        "reason": reason,
        "evidence": checked,
        "attempt": value["attempt"],
    }
    value["history"].append({
        "at": now,
        "actor": actor,
        "event": "verification",
        "verdict": verdict,
        "reason": reason,
        "attempt": value["attempt"],
        "evidence": checked,
    })
    state["updatedAt"] = now
    write_json(state_path, state)
    assemble(doc, root)


def reconcile_report(doc, run_id, candidate_id, actor):
    """Synchronize a final quarantine snapshot from its validated canonical report."""
    root = run_root(doc, run_id)
    state_path = root / "state.json"
    state = read_json(state_path)
    if candidate_id not in state["candidates"]:
        raise ValueError(f"unknown candidate: {candidate_id}")
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    value = normalize_record(state["candidates"][candidate_id], now)
    if value["status"] not in QUARANTINE_STATUSES:
        raise ValueError(f"{candidate_id}: only a final quarantine can be reconciled")
    candidate_root = (root / "candidates" / candidate_id).resolve()
    failures = quarantine_errors(candidate_id, candidate_root, value["attempt"])
    if failures:
        raise ValueError(f"{candidate_id}: quarantine gates failed:\n" + "\n".join(failures))
    report = read_json(candidate_root / "quarantine-report.json")
    if report["status"] != value["status"]:
        raise ValueError(f"{candidate_id}: report status differs from state")
    previous = {"stage": value["stage"], "reason": value["reason"]}
    value["stage"] = report["stage"]
    value["reason"] = report["reason"]
    relative = (candidate_root / "quarantine-report.json").relative_to(REPO).as_posix()
    value["artifactSha256"][relative] = artifact_digest(candidate_root / "quarantine-report.json")
    value["history"].append({
        "at": now,
        "actor": actor,
        "event": "report-reconciliation",
        "attempt": value["attempt"],
        "previous": previous,
        "stage": value["stage"],
        "reason": value["reason"],
    })
    state["updatedAt"] = now
    write_json(state_path, state)
    assemble(doc, root)


def artifact_digest(path: Path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def preview_records(fragment: Path, candidate_root: Path):
    payload = read_json(fragment)
    records = payload.get("landmarks", [payload])
    if not isinstance(records, list) or not records:
        raise ValueError(f"{fragment}: preview must contain at least one landmark")
    for record in records:
        if not record.get("name") or not isinstance(record.get("position"), list):
            raise ValueError(f"{fragment}: every landmark needs name and position")
        lods = record.get("lods")
        if not isinstance(lods, list) or not lods:
            raise ValueError(f"{fragment}: every landmark needs lods")
        for lod in lods:
            url = lod.get("url", "")
            if "://" in url or not url:
                raise ValueError(f"{fragment}: draft LOD URL must be repository-local: {url}")
            asset = repo_path(url.lstrip("/"))
            if candidate_root not in asset.parents or not asset.is_file():
                raise ValueError(f"{fragment}: draft LOD escapes or is missing: {url}")
    return records


def candidate_file(candidate_root, value, label):
    if not value or "://" in value:
        raise ValueError(f"{label}: path must be local")
    path = repo_path(value.lstrip("/"))
    if candidate_root not in path.parents or not path.is_file():
        raise ValueError(f"{label}: path escapes candidate or is missing: {value}")
    return path


def draft_errors(doc, item, candidate_root):
    errors = []
    report_path = candidate_root / "validation-report.json"
    fragment = candidate_root / "preview-landmark.json"
    if not report_path.is_file():
        return ["missing validation-report.json"]
    try:
        report = read_json(report_path)
    except (OSError, json.JSONDecodeError) as error:
        return [f"invalid validation-report.json: {error}"]
    if report.get("schemaVersion") != 1 or report.get("candidateId") != item["id"]:
        errors.append("validation report schema/candidate mismatch")
    sources = report.get("sources", {})
    if not sources.get("passed"):
        errors.append("source gate did not pass")
    if sources.get("officialSources", 0) < 1:
        errors.append("source gate needs at least one official/HABS source")
    if sources.get("sameBuildingElevations", 0) < 2:
        errors.append("source gate needs two same-building exterior elevations")
    if not sources.get("allRightsResolved"):
        errors.append("source rights are unresolved")
    hashes = sources.get("artifacts", [])
    if not hashes:
        errors.append("source artifacts need SHA-256 provenance")
    for index, value in enumerate(hashes):
        if not re.fullmatch(r"[0-9a-f]{64}", value.get("sha256", "")):
            errors.append(f"source artifact {index} needs a SHA-256")
            continue
        try:
            path = candidate_file(candidate_root, value.get("path"),
                                  f"source artifact {index}")
            if artifact_digest(path) != value["sha256"]:
                errors.append(f"source artifact {index} SHA-256 does not match file")
        except ValueError as error:
            errors.append(str(error))
    placement = report.get("placement", {})
    if not placement.get("passed") or placement.get("confidence", 0) < .85:
        errors.append("placement gate needs confidence >= 0.85")
    if not placement.get("evidence"):
        errors.append("placement gate needs evidence")

    budget = doc["budgets"][item["kind"]]
    lods = report.get("lods", {})
    for lod in ("LOD0", "LOD1", "LOD2"):
        value = lods.get(lod, {})
        if value.get("triangles", float("inf")) > budget["triangles"][lod]:
            errors.append(f"{lod} exceeds triangle budget")
        if value.get("materialPrimitives", float("inf")) > budget["materialPrimitives"][lod]:
            errors.append(f"{lod} exceeds material-primitive budget")
        try:
            candidate_file(candidate_root, value.get("path"), f"{lod} asset")
        except ValueError as error:
            errors.append(str(error))
    textures = report.get("textures", {})
    if textures.get("totalBytes", float("inf")) > budget["textureBytes"]:
        errors.append("textures exceed transfer budget")
    for index, value in enumerate(textures.get("files", [])):
        try:
            path = candidate_file(candidate_root, value.get("path"), f"texture {index}")
            if path.stat().st_size != value.get("bytes"):
                errors.append(f"texture {index} byte count does not match file")
        except ValueError as error:
            errors.append(str(error))

    captures = {value.get("id"): value for value in report.get("captures", [])}
    for capture_id in doc["requiredViews"]:
        value = captures.get(capture_id)
        if not value:
            errors.append(f"missing required capture {capture_id}")
            continue
        try:
            candidate_file(candidate_root, value.get("path"), f"capture {capture_id}")
        except ValueError as error:
            errors.append(str(error))
        if value.get("consoleErrors") or value.get("failedRequests"):
            errors.append(f"capture {capture_id} has runtime errors")
        if not value.get("visibleTerrainCoverage", {}).get("complete"):
            errors.append(f"capture {capture_id} has incomplete terrain")
    if not report.get("performance", {}).get("passed"):
        errors.append("performance gate did not pass")
    if not fragment.is_file():
        errors.append("missing preview-landmark.json")
    else:
        try:
            preview_records(fragment, candidate_root)
        except (ValueError, OSError, json.JSONDecodeError) as error:
            errors.append(str(error))
    return errors


def assemble(doc, root: Path):
    state_path = root / "state.json"
    state = read_json(state_path) if state_path.exists() else {
        "runId": root.name, "candidates": {},
    }
    landmarks, digests = [], {}
    for item in doc["candidates"]:
        status = state["candidates"].get(item["id"], {}).get("status", "pending")
        fragment = root / "candidates" / item["id"] / "preview-landmark.json"
        if status != "draft_passed" or not fragment.is_file():
            continue
        failures = draft_errors(doc, item, (root / "candidates" / item["id"]).resolve())
        if failures:
            raise ValueError(f"{item['id']}: recorded pass no longer validates:\n" +
                             "\n".join(failures))
        landmarks.extend(preview_records(
            fragment, (root / "candidates" / item["id"]).resolve()))
        for artifact in state["candidates"][item["id"]].get("artifacts", []):
            path = repo_path(artifact)
            if path.is_file():
                digests[artifact] = artifact_digest(path)
    preview = {
        "schemaVersion": 1,
        "draft": True,
        "runId": state.get("runId", root.name),
        "landmarks": landmarks,
        "artifactSha256": digests,
    }
    write_json(root / "preview" / "landmarks.json", preview)
    build_gallery(doc, state, root)


def build_gallery(doc, state, root):
    rows = []
    for item in doc["candidates"]:
        value = state.get("candidates", {}).get(item["id"], {})
        status = value.get("status", "pending")
        reason = value.get("reason") or ""
        links = []
        for artifact in value.get("artifacts", []):
            path = repo_path(artifact)
            try:
                relative = path.relative_to(root).as_posix()
            except ValueError:
                continue
            links.append(f'<a href="../{html.escape(relative)}">{html.escape(path.name)}</a>')
        rows.append(
            "<tr>"
            f"<td>{html.escape(item['name'])}</td>"
            f"<td>{html.escape(status)}</td>"
            f"<td>{value.get('attempt', 0)}</td>"
            f"<td>{html.escape(value.get('stage', 'package'))}</td>"
            f"<td>{html.escape(reason)}</td>"
            f"<td>{' · '.join(links)}</td>"
            "</tr>"
        )
    page = f"""<!doctype html>
<meta charset="utf-8">
<title>Hero building batch {html.escape(root.name)}</title>
<style>
body{{font:15px system-ui;margin:2rem;background:#17191b;color:#eee}}
table{{border-collapse:collapse;width:100%}}th,td{{padding:.65rem;border:1px solid #444;text-align:left}}
th{{background:#292d30}}a{{color:#8dc8ff}}code{{background:#292d30;padding:.15rem .35rem}}
</style>
<h1>Hero building batch: {html.escape(root.name)}</h1>
<p>Local preview: <code>?landmarkDraftRun={html.escape(root.name)}</code></p>
<table><thead><tr><th>Candidate</th><th>Status</th><th>Attempts</th><th>Stage</th>
<th>Reason</th><th>Artifacts</th></tr></thead><tbody>{''.join(rows)}</tbody></table>
"""
    gallery = root / "gallery" / "index.html"
    gallery.parent.mkdir(parents=True, exist_ok=True)
    gallery.write_text(page, encoding="utf-8")


def summary(doc, run_id):
    root = run_root(doc, run_id)
    state = read_json(root / "state.json")
    print(json.dumps({
        "runId": run_id,
        "preview": f"?{doc['previewQuery']}={run_id}",
        "gallery": str((root / "gallery" / "index.html").relative_to(REPO)),
        "candidates": state["candidates"],
    }, indent=2))


def audit(doc, run_id):
    root = run_root(doc, run_id)
    state = read_json(root / "state.json")
    errors = validate_packages(doc)
    for item in doc["candidates"]:
        candidate_id = item["id"]
        candidate_root = (root / "candidates" / candidate_id).resolve()
        value = normalize_record(state["candidates"][candidate_id],
                                 state.get("updatedAt", "unknown"))
        if not value.get("history"):
            errors.append(f"{candidate_id}: missing history")
        if value["status"] == "pending" and any(candidate_root.iterdir()):
            errors.append(f"{candidate_id}: pending state has unrecorded artifacts")
        for artifact in value.get("artifacts", []):
            path = repo_path(artifact)
            if not path.exists():
                errors.append(f"{candidate_id}: recorded artifact is missing: {artifact}")
                continue
            recorded = value.get("artifactSha256", {}).get(artifact)
            if path.is_file() and not recorded:
                errors.append(f"{candidate_id}: recorded artifact lacks state SHA-256: {artifact}")
            elif path.is_file() and artifact_digest(path) != recorded:
                errors.append(f"{candidate_id}: recorded artifact changed: {artifact}")
        if value["status"] == "draft_passed":
            errors.extend(f"{candidate_id}: {error}"
                          for error in draft_errors(doc, item, candidate_root))
            verification = value.get("verification") or {}
            if verification.get("verdict") != "passed":
                errors.append(f"{candidate_id}: pass lacks independent verification")
        if value["status"] in QUARANTINE_STATUSES:
            quarantine_limit = value.get("quarantineUnderLimit", doc["retryLimit"])
            if value.get("attempt") != quarantine_limit + 1:
                errors.append(f"{candidate_id}: final quarantine lacks targeted retry")
            errors.extend(f"{candidate_id}: {error}" for error in
                          quarantine_errors(candidate_id, candidate_root,
                                            value.get("attempt")))
            report_path = candidate_root / "quarantine-report.json"
            if report_path.is_file():
                report = read_json(report_path)
                for field in ("status", "stage", "reason", "attempt"):
                    if report.get(field) != value.get(field):
                        errors.append(
                            f"{candidate_id}: state {field} differs from quarantine report")
    if errors:
        raise ValueError("batch audit failed:\n" + "\n".join(errors))
    print(f"hero batch audit: {len(doc['candidates'])} candidates consistent")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("validate-packages")
    init = commands.add_parser("init")
    init.add_argument("--run-id", required=True)
    update = commands.add_parser("record")
    update.add_argument("--run-id", required=True)
    update.add_argument("--candidate", required=True)
    update.add_argument("--status", required=True, choices=sorted(ALL_STATUSES))
    update.add_argument("--stage", required=True)
    update.add_argument("--reason")
    update.add_argument("--actor", required=True)
    update.add_argument("--artifact", action="append", default=[])
    verification = commands.add_parser("verify")
    verification.add_argument("--run-id", required=True)
    verification.add_argument("--candidate", required=True)
    verification.add_argument("--actor", required=True)
    verification.add_argument("--verdict", required=True, choices=("passed", "failed"))
    verification.add_argument("--reason", required=True)
    verification.add_argument("--evidence", action="append", default=[])
    reconcile = commands.add_parser("reconcile-report")
    reconcile.add_argument("--run-id", required=True)
    reconcile.add_argument("--candidate", required=True)
    reconcile.add_argument("--actor", required=True)
    assemble_command = commands.add_parser("assemble")
    assemble_command.add_argument("--run-id", required=True)
    status = commands.add_parser("summary")
    status.add_argument("--run-id", required=True)
    audit_command = commands.add_parser("audit")
    audit_command.add_argument("--run-id", required=True)
    opt = parser.parse_args()
    doc = manifest(opt.manifest)
    if opt.command == "validate-packages":
        errors = validate_packages(doc)
        if errors:
            raise SystemExit("\n".join(errors))
        print(f"hero candidate packages: {len(doc['candidates'])} valid")
    elif opt.command == "init":
        print(init_run(doc, opt.run_id).relative_to(REPO))
    elif opt.command == "record":
        record(doc, opt.run_id, opt.candidate, opt.status, opt.stage,
               opt.reason, opt.artifact, opt.actor)
    elif opt.command == "verify":
        verify(doc, opt.run_id, opt.candidate, opt.actor, opt.verdict,
               opt.reason, opt.evidence)
    elif opt.command == "reconcile-report":
        reconcile_report(doc, opt.run_id, opt.candidate, opt.actor)
    elif opt.command == "assemble":
        assemble(doc, run_root(doc, opt.run_id))
    elif opt.command == "summary":
        summary(doc, opt.run_id)
    elif opt.command == "audit":
        audit(doc, opt.run_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
