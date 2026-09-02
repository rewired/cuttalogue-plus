# CUTTAlogue Plus Release Readiness

Status: integration hardening in progress  
Delivery model: tested feature branches into `main`
Protected baseline: `main`

## Automated release gate

Create the backend environment once with `start.ps1`, then run from the repository root:

    powershell -ExecutionPolicy Bypass -File scripts/test-fast.ps1

The fast gate runs every deterministic backend test except `test_alignment_smoke.py`, plus every frontend Node regression. The excluded test exercises the real TorchAudio MMS forced-alignment model and may download roughly 1 GB; run it manually after changes to the real model-facing alignment path:

    backend\.venv\Scripts\python.exe backend\tests\test_alignment_smoke.py

## Manual acceptance gate

Before merging to `main`:

1. Load a pre-Plus CUTTAlogue project and confirm it opens without an implicit save.
2. Import a PLY or SPLAT scene and an optional GLB blockout, assign the scene to two shots, and verify reuse.
3. Author representative static, push, pan, tilt, truck, pedestal, zoom, roll, tracking, and arc segments.
4. Open Shot Camera and Free View repeatedly, switch projects, and confirm playback remains synchronized without duplicate loops.
5. Scrub the timeline and preview in both directions; inspect paths, frusta, anchors, and unresolved-target diagnostics.
6. Compile and save a prompt, run an MCP read/edit/compile round trip, then verify a stale revision is rejected.
7. With a configured ComfyUI Pod and vocal track, explicitly start one generation, inspect its job, and cancel a second run.
8. Export Camera JSON and a project package; verify that authored Direction remains the source of truth.

## Recovery and migration

- Back up a project by copying its complete project directory while CUTTAlogue is stopped. Assets, audio, scenes, takes, exports, and `project.json` are project-relative.
- `project.draft.json` is legacy recovery input from pre-canonical-autosave releases. Open the app to review it; restoring it immediately queues a revision-guarded canonical autosave, and success removes the draft.
- Repository writes use a project-local `.project.lock`, same-directory temporary files, `fsync`, and atomic replacement. A stale `.project-*.tmp` file is never authoritative and may be removed only while the app is stopped and after `project.json` has been backed up.
- Old projects receive safe in-memory defaults for `scenes`, `sceneId`, `preview`, Camera optics, Lighting, Character fields, lyrics alignment, and subtitle offset. Loading alone does not rewrite the file; the next edit makes normalized migration durable through canonical autosave.
- MCP writes require the SHA-256 revision returned by a fresh read. On `revision_conflict`, discard the stale mutation, read again, and reapply intent through a narrow tool.

## Security and operational boundaries

- MCP is local STDIO. It is not an authenticated public network service.
- There is no generic project JSON writer. Writes are typed, revision-checked, path-confined, and atomically persisted.
- `start_generation` is the only MCP tool that starts external work. It is marked destructive/open-world and uses persisted shot state.
- Provider secrets remain in application settings and are never returned through MCP.
- Generation inputs must resolve inside the owning project directory. Path escapes are rejected before external submission.

## Known release limitations

- SPLAT preview uses point sprites rather than a full anisotropic Gaussian rasterizer.
- Scene calibration points are edited through controls; direct viewport manipulation remains open.
- Job state is in memory and does not survive a backend restart.
- MCP currently uses local STDIO only; authenticated Streamable HTTP is deferred.
- Large-scene GPU profiling and the real MMS alignment smoke remain manual release gates.
- The bundled H3 runtime is Reference-to-Video with a required vocal stem;
  Image-to-Video and first/last-frame adapters remain deferred.
- Extend is intentionally unavailable until a workflow with a tested
  continuation input is installed.
- Authored dialogue markers and multimodal video/audio subject references are
  planned in the H3 conformance roadmap and are not inferred from lyrics.

## H3 conformance addendum

Before merging an H3 conformance integration, run the focused frame, preflight,
workflow, lip-sync, generation-service, compiler-contract, and semantic-beat
tests listed in `docs/h3-conformance-roadmap.md`. A real configured ComfyUI
generation must confirm prompt, vocal, frame count, and image-reference order.


## Master merge gate

Merge release-scoped feature branches into `main` only when the fast suite, relevant real-model smoke, manual acceptance, and large-scene profiling are recorded as passing and the working tree is clean. Tag the resulting merge commit as the next CUTTAlogue Plus release candidate.
