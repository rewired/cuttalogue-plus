# CUTTAlogue Plus

A lean, local editor for planning *and generating* video shots against a song: listen to the mix and vocal stem in sync, lock shot boundaries to the musical grid, direct each shot with structured camera/character/prop tracks, compile that into a MiniMax H3 prompt, and generate the actual clip through a connected ComfyUI Pod - all from one project.

CUTTAlogue Plus adds an embedded spatial camera preview, reusable PLY/SPLAT/GLB scenes, deterministic Camera Direction evaluation, and a local controlled-write MCP interface. CUTTAlogue's workflow, colors, typography, and `shot.direction.camera` model remain authoritative.

Local first - everything runs on your machine, no cloud, no lock-in to a single generation backend beyond the ComfyUI workflow you point it at.

For background on architecture and design decisions, see [docs/musical-shot-editor.md](docs/musical-shot-editor.md), the [Plus integration roadmap](docs/cuttalogue-plus-roadmap.md), the [H3 conformance roadmap](docs/h3-conformance-roadmap.md), the [MCP guide](docs/mcp.md), and [release readiness](docs/release-readiness.md).

---

## Features

- **Musical timeline** - four synced tracks (Grid/Shots/Mix/Vocal), a configurable BPM/time-signature/offset grid, and manually-placed shot boundaries with live cut/render/overhang frame counts.
- **Asset library** - import images, video, and audio; each gets probed (FFprobe), thumbnailed, tagged, and classified (Location/Character/Prop, Full mix/Lip-sync, Motion guide) once for the whole project.
- **Structured Direction tab** - per shot, a Camera lane plus one lane per cast character (and per prop), each with real fields (movement/direction/amplitude/framing/target for camera; action/manner/gaze/expression for characters; before/after state for props) instead of a single free-text prompt.
- **Observable MCP editing** - controlled MCP writes appear in the open frontend within a second while preserving the selected shot and Camera preview; agents can open a native progress modal only for multi-step work where the user should wait.
- **Beats, cuts & Burst Mode** - segment boundaries across all lanes auto-derive a beat timeline; any beat can be marked a hard cut, splitting the shot into multiple `[Shot N]` compositions in the compiled prompt. **Burst Mode** bulk-populates a shot with evenly-spaced hard-cut beats and randomizes camera framing (and optionally subject pose) per beat - a fast way to explore poses/angles against a reference set.
- **Deterministic H3 compiler + optional AI expansion** - one click turns a shot's Direction data into MiniMax H3's six-section reference-generation prompt (`subject_definitions` / `summary` / `retention_analysis` / `detailed_description` / `overall_soundscape` / `non_diegetic_music`), with an optional "Expand with AI" pass that only elaborates the deterministic `detailed_description` - never inventing subjects, actions, or cuts that weren't authored.
- **Real generation, kept as takes** - each shot generates through a configured ComfyUI Pod running the actual `R2V_H3_V1` MiniMax H3 reference-to-video workflow; every run is kept as a new take (seed, status, video), never overwritten, with a one-click "promote to asset" to copy a take's video into the reusable asset pool.
- **Whole-project export** - a per-shot package (rendered `shot-XXX_<slug>-lip_sync.flac` or `.wav`, `shot.json`, `prompt.txt`, `notes.md`, copied assets) ready to hand off to further production steps.

---

## Getting started

A small Python/FastAPI backend serves the app and persists projects to disk (see [Backend](#backend) below). On Windows, start it from the repository root:

```powershell
.\start.ps1
```

The launcher creates the virtual environment and installs missing dependencies when needed. Once the server is ready, it opens `http://127.0.0.1:8000/` in the system's default browser.

For backend development, automatic Python reloads can be enabled explicitly with `.\start.ps1 -Reload`. The stable default intentionally avoids Uvicorn's reload worker because its console signaling can terminate the whole process tree on Windows.

1. Open the **☰** menu (top left of the header) and use **"Load mix"** to pick your music mix.
2. Optionally use **"Load vocal"** in the same menu to add the vocal stem.

Once the mix is loaded, the timeline appears with four synchronized tracks: **Grid**, **Shots**, **Mix**, **Vocal**.

Loading a mix/vocal file also copies it to the backend project folder in the background (needed for lip-sync export, see below) - but playback itself still needs the local file, so after a page refresh, reselect the mix/vocal files as before; tempo, video, shot-limit settings, and all shots persist automatically.

---

## Using the timeline

| Action | Control |
|---|---|
| Play / pause | Spacebar or the play button |
| Switch A/B (mix ↔ vocal) | Radio buttons in the transport bar |
| Zoom | Zoom slider in the transport bar |
| Scroll horizontally | Mouse wheel / trackpad gesture over the timeline |
| Set playback position | Click or drag on the grid, mix, or vocal track |

All four tracks (grid, shots, mix, vocal) always stay in sync - same zoom, same scroll range, shared playhead.

---

## Looping a region

Two draggable locators on the **Grid** track's ruler mark a loop region for playback:

- The **⟲** button (next to Play) turns looping on/off. First activation defaults the region to whichever shot the playhead is currently inside (or the next/last shot if it's in a gap or past everything) - not the whole project.
- Drag the region's edges to resize it, or drag its body to move the whole region.
- The **Grid / Events** toggle next to it controls what the locators snap to on release: the musical grid (default), or shot boundaries - the left locator snaps to shot starts, the right locator to shot ends.
- Loop points are saved with the project, same as shot boundaries.

---

## Tempo & grid

Click the **⚙** icon on the Grid track's label to open the Tempo/Video/Shot length flyout.

In the **Tempo** panel:

- **BPM** and **time signature** (numerator/denominator) are freely adjustable.
- **Grid offset**: use this if the song doesn't start exactly on beat one at second zero. **"Offset = Playhead"** sets the offset directly to the current playback position.
- **Grid**: Off, 1 beat, 1/2 bar, 1 bar, 2 bars, 1 second, or 1 frame. The chosen grid determines both the visible grid lines and what newly created or moved shot boundaries snap to.

In the **Video** panel:

- **FPS** of the target video (new projects default to 24 fps, matching MiniMax H3's internal rate; existing editorial rates remain readable).
- **H3 frame rule** is fixed to `17n+5` (`frameCount % 17 == 5`). The shot table and project export always round upward to the next legal count; older `free`, `4n+1`, or `8n+1` project values are migrated in memory and cannot drive a render.

In the **Shot length** panel:

- **Minimum** / **maximum** in seconds. Shots outside this range are color-coded in the timeline and the table (too short / too long) but nothing is blocked.

---

## Creating and editing shots

The shots track starts empty - no shot is created automatically. Shots don't have to form a continuous chain: a gap can remain between two shots (e.g. an intro that shouldn't appear in the shot list at all).

| Action | Control |
|---|---|
| Create a new shot | Drag on empty space in the shots track |
| Create/move without grid snap | Hold **Alt** while dragging |
| Select a shot | Click it - highlights the clip and its row in the table below, synced either direction |
| Split a shot | **Ctrl+click** inside an existing shot |
| Move a shot edge | Drag the edge of a shot |
| Merge two touching shots | Double-click their shared boundary |
| Delete a shot | Right-click the shot → "Delete shot" |

While dragging (creating or moving), the boundary only snaps to the selected grid on release - it follows the mouse freely during the drag itself.

Each shot's row in the table below shows: start, end, duration, status (too short / valid / too long), cut frames, H3 render frames, and the frame overhang. Double-click a shot's **#** in the table to rename it inline (Enter to confirm, Esc to cancel).

---

## Saving, naming & switching projects

Export, immediate-save, and project-switching controls live in the top-left menu. Normal editing does not require a save action.

- The text field in the header is the project's **name**. Names, tempo, video settings, shots, Direction data, prompts, notes, and asset metadata are canonically autosaved after a short quiet period. The header reports **Saving…**, **Saved**, or a retry state.
- **"Save now"** (or **Ctrl+S** anywhere) only flushes that same autosave queue immediately. It does not create a second manual-save state. Writes are atomic and revision guarded, so browser and MCP changes cannot silently overwrite one another.
- **"Projects ▾"** opens a list of every project on the backend (name, shot count, last saved) - click one to switch to it, or **"+ New project"** to start a blank one. The browser remembers whichever project it last opened and reloads it automatically on the next page visit.
- **"Export shots (JSON / CSV)"** exports just the shot list with calculated frame counts, e.g. for further use in H3 or an editing tool. It remains a plain client-side download.

---

## Assets

The top-level **Assets** tab (next to **Shots**, above the timeline) is the project's asset library - a master/detail view, not scoped to any shot:

- **"Add files"** imports images, videos, or audio - each gets copied into the project folder, probed with FFprobe (duration, dimensions, fps, codec, sample rate, channels), and given a thumbnail (images/video only).
- Every asset gets a **kind** right on its card - Location / Character / Prop for images, Full mix / Lip-sync for audio, Motion guide for video - fixed for that asset everywhere in the project (a person can't be a character in one shot and a location in the next). An asset must be classified before it can be assigned to a shot.
- Selecting a card opens the detail panel on the right with its tags (comma-separated; the filter box above the grid matches on tags) and, for images, a description field plus a **"Describe image"** button (see [Setup](#setup) below).
- Tags, kind, and descriptions live in the same canonically autosaved project state as prompts and notes; imported files themselves land on disk immediately.

Assigning an asset to a specific shot happens per-shot instead, in that shot's **Cast & Locations** tab (see below) - the library has no concept of "the selected shot". A generated take can also be promoted straight into this same pool (see **Generate**, below) - once promoted, it behaves like any imported file, including being usable as a reference image/video for other shots.

---

## Lyrics & Alignment

The top-level **Lyrics** tab turns pasted lyrics plus the project's vocal track into word-level timing, entirely locally (no cloud call, no cost) via a local forced-alignment model - given known text, it finds *where* each word occurs in the audio, it never transcribes/guesses what was sung.

- **Align to Vocal** runs the alignment (needs a vocal track already loaded; the first run on a machine downloads a ~1GB model). The result is a table of every word with its start/end time and a confidence score, plus two derived, read-only views: **Phrases** (one row per lyric line, spanning its first to last aligned word) and **Holds** (any single word whose aligned duration clears a configurable threshold - a likely sustained note). Both simply group/filter the same word timings; neither is a second source of truth.
- **Apply as Vocal Cues** (Add or Replace) turns the aligned words into real, persistent point markers on the main timeline - the one-way promotion from analysis to project data.
- The alignment result is saved with the project and restored instantly on reload - re-running the model is never required unless the lyrics text or the vocal file itself changed since the last alignment, in which case the tab says so and asks for an explicit re-align rather than silently reusing stale timing.
- **Export SRT** writes the current Phrase list out as a standard `.srt` subtitle file, independent of Shot boundaries. An **Offset** field (persisted with the project) shifts every subtitle's timing by a constant amount on export only - useful when the final rendered video has a fixed logo/preroll before the song starts, without touching the song-relative alignment/Phrase/cue/Shot timing itself.

### Getting good alignment results

Forced alignment is only as good as the correspondence between the pasted text and what's actually audible. Low-confidence words are highlighted (amber) in the Words, Phrases, and Holds tables - if a phrase's timing looks wrong (implausibly long or short), check whether its words are flagged before assuming the model is at fault. In practice:

- One sung line/phrase per text line - don't merge two sung phrases onto one line or split one phrase across two.
- Write out repeats in full (three "I'll come back."s as three lines, not "x3") - the aligner needs one text line per actual vocal occurrence.
- Include ad-libs and backing vocals as their own lines if they're clearly audible with their own timing; leave out lines that aren't actually sung (pure section labels, etc.).
- A stretch of low-confidence words usually means the audio in that span doesn't match the text closely enough (background vocals, an instrumental gap, an ad-libbed delivery) - fixing the source lyrics and re-aligning is the right move, not hand-editing a timestamp.

---

## Cast & Locations, Direction, Prompt, Notes, Generate (per shot)

Selecting a shot (click its row in the table, or the shot itself in the timeline - either stays in sync with the other) exposes five tabs to its right:

### Cast & Locations

The shot's assigned assets as chips. Click the trailing **"+"** tile to open the asset picker: a grid of every classified asset where clicking an unassigned tile assigns it and closes the picker immediately (unclassified assets show as unavailable until given a kind in the Assets tab). Click a chip's **×** to unassign it. Character assets also get a per-shot **role** (primary / supporting character) and locations get an environment role - these are per-shot, since the same character can lead one shot and support the next, unlike kind which is fixed for the asset everywhere.

### Direction

A structured, model-neutral director's timeline scoped to the shot's own duration - not a free-text prompt box. One draggable/resizable lane per track:

- **Camera** - each segment carries H3's real camera vocabulary: movement (zoom/pan/tilt/truck/track/arc/static/shake/roll/POV, etc.), direction, amplitude, framing, a target, and an optional transition into the next segment.
- **One lane per cast character** with an acting role (primary/supporting) - each segment has a structured action (walk/run/stop/sit/reach/drink/check phone/...), manner, gaze, and expression, plus a free-text notes field that always carries through regardless of whether the structured fields are set.
- **One lane per prop** - a prop's state over time (e.g. "on the table" → "held by Heather" → "on the table") *is* its before/after object state; holding is expressed by referencing the holding character directly rather than in prose.
- **Constraints** - short, chip-style continuity rules for the whole shot (e.g. "no bus", "same lighting throughout"), fed into the compiled prompt's limits section.

Drag a segment to move it, drag its edges to resize, click it to edit its fields in the panel below, or right-click it for **Split / Duplicate / Toggle enabled / Merge with next / Delete**. The **Snap: on/off** toggle controls whether dragging (or resizing) snaps to the grid ruler on release - same free-during-drag/snap-on-release behavior as the Shots track. The expand icon moves the same lanes into a large modal for more room - no separate view, just a reparent.

**Beats** are read-only ticks below the lanes, auto-derived as the union of every segment boundary across all tracks - not something you author directly. Click a beat to open its panel:

- **Hard cut before this beat** - marks this beat as the start of a brand-new `[Shot N]` composition in the compiled prompt (a hard cut) rather than a continuous evolution of the current one. A shot with no cuts marked compiles as one continuous `[Shot 1]`, exactly as before; marking any beat splits the compiled description into multiple hard-cut blocks, each stating its own duration, with matching "hard cuts only, no morphing" limits.
- **Intent / Priority / End state** - an optional note on what should be true by the end of that beat; woven into the compiled description, with priority stored for a future conflict/warning engine.

**Burst Mode** ("Burst…" button, above the Camera lane) is a bulk shortcut over the same hard-cut/beat mechanism: pick a beat length (as a fraction of a musical bar, seconds, or frames), and it replaces the shot's Camera lane with N evenly-spaced segments, each marked a hard cut - with checkboxes to also randomize the camera framing and/or (for any attached acting character) the pose per beat. Useful for quickly generating a burst of distinct, cleanly-cut compositions to explore poses/angles/framings against a reference set, or to pull a still frame from afterward.

### Prompt

**"Compile prompt"** deterministically serializes the shot's Direction data (camera/character/prop tracks, beats, cuts, constraints) into MiniMax H3's six-section reference-generation prompt format and writes the result here - nothing is invented, only what was explicitly authored is included. **"Expand with AI"** (needs the AI provider configured, see [Setup](#setup)) re-compiles the same five sections deterministically but sends only `detailed_description` to the configured chat model to elaborate toward H3's recommended 350-500 words, streaming the result in live. A word/character-count readout next to both buttons flags the 350-word gap either way. A **Seed** field holds the seed for the *next* generation in the Generate tab (leave it blank for a random one each time) - a completed take keeps a record of whichever seed it actually used, independent of whatever this field holds later.

Both actions enforce a hard 7,000-character cap on the assembled prompt (H3's own API limit) before writing into this field - going over it leaves the previous prompt untouched and explains why in the status line, instead of silently saving something the provider would reject anyway. "Expand with AI" is deliberately conservative: it's only allowed to make what's already stated more explicit (tighter camera/action mechanics, more precise spatial/timing detail), never to invent new subjects, actions, props, lighting, or decorative/sensory flourish (skin, reflections, atmosphere) beyond what the compiled description already says. It can be interrupted mid-stream with the **Cancel** button that appears next to its spinner while it's running.

### Notes

Free-text notes for that shot, round-tripped through the project JSON.

### Generate

Triggers video generation for this shot against a configured ComfyUI Pod (see [Setup](#setup)) and keeps every take rather than overwriting: each entry shows its seed, status, and (once done) an inline video player, with:

- **Set active** - marks which take represents this shot going forward (e.g. for export).
- **Use as asset** - copies that take's video into the project's asset pool (see [Assets](#assets)) so it can be assigned to any shot like an imported file, survives even if the take/shot it came from is later deleted, and can be picked as an **Extend** source (see below).
- **Delete** - removes the take.

Generating always adds a new take, even re-running with the same prompt. A video asset assigned to a shot can be put into **Extend** mode with a start-frame/frame-count range (a "last N frames" shortcut included) to continue from it - the UI and backend plumbing for this exist today, but the currently-wired `R2V_H3_V1` workflow (see [Setup](#setup)) doesn't yet have a continuation input to feed it, so Extend is inert until a workflow that supports it is wired in.

---

## Export

**Whole project** - the **☰** menu has an **"Export project"** button (plus an **"Include mix snippet"** checkbox). It builds the full per-shot export package from the product doc: unnamed shots use `export/shot-XXX/`, while named shots use `export/shot-XXX_<ascii-slug>/` (for example `shot-001_soenke-mag-baerbel/`). Each folder contains a matching `shot-XXX_<ascii-slug>-lip_sync.flac` or `.wav`, `shot.json` (the render manifest - frame counts, frame rule, audio format, assigned asset paths), `prompt.txt`, `notes.md`, copied assigned assets, and optionally `shot-XXX_<ascii-slug>-mix.flac` or `.wav`. For unnamed shots the `_slug` part is omitted. A floating task panel (bottom-right) tracks aggregate progress ("Shot 12 of 37") with a **Cancel** button; cancelling stops between shots (and mid-encode on the current one) without leaving a corrupted or partially-written shot folder behind.

Both need a vocal track already loaded (see above), and the mix track too if "Include mix snippet" is checked; export automatically flushes pending autosave changes first.

---

## Setup

The **"Setup"** button in the **☰** menu opens an application-wide settings dialog - separate from any project, stored locally on the backend and never written into a project's JSON or export.

**Audio render quality** controls the mono snippets used by both ComfyUI generation and per-shot project export. **FLAC** remains the default format; **WAV PCM 16-bit** and **WAV PCM 24-bit** are optional. The independently selectable sample rates are **32 kHz** (default for existing installs), **44.1 kHz**, and **48 kHz**.

**AI Provider** (optional image descriptions / prompt expansion):

- **API base URL** and **API key** for an OpenRouter-compatible chat completions API.
- **Default model**: used whenever a per-image request doesn't override it.
- **Test connection**: a quick round trip (`GET {base URL}/models`, then a tiny real completion if a default model is set) to confirm the key/URL/model work before relying on them.

With nothing configured, the rest of the app behaves exactly as before. Once configured, each **image** asset's card in the Assets tab gets a **Description** field plus a **"Describe image"** button (with an optional per-request model override). Clicking it sends that one image to the configured provider and streams the response straight into the description field as it arrives - one explicit action per image, never automatic or batched. Describe automatically flushes pending autosave changes so a newly imported asset is visible to the backend. The same provider also powers the Direction tab's **"Expand with AI"**.

**ComfyUI (Pod)** (per-shot video generation, see the **Generate** tab described above):

- **Pod base URL** - a ComfyUI instance running on a RunPod Pod (e.g. `https://<pod-id>-8188.proxy.runpod.net`). RunPod Serverless isn't supported yet.
- **API key** - stored, but not wired into any request yet. RunPod's HTTP proxy has no authentication of its own; how to secure it (a basic-auth sidecar, an SSH tunnel, or something else) is still an open decision.
- **Test connection**: checks that the Pod responds to `GET {base URL}/system_stats`.

The workflow actually submitted (`backend/app/workflows/R2V_H3_V1.json`, substituted per-request by `backend/app/comfy_workflow_template.py`) is the real MiniMax H3 "Reference to Video" ComfyUI graph - it takes the compiled prompt plus every reference image assigned to the shot and generates a clip through the model directly, not a placeholder. H3 has one fixed frame-count grid (`n % 17 == 5`, always at an internal 24fps) - shared frontend/backend frame math and `backend/app/frames.py`'s `h3_frame_count` round upward from the shot duration instead of trusting client-supplied or legacy project rules.

---

## Backend

A minimal FastAPI backend (`backend/`) replaces the old "download a JSON file" save/load with a real project folder on disk:

- `POST /api/projects` creates a new project folder + `project.json`. `GET /api/projects` lists every project (id, name, shot count, last-saved time) for the **Projects** picker.
- `GET /api/projects/{id}` / `PUT /api/projects/{id}` read/write it.
- `PUT` runs as a job (`GET /api/jobs/{jobId}` + `/events` for SSE progress) - the same job/SSE shape export, AI description, prompt expansion, and generation all reuse.
- `POST /api/projects/{id}/assets` imports one or more files into that project's `assets/` folder and returns their metadata/thumbnail descriptors; the frontend then canonically autosaves those descriptors into `project.json`.
- `POST /api/projects/{id}/shots/{shotId}/takes/{takeId}/promote-to-asset` copies a finished take's video into the asset pool the same way, under a new asset id, independent of the take/shot it came from.
- `POST /api/projects/{id}/audio/{track}` (`track` = `mix` or `vocal`) uploads the raw audio file itself to `audio/<track>.<ext>`.
- `POST /api/projects/{id}/export` runs the whole-project export as a job with aggregate SSE progress; `POST /api/jobs/{jobId}/cancel` requests cancellation, checked between shots and mid-`ffmpeg`-encode.
- `GET /api/settings` / `PUT /api/settings` read/write the application-level audio render preset plus provider connections - `providers.ai` (chat API) and `providers.comfy` (ComfyUI Pod) - in `backend/data/settings.json` (gitignored). API keys are never echoed back in the `GET` response, only whether one is saved.
- `POST /api/settings/test` makes a lightweight request against whichever provider (`ai` or `comfy`) is specified and reports whether it succeeded.
- `POST /api/projects/{id}/assets/{assetId}/describe` streams one image to the configured AI provider's chat completions endpoint (`stream: true`) and re-emits each token as a job event's `delta` field over the same SSE job shape, so the frontend can pour the response into the description field as it arrives.
- `POST /api/expand-description` streams the same way for the Direction tab's "Expand with AI" - stateless (text in, expanded text out), no project/asset lookup involved.
- `POST /api/projects/{id}/shots/{shotId}/generate` submits a generation job to the configured ComfyUI Pod (upload reference images, submit the real `R2V_H3_V1` workflow, poll for completion, download the result) over the same job/SSE shape; the resulting file lands under `shots/<shotId>/takes/<takeId>/output.mp4` in the project folder. Generation first flushes pending autosave changes, and the frontend canonically autosaves the returned take metadata.

Projects are stored under `backend/data/projects/<id>/` (gitignored) - `project.json`, `audio/`, `assets/<assetId>/`, `shots/<shotId>/takes/<takeId>/` (generated videos), `exports/scratch/` (single-shot export), and `export/` (whole-project export, rebuilt fresh on every run). Files are served straight off disk at `/project-files/<projectId>/<relativePath>`. The frontend keeps its current project id in the browser's `localStorage` and canonically autosaves changes to `project.json` with revision guards, atomic replacement, automatic retry, and a visible header status. Draft files are read only as a one-time migration path for sessions created by older releases.

Requires `ffprobe`/`ffmpeg` on `PATH` for asset metadata, thumbnails, and export. `ffmpeg` calls all run via a plain synchronous `subprocess.Popen` in a background thread rather than `asyncio.create_subprocess_exec` - the latter needs the Proactor event loop on Windows and raises `NotImplementedError` on Selector, which some `uvicorn --reload` worker processes end up on regardless of the policy set at startup.

---

## What the editor deliberately doesn't do

- No automatic shot or cut detection - all boundaries are set manually.
- No audio mixing (no gain, solo, mute, fades).
- No local rendering - video generation happens via a configured ComfyUI Pod (see [Setup](#setup)), not inside the app itself.

## Status

Early and actively evolving - the Direction tab, H3 compiler, and generation pipeline described above are real and working end-to-end against a configured ComfyUI Pod, but expect rough edges, missing validation, and design still settling in places (see the roadmap docs linked above for what's deliberately deferred).

Full details and roadmap: [docs/musical-shot-editor.md](docs/musical-shot-editor.md).
