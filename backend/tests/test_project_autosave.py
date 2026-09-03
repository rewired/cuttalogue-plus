"""Regression checks for canonical revision-guarded browser autosave."""
import json
import sys
import tempfile
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import projects  # noqa: E402


failures = 0


def check(condition: bool, label: str) -> None:
    global failures
    if condition:
        print(f"ok - {label}")
    else:
        failures += 1
        print(f"FAIL: {label}")


with tempfile.TemporaryDirectory(prefix="cuttalogue-autosave-test-") as raw:
    root = Path(raw)
    original_data_dir = projects.DATA_DIR
    projects.DATA_DIR = root
    try:
        app = FastAPI()
        app.include_router(projects.router)
        client = TestClient(app)

        created_response = client.post("/api/projects", json={
            "name": "Autosave", "savedAt": None, "shots": [],
        })
        created = created_response.json()
        project_id = created["id"]
        first_revision = created["revision"]
        check(created_response.status_code == 200 and bool(first_revision), "create returns the canonical revision")

        read_response = client.get(f"/api/projects/{project_id}")
        check(
            read_response.headers.get("X-Project-Revision") == first_revision,
            "project reads expose the exact canonical revision",
        )

        draft_path = root / project_id / "project.draft.json"
        draft_path.write_text(json.dumps({"legacy": True}), encoding="utf-8")
        changed = {**created["project"], "name": "Autosaved edit"}
        saved_response = client.put(f"/api/projects/{project_id}/autosave", json={
            "expectedRevision": first_revision,
            "project": changed,
        })
        saved = saved_response.json()
        check(saved_response.status_code == 200, "matching-revision autosave succeeds")
        check(saved["revision"] != first_revision, "autosave returns the new revision")
        check(saved["project"]["name"] == "Autosaved edit", "autosave writes the browser project canonically")
        check(isinstance(saved["project"]["savedAt"], int), "repository stamps the canonical save time")
        check(not draft_path.exists(), "successful canonical autosave removes a legacy draft")

        stale_response = client.put(f"/api/projects/{project_id}/autosave", json={
            "expectedRevision": first_revision,
            "project": {**changed, "name": "Stale overwrite"},
        })
        check(stale_response.status_code == 409, "stale autosave is rejected")
        check(
            client.get(f"/api/projects/{project_id}").json()["name"] == "Autosaved edit",
            "stale autosave cannot overwrite the canonical project",
        )
    finally:
        projects.DATA_DIR = original_data_dir


if failures:
    raise SystemExit(f"{failures} failure(s)")
print("\nAll canonical autosave checks passed.")

