"""In-memory protocol tests for the CUTTAlogue MCP server."""
import asyncio
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp import Client  # noqa: E402
from app import generation_service as generation_module, jobs  # noqa: E402
from app.mcp_server import create_mcp_server  # noqa: E402

failures = 0


def check(condition: bool, label: str) -> None:
    global failures
    if condition:
        print(f"ok - {label}")
    else:
        failures += 1
        print(f"FAIL: {label}")


async def main() -> None:
    with tempfile.TemporaryDirectory(prefix="cuttalogue-mcp-test-") as raw:
        root = Path(raw)
        directory = root / "mcp-project"
        directory.mkdir()
        (directory / "project.json").write_text(json.dumps({
            "name": "MCP test",
            "assets": [{"id": "lead", "name": "Lead reference", "type": "image"}],
            "scenes": [{"id": "scene-1", "defaultCamera": {
                "position": [0, 1.6, 4], "target": [0, 1.6, 0], "focalLengthMm": 35,
            }}],
            "shots": [{
                "id": 1, "startSeconds": 0, "endSeconds": 5, "sceneId": "scene-1",
                "direction": {"camera": [{"startSeconds": 0, "endSeconds": 5, "movement": "push_in"}]},
            }],
        }), encoding="utf-8")

        generation_calls = []

        async def fake_generation_start(project, project_directory, shot, body):
            generation_calls.append(body)
            job = jobs.create_job()
            return {"jobId": job.id, "takeId": "take-test"}

        original_generation_start = generation_module.start_generation_job
        generation_module.start_generation_job = fake_generation_start
        server = create_mcp_server(root)
        async with Client(server) as client:
            tools = await client.list_tools()
            names = {tool.name for tool in tools.tools}
            expected = {
                "list_projects", "get_project", "list_shots", "get_shot",
                "get_shot_direction", "get_camera_segments", "validate_camera_path",
                "evaluate_camera_path", "compile_shot_prompt", "get_project_warnings",
                "get_job_status",
                "create_shot", "update_shot_timing", "rename_shot",
                "add_camera_segment", "update_camera_segment", "remove_camera_segment",
                "assign_scene", "set_scene_anchor", "bind_camera_target",
                "assign_asset", "add_constraint", "compile_and_save_prompt",
                "cancel_job", "start_generation",
                "begin_live_edit", "update_live_edit", "end_live_edit",
            }
            check(names == expected, "MCP exposes exactly the planned read and Direction write tools")
            tools_by_name = {tool.name: tool for tool in tools.tools}
            read_annotations = tools_by_name["get_project"].annotations.model_dump(by_alias=True)
            write_annotations = tools_by_name["create_shot"].annotations.model_dump(by_alias=True)
            delete_annotations = tools_by_name["remove_camera_segment"].annotations.model_dump(by_alias=True)
            check(read_annotations["readOnlyHint"] is True, "MCP metadata marks reads as read-only")
            check(write_annotations["readOnlyHint"] is False and write_annotations["destructiveHint"] is False, "MCP metadata marks controlled writes as non-destructive mutations")
            check(delete_annotations["destructiveHint"] is True, "MCP metadata marks camera removal as destructive")
            check(tools_by_name["cancel_job"].annotations.model_dump(by_alias=True)["destructiveHint"] is True, "MCP metadata marks job cancellation as destructive")
            start_annotations = tools_by_name["start_generation"].annotations.model_dump(by_alias=True)
            check(start_annotations["destructiveHint"] is True and start_annotations["openWorldHint"] is True, "MCP metadata marks generation as an external destructive action")

            projects = await client.call_tool("list_projects", {})
            check(not projects.is_error and projects.structured_content["projects"][0]["id"] == "mcp-project", "list_projects returns structured service data")
            camera = await client.call_tool("get_camera_segments", {"project_id": "mcp-project", "shot_id": 1})
            check(not camera.is_error and camera.structured_content["cameraSegments"][0]["movement"] == "push_in", "camera tool returns authoritative Direction segments")
            evaluated = await client.call_tool("evaluate_camera_path", {"project_id": "mcp-project", "shot_id": 1, "time_seconds": 5})
            check(not evaluated.is_error and evaluated.structured_content["pose"]["position"] == [0.0, 1.6, 3.0], "MCP evaluates the backend camera path")
            compiled = await client.call_tool("compile_shot_prompt", {"project_id": "mcp-project", "shot_id": 1})
            check(not compiled.is_error and "The camera pushes in" in compiled.structured_content["prompt"], "MCP compiles the canonical H3 prompt")
            job = jobs.create_job()
            job.status, job.result = "done", {"artifact": "preview.mp4"}
            status = await client.call_tool("get_job_status", {"job_id": job.id})
            check(not status.is_error and status.structured_content["result"]["artifact"] == "preview.mp4", "MCP reads a non-consuming job snapshot")
            cancelled_terminal = await client.call_tool("cancel_job", {"job_id": job.id})
            check(not cancelled_terminal.is_error and cancelled_terminal.structured_content["cancelRequested"] is False, "MCP cancellation leaves terminal jobs unchanged")
            running_job = jobs.create_job()
            running_job.status = "running"
            cancelled = await client.call_tool("cancel_job", {"job_id": running_job.id})
            check(not cancelled.is_error and cancelled.structured_content["cancelRequested"] is True and running_job.cancel_requested, "MCP explicitly requests running-job cancellation")
            jobs._jobs.pop(running_job.id, None)
            jobs._jobs.pop(job.id, None)
            original_revision = projects.structured_content["projects"][0]["revision"]
            live_started = await client.call_tool("begin_live_edit", {
                "project_id": "mcp-project", "shot_id": 1,
                "message": "Updating the camera plan",
            })
            live_session_id = live_started.structured_content["sessionId"]
            check(
                not live_started.is_error and live_started.structured_content["active"] is True,
                "MCP opens a frontend-visible live edit session",
            )
            live_updated = await client.call_tool("update_live_edit", {
                "session_id": live_session_id, "message": "Validating camera motion",
                "progress_percent": 60,
            })
            check(
                live_updated.structured_content["progressPercent"] == 60,
                "MCP updates frontend-visible live edit progress",
            )
            live_ended = await client.call_tool("end_live_edit", {"session_id": live_session_id})
            check(
                live_ended.structured_content["active"] is False,
                "MCP closes the frontend-visible live edit session",
            )
            created = await client.call_tool("create_shot", {
                "project_id": "mcp-project", "expected_revision": original_revision,
                "start_seconds": 6, "end_seconds": 7, "name": "MCP shot",
            })
            created_revision = created.structured_content["revision"]
            check(not created.is_error and created.structured_content["shot"]["name"] == "MCP shot", "MCP creates one narrow shot mutation")
            stale = await client.call_tool("rename_shot", {
                "project_id": "mcp-project", "shot_id": 2,
                "expected_revision": original_revision, "name": "stale",
            })
            check(stale.is_error and stale.structured_content["code"] == "revision_conflict" and stale.structured_content["currentRevision"] == created_revision, "MCP stale write returns a structured current revision")
            renamed = await client.call_tool("rename_shot", {
                "project_id": "mcp-project", "shot_id": 2,
                "expected_revision": created_revision, "name": "Renamed safely",
            })
            check(not renamed.is_error and renamed.structured_content["shot"]["name"] == "Renamed safely", "MCP write succeeds with the fresh revision")
            camera_added = await client.call_tool("add_camera_segment", {
                "project_id": "mcp-project", "shot_id": 2,
                "expected_revision": renamed.structured_content["revision"],
                "start_seconds": 0, "end_seconds": 0.4, "movement": "push_in",
            })
            check(not camera_added.is_error and camera_added.structured_content["segmentIndex"] == 0, "MCP adds a validated Direction camera segment")
            camera_updated = await client.call_tool("update_camera_segment", {
                "project_id": "mcp-project", "shot_id": 2, "segment_index": 0,
                "expected_revision": camera_added.structured_content["revision"],
                "movement": "truck", "direction": "right", "amplitude": "small",
            })
            check(not camera_updated.is_error and camera_updated.structured_content["segment"]["movement"] == "truck", "MCP patches a Direction camera segment")
            overlap = await client.call_tool("add_camera_segment", {
                "project_id": "mcp-project", "shot_id": 2,
                "expected_revision": camera_updated.structured_content["revision"],
                "start_seconds": 0.2, "end_seconds": 0.6, "movement": "pan",
            })
            check(overlap.is_error and overlap.structured_content["code"] == "validation_error", "MCP rejects overlapping active camera segments")
            camera_removed = await client.call_tool("remove_camera_segment", {
                "project_id": "mcp-project", "shot_id": 2, "segment_index": 0,
                "expected_revision": camera_updated.structured_content["revision"],
            })
            check(not camera_removed.is_error and camera_removed.structured_content["removedSegment"]["movement"] == "truck", "MCP removes one addressed camera segment")
            missing_segment = await client.call_tool("remove_camera_segment", {
                "project_id": "mcp-project", "shot_id": 2, "segment_index": 0,
                "expected_revision": camera_removed.structured_content["revision"],
            })
            check(missing_segment.is_error and missing_segment.structured_content["code"] == "camera_segment_not_found", "MCP returns a structured missing-camera-segment error")
            scene_assigned = await client.call_tool("assign_scene", {
                "project_id": "mcp-project", "shot_id": 2,
                "expected_revision": camera_removed.structured_content["revision"],
                "scene_id": "scene-1",
            })
            check(not scene_assigned.is_error and scene_assigned.structured_content["shot"]["sceneId"] == "scene-1", "MCP assigns an existing scene to a shot")
            anchor_set = await client.call_tool("set_scene_anchor", {
                "project_id": "mcp-project", "scene_id": "scene-1",
                "expected_revision": scene_assigned.structured_content["revision"],
                "name": "performer", "x": 0, "y": 1.7, "z": 0,
            })
            check(not anchor_set.is_error and anchor_set.structured_content["anchor"]["position"] == [0.0, 1.7, 0.0], "MCP sets a finite scene anchor")
            target_bound = await client.call_tool("bind_camera_target", {
                "project_id": "mcp-project", "shot_id": 2,
                "expected_revision": anchor_set.structured_content["revision"],
                "target_name": "lead", "anchor_name": "performer",
            })
            check(not target_bound.is_error and target_bound.structured_content["targetBindings"]["lead"] == "performer", "MCP binds semantic camera targets to scene anchors")
            asset_assigned = await client.call_tool("assign_asset", {
                "project_id": "mcp-project", "shot_id": 2,
                "expected_revision": target_bound.structured_content["revision"],
                "asset_id": "lead", "role": "primary_character",
            })
            check(not asset_assigned.is_error and asset_assigned.structured_content["assetRoles"]["lead"] == "primary_character", "MCP assigns an existing asset with an allowed prompt role")
            constraint_added = await client.call_tool("add_constraint", {
                "project_id": "mcp-project", "shot_id": 2,
                "expected_revision": asset_assigned.structured_content["revision"],
                "constraint": "No visible text",
            })
            prompt_saved = await client.call_tool("compile_and_save_prompt", {
                "project_id": "mcp-project", "shot_id": 2,
                "expected_revision": constraint_added.structured_content["revision"],
            })
            check(not prompt_saved.is_error and "No visible text." in prompt_saved.structured_content["prompt"], "MCP compiles and atomically saves the canonical H3 prompt")
            generation_started = await client.call_tool("start_generation", {
                "project_id": "mcp-project", "shot_id": 2,
                "expected_revision": prompt_saved.structured_content["revision"],
                "seed": 42,
            })
            check(not generation_started.is_error and generation_started.structured_content["takeId"] == "take-test", "MCP explicitly starts generation from persisted shot state")
            check(generation_calls[0]["referenceAssetIds"] == ["lead"] and generation_calls[0]["seed"] == 42, "MCP generation preserves canonical references and explicit seed")
            jobs._jobs.pop(generation_started.structured_content["jobId"], None)
            invalid = await client.call_tool("create_shot", {
                "project_id": "mcp-project", "expected_revision": prompt_saved.structured_content["revision"],
                "start_seconds": 0, "end_seconds": 1, "name": "overlap",
            })
            check(invalid.is_error and invalid.structured_content["code"] == "validation_error", "MCP validation failures are structured write errors")
            after_invalid = await client.call_tool("get_project", {"project_id": "mcp-project"})
            check(after_invalid.structured_content["revision"] == prompt_saved.structured_content["revision"], "invalid MCP write leaves the revision unchanged")
            missing = await client.call_tool("get_shot", {"project_id": "mcp-project", "shot_id": 99})
            check(missing.is_error, "domain errors become MCP tool errors")
            check(client.protocol_version is not None, "in-memory client negotiates an MCP protocol version")
        generation_module.start_generation_job = original_generation_start


asyncio.run(main())
if failures:
    raise SystemExit(f"{failures} failure(s)")
print("\nAll MCP protocol checks passed.")
