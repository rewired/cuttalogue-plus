# CUTTAlogue Plus — Integration Release Notes

CUTTAlogue Plus embeds Shot Visualizer's camera mathematics, scene parsing, and WebGL preview into CUTTAlogue's existing workflow and visual language. CUTTAlogue remains authoritative for application styling and for `shot.direction.camera`; the visualizer is a derived preview, not a second animation editor.

## Added

- Native Shot Camera and Free View preview synchronized with the musical timeline.
- Deterministic camera interpretation and backend/browser parity for semantic Camera Direction.
- PLY, SPLAT, and GLB scene ingestion; reusable scenes, default cameras, motion calibration, named anchors, and per-shot target bindings.
- Versioned Camera JSON export and canonical H3 prompt compilation through one browser compiler.
- Local STDIO MCP server with eleven read tools and controlled Shot, Camera, scene, asset, constraint, prompt, generation, and job operations.
- Revision-guarded MCP import for explicit local asset files and structured per-character performance authoring, including singing and lip-sync.
- New projects and empty frame-rate inputs default to 24 fps; existing project frame rates remain unchanged.
- SHA-256 expected revisions, structured conflicts, project-local inter-process locks, and atomic project writes.
- Explicit generation startup from persisted shot state and effective cancellation checks throughout the ComfyUI polling path.

## Compatibility

Existing CUTTAlogue projects load with safe defaults and are not rewritten merely by opening them. CUTTAlogue's palette, typography, spacing, and chrome remain authoritative; Shot Visualizer branding and colors are not imported.

## Upgrade notes

Work from a copy of important project directories until release acceptance is complete. Review [release readiness](release-readiness.md), [MCP operation](mcp.md), and the [integration roadmap](cuttalogue-plus-roadmap.md) before merging a release-scoped feature branch into `main`.
