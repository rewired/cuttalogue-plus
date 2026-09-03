"""HTTP status adapter for frontend observation of MCP activity."""

from fastapi import APIRouter, HTTPException

from .live_activity import LiveActivityError, LiveActivityStore
from .project_repository import InvalidProjectError, ProjectNotFoundError, ProjectRepository
from .projects import DATA_DIR


router = APIRouter()


@router.get("/api/projects/{project_id}/live")
async def project_live_state(project_id: str):
    repository = ProjectRepository(DATA_DIR)
    try:
        record = repository.read(project_id)
    except ProjectNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except InvalidProjectError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    activity = LiveActivityStore(DATA_DIR, repository).read()
    if activity.get("projectId") != project_id:
        activity = LiveActivityStore.idle()
    browser = LiveActivityStore(DATA_DIR, repository).browser_status(project_id)
    return {
        "projectId": project_id, "revision": record["revision"],
        "activity": activity, "browser": browser,
    }


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
