"""Regression checks for process-safe MCP live activity."""

import asyncio
import json
import sys
import tempfile
import time
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import live_api  # noqa: E402
from app.live_activity import LiveActivityError, LiveActivityStore, STALE_AFTER_SECONDS  # noqa: E402
from app.project_repository import ProjectRepository  # noqa: E402


failures = 0


def check(condition: bool, label: str) -> None:
    global failures
    if condition:
        print(f"ok - {label}")
    else:
        failures += 1
        print(f"FAIL: {label}")


with tempfile.TemporaryDirectory(prefix="cuttalogue-live-test-") as raw:
    root = Path(raw)
    project_dir = root / "project-a"
    project_dir.mkdir()
    project = {
        "name": "Live test", "savedAt": None,
        "shots": [{"id": 1, "startSeconds": 0, "endSeconds": 4, "direction": {"camera": []}}],
    }
    (project_dir / "project.json").write_text(json.dumps(project), encoding="utf-8")

    repository = ProjectRepository(root)
    store = LiveActivityStore(root, repository)
    check(store.read()["active"] is False, "missing activity file reads as idle")

    try:
        store.begin("project-a", "No browser")
        check(False, "live edits reject an editor without a current browser handshake")
    except LiveActivityError as error:
        check("frontend handshake" in str(error), "live edits reject an editor without a current browser handshake")

    project_revision = repository.read("project-a")["revision"]
    acknowledged = store.acknowledge_browser("project-a", project_revision)
    check(
        acknowledged["revision"] == project_revision and store.browser_status("project-a")["connected"],
        "browser acknowledgement records a fresh connected revision",
    )

    begun = store.begin("project-a", "Planning camera motion", 1)
    check(begun["active"] and begun["shotId"] == 1, "begin opens a project-scoped live session")
    check(begun["revision"] == repository.read("project-a")["revision"], "begin returns the canonical project revision")

    try:
        store.begin("project-a", "Overlapping session")
        check(False, "a second live session is rejected")
    except LiveActivityError:
        check(True, "a second live session is rejected")

    updated = store.update(begun["sessionId"], "Adding camera segments", 50)
    check(updated["message"] == "Adding camera segments" and updated["progressPercent"] == 50, "update changes visible progress")
    confirmed = asyncio.run(store.wait_for_browser_revision(begun["sessionId"], 0.2))
    check(
        confirmed["revision"] == project_revision,
        "live wait confirms the exact revision acknowledged by the browser",
    )

    try:
        store.update("wrong-session", "Invalid")
        check(False, "a mismatched session id is rejected")
    except LiveActivityError:
        check(True, "a mismatched session id is rejected")

    ended = store.end(begun["sessionId"])
    check(ended["active"] is False and ended["progressPercent"] == 100, "end closes the live session")

    stale = store.begin("project-a", "Agent disappeared")
    stale["updatedAt"] = time.time() - STALE_AFTER_SECONDS - 1
    store._write(stale)
    check(store.read()["active"] is False, "stale sessions expire instead of locking the frontend")

    (project_dir / "project.draft.json").write_text(json.dumps({
        "basedOnSavedAt": None,
        "draftUpdatedAt": 1,
        "data": {**project, "name": "Unsaved browser edit"},
    }), encoding="utf-8")
    try:
        store.begin("project-a", "Unsafe overwrite")
        check(False, "unsaved frontend drafts block live edit sessions")
    except LiveActivityError as error:
        check("unsaved edits" in str(error), "unsaved frontend drafts block live edit sessions")
    (project_dir / "project.draft.json").unlink()

    active = store.begin("project-a", "Visible over HTTP", 1)
    original_data_dir = live_api.DATA_DIR
    live_api.DATA_DIR = root
    try:
        app = FastAPI()
        app.include_router(live_api.router)
        response = TestClient(app).get("/api/projects/project-a/live")
        body = response.json()
        check(response.status_code == 200 and body["revision"] == active["revision"], "HTTP live state returns the current revision")
        check(body["activity"]["sessionId"] == active["sessionId"], "HTTP live state exposes the active frontend session")
        check(body["browser"]["connected"] is True, "HTTP live state exposes the browser handshake")
        ack_response = TestClient(app).post("/api/projects/project-a/live/ack", json={
            "revision": body["revision"],
        })
        check(
            ack_response.status_code == 200 and ack_response.json()["revision"] == body["revision"],
            "HTTP live acknowledgement records the browser revision",
        )
    finally:
        live_api.DATA_DIR = original_data_dir


if failures:
    raise SystemExit(f"{failures} failure(s)")
print("\nAll MCP live activity checks passed.")
