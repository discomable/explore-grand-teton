import importlib.util
import json
from pathlib import Path
import shutil
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "terrain/pipeline/buildings/hero_batch.py"
SPEC = importlib.util.spec_from_file_location("hero_batch", SCRIPT)
HERO_BATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HERO_BATCH)


class HeroBuildingBatchTests(unittest.TestCase):
    def setUp(self):
        self.doc = HERO_BATCH.manifest(
            ROOT / "terrain/pipeline/buildings/hero-batch.json")
        self.run_id = "test-hero-building-batch"
        self.root = HERO_BATCH.run_root(self.doc, self.run_id)
        shutil.rmtree(self.root, ignore_errors=True)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_manifest_freezes_two_waves_and_six_unique_candidates(self):
        candidates = self.doc["candidates"]
        self.assertEqual(len(candidates), 6)
        self.assertEqual({item["wave"] for item in candidates}, {1, 2})
        self.assertEqual(len({item["id"] for item in candidates}), 6)
        self.assertEqual(self.doc["retryLimit"], 1)
        john_moulton = next(c for c in candidates if c["id"] == "john_moulton")
        self.assertEqual(john_moulton.get("retryLimitOverride"), 2)

    def test_candidate_packages_satisfy_the_shared_contract(self):
        self.assertEqual(HERO_BATCH.validate_packages(self.doc), [])

    def test_passing_fragment_is_the_only_content_assembled_for_preview(self):
        HERO_BATCH.init_run(self.doc, self.run_id)
        candidate = "john_moulton"
        output = self.root / "candidates" / candidate
        HERO_BATCH.record(
            self.doc, self.run_id, candidate, "running", "build", None, [],
            "worker-john")
        fragment = output / "preview-landmark.json"
        lod_paths = {}
        for lod in ("LOD0", "LOD1", "LOD2"):
            path = output / f"john-{lod.lower()}.glb"
            path.write_bytes(b"draft")
            lod_paths[lod] = path
        texture = output / "john.webp"
        texture.write_bytes(b"texture")
        source = output / "source.jpg"
        source.write_bytes(b"source")
        captures = []
        for capture_id in self.doc["requiredViews"]:
            path = output / f"{capture_id}.png"
            path.write_bytes(b"png")
            captures.append({
                "id": capture_id,
                "path": path.relative_to(ROOT).as_posix(),
                "consoleErrors": [],
                "failedRequests": [],
                "visibleTerrainCoverage": {"complete": True},
            })
        fragment.write_text(json.dumps({
            "landmarks": [{"name": "John Moulton Homestead", "lods": [
                {"url": lod_paths["LOD2"].relative_to(ROOT).as_posix(),
                 "maxDistance": 100000}
            ], "position": [0, 0]}]
        }), encoding="utf-8")
        report = output / "validation-report.json"
        report.write_text(json.dumps({
            "schemaVersion": 1,
            "candidateId": candidate,
            "sources": {
                "passed": True,
                "officialSources": 1,
                "sameBuildingElevations": 2,
                "allRightsResolved": True,
                "artifacts": [{
                    "path": source.relative_to(ROOT).as_posix(),
                    "sha256": HERO_BATCH.artifact_digest(source),
                }],
            },
            "placement": {"passed": True, "confidence": .9, "evidence": ["test"]},
            "lods": {
                lod: {
                    "path": path.relative_to(ROOT).as_posix(),
                    "triangles": 1,
                    "materialPrimitives": 1,
                } for lod, path in lod_paths.items()
            },
            "textures": {
                "totalBytes": texture.stat().st_size,
                "files": [{
                    "path": texture.relative_to(ROOT).as_posix(),
                    "bytes": texture.stat().st_size,
                }],
            },
            "captures": captures,
            "performance": {"passed": True},
        }), encoding="utf-8")
        artifacts = [*lod_paths.values(), texture, source, fragment, report,
                     *(output / f"{value}.png" for value in self.doc["requiredViews"])]
        HERO_BATCH.verify(
            self.doc, self.run_id, candidate, "fresh-verifier", "passed",
            "all deterministic gates inspected",
            [report.relative_to(ROOT).as_posix()])
        HERO_BATCH.record(
            self.doc, self.run_id, candidate, "draft_passed", "verified", None,
            [path.relative_to(ROOT).as_posix() for path in artifacts],
            "worker-john")
        preview = json.loads(
            (self.root / "preview/landmarks.json").read_text(encoding="utf-8"))
        self.assertTrue(preview["draft"])
        self.assertEqual([item["name"] for item in preview["landmarks"]],
                         ["John Moulton Homestead"])
        self.assertIn(lod_paths["LOD2"].relative_to(ROOT).as_posix(),
                      preview["artifactSha256"])

    def test_status_alone_cannot_bypass_draft_gates(self):
        HERO_BATCH.init_run(self.doc, self.run_id)
        candidate = "john_moulton"
        HERO_BATCH.record(
            self.doc, self.run_id, candidate, "running", "build", None, [],
            "worker-john")
        with self.assertRaisesRegex(ValueError, "independent verification"):
            HERO_BATCH.record(
                self.doc, self.run_id, candidate, "draft_passed", "verified", None, [],
                "worker-john")

    def test_quarantined_fragment_never_enters_preview(self):
        HERO_BATCH.init_run(self.doc, self.run_id)
        candidate = "cunningham_cabin"
        output = self.root / "candidates" / candidate
        fragment = self.root / "candidates" / candidate / "preview-landmark.json"
        fragment.write_text(json.dumps({"name": "Must not load"}), encoding="utf-8")
        HERO_BATCH.record(
            self.doc, self.run_id, candidate, "running", "sources", None, [],
            "worker-john")
        with self.assertRaisesRegex(ValueError, "invalid transition"):
            HERO_BATCH.record(
                self.doc, self.run_id, candidate, "quarantined_sources", "sources",
                "insufficient same-building elevations", [], "worker-john")
        HERO_BATCH.record(
            self.doc, self.run_id, candidate, "retrying", "sources",
            "targeted source retry", [], "worker-john")
        evidence = output / "source-audit.json"
        evidence.write_text("{}", encoding="utf-8")
        quarantine = output / "quarantine-report.json"
        quarantine.write_text(json.dumps({
            "schemaVersion": 1,
            "candidateId": candidate,
            "status": "quarantined_sources",
            "attempt": 2,
            "stage": "sources",
            "blockers": ["second same-building elevation absent"],
            "reason": "insufficient same-building elevations",
            "evidence": [{
                "path": evidence.relative_to(ROOT).as_posix(),
                "sha256": HERO_BATCH.artifact_digest(evidence),
            }],
        }), encoding="utf-8")
        HERO_BATCH.record(
            self.doc, self.run_id, candidate, "quarantined_sources", "sources",
            "insufficient same-building elevations",
            [evidence.relative_to(ROOT).as_posix(),
             quarantine.relative_to(ROOT).as_posix()],
            "worker-john")
        state_path = self.root / "state.json"
        state = HERO_BATCH.read_json(state_path)
        state["candidates"][candidate]["reason"] = "short paraphrase"
        HERO_BATCH.write_json(state_path, state)
        with self.assertRaisesRegex(ValueError, "state reason differs"):
            HERO_BATCH.audit(self.doc, self.run_id)
        HERO_BATCH.reconcile_report(
            self.doc, self.run_id, candidate, "coordinator")
        HERO_BATCH.audit(self.doc, self.run_id)
        preview = json.loads(
            (self.root / "preview/landmarks.json").read_text(encoding="utf-8"))
        self.assertEqual(preview["landmarks"], [])

    def test_audit_detects_artifact_mutation(self):
        HERO_BATCH.init_run(self.doc, self.run_id)
        candidate = "john_moulton"
        output = self.root / "candidates" / candidate
        artifact = output / "draft.glb"
        artifact.write_bytes(b"first")
        relative = artifact.relative_to(ROOT).as_posix()
        HERO_BATCH.record(
            self.doc, self.run_id, candidate, "running", "build", None,
            [relative], "worker-john")
        artifact.write_bytes(b"second")
        with self.assertRaisesRegex(ValueError, "recorded artifact changed"):
            HERO_BATCH.audit(self.doc, self.run_id)


if __name__ == "__main__":
    unittest.main()
