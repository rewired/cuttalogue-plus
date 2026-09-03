# Musical Shot Editor

## Goal

A lean, local browser editor for planning video shots against a song.

The editor displays two audio files in sync:

- **A: Mix**
- **B: Vocal stem**

Shot ranges are placed manually on a shared timeline and locked to a musical grid. For every shot, the editor calculates the required MiniMax H3 render length on the fixed `17n+5` lattice.

For now the editor is a standalone web app with no ComfyUI integration.

---

## Core principle

The editor deliberately does not work fully automatically.

It should:

- make musical structure visible,
- show vocal gaps as orientation,
- let shot boundaries be set manually,
- check shot lengths,
- calculate H3-compatible frame counts.

It should not decide on its own where to cut.

Guiding idea:

> Assistance, not autopilot.

---

## Technical approach

### Stack

- HTML
- CSS
- Vanilla JavaScript
- WaveSurfer.js
- local processing in the browser

No framework is required for the MVP.

### WaveSurfer building blocks

Planned usage:

- **Multitrack**
  - synchronized display of mix and vocal stem
  - shared playhead
  - shared seeking
  - shared zoom and scroll range

- **Timeline plugin**
  - musical grid
  - beat and bar markers
  - freely formatted labels

- **Regions plugin**
  - shot ranges
  - movable shot boundaries
  - editable regions

- **Hover plugin**
  - time position under the cursor
  - optional frame and bar info

- **Silence example**
  - visual detection of vocal gaps
  - orientation only
  - no automatic shot creation

---

## UI hierarchy

The order of the timeline tracks is fixed:

```text
Grid
|----- Bar -----|----- Bar -----|----- Bar -----|

Shots
[------ Shot 1 ------][-------- Shot 2 --------]

Mix
████████▂▁▁████████████▂▁████████████████

Vocal
▁▁▁█████▂▁▁▁▁▆█████▂▁▁▁▁▁▅██████████
```

### Rationale

1. The musical grid is the temporal orientation.
2. The shots track is the actual work layer.
3. Mix and vocal serve as visual reference.
4. Both waveforms are the same size.

---

## Timeline navigation

- **Zoom**: slider at the top of the transport bar, affects all four tracks at
  once.
- **Horizontal scrolling**: mouse wheel or trackpad gesture over the
  timeline. All four tracks scroll in sync.
- **Playhead / seeking**: click or drag on the mix or vocal track sets the
  playback position; the grid and shots tracks follow automatically.

---

## Audio

### Files

The editor can load two audio files:

- **A: Mix**
- **B: Vocal**

Both files live on the same timeline.

### Playback

Only one track plays at a time:

```text
[A Mix] [B Vocal]
```

The selection can be switched directly.

### Out of scope (audio)

- no gain
- no solo
- no mute
- no fade in/out
- no differently sized tracks
- no mixing features
- no DAW features

YAGNI: the editor is not an audio mixer.

### Time reference

The mix defines the primary project timeline.

The vocal stem serves as a second, synchronized reference track.

A manual vocal offset can be added later, but is not required for the first version.

---

## Musical grid

### Inputs

- BPM
- time signature
- grid offset
- grid subdivision

Example:

```text
BPM:         174
Time sig:    4/4
Grid:        1 bar
Grid offset: 0.000 s
```

### Calculation

```text
beatDuration = 60 / BPM
barDuration  = beatDuration × numerator
```

Example at 174 BPM and 4/4:

```text
beatDuration = 60 / 174
             ≈ 0.344828 s

barDuration  = 4 × 0.344828
             ≈ 1.379310 s
```

### Grid options for the MVP

- Off
- 1 beat
- 1/2 bar
- 1 bar
- 2 bars
- 1 second
- 1 frame (depends on the configured video FPS)

Second- and frame-based grids are independent of tempo and useful when shot boundaries should lock to fixed time or frame positions instead of the beat.

The Timeline plugin handles rendering. The app's own code only computes the musical intervals and configures the plugin.

### Grid offset

A song doesn't necessarily start exactly on beat one at second zero.

The editor therefore needs to support a grid offset.

Optional later:

```text
Set bar 1 / beat 1 to the playhead
```

---

## Shots

### Core model

Shots do **not** form a gap-free chain. It's a sorted list of independent, non-overlapping time ranges. There can be a gap between two shots - for instance an intro, or a section that's deliberately left out of the shot list.

```text
Shot 1: 00:00.000 – 00:09.640
                              (gap, no shot)
Shot 2: 00:12.000 – 00:20.640
```

Right after loading a mix, the shot list is empty - no shot is created automatically.

When two shots touch (no gap between them), they can't overlap while being resized - but unlike the old chain model, moving one shot's edge does not automatically drag the neighbor's edge along with it. More room only appears when the neighbor's edge is moved separately, or the neighboring shot is deleted.

### Controls

- **Click inside an existing shot** splits it at the click position (snapped
  to the current grid).
- **Drag on empty space** (a gap) draws a new shot.
- **Holding Alt** during a drag (creating a shot or moving an edge)
  overrides grid snapping for that one action.
- **Existing edges** can each be dragged independently, clamped against
  their own opposite edge and against the neighbor's facing edge or the
  timeline bounds. Snapping only happens on release, not during the drag -
  otherwise the edge would snap straight back to the same grid line on
  every tiny mouse movement.
- **Right-click a shot** opens a context menu to delete it. The shot
  disappears; the resulting gap is left unmarked.
- **Double-click a shared boundary** (two shots touching with no gap)
  merges the two shots into one.
- Shot duration is shown directly.

### Shot lengths

Global settings:

```text
Minimum shot length: 8.0 s
Maximum shot length: 12.0 s
```

Per-shot display:

```text
Shot 03
00:18.240 – 00:28.120
Duration: 9.880 s
```

Status:

- below minimum: too short
- within range: valid
- above maximum: too long

The warning is visual but doesn't necessarily block editing.

---

## Editorial FPS and the H3 frame rule

### Two clocks

The project FPS converts an editorial shot boundary into cut frames. MiniMax H3 render timing is always evaluated at 24 fps, independently of an older project's editorial rate.

Example:

```text
Shot duration:        10.0 s
Project FPS:          25
Editorial cut frames: 250
H3 desired frames:    240
```

### One supported render lattice

H3 render frame counts must satisfy:

```text
frameCount % 17 == 5
legal counts: 5, 22, 39, 56, ...
```

There is no `free`, `4n+1`, or `8n+1` render option. Legacy values are normalized to `{ stride: 17, offset: 5 }` when a project is loaded and are ignored by backend render planning.

### Calculating the render length

```text
editorialCutFrames = ceil(shotDuration × projectFPS)
h3DesiredFrames    = ceil(shotDuration × 24)
renderFrames       = h3DesiredFrames + ((5 - (h3DesiredFrames % 17) + 17) % 17)
renderDuration     = renderFrames / 24
overhangFrames     = renderFrames - h3DesiredFrames
overhangSeconds    = renderDuration - shotDuration
```

The upward alignment is deliberate: a render must never finish before the editorial cut.

Example at 25 editorial FPS and a 10-second shot:

```text
Editorial cut frames: 250
H3 desired frames:    240
H3 render frames:     243
H3 render duration:   10.125 s
Overhang:               3 H3 frames / 0.125 s
```

### Per-shot display

```text
SHOT 04

Cut length:         10.000 s
Cut frames:         250 @ 25 fps
H3 render frames:   243 @ 24 fps
Overhang:             3 frames / 0.125 s
```

---

## Hover display

Hovering over the timeline can show:

```text
01:23.440
Frame 2086
Bar 61 · Beat 2
```

For the MVP this is also enough:

```text
01:23.440 · F2086
```

The Hover plugin supplies the position; time, frame and bar values are derived from it.

---

## Vocal gaps

The vocal waveform should make singing pauses visually recognizable.

WaveSurfer's silence example can serve as a basis for this.

### Purpose

- spot quiet sections in the vocal stem
- surface possible cut points
- make manual shot planning easier

### Out of scope

- no automatic shot creation
- no automatic moving of boundaries
- no automatic scene list
- no forced recommendations

Vocal gaps are just an additional visual layer.

---

## Project settings

The following values belong to the project:

```text
Mix file name
Vocal file name
active playback track A or B

BPM
Time signature
Grid offset
Grid subdivision

FPS
Frame rule

Minimum shot length
Maximum shot length

Shot boundaries
```

---

## Data model

`shots` is a list of `{ id, startSeconds, endSeconds }` with no contiguity assumption - consecutive entries may, but don't have to, connect directly.

Example:

```json
{
  "version": 1,
  "audio": {
    "mix": {
      "fileName": "song_mix.wav",
      "durationSeconds": 311.24
    },
    "vocal": {
      "fileName": "song_vocal.wav",
      "durationSeconds": 311.24
    },
    "playbackTrack": "mix"
  },
  "tempo": {
    "bpm": 174,
    "timeSignature": {
      "numerator": 4,
      "denominator": 4
    },
    "gridOffsetSeconds": 0,
    "gridDivision": "bar"
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
  "shots": [
    {
      "id": 1,
      "startSeconds": 0,
      "endSeconds": 9.64
    },
    {
      "id": 2,
      "startSeconds": 9.64,
      "endSeconds": 18.28
    }
  ]
}
```

### Derived values

The following values don't necessarily need to be stored:

- shot duration
- cut frames
- H3 render frames
- overhang frames
- overhang seconds

They can be recomputed from the shot times and project settings at any time.

That keeps the data consistent when FPS or the frame rule change.

---

## Export

### Project file

The JSON contains:

- project settings
- file names
- shot boundaries

The audio files themselves are not embedded in the MVP.

When reopening, the mix and vocal may need to be reselected.

### Shot export as JSON

```json
{
  "fps": 25,
  "frameRule": "17n+5",
  "shots": [
    {
      "shot": 1,
      "startSeconds": 0,
      "endSeconds": 9.64,
      "durationSeconds": 9.64,
      "cutFrames": 241,
      "renderFps": 24,
      "renderFrames": 243,
      "renderDurationSeconds": 10.125,
      "overhangFrames": 11
    }
  ]
}
```

### Shot export as CSV

```csv
shot,start,end,duration,cut_frames,render_frames,overhang_frames
1,0.000,9.640,9.640,241,241,0
2,9.640,18.280,8.640,216,217,1
```

Possible later exports:

- Resolve marker CSV
- EDL
- FFmpeg cut list
- ComfyUI-compatible JSON

These are not part of the first MVP.

---

## MVP scope

Version 0.1 should be able to:

1. load a mix
2. load a vocal stem
3. display both waveforms at the same size
4. switch playback between A and B
5. shared playback, seeking, zoom and scrolling
6. set BPM
7. set the time signature
8. set the grid offset
9. show the musical grid
10. create shots by dragging (gaps between shots are allowed)
11. split shots by clicking
12. move shot edges individually, clamped against neighbor/timeline bounds
13. delete shots via right-click
14. apply grid snapping (beat/bar/second/frame), overridable per drag with Alt
15. show min/max shot length
16. set FPS
17. select a frame rule
18. calculate H3 render frames
19. calculate frame overhang
20. save the project as JSON
21. load the project again
22. export the shot list as JSON or CSV

---

## Deliberately out of the MVP

- no ComfyUI integration
- no beat detection
- no BPM detection
- no Whisper transcription
- no automatic shot creation
- no automatic scene analysis
- no automatic cut decisions
- no video preview
- no gain
- no solo
- no mute
- no fade in/out
- no audio effects
- no stem separation
- no differently sized tracks
- no React
- no full DAW
- no plugin system

---

## Guidelines

### YAGNI

Only build features that are actually needed for the current shot-planning task.

### Direct manipulation

- no hidden automation
- no unnecessary dialogs
- no complex channel controls
- no cluttered UI

### Transparent calculations

The user sees, per shot:

- cut duration
- cut frames
- H3 render frames
- overhang

### Extensible, but not over-engineered

The data structure should allow later extensions without burdening the MVP with them now.

---

## Summary

The Musical Shot Editor is a local browser editor with:

```text
WaveSurfer Multitrack
+ Timeline
+ Regions
+ Hover
+ Silence visualization
+ musical grid incl. second/frame grid
+ manual shot planning with gaps, deletion, Alt snap override
+ FPS
+ fixed MiniMax H3 17n+5 render lattice
+ H3 overhang
+ JSON/CSV export
```

It is not an audio editor and not an automatic director.

It's a plain tool for planning shots that make musical sense and are H3-compatible.
