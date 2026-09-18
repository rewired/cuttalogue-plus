# CUTTAlogue

> Historical concept note: configurable `free`, `4n+1`, and `8n+1` examples below are superseded in CUTTAlogue Plus by MiniMax H3's fixed `17n+5` render lattice at 24 fps.

## Product name

**CUTTAlogue**

The name combines three ideas:

- **cut** — shot and scene planning,
- **catalogue** — organizing project assets,
- **dialogue** — deliberate collaboration between the user and optional AI assistance.

Technical naming:

```text
Product name:  CUTTAlogue
Repository:    cuttalogue
Package name:  cuttalogue
Project file:  .cuttalogue.json
```

## Tagline

The tagline is intentionally still open.

Current candidates:

```text
Plan the shots. Guide the machine.
```

```text
Cut. Plan. Ship.
```

No tagline is considered final yet.

---

# Product definition

CUTTAlogue is a local browser-based production planning tool for music-driven video projects.

It combines:

- musical shot planning,
- H3-compatible frame calculations,
- project asset organization,
- manual assignment of assets to shots,
- optional AI-assisted image descriptions,
- clean per-shot export packages.

CUTTAlogue is not a video editor, not a DAW, and not a ComfyUI replacement.

Its purpose is to prepare material so downstream tools can consume it directly.

> Plan shots, assign material, and export production-ready shot packages.

---

# Core principles

## Assistance, not autopilot

The application may surface information and provide optional assistance, but it must not decide where shots begin or end.

It should:

- make musical structure visible,
- show vocal gaps as orientation,
- let the user define shot ranges manually,
- check shot lengths,
- calculate H3-compatible render lengths,
- organize project media,
- prepare export packages.

It should not:

- generate a complete shot plan automatically,
- move shot boundaries without explicit user action,
- make automatic edit decisions,
- turn into an autonomous video agent.

## Local first

Project files and media remain local.

Remote services are optional and only used when the user explicitly requests them, for example when asking an external vision model to describe an image.

Application-level connections and API credentials are configured separately from project data. Secrets must never be written into project files or exported shot packages.

## YAGNI

Only features required by the current production workflow should be built.

No speculative plugin system, node graph, database, distributed worker setup, or video editing environment.

## Direct manipulation

The editor should favor:

- clicking,
- dragging,
- moving,
- resizing,
- selecting,
- visible feedback.

Avoid hidden automation and modal workflows where direct interaction is possible.

---

# Current editor foundation

## Technology

Frontend:

- HTML
- CSS
- Vanilla JavaScript
- WaveSurfer.js

Backend:

- Python
- FastAPI
- FFmpeg
- FFprobe
- Server-Sent Events for progress reporting

No frontend framework is required for the initial versions.

---

# Timeline structure

The timeline hierarchy is fixed:

```text
Grid
|----- Bar -----|----- Bar -----|----- Bar -----|

Shots
[------ Shot 1 ------]      [-------- Shot 2 --------]

Mix
████████▂▁▁████████████▂▁████████████████

Vocal
▁▁▁█████▂▁▁▁▁▆█████▂▁▁▁▁▁▅██████████
```

The hierarchy is intentional:

1. The musical grid provides timing orientation.
2. The shot track is the main editing layer.
3. Mix and vocal waveforms provide visual reference.
4. Both waveforms are displayed at the same height.

---

# WaveSurfer components

## Multitrack

Used for:

- synchronized mix and vocal display,
- shared playback position,
- shared seeking,
- shared zoom,
- shared horizontal scrolling.

## Timeline plugin

Used for:

- musical grid,
- beat and bar markers,
- formatted labels,
- second-based grid,
- frame-based grid.

## Regions plugin

Used for:

- shot ranges,
- draggable shot regions,
- independently movable edges,
- region splitting,
- region deletion,
- region merging.

## Hover plugin

Used for cursor feedback such as:

```text
01:23.440
Frame 2086
Bar 61 · Beat 2
```

For the MVP, this is sufficient:

```text
01:23.440 · F2086
```

## Silence example

Used only to visualize quiet sections in the vocal stem.

It may help reveal possible cut locations, but it must not create shots automatically.

---

# Timeline navigation

## Zoom

One zoom control affects all timeline tracks.

## Horizontal scrolling

All tracks scroll together.

## Seeking

Clicking or dragging on the mix or vocal waveform changes playback position.

Clicking the shot track edits shots instead of seeking.

## Shot list navigation

Clicking a shot in the shot list:

1. selects the shot,
2. highlights it in the timeline,
3. scrolls it into view,
4. focuses the visible timeline around it.

The editor should not aggressively change zoom on every selection. It should only zoom when the shot cannot be displayed meaningfully at the current level.

---

# Audio

## Project audio

Each project can load:

- **A: Mix**
- **B: Vocal stem**

Only one track plays at a time:

```text
[A Mix] [B Vocal]
```

There is no gain control, solo mode, mute system, fade system, or mixer.

The mix is useful for musical orientation.

The vocal stem is useful for:

- identifying sung phrases,
- identifying pauses,
- preparing lip-sync audio.

## Out of scope

- no gain
- no solo
- no mute
- no fade in/out
- no mixing
- no audio effects
- no differently sized tracks
- no DAW features

---

# Musical grid

## Inputs

- BPM
- time signature
- grid offset
- grid subdivision

Example:

```text
BPM:         180
Time sig:    4/4
Grid:        1 beat
Grid offset: 0.000 s
```

## Calculation

```text
beatDuration = 60 / BPM
barDuration  = beatDuration × numerator
```

## Grid options

Initial grid options:

- Off
- 1 beat
- 1/2 bar
- 1 bar
- 2 bars
- 1 second
- 1 frame

Second- and frame-based grids are independent of tempo.

## Grid offset

A song does not necessarily begin exactly on bar one at time zero.

The editor therefore supports a grid offset.

Optional convenience action:

```text
Set bar 1 / beat 1 to the playhead
```

## Snapping

Shot creation and edge movement snap to the active grid.

Holding `Alt` during a drag disables snapping for that action.

Snapping occurs on release rather than during every mouse movement.

During dragging, the UI should show the future snap destination as visual feedback.

Example:

```text
Current edge:  00:32.541
Snap target:   00:32.667
```

---

# Shots

## Shot model

Shots are independent, sorted, non-overlapping time ranges.

They do not need to form a continuous chain.

Gaps are allowed:

```text
Shot 1: 00:00.000 – 00:09.640

        gap, no shot

Shot 2: 00:12.000 – 00:20.640
```

No shot is created automatically when audio is loaded.

## Interactions

- Drag on empty shot-track space to create a new shot.
- Click inside an existing shot to split it.
- Drag either edge independently.
- Move an entire shot by dragging it.
- Hold `Alt` to bypass snapping.
- Right-click a shot to delete it.
- Double-click a shared boundary to merge touching shots.
- Prevent overlap with neighboring shots.
- Clamp movement to timeline bounds.

## Visual feedback

During drag or resize, show:

```text
10.667 s
267 cut frames
273 H3 render frames
+6 frames
```

Selection and validation must use separate visual signals:

- selection: clear outline or highlight,
- valid duration: green status indicator,
- too short: warning indicator,
- too long: error indicator.

A valid shot should not simply become a large green block, because selection, validity, export state, and completion must remain visually distinct.

## Shot duration limits

Project settings:

```text
Minimum shot length: 8.0 s
Maximum shot length: 12.0 s
```

The limits provide visual feedback but do not necessarily block editing.

---

# FPS and H3 frame rules

## Why FPS matters

FPS converts a planned shot duration into a concrete frame count.

```text
Shot duration: 10.0 s
FPS:           25
Cut frames:    250
```

## Supported frame rules

- free
- `4n+1`
- `8n+1`

Examples:

```text
4n+1:
1, 5, 9, 13, 17, ...

8n+1:
1, 9, 17, 25, 33, ...
```

## Desired frame count

```text
desiredFrames = ceil(shotDuration × FPS)
```

## Next valid render frame count

```text
renderFrames =
ceil((desiredFrames - 1) / stride) × stride + 1
```

Where:

```text
stride = 4  → 4n+1
stride = 8  → 8n+1
```

## Overhang

```text
overhangFrames  = renderFrames - desiredFrames
overhangSeconds = overhangFrames / FPS
```

Example at 25 FPS:

```text
Cut duration:       10.000 s
Cut frames:         250
H3 render frames:   257
Render duration:    10.280 s
Overhang:             7 frames / 0.280 s
```

---

# Project asset pool

Each project has one asset pool.

Supported asset types:

- images
- videos
- audio files

Each asset stores only what is currently needed:

```json
{
  "id": "asset-001",
  "type": "image",
  "fileName": "character-front.png",
  "relativePath": "assets/images/character-front.png",
  "tags": ["character", "front"],
  "description": ""
}
```

Additional media metadata can be read automatically with FFprobe:

- duration
- width
- height
- frame rate
- codec
- sample rate
- channel count

## Tags

Tags are simple strings.

No category hierarchy or ontology is required.

Examples:

```text
character
location
start-frame
reference
motion
background
lip-sync
```

## Asset assignment

Assets can be assigned to one or more shots.

A shot stores asset IDs:

```json
{
  "id": "shot-003",
  "startSeconds": 18.24,
  "endSeconds": 28.12,
  "assetIds": [
    "asset-001",
    "asset-014"
  ],
  "prompt": "",
  "notes": ""
}
```

No formal role system is required for the first version.

Tags and filenames are sufficient until a real need for asset roles appears.

---

# Images

Images may be:

- previewed,
- tagged,
- described,
- assigned to shots,
- copied into shot export folders.

## Optional AI description

A user may explicitly request an image description through OpenRouter.

The UI provides:

```text
[Describe image]
Model: [select model]
```

The result is inserted into an editable description field.

Rules:

- one image at a time,
- explicit user action,
- free model selection,
- no automatic batch processing,
- no automatic overwrite of manual text,
- API key stored locally,
- API key never written into project exports.

The description may stream into the field while it is generated.

---

# Videos

Videos are reference assets only.

The application may:

- import them,
- read metadata,
- generate a thumbnail,
- play them in a simple preview,
- tag them,
- describe them later if needed,
- assign them to shots,
- copy them unchanged during export.

The application must not become a video editor.

## Explicitly out of scope

- no video timeline
- no video trimming
- no in/out points
- no clip splitting
- no proxy workflow
- no transitions
- no video re-encoding
- no video synchronization tools
- no multi-track video editing

If partial extraction becomes necessary later, it should be a separate action that creates a new asset. It should not turn the timeline into a video editing environment.

---

# Audio export

## Lip-sync audio

Every exported shot receives one vocal snippet prepared for lip sync.

Format:

```text
File name:    shot-XXX_<slug>-lip_sync.flac
Codec:        FLAC
Sample rate:  32 kHz
Channels:     Mono
```

The exported duration is the H3 render duration, including frame-rule overhang.

Conceptual FFmpeg command:

```bash
ffmpeg \
  -ss 18.240 \
  -i vocals.flac \
  -t 9.960 \
  -ar 32000 \
  -ac 1 \
  -c:a flac \
  shot-XXX_<slug>-lip_sync.flac
```

## Optional mix export

The mix is not exported by default.

Project option:

```text
[ ] Export mix snippet
```

When enabled, a mix snippet is written alongside the lip-sync file.

The visible export configuration should remain minimal. FLAC, 32 kHz, and mono may remain fixed instead of becoming user-configurable settings.

---

# Export package

Each shot is exported into its own folder.

Example:

```text
export/
├── project.json
├── project.md
│
├── shot-001_opening-closeup/
│   ├── shot-001_opening-closeup-shot.json
│   ├── shot-001_opening-closeup-prompt.txt
│   ├── shot-001_opening-closeup-notes.md
│   ├── shot-001_opening-closeup-lip_sync.flac
│   └── assets/
│       ├── character-front.png
│       └── motion-reference.mp4
│
├── shot-002/
│   └── ...
```

When optional mix export is enabled:

```text
shot-001_opening-closeup/
├── shot-001_opening-closeup-lip_sync.flac
├── shot-001_opening-closeup-mix.flac
└── ...
```

## Shot manifest

Example:

```json
{
  "shot": 3,
  "startSeconds": 18.24,
  "endSeconds": 28.12,
  "cutDurationSeconds": 9.88,
  "fps": 25,
  "cutFrames": 247,
  "frameRule": "8n+1",
  "renderFrames": 249,
  "renderDurationSeconds": 9.96,
  "overhangFrames": 2,
  "assets": [
    "assets/character-front.png",
    "assets/motion-reference.mp4"
  ]
}
```

## Export behavior

For every shot:

1. create the shot folder,
2. generate `shot-XXX_<slug>-lip_sync.flac`,
3. optionally generate `shot-XXX_<slug>-mix.flac`,
4. copy assigned assets unchanged,
5. write `shot-XXX_<slug>-shot.json`,
6. write prompt and notes.

No EDL, Resolve marker export, ComfyUI workflow generation, or script generator is required initially.

---

# Backend

## Choice

Python with FastAPI.

The backend exists only for tasks that the browser should not handle directly:

- project file access,
- asset import,
- FFprobe metadata extraction,
- FFmpeg audio conversion,
- thumbnail creation,
- export folder creation,
- file copying,
- requests to configured external services.

## No unnecessary infrastructure

The initial backend does not need:

- a database,
- authentication,
- Redis,
- Celery,
- distributed workers,
- Docker,
- a plugin system,
- an agent system,
- a generic tool registry.

Projects are stored as JSON plus project files on disk.

---

# Setup page

CUTTAlogue needs one application-level setup page separate from individual projects.

The setup page is used for connections and credentials required by optional integrations.

Initial examples:

```text
AI provider
- API base URL
- API key
- default model

ComfyUI
- server URL
- optional authentication
- connection test
```

The structure should remain intentionally open. CUTTAlogue may support more than one external provider over time, and configuration should not be hard-wired to OpenRouter alone.

## Rules

- setup is application-wide, not project-specific,
- secrets are never stored in project JSON,
- secrets are never copied into exports,
- project files may reference a configured connection by ID or name,
- every external integration remains optional,
- the UI must show which service and model will be used before sending data,
- a simple connection test should provide immediate feedback.

The exact local secret-storage mechanism is an implementation decision. The product specification only requires strict separation between credentials, project data, and export data.

## ComfyUI outlook

ComfyUI is not the application core and CUTTAlogue must remain useful without it.

A later optional integration may allow CUTTAlogue to:

- connect to a configured ComfyUI server,
- select or reference an existing workflow,
- insert prepared shot assets and parameters,
- submit a workflow through the ComfyUI API,
- display queue and execution progress in the shared task panel.

This is an outlook, not part of the initial implementation scope. CUTTAlogue prepares the shot package first; direct workflow submission may be added once the packaging workflow is stable.

---

# Progress and task feedback

Long-running backend operations must not be represented by a spinner alone.

Operations such as:

- project export,
- FFmpeg processing,
- large file copying,
- thumbnail generation,
- OpenRouter requests

are represented as jobs.

## Basic API

```text
POST /api/projects/{id}/export
POST /api/assets/{id}/describe

GET  /api/jobs/{jobId}
GET  /api/jobs/{jobId}/events
POST /api/jobs/{jobId}/cancel
```

## Server-Sent Events

The backend sends structured progress events to the browser.

Example:

```json
{
  "status": "running",
  "phase": "audio",
  "shot": 12,
  "shotCount": 37,
  "message": "Creating shot-012_rooftop-lip_sync.flac",
  "itemProgress": 0.68
}
```

## FFmpeg progress

FFmpeg should use:

```text
-progress pipe:1
```

This allows the backend to calculate real progress from processed output time and known target duration.

## Frontend display

Example:

```text
Exporting project

Shot 12 of 37
──────────────────────────────── 32%

Current task:
Creating shot-012_rooftop-lip_sync.flac

FFmpeg:
██████████████████░░░░░░░ 68%

Output:
export/shot-012_rooftop/shot-012_rooftop-lip_sync.flac

[Cancel] [Show details]
```

## OpenRouter progress

Before generated text arrives, use real phases rather than a fake percentage:

```text
✓ Image prepared
✓ Request sent
→ Model processing
→ Response streaming
```

As soon as text arrives, stream it directly into the editable description field.

---

# Frontend layout

## Main structure

```text
┌──────────────────────────────────────────────────────────────┐
│ CUTTAlogue   Project name            Save Export Tasks Setup │
├──────────────────────────────────────────────────────────────┤
│ A Mix  B Vocal  Play  Position                    Zoom       │
├──────────────────────────────────────────────────────────────┤
│ BPM · Time sig · Offset · Grid │ FPS · Rule │ Min · Max     │
├──────────────────────────────────────────────────────────────┤
│ GRID                                                         │
│ SHOTS                                                        │
│ MIX                                                          │
│ VOCAL                                                        │
├───────────────────────────────────┬──────────────────────────┤
│ SHOT LIST                         │ SHOT / ASSETS            │
│                                   │                          │
│ Shot 1                            │ Selected shot            │
│ Shot 2                            │ Assigned assets          │
│ Shot 3                            │ Asset pool                │
└───────────────────────────────────┴──────────────────────────┘
```

The timeline remains full width.

The lower work area is divided into:

- shot list,
- contextual shot or asset panel.

## Shot list

The shot list remains the main navigation tool.

Each row may show:

```text
03  00:22.000–00:32.667  10.667 s  273 F  +6 F  4 assets
```

Clicking a row focuses the corresponding shot in the timeline.

## Context panel

Two views are sufficient:

```text
[Shot] [Assets]
```

### Shot view

Shows:

- shot timing,
- duration,
- cut frames,
- render frames,
- overhang,
- prompt,
- notes,
- assigned assets.

### Assets view

Shows:

- add files,
- tag filter,
- simple image/video/audio cards,
- preview,
- file name,
- tags,
- description,
- assign to selected shot,
- remove from selected shot.

Drag-and-drop may be supported, but must not be the only assignment method.

---

# Shared task panel

One task panel handles all backend activity.

Example:

```text
Tasks ①
```

Expanded:

```text
EXPORT PROJECT

Shot 12 of 37
shot-012_rooftop-lip_sync.flac
████████████████░░░ 74%

✓ Folder created
→ Converting audio
  Copying assets
  Writing manifest

[Cancel] [Log]
```

The detailed log may show raw backend or FFmpeg output, but it should remain collapsed by default.

---

# Project model

Example:

```json
{
  "version": 1,
  "name": "Liquid DnB Video",
  "audio": {
    "mix": {
      "fileName": "song-mix.wav",
      "relativePath": "audio/song-mix.wav"
    },
    "vocal": {
      "fileName": "song-vocal.wav",
      "relativePath": "audio/song-vocal.wav"
    },
    "playbackTrack": "mix"
  },
  "tempo": {
    "bpm": 180,
    "timeSignature": {
      "numerator": 4,
      "denominator": 4
    },
    "gridOffsetSeconds": 0,
    "gridDivision": "beat"
  },
  "video": {
    "fpsNumerator": 25,
    "fpsDenominator": 1,
    "frameRule": {
      "stride": 8,
      "offset": 1
    }
  },
  "shotLimits": {
    "minimumSeconds": 8,
    "maximumSeconds": 12
  },
  "export": {
    "includeMix": false
  },
  "assets": [
    {
      "id": "asset-001",
      "type": "image",
      "fileName": "character-front.png",
      "relativePath": "assets/images/character-front.png",
      "tags": ["character", "front"],
      "description": ""
    }
  ],
  "shots": [
    {
      "id": "shot-001",
      "startSeconds": 22.0,
      "endSeconds": 32.667,
      "assetIds": ["asset-001"],
      "prompt": "",
      "notes": ""
    }
  ]
}
```

Derived values are not required in the project file:

- shot duration,
- cut frames,
- render frames,
- render duration,
- overhang.

They are recalculated from source timing and project settings.

---

# Implementation sequence

## Phase 1 — Complete the timeline editor

- shot drag and move,
- resize feedback,
- snap target feedback,
- shot-list selection,
- timeline focus,
- project save/load,
- stable region behavior.

## Phase 2 — Asset pool

- import images, videos, and audio,
- display metadata,
- add tags,
- preview assets,
- assign assets to shots.

## Phase 3 — Export

- create shot folders,
- generate `shot-XXX_<slug>-lip_sync.flac`,
- optionally generate `shot-XXX_<slug>-mix.flac`,
- copy assigned assets,
- write shot manifests,
- report structured progress.

## Phase 4 — Setup and optional AI provider support

- application-level setup page,
- local credential configuration,
- configurable API base URL,
- free model selection,
- manual image description,
- streamed response,
- editable stored result.

## Later outlook — Optional ComfyUI connection

- configure a ComfyUI server,
- test the connection,
- reference an existing workflow,
- submit prepared shot data,
- report queue and execution progress through the shared task panel.

This remains outside the initial implementation scope.

Each phase must be useful on its own.

---

# Deliberately out of scope

- no ComfyUI dependency and no ComfyUI integration as the application core
- no video editing timeline
- no video trimming
- no DAW features
- no automatic shot generation
- no automatic cut decisions
- no beat detection
- no BPM detection
- no Whisper transcription
- no local AI model requirement
- no asset role ontology
- no database
- no user accounts
- no cloud synchronization
- no plugin system
- no node graph
- no agent framework
- no workflow engine
- no floating or rearrangeable UI panels
- no dashboard
- no analytics
- no project statistics
- no export format collection built in advance

---

# Summary

CUTTAlogue is a local music-aware shot planner and production-preparation tool.

It provides:

```text
WaveSurfer Multitrack
+ musical timeline
+ manual shot regions
+ drag, move, split, merge, and delete
+ shot-list navigation
+ FPS and H3 frame rules
+ asset pool
+ tags
+ manual shot assignment
+ application-level setup for optional external services
+ optional AI-assisted image descriptions
+ FLAC lip-sync export
+ per-shot production packages
+ structured backend progress
```

CUTTAlogue prepares materials for downstream tools.

It does not try to replace them.

A future optional ComfyUI connection may submit prepared shots directly, but the project remains independent of ComfyUI.
