# MiniMax H3 Conformance Roadmap

- Status: foundation implemented; advanced authoring remains in progress
- Integration branch: `integration/h3-conformance`
- Reference implementation: [ComfyUI-MiniMaxDirector](https://github.com/imbutus/ComfyUI-MiniMaxDirector)

## 1. Purpose

CUTTAlogue owns the creative product, musical timeline, Direction model, Camera
Visualizer, application design, persistence, jobs, and MCP boundary. MiniMax H3
is a generation target behind that product.

This roadmap adds an explicit H3 conformance layer between CUTTAlogue's
model-neutral authoring data and the concrete ComfyUI graph. The layer exists to
make model constraints visible, deterministic, testable, and impossible to
silently ignore.

ComfyUI-MiniMaxDirector is treated as a high-signal behavioral reference because
it documents prompt and graph behavior tested closer to H3. It is not merged as
a subtree and does not become a second application architecture. Its repository
is MIT licensed; this work currently adapts documented behaviors and test ideas,
not copied source.

## 2. Product boundaries

The following remain authoritative in CUTTAlogue:

- project time is expressed in musical/editorial seconds;
- `shot.direction.camera` owns camera intent;
- the embedded Camera Visualizer owns spatial preview;
- CUTTAlogue colors, typography, layout, and interaction patterns own the UI;
- canonical project services own reads, writes, revisions, generation, and MCP;
- H3 frame samples, prompt sections, and ComfyUI nodes are derived render data.

H3 constraints must not rewrite musical shot boundaries. The render plan may
extend beyond the editorial cut to reach a legal H3 frame count, and that
overhang must remain explicit.

## 3. Implemented foundation

### 3.1 H3 frame contract

H3 generation is fixed at 24 fps and legal frame counts satisfy:

    frame_count % 17 == 5

The requested editorial duration is a lower bound. CUTTAlogue computes the
ceiling of `duration * 24`, then snaps upward to the next legal count. It never
rounds backward to a legal clip that ends before the cut.

Regression coverage includes the boundary immediately above an already legal
frame count, ordinary overhang, the minimum, and the documented upper trained
boundary.

### 3.2 Generation preflight

Every HTTP- or MCP-adjacent generation start passes through the same pure
preflight report before a job exists.

Blocking errors currently include:

- missing or over-7,000-character prompts;
- invalid shot timing;
- malformed, duplicate, missing, or non-image image references;
- more than nine image references;
- an Extend assignment while the bundled workflow has no continuation input.

Non-blocking guidance currently includes:

- prompt word count outside the documented 350-500 guidance;
- render length outside the documented 124-362-frame trained range;
- an `N/A` soundscape while a vocal reference is supplied.

Warnings are diagnostic, not invented corrections. CUTTAlogue never pads prose
or changes authored timing merely to satisfy a recommendation.

### 3.3 Honest Extend behavior

The bundled `R2V_H3_V1` graph contains no usable continuation input. Extend is
therefore disabled for new UI assignments and rejected before job creation if
an older project still contains one. Existing assignments remain visible and
removable.

Extend must not be re-enabled until a compatible graph adapter and an
end-to-end continuation fixture exist.

### 3.4 Prompt dialects

The deterministic compiler exposes two explicit dialects:

Reference-to-video:

1. `subject_definitions`
2. `summary`
3. `retention_analysis`
4. `detailed_description`
5. `overall_soundscape`
6. `non_diegetic_music`

Base generation:

1. `integrated_multimodal_description`
2. `overall_soundscape`
3. `non_diegetic_music`

CUTTAlogue's current production path explicitly selects reference mode because
the bundled graph always supplies the stored vocal stem as `ref_audio_0`.
Mode is never inferred from image count alone.

A base prompt rejects picture-bound subjects. This prevents `<Picture N>`
tokens from entering a graph with no matching attachments.

### 3.5 Vocal reference semantics

Reference compilation no longer claims `overall_soundscape: N/A` while sending
a vocal stem. It instructs H3 to preserve the supplied vocal's audible words,
delivery, timing, and synchronization without replacement or paraphrase.

`non_diegetic_music` remains `N/A` because the current graph supplies the
vocal stem, not the full mix.

### 3.6 Workflow graph contract

The bundled workflow adapter validates required node classes and links before
substitution. A re-export that renumbers or replaces contracted nodes fails
locally instead of reaching ComfyUI with partial data.

The contract proves that these exact values reach their consumers:

- compiled prompt -> H3 prompt;
- legal frame count -> H3 length;
- 24 fps -> CreateVideo;
- resolved seed -> RandomNoise;
- generated vocal filename and duration -> H3 audio reference;
- canonical image order -> contiguous `ref_image_N` slots.

The builder requires prompt, seed, legal frame count, 24 fps, vocal filename,
and matching vocal duration. Exported manual-test defaults cannot be used.

Every request clears exported image slots before adding current references.
With zero images, the stale first-image nodes are removed entirely. This closes
a defect where the workflow's old club test image could remain attached to a
shot with no requested image reference.

## 4. Branch and commit structure

The implementation is intentionally split:

- `feature/h3-frame-contract` - upward frame snapping and boundary tests;
- `feature/h3-generation-preflight` - validation, warnings, and honest Extend;
- `feature/h3-compiler-contract` - prompt dialects and vocal semantics;
- `feature/h3-workflow-contract` - graph signature and exact-input tests;
- `docs/h3-conformance-roadmap` - this roadmap and release documentation.

Each feature branch was created from `integration/h3-conformance`, tested,
pushed, and merged with a non-fast-forward merge. The integration branch is the
only branch intended to merge into `main`.

## 5. Next phases

### Phase 2 - Visible preflight report

Expose the structured preflight report in the Generate tab before submission.
Errors disable generation and link to the relevant field. Warnings remain
overridable and are recorded with the take.

Acceptance:

- the report is deterministic for saved project state;
- browser, HTTP, and MCP display the same issue codes;
- no generation job is created while errors exist;
- warnings do not silently mutate prompts or shots.

### Phase 3 - Dialogue and on-screen text

Add authored, persisted fields rather than deriving dialogue from lyric
alignment:

- exact line text;
- speaker/subject binding;
- spoken language and delivery;
- visible, off-screen, voice-over, singing, and non-verbal modes;
- cross-cut `<scenetrans>` and end-of-clip `<cutoff>`;
- exact on-screen text plus placement interval.

Lyrics alignment may propose timing and text, but promotion into dialogue is an
explicit user action. The compiler must never guess uncertain words.

Acceptance:

- exact authored wording is byte-preserved;
- every speaker marker resolves to one subject;
- off-screen speech includes the correct visible-mouth constraint;
- cut markers appear only where the authored interval requires them;
- screen text is quoted exactly and covered by Golden tests.

### Phase 4 - Multimodal reference model

Replace the image-role-only binding with a typed reference presentation:

- image appearance references;
- video motion references;
- audio voice/performance references;
- one subject drawing appearance, motion, and voice from different files;
- deterministic presentation order and token numbering;
- model limits for counts, duration, dimensions, and total attachments.

Acceptance:

- prompt tokens and graph slots derive from one canonical binding;
- video-provided audio is ordered before standalone audio where required;
- unused attachments and unmentioned tokens are reported;
- many-to-many subject/reference cases have fixtures.

### Phase 5 - Runtime adapter selection

Move from one hard-coded exported graph toward capability-based adapters for
H3 Image-to-Video, Reference-to-Video, and supported first/last-frame modes.
Node introspection may validate installed ComfyUI capabilities, but adapter
selection remains deterministic and testable offline.

Acceptance:

- attachment/mode combinations select exactly one compatible adapter;
- incompatible combinations fail before upload;
- node identifiers are isolated behind the adapter;
- each adapter has an exact-input graph test;
- changing a ComfyUI node signature produces a local contract error.

### Phase 6 - First/last frame and storyboard control

Add explicit start-frame, end-frame, and storyboard reference roles without
overloading Extend or the current cast-role model.

Acceptance:

- reference and first/last-frame modes cannot be mixed illegally;
- storyboard timing is expressed in H3 render frames;
- the Camera Visualizer remains derived from Direction and is not replaced by
  storyboard keyframes;
- export records both editorial timing and H3 render timing.

### Phase 7 - Real-model conformance suite

Keep the fast suite entirely local, then add opt-in fixtures against an actual
configured H3 installation.

The real-model matrix should cover:

- no image plus vocal reference;
- one and multiple ordered images;
- hard cuts and continuous camera moves;
- exact vocals, off-screen dialogue, cross-cut speech, and cutoff;
- minimum, typical, and maximum trained lengths;
- prompt near the character limit;
- every supported runtime adapter.

Results must record model/workflow versions, seed, frame count, prompt hash,
attachment manifest, output metadata, and human observations. Outputs are not
committed unless licensing and storage policy explicitly allow it.

## 6. Deferred capabilities

The following are not part of the foundation:

- Turbo variants;
- model upscaling;
- public remote MCP transport;
- automatic transcription or dialogue invention;
- silent conversion of old Extend assignments;
- wholesale adoption of MiniMaxDirector's timeline UI;
- replacing CUTTAlogue's Camera Direction or visual design.

## 7. Verification commands

Fast deterministic verification:

    powershell -ExecutionPolicy Bypass -File scripts/test-fast.ps1

Focused H3 contracts:

    python backend/tests/test_h3_frames.py
    python backend/tests/test_h3_preflight.py
    python backend/tests/test_h3_workflow_contract.py
    python backend/tests/test_lip_sync_audio.py
    python backend/tests/test_generation_service.py
    node frontend/tests/h3CompilerContract.test.js
    node frontend/tests/h3SemanticBeats.test.js

The real ComfyUI/H3 acceptance run remains manual and opt-in because it uses
external compute, installed model weights, and potentially billable resources.

## 8. Master merge gate

`integration/h3-conformance` may merge into `main` when:

1. the fast deterministic gate passes;
2. the focused H3 tests pass;
3. the working tree is clean;
4. the integration branch is pushed;
5. a manual generation confirms prompt, vocal, frame count, and reference order
   on the configured ComfyUI installation;
6. the merge commit and resulting `main` are pushed.

Advanced phases do not block the foundation merge if they remain accurately
documented as deferred and no current UI promises unsupported behavior.
