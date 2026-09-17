"""HTTP status adapter for frontend observation of MCP activity."""

import asyncio
import hashlib
import json
import time

from fastapi import APIRouter, HTTPException, Request

from .live_activity import LiveActivityError, LiveActivityStore
from .project_repository import InvalidProjectError, ProjectNotFoundError, ProjectRepository
from .projects import DATA_DIR


router = APIRouter()


def _live_payload(repository: ProjectRepository, store: LiveActivityStore, project_id: str) -> dict:
    record = repository.read(project_id)
    activity = store.read()
    if activity.get("projectId") != project_id:
        activity = LiveActivityStore.idle()
    token_source = json.dumps(
        {"revision": record["revision"], "activity": activity},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return {
        "projectId": project_id,
        "revision": record["revision"],
        "activity": activity,
        "browser": store.browser_status(project_id),
        "token": hashlib.sha256(token_source).hexdigest(),
    }


@router.get("/api/projects/{project_id}/live")
async def project_live_state(
    project_id: str,
    request: Request,
    after: str | None = None,
    revision: str | None = None,
    ready: bool = True,
    wait_seconds: float = 20,
):
    repository = ProjectRepository(DATA_DIR)
    store = LiveActivityStore(DATA_DIR, repository)
    try:
        if revision:
            store.acknowledge_browser(project_id, revision, ready)
        payload = _live_payload(repository, store, project_id)
        if not after or payload["token"] != after:
            return payload

        deadline = time.monotonic() + max(0.1, min(float(wait_seconds), 25))
        next_heartbeat = time.monotonic() + 3
        while time.monotonic() < deadline:
            if await request.is_disconnected():
                return payload
            await asyncio.sleep(0.25)
            payload = _live_payload(repository, store, project_id)
            if payload["token"] != after:
                return payload
            if revision and time.monotonic() >= next_heartbeat:
                store.acknowledge_browser(project_id, revision, ready)
                next_heartbeat = time.monotonic() + 3
        return payload
    except ProjectNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except InvalidProjectError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except LiveActivityError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/api/projects/{project_id}/live/ack")
async def acknowledge_project_live_state(project_id: str, payload: dict):
    repository = ProjectRepository(DATA_DIR)
    try:
        return LiveActivityStore(DATA_DIR, repository).acknowledge_browser(
            project_id, payload.get("revision"), payload.get("ready", True),
        )
    except ProjectNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except (InvalidProjectError, LiveActivityError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
