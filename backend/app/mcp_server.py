"""CUTTAlogue MCP server over local STDIO."""
import json
import os
from pathlib import Path
from typing import Any

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import CallToolResult, TextContent, ToolAnnotations

from .asset_import_service import AssetImportService
from .camera_service import CameraEvaluationError
from .comfy import GenerationStartError
from .generation_service import GenerationService
from .jobs import JobNotFoundError, cancel_job_request, read_job_status
from .live_activity import LiveActivityError, LiveActivityStore
from .project_repository import InvalidProjectError, ProjectNotFoundError, ProjectRepository, RevisionConflictError
from .projects import DATA_DIR
from .prompt_service import PromptCompilationError
from .read_services import EntityNotFoundError, ProjectReadService
from .write_services import (
    AnchorNotFoundError, AssetNotFoundError, CameraSegmentNotFoundError,
    ProjectWriteService, SceneNotFoundError, ShotNotFoundError,
    WriteValidationError,
)


EXPECTED_READ_ERRORS = (
    CameraEvaluationError, EntityNotFoundError, InvalidProjectError,
    JobNotFoundError, ProjectNotFoundError, PromptCompilationError,
)
READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
CONTROLLED_WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)
LOCAL_FILE_IMPORT = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=True)
CONTROLLED_DELETE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=False)
EXTERNAL_ACTION = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=True)


def _read(operation, *args) -> Any:
    try:
        return operation(*args)
    except EXPECTED_READ_ERRORS as error:
        raise ToolError(str(error)) from error


def _write_error(payload: dict[str, Any]) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(text=json.dumps(payload))],
        structuredContent=payload,
        isError=True,
    )


def _write(operation, *args) -> Any:
    try:
        return operation(*args)
    except RevisionConflictError as error:
        return _write_error({
            "code": "revision_conflict", "message": str(error),
            "expectedRevision": error.expected_revision, "currentRevision": error.current_revision,
        })
    except ProjectNotFoundError as error:
        return _write_error({"code": "project_not_found", "message": str(error)})
    except ShotNotFoundError as error:
        return _write_error({"code": "shot_not_found", "message": str(error)})
    except CameraSegmentNotFoundError as error:
        return _write_error({"code": "camera_segment_not_found", "message": str(error)})
    except SceneNotFoundError as error:
        return _write_error({"code": "scene_not_found", "message": str(error)})
    except AnchorNotFoundError as error:
        return _write_error({"code": "anchor_not_found", "message": str(error)})
    except AssetNotFoundError as error:
        return _write_error({"code": "asset_not_found", "message": str(error)})
    except LiveActivityError as error:
        return _write_error({"code": "live_activity_error", "message": str(error)})
    except PromptCompilationError as error:
        return _write_error({"code": "prompt_compilation_error", "message": str(error)})
    except WriteValidationError as error:
        return _write_error({"code": "validation_error", "message": str(error)})
    except InvalidProjectError as error:
        return _write_error({"code": "invalid_project", "message": str(error)})


async def _write_async(operation, *args) -> Any:
    try:
        return await operation(*args)
    except RevisionConflictError as error:
        return _write_error({
            "code": "revision_conflict", "message": str(error),
            "expectedRevision": error.expected_revision,
            "currentRevision": error.current_revision,
        })
    except ProjectNotFoundError as error:
        return _write_error({"code": "project_not_found", "message": str(error)})
    except ShotNotFoundError as error:
        return _write_error({"code": "shot_not_found", "message": str(error)})
    except WriteValidationError as error:
        return _write_error({"code": "validation_error", "message": str(error)})
    except GenerationStartError as error:
        return _write_error({"code": "generation_start_error", "message": str(error)})
    except LiveActivityError as error:
        return _write_error({"code": "live_activity_error", "message": str(error)})
    except InvalidProjectError as error:
        return _write_error({"code": "invalid_project", "message": str(error)})


def create_mcp_server(data_dir: Path | None = None) -> MCPServer:
    root = data_dir or Path(os.environ.get("CUTTALOGUE_PROJECTS_DIR", DATA_DIR))
    service = ProjectReadService(ProjectRepository(root))
    write_service = ProjectWriteService(ProjectRepository(root))
    asset_import_service = AssetImportService(ProjectRepository(root))
    generation_service = GenerationService(ProjectRepository(root))
    activity_store = LiveActivityStore(root)
    server = MCPServer(
        "CUTTAlogue",
        instructions=(
            "Read CUTTAlogue projects, shots, Direction data, camera paths, prompts, and jobs. "
            "Narrow write tools require the exact revision returned by a fresh read. "
            "For multi-step edits that the user should watch or wait for, call begin_live_edit first, "
            "update_live_edit as meaningful stages complete, wait_for_live_edit before reporting success, "
            "and always call end_live_edit."
        ),
    )

    @server.tool(annotations=CONTROLLED_WRITE)
    def begin_live_edit(project_id: str, message: str, shot_id: int | None = None) -> dict[str, Any]:
        """Open a visible frontend wait session before a multi-step MCP edit."""
        return _write(activity_store.begin, project_id, message, shot_id)

    @server.tool(annotations=CONTROLLED_WRITE)
    def update_live_edit(
        session_id: str, message: str, progress_percent: float | None = None,
    ) -> dict[str, Any]:
        """Update the message and optional progress shown in the frontend wait modal."""
        return _write(activity_store.update, session_id, message, progress_percent)

    @server.tool(annotations=READ_ONLY)
    async def wait_for_live_edit(
        session_id: str, timeout_seconds: float = 10,
    ) -> dict[str, Any]:
        """Wait until the open frontend acknowledges the current project revision."""
        return await _write_async(activity_store.wait_for_browser_revision, session_id, timeout_seconds)

    @server.tool(annotations=CONTROLLED_WRITE)
    def end_live_edit(session_id: str, message: str = "Changes complete") -> dict[str, Any]:
        """Close a visible frontend wait session; call this even after a failed edit."""
        return _write(activity_store.end, session_id, message)

    @server.tool(annotations=READ_ONLY)
    def list_projects() -> dict[str, Any]:
        """List CUTTAlogue projects with content revisions and shot counts."""
        return {"projects": _read(service.list_projects)}

    @server.tool(annotations=READ_ONLY)
    def get_project(project_id: str) -> dict[str, Any]:
        """Read one complete CUTTAlogue project by id."""
        return _read(service.get_project, project_id)

    @server.tool(annotations=READ_ONLY)
    def list_shots(project_id: str) -> dict[str, Any]:
        """List all shots in one CUTTAlogue project."""
        return _read(service.list_shots, project_id)

    @server.tool(annotations=READ_ONLY)
    def get_shot(project_id: str, shot_id: int) -> dict[str, Any]:
        """Read one shot by project id and numeric shot id."""
        return _read(service.get_shot, project_id, shot_id)

    @server.tool(annotations=READ_ONLY)
    def get_shot_direction(project_id: str, shot_id: int) -> dict[str, Any]:
        """Read normalized Camera, Lighting, Subject, Prop, and Beat Direction."""
        return _read(service.get_shot_direction, project_id, shot_id)

    @server.tool(annotations=READ_ONLY)
    def get_camera_segments(project_id: str, shot_id: int) -> dict[str, Any]:
        """Read the authoritative shot.direction.camera segments for one shot."""
        return _read(service.get_camera_segments, project_id, shot_id)

    @server.tool(annotations=READ_ONLY)
    def validate_camera_path(project_id: str, shot_id: int) -> dict[str, Any]:
        """Compile and validate a shot's deterministic spatial camera path."""
        return _read(service.validate_camera_path, project_id, shot_id)

    @server.tool(annotations=READ_ONLY)
    def evaluate_camera_path(project_id: str, shot_id: int, time_seconds: float) -> dict[str, Any]:
        """Evaluate a shot-relative deterministic camera pose at a time in seconds."""
        return _read(service.evaluate_camera_path, project_id, shot_id, time_seconds)

    @server.tool(annotations=READ_ONLY)
    def compile_shot_prompt(project_id: str, shot_id: int) -> dict[str, Any]:
        """Compile authored Direction into CUTTAlogue's deterministic H3 prompt without saving it."""
        return _read(service.compile_shot_prompt, project_id, shot_id)

    @server.tool(annotations=READ_ONLY)
    def get_job_status(job_id: str) -> dict[str, Any]:
        """Read one in-memory CUTTAlogue job snapshot without consuming its event stream."""
        return _read(read_job_status, job_id)

    @server.tool(annotations=READ_ONLY)
    def get_project_warnings(project_id: str) -> dict[str, Any]:
        """Validate project timing and scene references without changing data."""
        return _read(service.get_project_warnings, project_id)

    @server.tool(annotations=CONTROLLED_WRITE)
    def create_shot(project_id: str, expected_revision: str, start_seconds: float, end_seconds: float, name: str = "") -> dict[str, Any]:
        """Create one non-overlapping shot when the project revision still matches."""
        return _write(write_service.create_shot, project_id, expected_revision, start_seconds, end_seconds, name)

    @server.tool(annotations=CONTROLLED_WRITE)
    def update_shot_timing(project_id: str, shot_id: int, expected_revision: str, start_seconds: float, end_seconds: float) -> dict[str, Any]:
        """Update one shot's exact bounds when the project revision still matches."""
        return _write(write_service.update_shot_timing, project_id, shot_id, expected_revision, start_seconds, end_seconds)

    @server.tool(annotations=CONTROLLED_WRITE)
    def rename_shot(project_id: str, shot_id: int, expected_revision: str, name: str) -> dict[str, Any]:
        """Rename one shot when the project revision still matches."""
        return _write(write_service.rename_shot, project_id, shot_id, expected_revision, name)

    @server.tool(annotations=LOCAL_FILE_IMPORT)
    async def import_asset(
        project_id: str, expected_revision: str, source_path: str,
        description: str = "", kind: str = "",
    ) -> dict[str, Any]:
        """Copy one absolute local file into project assets with a fresh revision."""
        return await _write_async(
            asset_import_service.import_asset, project_id, expected_revision,
            source_path, description, kind,
        )

    @server.tool(annotations=CONTROLLED_WRITE)
    def add_camera_segment(
        project_id: str, shot_id: int, expected_revision: str,
        start_seconds: float, end_seconds: float, movement: str = "zoom_in",
        framing: str = "", speed: str = "", amplitude: str = "",
        direction: str = "", target: str = "", focal_length: str = "",
        depth_of_field: str = "", focus_target: str = "",
        transition_to_next: str = "", enabled: bool = True,
    ) -> dict[str, Any]:
        """Add one validated, shot-relative camera segment with a fresh revision."""
        segment = {
            "startSeconds": start_seconds, "endSeconds": end_seconds,
            "movement": movement, "framing": framing, "speed": speed,
            "amplitude": amplitude, "direction": direction, "target": target,
            "focalLength": focal_length, "depthOfField": depth_of_field,
            "focusTarget": focus_target, "transitionToNext": transition_to_next,
            "enabled": enabled,
        }
        return _write(write_service.add_camera_segment, project_id, shot_id, expected_revision, segment)

    @server.tool(annotations=CONTROLLED_WRITE)
    def update_camera_segment(
        project_id: str, shot_id: int, segment_index: int, expected_revision: str,
        start_seconds: float | None = None, end_seconds: float | None = None,
        movement: str | None = None, framing: str | None = None,
        speed: str | None = None, amplitude: str | None = None,
        direction: str | None = None, target: str | None = None,
        focal_length: str | None = None, depth_of_field: str | None = None,
        focus_target: str | None = None, transition_to_next: str | None = None,
        enabled: bool | None = None,
    ) -> dict[str, Any]:
        """Patch one camera segment by its current sorted index with a fresh revision."""
        values = {
            "startSeconds": start_seconds, "endSeconds": end_seconds,
            "movement": movement, "framing": framing, "speed": speed,
            "amplitude": amplitude, "direction": direction, "target": target,
            "focalLength": focal_length, "depthOfField": depth_of_field,
            "focusTarget": focus_target, "transitionToNext": transition_to_next,
            "enabled": enabled,
        }
        patch = {key: value for key, value in values.items() if value is not None}
        return _write(
            write_service.update_camera_segment, project_id, shot_id,
            segment_index, expected_revision, patch,
        )

    @server.tool(annotations=CONTROLLED_DELETE)
    def remove_camera_segment(
        project_id: str, shot_id: int, segment_index: int,
        expected_revision: str,
    ) -> dict[str, Any]:
        """Remove one camera segment by its current sorted index with a fresh revision."""
        return _write(
            write_service.remove_camera_segment, project_id, shot_id,
            segment_index, expected_revision,
        )

    @server.tool(annotations=CONTROLLED_WRITE)
    def add_subject_segment(
        project_id: str, shot_id: int, asset_id: str,
        expected_revision: str, start_seconds: float, end_seconds: float,
        action_type: str = "", vocal_performance: str = "",
        manner: str = "", gaze: str = "", eyes: str = "",
        expression: str = "", gesture: str = "", body_motion: str = "",
        notes: str = "", enabled: bool = True,
    ) -> dict[str, Any]:
        """Add one validated performance segment for an assigned character asset."""
        segment = {
            "startSeconds": start_seconds,
            "endSeconds": end_seconds,
            "actionType": action_type,
            "vocalPerformance": vocal_performance,
            "manner": manner,
            "gaze": gaze,
            "eyes": eyes,
            "expression": expression,
            "gesture": gesture,
            "bodyMotion": body_motion,
            "notes": notes,
            "enabled": enabled,
        }
        return _write(
            write_service.add_subject_segment, project_id, shot_id, asset_id,
            expected_revision, segment,
        )

    @server.tool(annotations=CONTROLLED_WRITE)
    def assign_scene(
        project_id: str, shot_id: int, expected_revision: str,
        scene_id: str = "",
    ) -> dict[str, Any]:
        """Assign an existing scene to a shot, or clear it with an empty scene id."""
        return _write(
            write_service.assign_scene, project_id, shot_id,
            expected_revision, scene_id or None,
        )

    @server.tool(annotations=CONTROLLED_WRITE)
    def set_scene_anchor(
        project_id: str, scene_id: str, expected_revision: str, name: str,
        x: float, y: float, z: float, previous_name: str = "",
    ) -> dict[str, Any]:
        """Create, move, or rename one finite 3D anchor in an existing scene."""
        return _write(
            write_service.set_scene_anchor, project_id, scene_id,
            expected_revision, name, [x, y, z], previous_name or None,
        )

    @server.tool(annotations=CONTROLLED_WRITE)
    def bind_camera_target(
        project_id: str, shot_id: int, expected_revision: str,
        target_name: str, anchor_name: str = "",
    ) -> dict[str, Any]:
        """Bind a semantic camera target to a scene anchor, or clear the binding."""
        return _write(
            write_service.bind_camera_target, project_id, shot_id,
            expected_revision, target_name, anchor_name,
        )

    @server.tool(annotations=CONTROLLED_WRITE)
    def assign_asset(
        project_id: str, shot_id: int, expected_revision: str,
        asset_id: str, role: str = "",
    ) -> dict[str, Any]:
        """Assign an existing project asset to a shot with an optional prompt role."""
        return _write(
            write_service.assign_asset, project_id, shot_id,
            expected_revision, asset_id, role,
        )

    @server.tool(annotations=CONTROLLED_WRITE)
    def add_constraint(
        project_id: str, shot_id: int, expected_revision: str,
        constraint: str,
    ) -> dict[str, Any]:
        """Append one non-empty authored constraint to a shot."""
        return _write(
            write_service.add_constraint, project_id, shot_id,
            expected_revision, constraint,
        )

    @server.tool(annotations=CONTROLLED_WRITE)
    def compile_and_save_prompt(
        project_id: str, shot_id: int, expected_revision: str,
    ) -> dict[str, Any]:
        """Compile canonical H3 Direction and atomically save it as the shot prompt."""
        return _write(
            write_service.compile_and_save_prompt, project_id, shot_id,
            expected_revision,
        )

    @server.tool(annotations=CONTROLLED_DELETE)
    def cancel_job(job_id: str) -> dict[str, Any]:
        """Explicitly request cancellation of one queued or running CUTTAlogue job."""
        return _read(cancel_job_request, job_id)

    @server.tool(annotations=EXTERNAL_ACTION)
    async def start_generation(
        project_id: str, shot_id: int, expected_revision: str,
        seed: int | None = None,
    ) -> dict[str, Any]:
        """Explicitly start one external ComfyUI take from persisted shot state."""
        return await _write_async(
            generation_service.start_generation, project_id, shot_id,
            expected_revision, seed,
        )

    return server


mcp = create_mcp_server()


if __name__ == "__main__":
    mcp.run()
