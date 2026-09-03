# CUTTAlogue Plus Integration Roadmap

Status: implementation in progress
Baseline: CUTTAlogue commit `ec19f2e`  
Default branch: `main`; changes land through focused feature branches.

## 1. Product vision

CUTTAlogue Plus combines CUTTAlogue's musical shot planning and prompt-direction workflow with Shot Visualizer's spatial camera preview. It remains one local-first application with one project model, one playback clock, and one authoritative camera-direction representation.

CUTTAlogue is authoritative in two distinct ways:

1. `shot.direction.camera` is the source of truth for camera animation. The visualizer renders a derived path and does not introduce a competing editable keyframe timeline.
2. CUTTAlogue owns the product's visual language. The embedded preview adopts CUTTAlogue's colors, typography, spacing, controls, and application chrome. Shot Visualizer contributes renderer, camera mathematics, parsers, and useful interaction patterns, not a competing palette or brand.

The intended workflow is:

1. Select or create a shot on the musical timeline.
2. Author camera segments in the Direction tab.
3. A deterministic interpreter converts the semantic segments into a spatial path.
4. The embedded visualizer renders the path against a Gaussian splat and optional GLB blockout.
5. Audio, playhead, Direction lanes, and 3D preview remain synchronized.
6. The same evaluated path is available to validation, export, and MCP clients.

MCP exposes the same domain operations used by the browser UI. It must never become a second, less-safe way to edit `project.json`.

## Implementation status

- Phase 0 is complete: the fork, baseline tag, integration branch, and this roadmap exist.
- Phase 1 is complete for the initial deterministic camera vocabulary and regression coverage.
- Phase 2 is substantially implemented: the native CUTTAlogue WebGL workspace has shared transport, an orbitable and pannable Free View, an animated Shot Camera frustum, automatic translucent environment-image mood cards, and explicit GPU resource disposal. Direct viewport manipulation of scene anchors remains open.
- Phase 3 is substantially implemented: PLY/SPLAT/GLB ingestion, reusable scene persistence, backwards-compatible normalization, per-shot scene assignment, scene-default camera and motion calibration, named anchors, per-shot target bindings, concrete unresolved-target diagnostics, and initial geometry rendering are implemented. SPLAT currently uses a point-sprite preview; a full anisotropic Gaussian rasterizer and direct viewport manipulation of calibration points remain open.
- Phase 4 has started: preview compilation and deterministic, versioned Camera JSON export now share one application-service boundary. Broader authoring synchronization remains open.
- Phase 5 is substantially implemented: canonical reads and atomic, revision-guarded writes pass through path-confined repositories and transport-neutral services. The browser now uses debounced canonical autosave with serialized writes, automatic retry, revision conflicts, visible status, and an MCP-ready handshake; legacy drafts remain read-only migration input.
- Phase 6's read-only milestone is complete: an official MCP-v2 STDIO server exposes all eleven planned Project/Shot/Direction/camera/prompt/job tools through shared services and is tested with the SDK's in-memory client. Controlled writes remain deferred to Phase 7.
- Phase 7 is functionally complete: typed Shot and Camera Direction writes, spatial scene calibration, asset assignment, authored constraints, canonical compile-and-save, revision-checked explicit generation, and job cancellation share domain services with structured conflicts and MCP mutation metadata. A shot can be spatially directed, compiled, generated, inspected, and cancelled without raw JSON access; Phase 8 hardening remains.
- Phase 8 has started: the integrated deterministic fast release gate passes all 16 local backend suites and all 22 frontend suites; recovery, migration, security boundaries, known limitations, manual acceptance, and initial release notes are documented. Real-model alignment smoke, large-scene profiling, and recorded manual acceptance remain before the next release merge into `main`.

## 2. Guiding principles

### 2.1 Direction data is authoritative

Spatial camera samples are derived data. They may be cached, but must be reproducible from camera segments, shot duration, scene calibration, named anchors, and interpreter profile version.

### 2.2 Semantic intent and spatial calibration are separate

Current segments express movement, direction, amplitude, speed, framing, target, focal length, depth of field, focus target, and transition. They do not define a unique world-space path. A narrow calibration layer therefore supplies the initial camera, scene scale, semantic motion magnitudes, and named 3D targets without replacing semantic authoring.

### 2.3 CUTTAlogue owns the product experience

Imported code must not bring over Shot Visualizer's dark lime palette, standalone top bar, brand mark, typography, or unrelated layout conventions. New preview controls use CUTTAlogue tokens and component patterns.

### 2.4 One service layer for every client

The browser UI, REST endpoints, background jobs, exports, and MCP server call the same validated application services. Direct JSON mutation is prohibited outside the persistence adapter.

### 2.5 Local, deterministic, and compatible

The combined application keeps CUTTAlogue's project folders and single FastAPI process. The standalone Node server disappears. Interpretation is deterministic and testable. Existing projects load with safe defaults and upgrade only on explicit save.

## 3. Scope

### In scope

- Embed the Shot Visualizer renderer as a native CUTTAlogue component.
- Support PLY, SPLAT, and GLB scene assets.
- Convert Camera-lane segments into deterministic poses over time.
- Synchronize preview, shot playback, project audio, and Direction state.
- Add scene calibration, named anchors, diagnostics, and camera export.
- Add a shared application-service layer.
- Add local read and controlled-write MCP tools.

### Initially out of scope

- Replacing the Direction lane with a conventional keyframe editor.
- Lossless conversion of arbitrary curves back to natural-language direction.
- Full scene editing, modelling, rigging, or character animation.
- Physically accurate depth-of-field rendering.
- Multi-user editing.
- Public Internet exposure of the local MCP server.
- Re-theming CUTTAlogue to resemble Shot Visualizer.

## 4. Target architecture

```text
Browser UI
  |-- Timeline, audio, Direction and prompts
  |-- Embedded 3D preview
  `-- Project and asset management
                  |
                  v
CUTTAlogue application services
  |-- Project / Shot / Direction / Scene
  |-- CameraPath / Prompt / Export
  `-- Generation / Jobs
           |                 |
           v                 v
      FastAPI adapters    MCP adapters
           |                 |
           `--------+--------'
                    v
       Project repository and project files
```

The camera path implementation has a compiler that normalizes segments into a compact plan and an evaluator that returns pose and lens values at time `t`. Neither depends on DOM, WebGL, or persistence.

## 5. Data ownership and schema

Project-level scenes can be reused by multiple shots. Direction and optional calibration overrides belong to the shot. Evaluated frame samples are never persisted as authored state.

```json
{
  "version": 2,
  "scenes": [{
    "id": "scene-main-stage",
    "splatAssetId": "asset-splat-1",
    "blockoutAssetId": "asset-glb-1",
    "unitsPerMeter": 1,
    "defaultCamera": {
      "position": [0, 1.6, 4],
      "target": [0, 1.5, 0],
      "focalLengthMm": 35
    },
    "anchors": {
      "performer": { "position": [0, 1.5, 0] },
      "face": { "position": [0, 1.7, 0] }
    },
    "motionProfile": {
      "smallDistanceMeters": 0.5,
      "largeDistanceMeters": 2,
      "smallAngleDegrees": 10,
      "largeAngleDegrees": 45
    }
  }],
  "shots": [{
    "id": 1,
    "sceneId": "scene-main-stage",
    "direction": { "camera": [] },
    "preview": {
      "initialCameraOverride": null,
      "targetBindings": {},
      "interpreterProfile": "cinematic-v1"
    }
  }]
}
```

The asset pipeline recognizes PLY/SPLAT as point-cloud or Gaussian-splat scenes and GLB as blockout geometry. FFprobe and media thumbnails are skipped where inapplicable. Normalization defaults `scenes`, `sceneId`, and `preview` for older projects. Service boundaries reject non-finite coordinates, invalid references, and unsupported profiles.

## 6. Camera interpretation contract

At any valid shot-relative time the evaluator returns position, rotation quaternion, focal length, focus distance, active segment, and warnings.

| Direction movement | Initial spatial interpretation |
|---|---|
| `zoom_in`, `zoom_out` | Change focal length without translation. |
| `push_in`, `pull_out` | Translate along camera forward. |
| `pan` | Rotate yaw while preserving position. |
| `tilt_up`, `tilt_down` | Rotate pitch while preserving position. |
| `truck` | Translate along camera right; direction selects sign. |
| `pedestal_up`, `pedestal_down` | Translate along calibrated scene up. |
| `tracking_shot` | Move relative to a target while maintaining composition. |
| `arc_shot` | Orbit around a resolved target. |
| `static_shot` | Preserve the current pose. |
| `shake_slightly`, `shake_strongly` | Add deterministic procedural offsets. |
| `pov` | Apply a profile-specific handheld pose. |
| `roll_cw`, `roll_ccw` | Rotate around camera forward. |

Amplitude selects a calibrated magnitude without changing duration. Speed controls interpolation inside the authored range. Target resolution uses explicit shot binding, scene anchor, assigned subject/prop, scene default, then a warned camera-forward fallback. `target` and `focusTarget` remain independent.

Adjacent segments inherit the previous end pose. Disabled segments are ignored, gaps hold, overlaps are validation errors, and hard cuts never interpolate across their boundary.

## 7. User experience

The Direction tab receives a `Preview camera` action that opens an expanded native CUTTAlogue workspace. It is not an iframe and does not recreate Shot Visualizer's standalone header or sidebar.

Project audio remains controlled by CUTTAlogue. Preview time is shot-relative while the main playhead stays project-relative. Scrubbing either view updates the shared playhead, and the active Camera segment is highlighted.

Preview modes are Shot Camera, Free View, Path Overlay, and Diagnostics. Free View can inspect paths, frusta, anchors, and geometry but does not directly replace semantic direction. Calibration can assign scenes, set a default camera, place anchors, bind target names, adjust semantic motion magnitudes, and reset overrides.

### Visual integration requirements

- CUTTAlogue color variables and component patterns are authoritative.
- The viewport may use scene and diagnostic colors, but its surrounding UI uses CUTTAlogue styling.
- Shot Visualizer's lime accent, dark panel theme, branding, top bar, and typography are not imported.
- Preview controls look native beside existing Direction, Prompt, and Generate controls.
- Focus, hover, disabled, warning, and error states follow CUTTAlogue conventions.
- New layouts remain usable at CUTTAlogue's current breakpoints.

## 8. Export

The first camera export is versioned JSON containing frame samples at a declared FPS, output framing, interpreter profile, source segment references, and warnings. Whole-project export may add `camera.json`, optional `camera-preview.webm`, and `camera-warnings.json` to each shot package.

The implemented version-1 export identifies `shot.direction.camera` as its authoritative source. A non-frame-aligned shot endpoint is included as an explicit `endpoint` sample with `frame: null`, rather than being mislabeled as a regular sample at the declared FPS.

The H3 prompt compiler remains independent. Camera export supplements the prompt and never silently changes prompt wording.

## 9. Application-service extraction

MCP requires explicit command boundaries, so service extraction proceeds incrementally. Initial services cover projects, shots, direction segments, scenes, camera evaluation, prompt compilation, assets, exports, generation, and jobs.

Each mutating command returns the updated entity and project revision. Persistence uses atomic replacement of `project.json`. Commands validate identifiers, timing, asset ownership, paths, and expected revision before writing.

```text
Browser UI ----+
FastAPI -------+--> validated application services --> persistence/jobs
MCP -----------+
```

## 10. MCP interface

### Transport strategy

The first implementation is a local STDIO MCP server launched by a Codex host. A later Streamable HTTP adapter may expose the same services to authenticated remote clients. Transport code remains separate from domain services.

### Read-only milestone

- `list_projects`
- `get_project`
- `list_shots`
- `get_shot`
- `get_shot_direction`
- `get_camera_segments`
- `validate_camera_path`
- `evaluate_camera_path`
- `compile_shot_prompt`
- `get_project_warnings`
- `get_job_status`

Large project and frame payloads use MCP resources or pagination rather than oversized tool responses.

### Controlled-write milestone

- `create_shot`
- `update_shot_timing`
- `rename_shot`
- `add_camera_segment`
- `update_camera_segment`
- `remove_camera_segment`
- `assign_scene`
- `set_scene_anchor`
- `bind_camera_target`
- `assign_asset`
- `add_constraint`
- `compile_and_save_prompt`
- `start_generation`
- `cancel_job`

There is no generic `write_project_json` tool.

### Safety and concurrency

- Mutating tools require an expected project revision.
- Stale writes fail and return the current revision.
- File paths are project-relative and confined beneath the owning project.
- Provider secrets are never returned through MCP.
- Generation and exports reuse cancellable jobs.
- Tool metadata distinguishes reads, edits, destructive actions, and expensive external jobs.
- Server instructions require inspection and validation before narrow mutations and forbid implicit external generation.

## 11. Delivery phases and acceptance criteria

### Phase 0 — Fork and documentation

Deliver the history-preserving fork, baseline tag, integration branch, and this roadmap. The original repositories remain unchanged and `upstream` points to CUTTAlogue.

### Phase 1 — Camera interpreter foundation

Deliver pure camera math, normalized path plans, deterministic mappings for static, pan, tilt, push, pull, truck, pedestal, zoom, and roll, plus unit tests.

Acceptance:

- identical inputs produce byte-equivalent rounded output;
- the module runs without DOM or WebGL;
- empty direction produces a stable default pose;
- invalid inputs produce warnings rather than crashes.

### Phase 2 — Embedded renderer

Deliver a lifecycle-managed renderer, expanded Preview workspace, Shot/Free views, path and frustum overlays, a preview-only environment-image mood card, and cleanup on close or project switch.

Acceptance:

- repeated opening creates no duplicate animation loops or listeners;
- project switching releases obsolete GPU resources;
- preview follows the selected shot;
- Free View supports mouse orbit, Shift-drag pan, wheel zoom, and a visible animated Shot Camera frustum;
- a shot's environment image can appear as a configurable translucent 3D mood card without affecting prompts or generation;
- all surrounding controls use CUTTAlogue's visual system;
- no standalone Shot Visualizer palette, branding, or app chrome remains.

### Phase 3 — Scene assets and calibration

Deliver PLY/SPLAT/GLB ingestion, reusable scenes, shot assignment, default camera, anchors, target binding, motion profiles, and migration tests. Acceptance includes path confinement, backwards-compatible project loading, scene reuse, and visible unresolved-target diagnostics.

### Phase 4 — Playback and authoring integration

Deliver shared playhead/audio synchronization, active-segment highlighting, live invalidation, cut handling, diagnostics, and camera JSON export. Acceptance requires synchronization within one project frame and no interpolation across cuts.

### Phase 5 — Shared service layer

Deliver project revisions, validated services, FastAPI adapters, and atomic persistence. UI and API remain compatible, stale writes are rejected, and adapters perform no ad-hoc mutation.

### Phase 6 — Read-only MCP

Deliver the local STDIO server, read tools, resources for large data, project-scoped configuration example, and disposable-project integration tests. Reads must not modify project files or timestamps.

### Phase 7 — Controlled-write MCP

Deliver typed write tools, revision enforcement, structured errors, and explicit generation controls. An agent can direct a shot without raw JSON access, stale writes fail safely, and external jobs never start implicitly.

### Phase 8 — Hardening and release

Deliver end-to-end fixtures, large-scene profiling, recovery and migration documentation, user documentation, release notes, and optionally authenticated Streamable HTTP MCP.

## 12. Branching and integration strategy

Primary branch:

- `main`: canonical CUTTAlogue Plus product line and merge target.
- `integration/*`: retained milestone branches, not competing product baselines.

Short-lived branches:

- `docs/*` for architecture and developer documentation;
- `feature/camera-interpreter` for planning and evaluation;
- `feature/embedded-visualizer` for renderer lifecycle and UI;
- `feature/scene-assets` for ingestion and persistence;
- `feature/preview-sync` for transport integration;
- `feature/service-layer` for domain operations;
- `feature/mcp-read` and `feature/mcp-write` for MCP milestones.

Each new branch starts from `main`, keeps commits focused, includes proportional tests, updates changed contracts, and merges only after focused verification.

The standalone Shot Visualizer is an implementation donor, not a subtree with an independent runtime or identity. Math, parsing, renderer, and interaction logic move in coherent units and are adapted to CUTTAlogue lifecycle and styling.

## 13. Verification strategy

Unit tests cover camera math, movement mapping, target resolution, parsing, migrations, services, and revision conflicts. Browser tests cover renderer lifecycle, preview selection, shared playback, scene switching, diagnostics, and style integration. Backend tests cover 3D ingestion, path confinement, atomic persistence, jobs, and MCP parity.

Manual acceptance covers loading an old project, sharing a scene across shots, authoring representative movements, synchronized scrubbing, camera export, an MCP read/edit round trip, and safe rejection of a stale write.

## 14. Principal risks and mitigations

- **Semantic ambiguity:** versioned profiles, explicit calibration, and visible fallbacks.
- **Duplicate state:** persist direction and calibration, never derived keyframes.
- **Renderer leaks:** explicit create, resize, setScene, setPath, and dispose lifecycle.
- **Large scenes:** limits, GPU cleanup, and progressive loading where feasible.
- **MCP bypass:** typed services, revisions, path confinement, and no generic writer.
- **Cross-runtime divergence:** one canonical evaluator plus parity fixtures.
- **Visual inconsistency:** CUTTAlogue CSS and UI patterns are the acceptance baseline.

## 15. First integrated milestone

The first milestone is complete when a user can select a CUTTAlogue shot, author static, push, pan, tilt, truck, pedestal, zoom, and roll segments, open an embedded Shot/Free preview styled as CUTTAlogue, and watch a deterministic path synchronized to the shot duration. A bundled demo scene and default calibration are sufficient; scene import, target anchors, export, and MCP writes follow later.

This proves the core proposition: camera direction authored for the prompt can be seen as motion without creating a competing animation model or application identity.
