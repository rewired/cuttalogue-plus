"""Process-safe activity state shared by the MCP and web processes."""

from __future__ import annotations

import json
import os
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from .project_repository import ProjectRepository


SCHEMA_VERSION = 1
STALE_AFTER_SECONDS = 300


class LiveActivityError(ValueError):
    """Raised when a visible MCP edit session cannot be changed safely."""


class LiveActivityStore:
    def __init__(self, projects_root: Path, repository: ProjectRepository | None = None):
        self.projects_root = Path(projects_root)
        self.repository = repository or ProjectRepository(self.projects_root)
        self.path = self.projects_root / ".mcp-live.json"

    @staticmethod
    def idle() -> dict[str, Any]:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "active": False,
            "sessionId": None,
            "projectId": None,
            "shotId": None,
            "message": "",
            "progressPercent": None,
            "updatedAt": None,
        }

    def read(self) -> dict[str, Any]:
        if not self.path.exists():
            return self.idle()
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return self.idle()
        if not isinstance(value, dict) or value.get("schemaVersion") != SCHEMA_VERSION:
            return self.idle()
        updated_at = value.get("updatedAt")
        if value.get("active") and (
            not isinstance(updated_at, (int, float))
            or time.time() - updated_at > STALE_AFTER_SECONDS
        ):
            return {**self.idle(), "message": "Live edit session expired."}
        return {**self.idle(), **value}

    def _write(self, value: dict[str, Any]) -> dict[str, Any]:
        self.projects_root.mkdir(parents=True, exist_ok=True)
        handle, temporary_name = tempfile.mkstemp(
            prefix=".mcp-live-", suffix=".tmp", dir=self.projects_root,
        )
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(value, stream, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_name, self.path)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)
        return value

    @staticmethod
    def _message(value: str) -> str:
        message = str(value or "").strip()
        if not message:
            raise LiveActivityError("a live edit message is required")
        if len(message) > 240:
            raise LiveActivityError("live edit messages are limited to 240 characters")
        return message

    def _assert_clean_browser_draft(self, project_id: str, project: dict[str, Any]) -> None:
        draft_path = self.projects_root / project_id / "project.draft.json"
        if not draft_path.exists():
            return
        try:
            draft = json.loads(draft_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return
        if (
            isinstance(draft, dict)
            and draft.get("basedOnSavedAt") == project.get("savedAt")
            and draft.get("data") != project
        ):
            raise LiveActivityError(
                "the frontend has unsaved edits; ask the user to save them before starting a live edit"
            )

    def begin(self, project_id: str, message: str, shot_id: int | None = None) -> dict[str, Any]:
        current = self.read()
        if current["active"]:
            raise LiveActivityError("another MCP live edit session is already active")
        record = self.repository.read(project_id)
        self._assert_clean_browser_draft(project_id, record["project"])
        if shot_id is not None and not any(
            shot.get("id") == shot_id for shot in record["project"].get("shots", [])
        ):
            raise LiveActivityError(f"shot {shot_id} not found")
        value = {
            **self.idle(),
            "active": True,
            "sessionId": uuid.uuid4().hex,
            "projectId": project_id,
            "shotId": shot_id,
            "message": self._message(message),
            "updatedAt": time.time(),
        }
        self._write(value)
        return {**value, "revision": record["revision"]}

    def update(
        self, session_id: str, message: str, progress_percent: float | None = None,
    ) -> dict[str, Any]:
        current = self._require_session(session_id)
        if progress_percent is not None and not 0 <= progress_percent <= 100:
            raise LiveActivityError("progress_percent must be between 0 and 100")
        current.update({
            "message": self._message(message),
            "progressPercent": progress_percent,
            "updatedAt": time.time(),
        })
        return self._write(current)

    def end(self, session_id: str, message: str = "Changes complete") -> dict[str, Any]:
        current = self._require_session(session_id)
        current.update({
            "active": False,
            "message": self._message(message),
            "progressPercent": 100,
            "updatedAt": time.time(),
        })
        return self._write(current)

    def _require_session(self, session_id: str) -> dict[str, Any]:
        current = self.read()
        if not current["active"] or current["sessionId"] != session_id:
            raise LiveActivityError("live edit session is not active")
        return current
