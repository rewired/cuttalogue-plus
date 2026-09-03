# Legacy draft recovery from releases before canonical autosave. Current
# clients can inspect or discard an existing project.draft.json, but can no
# longer create a second writable representation beside project.json.
import json

from fastapi import APIRouter, HTTPException

from .projects import project_dir

router = APIRouter()


def draft_file(project_id: str):
    return project_dir(project_id) / "project.draft.json"


@router.get("/api/projects/{project_id}/draft")
async def read_draft(project_id: str):
    file = draft_file(project_id)
    if not file.exists():
        raise HTTPException(status_code=404, detail="no draft")
    return json.loads(file.read_text(encoding="utf-8"))


@router.delete("/api/projects/{project_id}/draft")
async def delete_draft(project_id: str):
    file = draft_file(project_id)
    if file.exists():
        file.unlink()
    return {"ok": True}
