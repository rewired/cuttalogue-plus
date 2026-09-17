# CUTTAlogue — Implementation Roadmap

## Starting point

The current app (`index.html`, `js/`, `css/`) already ships the full timeline editor as a client-only tool: synchronized mix/vocal playback, musical grid, shot create/split/move/merge/delete with snap, min/max length feedback, H3 frame-rule math, and JSON/CSV export/import — all in the browser, no backend. See [musical-shot-editor.md](musical-shot-editor.md) for the full spec of that layer.

CUTTAlogue (see the product doc) extends this into asset management, a Python backend, FFmpeg export packages, and optional AI assistance. That is a large jump from a static page to a full local application. This document re-cuts that jump into slices that are each independently shippable and testable, instead of the four broad phases in the original sequence.

Rule for every slice below: it must leave the app in a state that is strictly more useful than before, without requiring the next slice to be usable.

---

## Phase 1 — Shot list / context panel shell

Frontend only. No backend, no new dependencies.

Restructure the lower work area from the current single view into:

- shot list (left),
- context panel (right) with `[Shot] [Assets]` tabs.

The `Assets` tab can be an empty placeholder (`"No assets yet"`). The `Shot` tab shows what already exists today (timing, duration, cut/render frames, overhang) plus new empty `prompt` and `notes` fields, persisted in the existing project JSON.

**Why this size:** it's a pure layout/data-model change. It gives every later phase a place to render into, without coupling UI work to backend work.

**Acceptance:** selecting a shot in the list focuses it in the timeline (already true) and shows it in the new Shot tab; prompt/notes round-trip through save/load JSON.

---

## Phase 2 — Backend bootstrap

Introduce FastAPI, but only to replace the current "download a JSON file" save/load with a real project folder on disk. No assets, no export, no FFmpeg yet.

- `POST /api/projects` — create project folder + `project.json`
- `GET /api/projects/{id}` / `PUT /api/projects/{id}` — read/write project JSON
- Static serving of `index.html`/`js`/`css` from the same process (or documented as still-separate; either is fine, but decide once)

This is also where the job/SSE pattern gets established, on the simplest possible operation (`GET /api/jobs/{jobId}` + `/events` around a trivial "save" job), so later phases (export, describe) reuse a pattern that's already proven rather than inventing it under load.

**Why this size:** it isolates "does the backend plumbing work" from "does the backend do anything domain-specific." Bugs in routing, CORS, file I/O, and SSE surface here, cheaply.

**Acceptance:** a project can be created, edited in the browser, saved to disk via the backend, and reloaded after a full page refresh — audio files still need to be reselected, as in the current MVP.

---

## Phase 3 — Asset pool

Now that a project folder and backend exist, add:

- import images/videos/audio into `assets/` under the project folder,
- FFprobe metadata extraction (duration, width, height, fps, codec, sample rate, channels),
- thumbnail generation for images/video,
- tags (plain strings, filterable),
- preview in the Assets tab from Phase 1,
- manual assignment to the selected shot (assign/remove), click-based — drag-and-drop is optional, not required.

**Why this size:** it's the first phase that touches the filesystem and FFprobe, but still has zero interaction with export or FFmpeg encoding. Metadata extraction and file copying can be validated independently of the export pipeline.

**Acceptance:** import a handful of mixed-type files, tag them, assign two to a shot, reload the project, confirm assignments and tags persisted.

---

## Phase 4 — Audio export

Split from the original single "Export" phase because FFmpeg encoding and folder/manifest structure are separable risks.

### 4a — lip-sync export only

For one selected shot (not the whole project yet): generate `shot-XXX_<slug>-lip_sync.flac` (32 kHz mono FLAC, H3 render duration including overhang) into a scratch/output location, with real FFmpeg progress via `-progress pipe:1` reported through the job/SSE pattern from Phase 2.

**Why first:** this is the actual novel, error-prone part (`-ss`/`-t` math against render duration, not cut duration). Proving it on one shot avoids debugging FFmpeg edge cases inside a 37-shot batch loop.

### 4b — full export package

Extend 4a to the whole project: per-shot folders, `shot.json` manifest, copied assets, `prompt.txt`/`notes.md`, optional `shot-XXX_<slug>-mix.flac` when enabled, aggregate progress ("Shot 12 of 37") in the shared task panel, cancel support.

**Acceptance (4b):** exporting a project with several shots and mixed assets produces the folder structure from the product doc, matches the manifest schema, and can be cancelled mid-run without leaving the project state corrupted.

---

## Phase 5 — Setup page & optional AI description

- application-level setup page (separate from project data),
- local credential storage, never written into project JSON or exports,
- connection test,
- `[Describe image]` action on a single selected image, streamed response into the editable description field.

**Why last:** it's fully optional per the product doc's own rules, has no dependency from any earlier phase, and touches external network calls — the highest-uncertainty, lowest-risk-if-delayed piece.

**Acceptance:** with no provider configured, nothing in the rest of the app changes behavior; with one configured, describing an image streams text into the field without overwriting manually entered text.

---

## Deferred (outlook only, not scheduled)

Unchanged from the product doc: ComfyUI server connection, workflow submission, queue/progress in the shared task panel. Starts only once Phase 4 is stable and only as an addition, not a prerequisite for anything above.

---

## Net effect of the re-cut

Original sequence bundled "backend exists" + "assets work" into one phase, and "FFmpeg works" + "folder structure works" + "progress reporting works" into another. Both bundles mixed a plumbing risk with a domain-logic risk. Splitting them (Phase 2 vs. 3, Phase 4a vs. 4b) means each slice has one new kind of failure to debug at a time, and Phase 1 gives every later phase a UI slot to land in instead of requiring a layout change alongside new functionality.
