"""HTTP status adapter for frontend observation of MCP activity."""

from fastapi import APIRouter, HTTPException

from .live_activity import LiveActivityStore
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
    return {"projectId": project_id, "revision": record["revision"], "activity": activity}
