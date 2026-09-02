# CUTTAlogue MCP

Status: Phase 7 local STDIO read/write toolset complete; Phase 8 hardening in progress

CUTTAlogue exposes its transport-neutral project services through a local MCP server. Mutations are narrow typed operations; there is no generic project JSON writer.

## Requirements

Install the backend dependencies:

    backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt

Node.js must be available on PATH because read-only prompt compilation invokes the canonical browser H3 compiler instead of maintaining a second grammar.

## STDIO launch

Run from the backend directory:

    .venv\Scripts\python.exe -m app.mcp_server

STDIO is the protocol wire, so the server does not print a startup banner. Logs must go to stderr.

Set CUTTALOGUE_PROJECTS_DIR only when the host should read a non-default project directory.

## Observable frontend edits

The open CUTTAlogue frontend watches the canonical project revision every 750 ms. A successful MCP project mutation is therefore applied to the visible editor without a reload. Shot selection and an open Camera preview are preserved, so Camera segments and path changes can be inspected as they arrive.

Single, quick writes do not need to interrupt the user. For multi-step work where the user should wait, MCP exposes an explicit visible session:

- `begin_live_edit`
- `update_live_edit`
- `end_live_edit`

`begin_live_edit` opens the native CUTTAlogue wait modal for one project and optional shot. `update_live_edit` changes its message and optional 0-100 progress. `end_live_edit` closes it. Agents must end sessions after both success and failure. Sessions expire after five minutes without an update so an interrupted MCP client cannot leave the editor locked.

A live session refuses to start when a current browser draft contains unsaved changes. This keeps MCP from silently replacing edits that exist only in the frontend. Direct writes remain revision-guarded as before; if an external revision appears while the browser is dirty, automatic application pauses instead of overwriting local state.

## Read-only tools

- list_projects
- get_project
- list_shots
- get_shot
- get_shot_direction
- get_camera_segments
- validate_camera_path
- evaluate_camera_path
- compile_shot_prompt
- get_project_warnings
- get_job_status

Every project result includes a SHA-256 content revision where applicable. Project identifiers are path-confined before any file access.

## Controlled-write tools

- create_shot
- update_shot_timing
- rename_shot
- add_camera_segment
- update_camera_segment
- remove_camera_segment
- assign_scene
- set_scene_anchor
- bind_camera_target
- assign_asset
- add_constraint
- compile_and_save_prompt
- cancel_job
- start_generation

Every write requires `expected_revision` from a fresh read. Write failures return MCP errors with structured `code` and `message` fields; revision conflicts additionally contain `expectedRevision` and `currentRevision`. Failed writes do not change the project. Writes hold a project-local inter-process lock across revision verification and use same-directory temporary files plus atomic replacement.

Camera segment times are shot-relative. Active segments must stay inside the shot and may touch but not overlap. Disabled draft segments may overlap. Segment mutations address the current start-time-sorted `segment_index`; add and update responses return the resulting sorted index. Removal is explicitly marked destructive in MCP tool metadata.

Scene writes only reference existing scenes. Anchors require finite 3D coordinates; renaming an anchor migrates bindings in shots assigned to that scene. Target bindings require an assigned scene and an existing anchor. Passing an empty scene or anchor id clears the corresponding assignment or binding.

Asset assignment only accepts existing project assets and the canonical optional roles `primary_character`, `supporting_character`, `environment`, and `prop`. Constraints are appended as trimmed authored text. `compile_and_save_prompt` runs the same deterministic H3 compiler as the browser, then persists that exact result under the same expected-revision guard.

`cancel_job` is an explicit destructive control. It requests cancellation only for queued or running jobs and reports `cancelRequested: false` for jobs that are already terminal. ComfyUI generation checks cancellation between preparation stages and on every polling cycle, then transitions the job to `cancelled`.

`start_generation` is the only MCP operation that starts external work. It is marked destructive and open-world, requires a fresh project revision, and derives the prompt, role-ordered references, stored seed, and optional extend-video configuration from persisted shot state. Read, validation, and prompt-compilation tools never start generation.

## Testing

The test uses the official SDK's in-memory client, with no subprocess or port:

    backend\.venv\Scripts\python.exe backend\tests\test_mcp_read_server.py

The controlled-write test suite is dependency-free:

    backend\.venv\Scripts\python.exe backend\tests\test_write_services.py
