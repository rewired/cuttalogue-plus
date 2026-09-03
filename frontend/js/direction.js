// Phase B/C of docs/h3-shot-direction-roadmap.md: direct a shot's already-cast
// subjects (casting itself happens in the Cast & Locations tab - see
// contextPanel.js) on lane-based mini-timelines (Camera + one lane per acting
// subject + one lane per cast prop) scoped to the shot's own duration -
// draggable/resizable segments, not a form of number inputs. A read-only
// Beats row below them is clickable for an optional intent/priority/end-
// state note, but its boundaries are derived from the tracks above, not
// directly editable. Renders inline in the Direction tab; an expand button
// moves the same live DOM subtree into a big modal for more room, no
// separate render path.
(function (MSE) {
  'use strict';

  const { state, on } = MSE.state;
  const shotsApi = MSE.shots;

  // Suggestions only (still a free-text field) - keeps speed phrasing within
  // H3's own guide, which favors natural sentences like "at whip-fast speed"
  // over inventing new movement types for things that are really just an
  // existing movement (pan, zoom_in/out) at an extreme speed.
  const SPEED_SUGGESTIONS = [
    'glacial, almost imperceptible',
    'creeping',
    'slow',
    'moderate',
    'brisk',
    'fast',
    'whip-fast, blurring the frame',
    'crash-fast',
    'ramping from slow to fast',
    'ramping from fast to slow',
  ];

  const MOVEMENT_LABELS = {
    zoom_in: 'Zoom in',
    zoom_out: 'Zoom out',
    push_in: 'Push in',
    pull_out: 'Pull out',
    pan: 'Pan',
    truck: 'Truck',
    tilt_up: 'Tilt up',
    tilt_down: 'Tilt down',
    pedestal_up: 'Pedestal up',
    pedestal_down: 'Pedestal down',
    tracking_shot: 'Tracking shot',
    arc_shot: 'Arc shot',
    static_shot: 'Static shot',
    shake_slightly: 'Shake slightly',
    shake_strongly: 'Shake strongly',
    pov: 'POV',
    roll_cw: 'Roll clockwise',
    roll_ccw: 'Roll counterclockwise',
  };

  const CAMERA_AMPLITUDE_LABELS = {
    '': 'No amplitude set',
    small: 'Small',
    large: 'Large',
  };

  const CAMERA_DIRECTION_LABELS = {
    '': 'No direction set',
    left: 'Left',
    right: 'Right',
    up: 'Up',
    down: 'Down',
    forward: 'Forward',
    backward: 'Backward',
  };

  const ACTION_TYPE_LABELS = {
    '': 'No action type set',
    walk: 'Walk',
    run: 'Run',
    stop: 'Stop',
    sit: 'Sit',
    stand: 'Stand',
    turn: 'Turn',
    reach: 'Reach',
    pick_up: 'Pick up',
    put_down: 'Put down',
    drink: 'Drink',
    check_phone: 'Check phone',
    look: 'Look',
    speak: 'Speak',
    interact: 'Interact',
    sing: 'Sing',
  };

  // Phase 4a: vocal/performance sync requirement, kept distinct from
  // actionType (see shots.js's VOCAL_PERFORMANCES for the split rationale).
  const VOCAL_PERFORMANCE_LABELS = {
    '': 'No vocal performance set',
    lip_sync: 'Lip sync',
    sing: 'Sing (unsynced)',
    speak: 'Speak',
  };

  // Physical eye state - distinct from `gaze` (directional intent).
  const EYES_LABELS = {
    '': 'No eye state set',
    open: 'Open',
    closed: 'Closed',
    half_closed: 'Half-closed',
  };

  // Suggestions only, same reasoning as SPEED_SUGGESTIONS - bodyMotion stays
  // free text (see docs/h3-shot-direction-roadmap.md Phase 4a).
  const BODY_MOTION_SUGGESTIONS = [
    'still',
    'restrained',
    'subtle sway',
    'tense',
    'slowly rocking',
    'energetic',
  ];

  // Phase 4b: focal length is visual-perspective intent, not lens metadata -
  // a datalist (free text + suggestions), same UX pattern as
  // SPEED_SUGGESTIONS, not a closed <select>.
  const FOCAL_LENGTH_SUGGESTIONS = ['18mm', '24mm', '28mm', '35mm', '50mm', '85mm', '105mm', '135mm'];

  const DEPTH_OF_FIELD_LABELS = {
    '': 'No depth of field set',
    deep: 'Deep',
    medium: 'Medium',
    shallow: 'Shallow',
    very_shallow: 'Very shallow',
  };

  const LIGHTING_EXPOSURE_LABELS = {
    '': 'No exposure set',
    low_key: 'Low-key',
    dark: 'Dark',
    balanced: 'Balanced',
    slightly_underexposed: 'Slightly underexposed',
    bright: 'Bright',
    high_key: 'High-key',
  };

  // Suggestions only, same reasoning as SPEED_SUGGESTIONS - a small closed
  // vocabulary for the common continuity rules, but never the only option.
  const CONSTRAINT_SUGGESTIONS = [
    'Single continuous shot',
    'Preserve identity',
    'Preserve wardrobe',
    'No additional people',
    'No location change',
    'Camera remains outside',
    'Subject remains visible',
    'No dialogue',
    'No music',
  ];

  const el = {};
  let currentShotId = null;
  // { kind: 'camera'|'subject'|'prop', assetId?, index } for a segment, or
  // { kind: 'beat', startSeconds, endSeconds } for a beat - which one's
  // fields show in the detail panel below the lanes. Cleared whenever the
  // thing it points at might no longer exist (shot switch, remove, a
  // dragged boundary that no longer forms this beat, project load).
  let selection = null;

  // One .playhead-segment per .direction-lane-content row (same class/CSS
  // the main Grid/Shots/Mix/Vocal playhead uses, just positioned in % of
  // this shot's domainDuration instead of px against the song timeline) -
  // rebuilt every renderLanes() call since el.lanes.innerHTML = '' already
  // discards the old row elements.
  let directionPlayheadEls = [];

  // 'absolute' labels grid ticks with the song's own bar.beat (matches the
  // main Shots timeline); 'relative' re-anchors bar 1 beat 1 to this shot's
  // own start, which reads easier when eyeballing a shot's internal beat
  // count in isolation. Persisted since it's a standing viewing preference,
  // not per-shot data.
  const GRID_MODE_KEY = 'cuttalogue.directionGridMode';
  let gridMode = localStorage.getItem(GRID_MODE_KEY) === 'relative' ? 'relative' : 'absolute';

  function setGridMode(mode) {
    gridMode = mode;
    localStorage.setItem(GRID_MODE_KEY, mode);
    renderAll();
  }

  // Segments snap to whichever grid is currently displayed (see the Grid row
  // toggle above) on drag release only - live dragging stays free, same as
  // the main Shots timeline's own snap-on-release convention. Alt inverts
  // the toggle for that one drag, also mirroring the Shots timeline.
  const SNAP_KEY = 'cuttalogue.directionSnap';
  let snapEnabled = localStorage.getItem(SNAP_KEY) !== 'off';

  function setSnapEnabled(v) {
    snapEnabled = v;
    localStorage.setItem(SNAP_KEY, v ? 'on' : 'off');
    updateSnapToggle();
  }

  function updateSnapToggle() {
    if (!el.snapToggle) return;
    el.snapToggle.textContent = snapEnabled ? 'Snap: on' : 'Snap: off';
    el.snapToggle.classList.toggle('active', snapEnabled);
    el.snapToggle.title = 'Toggle snapping segments to the grid on drag release (hold Alt while dragging to invert for one drag)';
  }

  // Shot-relative time (0 = shot start) -> nearest grid line, in the same
  // domain the Grid row ticks are drawn in (absolute song grid or shot-local,
  // per gridMode) - mirrors shots.js's own snapSeconds, but that one only
  // knows the song timeline, not a shot-relative one. Returns null (rather
  // than relativeTime unchanged) when there's no valid grid step, so the
  // union in snapToDirectionGrid below can tell "no grid candidate" apart
  // from "grid candidate happens to equal the input".
  function nearestGridTime(relativeTime, shot) {
    const tempo = state.tempo;
    const step = MSE.grid.gridStepSeconds(tempo);
    if (!step || step <= 0) return null;
    const origin = gridMode === 'relative' ? shot.startSeconds : tempo.gridOffsetSeconds;
    const absoluteTime = shot.startSeconds + relativeTime;
    const snappedRel = Math.round((absoluteTime - origin) / step) * step;
    return Math.max(0, origin + snappedRel - shot.startSeconds);
  }

  // Phase 4a: the current transient Phrase/Hold analysis result (see
  // lyricsAlign.js's getCurrentRegions) - read fresh on every call, never
  // cached locally, same convention as MSE.vocalCues.forShot() calls
  // elsewhere in this file. Falls back to empty when the Lyrics tab module
  // hasn't loaded (defensive only; both modules always load together in the
  // real app).
  function currentRegions() {
    return MSE.lyricsAlign ? MSE.lyricsAlign.getCurrentRegions() : { phrases: [], holds: [] };
  }

  // This shot's visible phrase/hold boundaries, shot-relative - both the
  // start AND end of each region are valid snap targets. Reuses Phase-3b's
  // own canonical regionsForShot() projection (never a second shot-overlap
  // implementation) purely to read off relativeStartSeconds/
  // relativeEndSeconds.
  function regionSnapTimes(shot) {
    const regions = currentRegions();
    const times = [];
    MSE.vocalRegions.regionsForShot(regions.phrases, shot).forEach((r) => {
      times.push(r.relativeStartSeconds, r.relativeEndSeconds);
    });
    MSE.vocalRegions.regionsForShot(regions.holds, shot).forEach((r) => {
      times.push(r.relativeStartSeconds, r.relativeEndSeconds);
    });
    return times;
  }

  // Snap targets are the union of the musical grid, this shot's vocal cues
  // (MSE.vocalCues.forShot - never anything in H3's render overhang), and
  // its visible Phrase/Hold region boundaries (Phase 4a) - whichever single
  // candidate lands closest to relativeTime wins, via the same nearestOf()
  // union rule the regression tests exercise directly. None of these feed
  // the H3 compiler or create a semantic beat boundary by themselves - only
  // an authored segment edge does; they only ever influence where that edge
  // LANDS when Snap is on.
  function snapToDirectionGrid(relativeTime, shot) {
    const gridTime = nearestGridTime(relativeTime, shot);
    const cueTimes = MSE.vocalCues.forShot(shot).map((cue) => cue.relativeTimeSeconds);
    const candidates = [gridTime, ...cueTimes, ...regionSnapTimes(shot)];
    const snapped = MSE.vocalCues.nearestOf(candidates, relativeTime);
    return snapped === null ? relativeTime : snapped;
  }

  // Reprojects a raw pointer clientX (e.g. from a context-menu right-click)
  // onto the currently rendered shot's own domainDuration, via whichever
  // lane content element is on screen - all lane rows for a shot share the
  // same rect (see percentMetrics), so any one of them works as the
  // reference.
  function directionTimeAtClientX(shot, clientX) {
    const duration = shotsApi.shotDuration(shot);
    const calc = MSE.frames.frameCalc(duration, state.video);
    const domainDuration = duration + calc.overhangSeconds;
    const contentEl = el.lanes.querySelector('.direction-lane-content');
    return contentEl ? MSE.laneWidget.timeAtClientX(contentEl, clientX, domainDuration) : 0;
  }

  function cacheElements() {
    el.lanesRoot = document.getElementById('direction-lanes-root');
    el.tabDetailContainer = document.getElementById('direction-tab-detail');
    el.expandBtn = document.getElementById('direction-expand-btn');
    el.overlay = document.getElementById('direction-modal');
    el.modalTitle = document.getElementById('direction-modal-title');
    el.modalBody = document.getElementById('direction-modal-body');
    el.closeBtn = document.getElementById('direction-close-btn');
    el.lanes = document.getElementById('direction-lanes');
    el.segmentDetail = document.getElementById('direction-segment-detail');
    el.compileBtn = document.getElementById('direction-compile-btn');
    el.expandAiBtn = document.getElementById('direction-expand-ai-btn');
    el.compileStatusText = document.getElementById('direction-compile-status-text');
    el.compileSpinner = document.getElementById('direction-compile-spinner');
    el.expandCancelBtn = document.getElementById('direction-expand-cancel-btn');
    el.segmentContextMenu = document.getElementById('direction-segment-context-menu');
    el.segmentContextSplit = document.getElementById('direction-segment-context-split');
    el.segmentContextDuplicate = document.getElementById('direction-segment-context-duplicate');
    el.segmentContextToggle = document.getElementById('direction-segment-context-toggle');
    el.segmentContextMerge = document.getElementById('direction-segment-context-merge');
    el.segmentContextDelete = document.getElementById('direction-segment-context-delete');
    el.regionContextMenu = document.getElementById('direction-region-context-menu');
    el.regionContextCamera = document.getElementById('direction-region-context-camera');
    el.regionContextCharacterList = document.getElementById('direction-region-context-character-list');
    el.regionContextFit = document.getElementById('direction-region-context-fit');
    el.snapToggle = document.getElementById('direction-snap-toggle');
    el.constraintsList = document.getElementById('direction-constraints-list');
    el.constraintsInput = document.getElementById('direction-constraints-input');
  }

  function findShot(shotId) {
    return state.shots.find((s) => s.id === shotId) || null;
  }

  function selectedShot() {
    const shotId = MSE.context ? MSE.context.getSelectedShotId() : null;
    return shotId !== null ? findShot(shotId) : null;
  }

  function buildSelect(options, value, onChange) {
    const select = document.createElement('select');
    options.forEach(([optValue, label]) => {
      const opt = document.createElement('option');
      opt.value = optValue;
      opt.textContent = label;
      if (optValue === value) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  function buildTextInput(value, placeholder, onChange, className) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = className || 'direction-text-input';
    input.placeholder = placeholder || '';
    input.value = value || '';
    input.addEventListener('change', () => onChange(input.value));
    return input;
  }

  function buildCheckboxInput(checked, labelText, onChange) {
    const wrap = document.createElement('label');
    wrap.className = 'direction-checkbox-field';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    wrap.appendChild(input);
    wrap.appendChild(document.createTextNode(labelText));
    return wrap;
  }

  function buildField(label, inputEl, wide) {
    const wrap = document.createElement('div');
    wrap.className = wide ? 'direction-field direction-field-wide' : 'direction-field';
    const labelEl = document.createElement('label');
    labelEl.className = 'direction-field-label';
    labelEl.textContent = label;
    wrap.appendChild(labelEl);
    wrap.appendChild(inputEl);
    return wrap;
  }

  function buildRemoveButton(onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'direction-remove-btn';
    btn.textContent = '×';
    btn.title = 'Remove';
    btn.addEventListener('click', onClick);
    return btn;
  }

  // Camera and Lighting are both single-array lanes (no assetId), unlike
  // subject/prop lanes which are keyed per cast asset.
  function isLaneWithoutAsset(kind) {
    return kind === 'camera' || kind === 'lighting';
  }

  function isSelected(opts, index) {
    return !!selection
      && selection.kind === opts.kind
      && selection.index === index
      && (isLaneWithoutAsset(opts.kind) || selection.assetId === opts.assetId);
  }

  // Timeline blocks stay compact (see Phase 4b's Lighting-summary
  // requirement) - a Lighting block shows at most exposure + keyLight, not
  // every populated field; the detail editor below owns the full list.
  function segmentLabelText(seg, opts) {
    if (opts.kind === 'camera') return MOVEMENT_LABELS[seg.movement] || seg.movement || 'Camera';
    if (opts.kind === 'lighting') {
      const parts = [];
      if (seg.exposure) parts.push(LIGHTING_EXPOSURE_LABELS[seg.exposure] || seg.exposure);
      if (seg.keyLight) parts.push(seg.keyLight);
      return parts.length > 0 ? parts.join(' / ') : 'Lighting';
    }
    if (opts.kind === 'prop') return seg.state || (seg.ownerAssetId ? 'Held' : 'Prop');
    if (seg.actionType) return ACTION_TYPE_LABELS[seg.actionType] || seg.actionType;
    return seg.notes || 'Action';
  }

  // H3 always renders a valid 17n+5 length, which is usually a
  // few frames longer than the shot's actual cut point - that trailing pad
  // gets trimmed after render, but H3 still has to generate *something* for
  // it despite nothing in the prompt describing it. Marking it here (instead
  // of only in the shot table) keeps that blind spot visible while directing.
  const OVERHANG_TITLE = 'H3 render padding after this shot’s cut point (see Render column) - nothing here is described by the prompt.';

  // Segment rendering/drag/resize/select mechanics live in laneWidget.js -
  // this builds the opts contract it expects, wiring shots.js's camera/
  // subject move functions and this module's own selection/snap state
  // through to it. See laneWidget.js's buildLaneRow doc comment for the
  // full opts shape.
  function buildLaneRow(label, segments, duration, domainDuration, opts) {
    return MSE.laneWidget.buildLaneRow(label, segments, duration, domainDuration, {
      labelText: (seg) => segmentLabelText(seg, opts),
      isSelected: (index) => isSelected(opts, index),
      isDisabled: (index) => segments[index] && segments[index].enabled === false,
      moveSegment: (index, timeValue) => {
        if (opts.kind === 'camera') return shotsApi.moveCameraSegment(currentShotId, index, timeValue);
        if (opts.kind === 'lighting') return shotsApi.moveLightingSegment(currentShotId, index, timeValue);
        if (opts.kind === 'prop') return shotsApi.movePropSegment(currentShotId, opts.assetId, index, timeValue);
        return shotsApi.moveSubjectSegment(currentShotId, opts.assetId, index, timeValue);
      },
      moveSegmentEdge: (index, side, timeValue) => {
        if (opts.kind === 'camera') return shotsApi.moveCameraSegmentEdge(currentShotId, index, side, timeValue);
        if (opts.kind === 'lighting') return shotsApi.moveLightingSegmentEdge(currentShotId, index, side, timeValue);
        if (opts.kind === 'prop') return shotsApi.movePropSegmentEdge(currentShotId, opts.assetId, index, side, timeValue);
        return shotsApi.moveSubjectSegmentEdge(currentShotId, opts.assetId, index, side, timeValue);
      },
      onSelect: (index) => {
        selection = { kind: opts.kind, assetId: opts.assetId, index };
      },
      onCommit: () => shotsApi.notifyDirectionChanged(),
      onClickOnly: () => renderAll(),
      onDeselect: () => {
        selection = null;
        renderAll();
      },
      onAdd: opts.onAdd,
      addTitle: opts.kind === 'camera'
        ? 'Add camera segment'
        : opts.kind === 'lighting'
          ? 'Add lighting segment'
          : (opts.kind === 'prop' ? 'Add prop state' : 'Add action'),
      snapTime: (currentValue, altKey) => {
        const shot = findShot(currentShotId);
        return snapEnabled && !altKey && shot ? snapToDirectionGrid(currentValue, shot) : currentValue;
      },
      datasetAttrs: opts.assetId ? { kind: opts.kind, assetId: opts.assetId } : { kind: opts.kind },
      overhangTitle: OVERHANG_TITLE,
    });
  }

  const MAX_GRID_TICKS = 200;

  // Same bar/beat math as MSE.grid.barBeatAt, but anchored to the shot's own
  // start (bar 1 beat 1 there) instead of the song's grid offset - only used
  // in 'relative' mode.
  function relativeBarBeatAt(timeSeconds, shotStart, tempo) {
    const bd = MSE.grid.beatDuration(tempo.bpm);
    const rel = Math.max(0, timeSeconds - shotStart);
    const totalBeats = Math.round((rel / bd) * 1e6) / 1e6;
    const bar = Math.floor(totalBeats / tempo.numerator) + 1;
    const beat = Math.floor(totalBeats % tempo.numerator) + 1;
    return { bar, beat };
  }

  // Musical grid (from the Tempo panel) reprojected onto the shot's own
  // local 0..duration range, so segments can be dragged/resized against the
  // same bar.beat reference the main Shots timeline snaps to. The row label
  // doubles as a click-to-toggle switch between absolute (song) and relative
  // (shot-local) bar.beat numbering.
  function buildGridRow(shot, duration, domainDuration) {
    const row = document.createElement('div');
    row.className = 'direction-lane-row direction-grid-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'direction-lane-label direction-grid-toggle';
    labelEl.textContent = gridMode === 'relative' ? 'Grid · rel' : 'Grid · abs';
    labelEl.title = 'Click to toggle between absolute (song) and relative (shot-local) bar.beat numbering';
    labelEl.setAttribute('role', 'button');
    labelEl.tabIndex = 0;
    labelEl.addEventListener('click', () => setGridMode(gridMode === 'relative' ? 'absolute' : 'relative'));
    labelEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        labelEl.click();
      }
    });
    row.appendChild(labelEl);

    const content = document.createElement('div');
    content.className = 'direction-lane-content';
    row.appendChild(content);

    const tempo = state.tempo;
    const step = MSE.grid.gridStepSeconds(tempo);
    if (step && step > 0 && domainDuration > 0) {
      const shotStart = shot.startSeconds;
      const shotEnd = shotStart + domainDuration;
      const origin = gridMode === 'relative' ? shotStart : tempo.gridOffsetSeconds;
      const firstStepIndex = Math.ceil((shotStart - origin) / step);
      let ticks = 0;
      for (let i = firstStepIndex; ticks < MAX_GRID_TICKS; i += 1) {
        const t = origin + i * step;
        if (t > shotEnd + 1e-9) break;
        if (t < shotStart - 1e-9) continue;
        ticks += 1;
        const pct = ((t - shotStart) / domainDuration) * 100;
        const { bar, beat } = gridMode === 'relative'
          ? relativeBarBeatAt(t, shotStart, tempo)
          : MSE.grid.barBeatAt(t, tempo);

        const tick = document.createElement('div');
        tick.className = 'direction-grid-tick';
        tick.classList.toggle('bar-start', beat === 1);
        tick.style.left = `${pct}%`;
        content.appendChild(tick);

        const label = document.createElement('div');
        label.className = 'direction-grid-label';
        label.style.left = `${pct}%`;
        label.textContent = `${bar}.${beat}`;
        content.appendChild(label);
      }
    }

    MSE.laneWidget.appendOverhangBand(content, duration, domainDuration, OVERHANG_TITLE);

    return row;
  }

  // Beat epsilon matches h3Compiler.js's own BEAT_NOTE_EPSILON reasoning:
  // boundaries come straight from untouched segment edges, so exact float
  // match is the right bar for "is this still the same beat".
  const BEAT_EPSILON = 1e-6;

  // Consecutive-boundary pairs a note/selection can attach to - shared by
  // the beat spans, the detail panel's "does my selection still exist"
  // check, and the orphaned-notes list, so all three agree on what counts
  // as the same beat.
  function beatPairsFor(shot, allSubjects) {
    const boundaries = MSE.h3Compiler.collectBeatBoundaries(shot, allSubjects);
    const pairs = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
      if (boundaries[i + 1] - boundaries[i] < BEAT_EPSILON) continue;
      pairs.push({ start: boundaries[i], end: boundaries[i + 1] });
    }
    return pairs;
  }

  function beatPairMatches(pair, start, end) {
    return Math.abs(pair.start - start) < BEAT_EPSILON && Math.abs(pair.end - end) < BEAT_EPSILON;
  }

  function isBeatSelected(start, end) {
    return !!selection && selection.kind === 'beat' && beatPairMatches({ start, end }, selection.startSeconds, selection.endSeconds);
  }

  // Not built through laneWidget.buildSegment - that widget is drag/resize-
  // oriented, and beat boundaries are derived from the tracks above, not
  // directly editable. This is just a clickable, non-draggable span.
  function buildBeatSpan(shot, start, end, domainDuration) {
    const span = document.createElement('div');
    span.className = 'direction-beat-segment';
    span.classList.toggle('selected', isBeatSelected(start, end));
    const note = MSE.h3Compiler.findBeatNote(shot, start, end);
    const hasNote = !!(note && (note.intent || note.priority || note.endState));
    const isCut = !!(note && note.isCut);
    span.classList.toggle('has-note', hasNote);
    span.classList.toggle('is-cut', isCut);
    span.style.left = `${domainDuration > 0 ? (start / domainDuration) * 100 : 0}%`;
    span.style.width = `${domainDuration > 0 ? Math.max(0, (end - start) / domainDuration) * 100 : 0}%`;
    span.title = `${start.toFixed(2)}s – ${end.toFixed(2)}s${isCut ? ' (hard cut)' : ''}${hasNote ? ' (has a note - click to edit)' : ' (click to add a note)'}`;
    span.addEventListener('click', () => {
      selection = { kind: 'beat', startSeconds: start, endSeconds: end };
      renderAll();
    });
    return span;
  }

  function buildBeatRow(shot, allSubjects, duration, domainDuration) {
    const row = document.createElement('div');
    row.className = 'direction-lane-row direction-beat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'direction-lane-label';
    labelEl.textContent = 'Beats';
    labelEl.title = 'Semantic beats the compiler will generate - click one to add an intent/priority/end-state note';
    row.appendChild(labelEl);

    const content = document.createElement('div');
    content.className = 'direction-lane-content';
    row.appendChild(content);

    MSE.h3Compiler.collectBeatBoundaries(shot, allSubjects).forEach((t) => {
      const pct = domainDuration > 0 ? (t / domainDuration) * 100 : 0;
      const tick = document.createElement('div');
      tick.className = 'direction-beat-tick';
      tick.style.left = `${pct}%`;
      content.appendChild(tick);

      const tickLabel = document.createElement('div');
      tickLabel.className = 'direction-beat-label';
      tickLabel.style.left = `${pct}%`;
      tickLabel.textContent = `${t.toFixed(1)}s`;
      content.appendChild(tickLabel);
    });

    beatPairsFor(shot, allSubjects).forEach((pair) => {
      content.appendChild(buildBeatSpan(shot, pair.start, pair.end, domainDuration));
    });

    MSE.laneWidget.appendOverhangBand(content, duration, domainDuration, OVERHANG_TITLE);

    return row;
  }

  // Notes whose (start, end) no longer matches any current beat boundary
  // pair (a segment moved since the note was written) - flagged rather than
  // silently dropped on the next render, so nothing the user wrote is ever
  // lost without an explicit delete.
  function buildBeatOrphansRow(shot, allSubjects) {
    const row = document.createElement('div');
    row.className = 'direction-beat-orphans';
    const pairs = beatPairsFor(shot, allSubjects);
    const notes = shot.direction.beatNotes || [];
    const orphaned = notes
      .map((note, index) => ({ note, index }))
      .filter(({ note }) => !pairs.some((pair) => beatPairMatches(pair, note.startSeconds, note.endSeconds)));

    row.hidden = orphaned.length === 0;
    if (orphaned.length === 0) return row;

    const label = document.createElement('div');
    label.className = 'direction-beat-orphans-label';
    label.textContent = `${orphaned.length} unattached beat note${orphaned.length > 1 ? 's' : ''} (boundary moved since written):`;
    row.appendChild(label);

    orphaned.forEach(({ note, index }) => {
      const chip = document.createElement('span');
      chip.className = 'direction-constraint-chip';
      chip.textContent = note.intent || note.priority || note.endState || `${note.startSeconds.toFixed(2)}s–${note.endSeconds.toFixed(2)}s`;
      chip.appendChild(buildRemoveButton(() => shotsApi.removeBeatNote(shot.id, index)));
      row.appendChild(chip);
    });

    return row;
  }

  // Read-only point markers for this shot's vocal cues (MSE.vocalCues, Phase
  // 2) - not built through laneWidget.buildSegment, same reasoning as
  // buildBeatSpan: a cue is authored on the main timeline (waveformSync.js),
  // never dragged from here. Positioned against the same domainDuration as
  // every other row, but MSE.vocalCues.forShot() already excludes anything
  // at/after shot.endSeconds, so a cue never appears inside H3's render
  // overhang even though the row's own band reaches that far.
  function buildCueRow(shot, duration, domainDuration) {
    const row = document.createElement('div');
    row.className = 'direction-lane-row direction-cue-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'direction-lane-label';
    labelEl.textContent = 'Vocal Cues';
    labelEl.title = 'Project vocal cues inside this shot - authored on the main timeline; drag a segment edge onto one to snap to it';
    row.appendChild(labelEl);

    const content = document.createElement('div');
    content.className = 'direction-lane-content';
    row.appendChild(content);

    MSE.vocalCues.forShot(shot).forEach((cue) => {
      const pct = domainDuration > 0 ? (cue.relativeTimeSeconds / domainDuration) * 100 : 0;
      const title = `${cue.label || '(untitled cue)'} · ${cue.relativeTimeSeconds.toFixed(2)}s`;

      const marker = document.createElement('div');
      marker.className = 'direction-cue-marker';
      marker.style.left = `${pct}%`;

      const dot = document.createElement('div');
      dot.className = 'direction-cue-dot';
      dot.title = title;
      marker.appendChild(dot);

      const labelSpan = document.createElement('div');
      labelSpan.className = 'direction-cue-label';
      labelSpan.textContent = cue.label || '(untitled)';
      labelSpan.title = title;
      marker.appendChild(labelSpan);

      content.appendChild(marker);
    });

    MSE.laneWidget.appendOverhangBand(content, duration, domainDuration, OVERHANG_TITLE);

    return row;
  }

  // Phase 4a: read-only reference rows for the current transient Phrase/
  // Hold analysis result (see lyricsAlign.js's getCurrentRegions) - same
  // non-laneWidget, click-through-only convention as buildCueRow above (a
  // region is authored on the Lyrics tab, never dragged/resized/renamed
  // from here). Always rendered, even with zero regions for this shot (or
  // no analysis result at all) - an empty row, never a broken placeholder,
  // matches buildCueRow's own behavior when a shot has no cues. Right-click
  // a span to create a Camera/Character segment from it, or fit the
  // currently selected segment to it - see setupRegionContextMenu().
  function buildVocalRegionRow(shot, label, regions, kind, duration, domainDuration) {
    const row = document.createElement('div');
    row.className = 'direction-lane-row direction-region-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'direction-lane-label';
    labelEl.textContent = label;
    labelEl.title = `${label} - transient timing analysis from the Lyrics tab; right-click a span to create or fit a Direction segment from it`;
    row.appendChild(labelEl);

    const content = document.createElement('div');
    content.className = 'direction-lane-content';
    row.appendChild(content);

    MSE.vocalRegions.regionsForShot(regions, shot).forEach((region) => {
      const pct = domainDuration > 0 ? (region.relativeStartSeconds / domainDuration) * 100 : 0;
      const widthPct = domainDuration > 0 ? Math.max(0, (region.relativeEndSeconds - region.relativeStartSeconds) / domainDuration) * 100 : 0;

      const span = document.createElement('div');
      span.className = `direction-region-segment direction-region-segment-${kind}`;
      span.style.left = `${pct}%`;
      span.style.width = `${widthPct}%`;
      span.textContent = region.text;
      span.title = `${region.text} · ${region.relativeStartSeconds.toFixed(2)}s – ${region.relativeEndSeconds.toFixed(2)}s (right-click to create/fit a Direction segment)`;
      span.dataset.regionKind = kind;
      span.dataset.regionId = region.id;
      content.appendChild(span);
    });

    MSE.laneWidget.appendOverhangBand(content, duration, domainDuration, OVERHANG_TITLE);

    return row;
  }

  // Bulk convenience over the same per-beat isCut primitive the beat detail
  // panel edits one at a time (see shots.js's applyBurstBeats) - shown
  // unconditionally (unlike the beat/orphans rows below, which only appear
  // once there's direction content to derive beats from), since Burst's own
  // job is to create that content from scratch.
  function buildBurstToolbarRow(shot) {
    const row = document.createElement('div');
    row.className = 'direction-burst-toolbar';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Burst…';
    btn.title = 'Populate this shot with evenly-spaced hard-cut beats (replaces the Camera lane)';
    btn.addEventListener('click', () => MSE.burstBeatsModal.open(shot.id));
    row.appendChild(btn);
    return row;
  }

  function renderLanes(shot) {
    el.lanes.innerHTML = '';
    directionPlayheadEls = [];
    const duration = shotsApi.shotDuration(shot);
    if (duration <= 0) return;

    // domainDuration extends past the shot's cut point to cover H3's render
    // padding (see frameMath.js) whenever the frame-rule stride demands one -
    // every row is positioned against this same wider span so the padding
    // lines up as one continuous band across all of them.
    const calc = MSE.frames.frameCalc(duration, state.video);
    const domainDuration = duration + calc.overhangSeconds;

    const direction = shot.direction || { camera: [], lighting: [], subjects: {}, props: {}, beatNotes: [] };

    el.lanes.appendChild(buildGridRow(shot, duration, domainDuration));
    el.lanes.appendChild(buildCueRow(shot, duration, domainDuration));
    const regions = currentRegions();
    el.lanes.appendChild(buildVocalRegionRow(shot, 'Vocal Phrases', regions.phrases, 'phrase', duration, domainDuration));
    el.lanes.appendChild(buildVocalRegionRow(shot, 'Vocal Holds', regions.holds, 'hold', duration, domainDuration));
    el.lanes.appendChild(buildBurstToolbarRow(shot));

    el.lanes.appendChild(
      buildLaneRow('Camera', direction.camera || [], duration, domainDuration, {
        kind: 'camera',
        onAdd: () => {
          const start = MSE.laneWidget.nextSegmentStart(direction.camera || []);
          shotsApi.addCameraSegment(shot.id, { startSeconds: start, endSeconds: duration });
        },
      })
    );

    // Independent over time from Camera/Character (see docs/h3-shot-
    // direction-roadmap.md Phase 4b) - its own lane, not folded into either.
    el.lanes.appendChild(
      buildLaneRow('Lighting', direction.lighting || [], duration, domainDuration, {
        kind: 'lighting',
        onAdd: () => {
          const start = MSE.laneWidget.nextSegmentStart(direction.lighting || []);
          shotsApi.addLightingSegment(shot.id, { startSeconds: start, endSeconds: duration });
        },
      })
    );

    const allSubjects = MSE.h3Compiler.orderedSubjects(shot);
    const actingSubjects = allSubjects.filter((s) => MSE.h3Compiler.isActingRole(s.role));
    actingSubjects.forEach((s) => {
      const track = (direction.subjects && direction.subjects[s.assetId]) || [];
      el.lanes.appendChild(
        buildLaneRow(s.asset ? MSE.format.stripFileExtension(s.asset.fileName) : s.assetId, track, duration, domainDuration, {
          kind: 'subject',
          assetId: s.assetId,
          onAdd: () => {
            const start = MSE.laneWidget.nextSegmentStart(track);
            shotsApi.addSubjectSegment(shot.id, s.assetId, { startSeconds: start, endSeconds: duration });
          },
        })
      );
    });

    const propSubjects = allSubjects.filter((s) => s.role === 'prop');
    propSubjects.forEach((s) => {
      const track = (direction.props && direction.props[s.assetId]) || [];
      el.lanes.appendChild(
        buildLaneRow(s.asset ? MSE.format.stripFileExtension(s.asset.fileName) : s.assetId, track, duration, domainDuration, {
          kind: 'prop',
          assetId: s.assetId,
          onAdd: () => {
            const start = MSE.laneWidget.nextSegmentStart(track);
            shotsApi.addPropSegment(shot.id, s.assetId, { startSeconds: start, endSeconds: duration });
          },
        })
      );
    });

    const hasAnyDirectionContent = (direction.camera || []).length > 0
      || (direction.lighting || []).length > 0
      || actingSubjects.some((s) => ((direction.subjects || {})[s.assetId] || []).length > 0)
      || propSubjects.some((s) => ((direction.props || {})[s.assetId] || []).length > 0);
    if (hasAnyDirectionContent) {
      el.lanes.appendChild(buildBeatRow(shot, allSubjects, duration, domainDuration));
      el.lanes.appendChild(buildBeatOrphansRow(shot, allSubjects));
    }

    directionPlayheadEls = Array.from(el.lanes.querySelectorAll('.direction-lane-content')).map((content) => {
      const seg = document.createElement('div');
      seg.className = 'playhead-segment';
      content.appendChild(seg);
      return seg;
    });
    updateDirectionPlayhead();
  }

  // Synced to the main Grid/Shots/Mix/Vocal playhead via
  // MSE.sync.onPlayheadTick (see waveformSync.js) - hidden whenever the
  // current position falls outside the shot this tab is currently showing,
  // since every row here is scoped to just that one shot.
  function updateDirectionPlayhead() {
    if (!directionPlayheadEls.length) return;
    const shot = findShot(currentShotId);
    if (!shot) return;
    const duration = shotsApi.shotDuration(shot);
    const calc = MSE.frames.frameCalc(duration, state.video);
    const domainDuration = duration + calc.overhangSeconds;
    const currentTime = MSE.sync.getCurrentTime();
    const pct = domainDuration > 0 ? ((currentTime - shot.startSeconds) / domainDuration) * 100 : 0;
    const visible = pct >= 0 && pct <= 100;
    directionPlayheadEls.forEach((el) => {
      el.style.display = visible ? '' : 'none';
      if (visible) el.style.left = `${pct}%`;
    });
  }

  // A beat can't be deleted (its boundaries are derived, not authored), only
  // its note content cleared by emptying the fields - so no remove button on
  // its header, unlike segment detail below.
  function renderBeatDetail(shot) {
    const allSubjects = MSE.h3Compiler.orderedSubjects(shot);
    const stillExists = beatPairsFor(shot, allSubjects).some((pair) => beatPairMatches(pair, selection.startSeconds, selection.endSeconds));
    if (!stillExists) {
      selection = null;
      el.segmentDetail.hidden = true;
      return;
    }
    el.segmentDetail.hidden = false;

    const header = document.createElement('div');
    header.className = 'direction-segment-detail-header';
    const timeLabel = document.createElement('span');
    timeLabel.textContent = `Beat ${selection.startSeconds.toFixed(2)}s – ${selection.endSeconds.toFixed(2)}s`;
    header.appendChild(timeLabel);
    el.segmentDetail.appendChild(header);

    const note = MSE.h3Compiler.findBeatNote(shot, selection.startSeconds, selection.endSeconds) || {};
    const row = document.createElement('div');
    row.className = 'direction-row';
    row.appendChild(
      buildCheckboxInput(note.isCut, 'Hard cut before this beat', (v) =>
        shotsApi.upsertBeatNote(shot.id, selection.startSeconds, selection.endSeconds, { isCut: v })
      )
    );
    row.appendChild(
      buildField('Intent', buildTextInput(note.intent, 'e.g. she appears determined', (v) => shotsApi.upsertBeatNote(shot.id, selection.startSeconds, selection.endSeconds, { intent: v })))
    );
    row.appendChild(
      buildField('Priority', buildTextInput(note.priority, 'what matters more here', (v) => shotsApi.upsertBeatNote(shot.id, selection.startSeconds, selection.endSeconds, { priority: v })))
    );
    row.appendChild(
      buildField(
        'End state',
        buildTextInput(note.endState, 'by the end of this beat...', (v) => shotsApi.upsertBeatNote(shot.id, selection.startSeconds, selection.endSeconds, { endState: v })),
        true
      )
    );
    el.segmentDetail.appendChild(row);
  }

  function renderSegmentDetail(shot) {
    el.segmentDetail.innerHTML = '';
    if (!selection) {
      el.segmentDetail.hidden = true;
      return;
    }
    if (selection.kind === 'beat') {
      renderBeatDetail(shot);
      return;
    }
    const segments = selection.kind === 'camera'
      ? (shot.direction.camera || [])
      : selection.kind === 'lighting'
        ? (shot.direction.lighting || [])
        : selection.kind === 'prop'
          ? ((shot.direction.props && shot.direction.props[selection.assetId]) || [])
          : ((shot.direction.subjects && shot.direction.subjects[selection.assetId]) || []);
    const seg = segments[selection.index];
    if (!seg) {
      selection = null;
      el.segmentDetail.hidden = true;
      return;
    }
    el.segmentDetail.hidden = false;

    const header = document.createElement('div');
    header.className = 'direction-segment-detail-header';
    const timeLabel = document.createElement('span');
    timeLabel.textContent = `${seg.startSeconds.toFixed(2)}s – ${seg.endSeconds.toFixed(2)}s`;
    header.appendChild(timeLabel);
    header.appendChild(
      buildRemoveButton(() => {
        if (selection.kind === 'camera') shotsApi.removeCameraSegment(shot.id, selection.index);
        else if (selection.kind === 'lighting') shotsApi.removeLightingSegment(shot.id, selection.index);
        else if (selection.kind === 'prop') shotsApi.removePropSegment(shot.id, selection.assetId, selection.index);
        else shotsApi.removeSubjectSegment(shot.id, selection.assetId, selection.index);
        selection = null;
      })
    );
    el.segmentDetail.appendChild(header);

    const row = document.createElement('div');
    row.className = 'direction-row';
    if (selection.kind === 'camera') {
      const movementOptions = shotsApi.CAMERA_MOVEMENTS.map((m) => [m, MOVEMENT_LABELS[m] || m]);
      row.appendChild(buildField('Movement', buildSelect(movementOptions, seg.movement, (v) => shotsApi.updateCameraSegment(shot.id, selection.index, { movement: v }))));
      row.appendChild(buildField('Framing', buildTextInput(seg.framing, 'e.g. medium-wide', (v) => shotsApi.updateCameraSegment(shot.id, selection.index, { framing: v }))));
      const speedInput = buildTextInput(seg.speed, 'e.g. slow', (v) => shotsApi.updateCameraSegment(shot.id, selection.index, { speed: v }));
      speedInput.setAttribute('list', 'direction-speed-suggestions');
      row.appendChild(buildField('Speed', speedInput));

      const amplitudeOptions = shotsApi.CAMERA_AMPLITUDES.map((a) => [a, CAMERA_AMPLITUDE_LABELS[a] || a]);
      row.appendChild(buildField('Amplitude', buildSelect(amplitudeOptions, seg.amplitude, (v) => shotsApi.updateCameraSegment(shot.id, selection.index, { amplitude: v }))));

      const directionOptions = shotsApi.CAMERA_DIRECTIONS.map((d) => [d, CAMERA_DIRECTION_LABELS[d] || d]);
      row.appendChild(buildField('Direction', buildSelect(directionOptions, seg.direction, (v) => shotsApi.updateCameraSegment(shot.id, selection.index, { direction: v }))));
      row.appendChild(buildField('Target', buildTextInput(seg.target, 'reference point', (v) => shotsApi.updateCameraSegment(shot.id, selection.index, { target: v })), true));

      // Optics (Phase 4b) - `target` above is movement/composition intent;
      // `focusTarget` here is the optical focus target, a distinct concept
      // (see h3-shot-direction-roadmap.md Phase 4b: "target -> movement/
      // composition target, focusTarget -> optical focus target").
      const focalLengthInput = buildTextInput(seg.focalLength, 'e.g. 85mm', (v) => shotsApi.updateCameraSegment(shot.id, selection.index, { focalLength: v }));
      focalLengthInput.setAttribute('list', 'direction-focal-length-suggestions');
      row.appendChild(buildField('Focal length', focalLengthInput));
      const dofOptions = shotsApi.DEPTH_OF_FIELDS.map((v) => [v, DEPTH_OF_FIELD_LABELS[v] || v]);
      row.appendChild(buildField('Depth of field', buildSelect(dofOptions, seg.depthOfField, (v) => shotsApi.updateCameraSegment(shot.id, selection.index, { depthOfField: v }))));
      row.appendChild(buildField('Focus target', buildTextInput(seg.focusTarget, 'e.g. face', (v) => shotsApi.updateCameraSegment(shot.id, selection.index, { focusTarget: v })), true));

      row.appendChild(
        buildField(
          'Transition to next',
          buildTextInput(seg.transitionToNext, 'e.g. hard cut, dissolve...', (v) => shotsApi.updateCameraSegment(shot.id, selection.index, { transitionToNext: v })),
          true
        )
      );
    } else if (selection.kind === 'lighting') {
      row.appendChild(
        buildField(
          'Key light',
          buildTextInput(seg.keyLight, 'e.g. warm stage key from camera-left', (v) => shotsApi.updateLightingSegment(shot.id, selection.index, { keyLight: v })),
          true
        )
      );
      row.appendChild(buildField('Fill', buildTextInput(seg.fill, 'e.g. minimal', (v) => shotsApi.updateLightingSegment(shot.id, selection.index, { fill: v }))));
      row.appendChild(buildField('Backlight', buildTextInput(seg.backlight, 'e.g. subtle amber rim', (v) => shotsApi.updateLightingSegment(shot.id, selection.index, { backlight: v }))));
      const exposureOptions = shotsApi.LIGHTING_EXPOSURES.map((v) => [v, LIGHTING_EXPOSURE_LABELS[v] || v]);
      row.appendChild(buildField('Exposure', buildSelect(exposureOptions, seg.exposure, (v) => shotsApi.updateLightingSegment(shot.id, selection.index, { exposure: v }))));
      row.appendChild(
        buildField('Atmosphere', buildTextInput(seg.atmosphere, 'e.g. dark smoky club', (v) => shotsApi.updateLightingSegment(shot.id, selection.index, { atmosphere: v })), true)
      );
      row.appendChild(
        buildField('Notes', buildTextInput(seg.notes, 'notes...', (v) => shotsApi.updateLightingSegment(shot.id, selection.index, { notes: v })), true)
      );
    } else if (selection.kind === 'prop') {
      const actingSubjects = MSE.h3Compiler.orderedSubjects(shot).filter((s) => MSE.h3Compiler.isActingRole(s.role));
      const ownerOptions = [['', 'Unowned']].concat(
        actingSubjects.map((s) => [s.assetId, s.asset ? MSE.format.stripFileExtension(s.asset.fileName) : s.assetId])
      );
      row.appendChild(buildField('Owner', buildSelect(ownerOptions, seg.ownerAssetId || '', (v) => shotsApi.updatePropSegment(shot.id, selection.assetId, selection.index, { ownerAssetId: v || null }))));
      row.appendChild(buildField('State', buildTextInput(seg.state, 'e.g. on saucer', (v) => shotsApi.updatePropSegment(shot.id, selection.assetId, selection.index, { state: v }))));
      row.appendChild(
        buildField(
          'Notes',
          buildTextInput(seg.notes, 'notes...', (v) => shotsApi.updatePropSegment(shot.id, selection.assetId, selection.index, { notes: v })),
          true
        )
      );
    } else {
      const actionTypeOptions = shotsApi.ACTION_TYPES.map((t) => [t, ACTION_TYPE_LABELS[t] || t]);
      row.appendChild(buildField('Action', buildSelect(actionTypeOptions, seg.actionType, (v) => shotsApi.updateSubjectSegment(shot.id, selection.assetId, selection.index, { actionType: v }))));
      const vocalPerformanceOptions = shotsApi.VOCAL_PERFORMANCES.map((v) => [v, VOCAL_PERFORMANCE_LABELS[v] || v]);
      row.appendChild(buildField('Vocal performance', buildSelect(vocalPerformanceOptions, seg.vocalPerformance, (v) => shotsApi.updateSubjectSegment(shot.id, selection.assetId, selection.index, { vocalPerformance: v }))));
      row.appendChild(buildField('Manner', buildTextInput(seg.manner, 'e.g. confident', (v) => shotsApi.updateSubjectSegment(shot.id, selection.assetId, selection.index, { manner: v }))));
      row.appendChild(buildField('Gaze', buildTextInput(seg.gaze, 'gaze target', (v) => shotsApi.updateSubjectSegment(shot.id, selection.assetId, selection.index, { gaze: v }))));
      const eyesOptions = shotsApi.EYE_STATES.map((v) => [v, EYES_LABELS[v] || v]);
      row.appendChild(buildField('Eyes', buildSelect(eyesOptions, seg.eyes, (v) => shotsApi.updateSubjectSegment(shot.id, selection.assetId, selection.index, { eyes: v }))));
      row.appendChild(buildField('Expression', buildTextInput(seg.expression, 'expression', (v) => shotsApi.updateSubjectSegment(shot.id, selection.assetId, selection.index, { expression: v }))));
      row.appendChild(
        buildField(
          'Gesture',
          buildTextInput(seg.gesture, 'e.g. both hands grip microphone', (v) => shotsApi.updateSubjectSegment(shot.id, selection.assetId, selection.index, { gesture: v })),
          true
        )
      );
      const bodyMotionInput = buildTextInput(seg.bodyMotion, 'e.g. restrained', (v) => shotsApi.updateSubjectSegment(shot.id, selection.assetId, selection.index, { bodyMotion: v }));
      bodyMotionInput.setAttribute('list', 'direction-body-motion-suggestions');
      row.appendChild(buildField('Body motion', bodyMotionInput));
      row.appendChild(
        buildField(
          'Director’s notes',
          buildTextInput(seg.notes, 'notes...', (v) => shotsApi.updateSubjectSegment(shot.id, selection.assetId, selection.index, { notes: v })),
          true
        )
      );
    }
    el.segmentDetail.appendChild(row);
  }

  // Shot-wide continuity rules (see the Direction structured-editor
  // discussion) - deliberately rendered above the lanes, not attached to any
  // one segment, since they apply to the shot as a whole.
  function renderConstraints(shot) {
    el.constraintsList.innerHTML = '';
    (shot.constraints || []).forEach((text, index) => {
      const chip = document.createElement('span');
      chip.className = 'direction-constraint-chip';
      chip.textContent = text;
      chip.appendChild(
        buildRemoveButton(() => {
          const next = (shot.constraints || []).slice();
          next.splice(index, 1);
          shotsApi.setShotConstraints(shot.id, next);
        })
      );
      el.constraintsList.appendChild(chip);
    });
  }

  function renderAll() {
    const shot = findShot(currentShotId);
    if (!shot) return;
    el.modalTitle.textContent = `Direction — Shot #${shot.id}`;
    renderConstraints(shot);
    renderLanes(shot);
    renderSegmentDetail(shot);
  }

  // Percentage-based segment positioning means the same live DOM subtree
  // just reflows correctly at whatever width its new parent gives it - no
  // re-render needed on expand/collapse, only a reparent.
  function expand() {
    el.modalBody.appendChild(el.lanesRoot);
    el.overlay.hidden = false;
    el.expandBtn.hidden = true;
  }

  function collapse() {
    el.tabDetailContainer.appendChild(el.lanesRoot);
    el.overlay.hidden = true;
    el.expandBtn.hidden = false;
  }

  // Right-click menu on a segment: split/duplicate/toggle-enabled/merge with
  // next/delete, same shared implementation the main Shots track's own
  // (delete-only) context menu goes through (see contextMenu.js). Delegated
  // on el.lanes rather than per-segment so it keeps working across
  // re-renders and the inline<->modal reparent without rewiring.
  function setupSegmentContextMenu() {
    const buttons = [
      el.segmentContextSplit,
      el.segmentContextDuplicate,
      el.segmentContextToggle,
      el.segmentContextMerge,
      el.segmentContextDelete,
    ];
    if (!el.segmentContextMenu || buttons.some((b) => !b)) return;

    function clearSelectionIfTarget(target) {
      if (selection && selection.kind === target.kind && selection.index === target.index && selection.assetId === target.assetId) {
        selection = null;
      }
    }

    // Camera/lighting/subject/prop mutators live in shots.js as four
    // parallel families (same shape, different track) - this just picks the
    // right one by target.kind instead of repeating the four-way branch in
    // every action below.
    function dispatchByKind(kind, cameraFn, subjectFn, propFn, lightingFn) {
      if (kind === 'camera') return cameraFn();
      if (kind === 'lighting') return lightingFn();
      if (kind === 'prop') return propFn();
      return subjectFn();
    }

    MSE.contextMenu.create({
      container: el.lanes,
      menuEl: el.segmentContextMenu,
      resolveTarget: (e) => {
        const segEl = e.target.closest('.lane-segment');
        if (!segEl) return null;
        return {
          kind: segEl.dataset.kind,
          assetId: segEl.dataset.assetId || null,
          index: Number(segEl.dataset.index),
          clientX: e.clientX,
        };
      },
      actions: [
        {
          btn: el.segmentContextSplit,
          onClick: (target) => {
            const shot = findShot(currentShotId);
            if (!shot) return;
            const atTime = directionTimeAtClientX(shot, target.clientX);
            const ok = dispatchByKind(
              target.kind,
              () => shotsApi.splitCameraSegment(currentShotId, target.index, atTime),
              () => shotsApi.splitSubjectSegment(currentShotId, target.assetId, target.index, atTime),
              () => shotsApi.splitPropSegment(currentShotId, target.assetId, target.index, atTime),
              () => shotsApi.splitLightingSegment(currentShotId, target.index, atTime)
            );
            if (ok) clearSelectionIfTarget(target);
          },
        },
        {
          btn: el.segmentContextDuplicate,
          onClick: (target) => {
            if (currentShotId === null) return;
            dispatchByKind(
              target.kind,
              () => shotsApi.duplicateCameraSegment(currentShotId, target.index),
              () => shotsApi.duplicateSubjectSegment(currentShotId, target.assetId, target.index),
              () => shotsApi.duplicatePropSegment(currentShotId, target.assetId, target.index),
              () => shotsApi.duplicateLightingSegment(currentShotId, target.index)
            );
          },
        },
        {
          btn: el.segmentContextToggle,
          onClick: (target) => {
            if (currentShotId === null) return;
            dispatchByKind(
              target.kind,
              () => shotsApi.toggleCameraSegmentEnabled(currentShotId, target.index),
              () => shotsApi.toggleSubjectSegmentEnabled(currentShotId, target.assetId, target.index),
              () => shotsApi.togglePropSegmentEnabled(currentShotId, target.assetId, target.index),
              () => shotsApi.toggleLightingSegmentEnabled(currentShotId, target.index)
            );
          },
        },
        {
          btn: el.segmentContextMerge,
          onClick: (target) => {
            const ok = dispatchByKind(
              target.kind,
              () => shotsApi.mergeCameraSegments(currentShotId, target.index),
              () => shotsApi.mergeSubjectSegments(currentShotId, target.assetId, target.index),
              () => shotsApi.mergePropSegments(currentShotId, target.assetId, target.index),
              () => shotsApi.mergeLightingSegments(currentShotId, target.index)
            );
            if (ok) clearSelectionIfTarget(target);
          },
        },
        {
          btn: el.segmentContextDelete,
          onClick: (target) => {
            if (currentShotId === null) return;
            clearSelectionIfTarget(target);
            dispatchByKind(
              target.kind,
              () => shotsApi.removeCameraSegment(currentShotId, target.index),
              () => shotsApi.removeSubjectSegment(currentShotId, target.assetId, target.index),
              () => shotsApi.removePropSegment(currentShotId, target.assetId, target.index),
              () => shotsApi.removeLightingSegment(currentShotId, target.index)
            );
          },
        },
      ],
    });
  }

  // Phase 4a region -> segment creation/fit. All three read only a
  // projected region's relativeStartSeconds/relativeEndSeconds (Phase 3b's
  // own canonical shot-relative clip, see vocalRegions.js's regionsForShot)
  // and never store the region's id anywhere - once created, the resulting
  // Direction segment is ordinary numeric timing indistinguishable from one
  // typed in by hand. See the module doc comment at the top of this file's
  // region-authoring section in docs/h3-shot-direction-roadmap.md.
  //
  // Camera gets no inferred fields beyond the timing - addCameraSegment's
  // own defaults (same ones the '+' add tile already uses) apply as-is;
  // "WHEN", never "WHAT".
  function createCameraSegmentFromRegion(shot, region) {
    const start = region.relativeStartSeconds;
    const end = region.relativeEndSeconds;
    if (end - start <= 0) return;
    shotsApi.addCameraSegment(shot.id, { startSeconds: start, endSeconds: end });
  }

  // A Hold (a sustained vocal note) gets a conservative actionType/
  // vocalPerformance default (sing/lip_sync) since that's the one inference
  // directly implied by "this word was held" - never eyes/gesture/
  // expression/bodyMotion, which are directorial choices left blank for the
  // user. A Phrase carries no such implication (a sung phrase's overall
  // performance style isn't determinable from timing alone), so it starts
  // fully blank.
  function createCharacterSegmentFromRegion(shot, assetId, region, regionKind) {
    const start = region.relativeStartSeconds;
    const end = region.relativeEndSeconds;
    if (end - start <= 0) return;
    const defaults = regionKind === 'hold' ? { actionType: 'sing', vocalPerformance: 'lip_sync' } : {};
    shotsApi.addSubjectSegment(shot.id, assetId, { startSeconds: start, endSeconds: end, ...defaults });
  }

  // Replaces the currently selected Camera/Character segment's timing with
  // the region's shot-relative visible bounds - a plain numeric edit, same
  // as any other drag/resize, via the existing clamped edge movers (never
  // shotsApi.updateXSegment, which resorts the array and would strand
  // `selection.index` if the new timing crosses a neighbor). Moves
  // whichever edge shrinks the segment first so the intermediate state
  // (after only one edge has moved) never has start > end.
  function fitSelectedSegmentToRegion(shot, region) {
    if (!selection || !['camera', 'lighting', 'subject'].includes(selection.kind)) return;
    const start = region.relativeStartSeconds;
    const end = region.relativeEndSeconds;
    if (end - start <= 0) return;
    const segments = selection.kind === 'camera'
      ? shot.direction.camera
      : selection.kind === 'lighting'
        ? shot.direction.lighting
        : (shot.direction.subjects || {})[selection.assetId];
    const seg = segments && segments[selection.index];
    if (!seg) return;
    const moveEdge = (side, time) => {
      if (selection.kind === 'camera') return shotsApi.moveCameraSegmentEdge(shot.id, selection.index, side, time);
      if (selection.kind === 'lighting') return shotsApi.moveLightingSegmentEdge(shot.id, selection.index, side, time);
      return shotsApi.moveSubjectSegmentEdge(shot.id, selection.assetId, selection.index, side, time);
    };
    if (end >= seg.startSeconds) {
      moveEdge('end', end);
      moveEdge('start', start);
    } else {
      moveEdge('start', start);
      moveEdge('end', end);
    }
    shotsApi.notifyDirectionChanged();
  }

  // Right-click menu on a Vocal Phrase/Hold span: create a Camera segment,
  // create a Character segment (one button per acting subject, built fresh
  // on every open since the cast can change between shots), or fit the
  // currently selected segment to this region. Delegated on el.lanes via
  // the shared contextMenu.js implementation, same as
  // setupSegmentContextMenu - a second, purpose-built menu rather than
  // trying to fold dynamic per-character buttons into that one's fixed
  // action list.
  function setupRegionContextMenu() {
    if (!el.regionContextMenu || !el.regionContextCamera || !el.regionContextCharacterList || !el.regionContextFit) return;

    let menu = null;
    menu = MSE.contextMenu.create({
      container: el.lanes,
      menuEl: el.regionContextMenu,
      resolveTarget: (e) => {
        const segEl = e.target.closest('.direction-region-segment');
        if (!segEl) return null;
        const shot = findShot(currentShotId);
        if (!shot) return null;
        const kind = segEl.dataset.regionKind;
        const regions = kind === 'hold' ? currentRegions().holds : currentRegions().phrases;
        const region = MSE.vocalRegions.regionsForShot(regions, shot).find((r) => r.id === segEl.dataset.regionId);
        if (!region) return null;

        // Built fresh here (before the menu becomes visible) rather than
        // once at init - the acting cast can differ per shot.
        el.regionContextCharacterList.innerHTML = '';
        const actingSubjects = MSE.h3Compiler.orderedSubjects(shot).filter((s) => MSE.h3Compiler.isActingRole(s.role));
        actingSubjects.forEach((s) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = `Create Character segment (${s.asset ? MSE.format.stripFileExtension(s.asset.fileName) : s.assetId})`;
          btn.addEventListener('click', () => {
            createCharacterSegmentFromRegion(shot, s.assetId, region, kind);
            if (menu) menu.hide();
          });
          el.regionContextCharacterList.appendChild(btn);
        });

        el.regionContextFit.hidden = !(selection && ['camera', 'lighting', 'subject'].includes(selection.kind));

        return { shot, region };
      },
      actions: [
        { btn: el.regionContextCamera, onClick: (target) => createCameraSegmentFromRegion(target.shot, target.region) },
        { btn: el.regionContextFit, onClick: (target) => fitSelectedSegmentToRegion(target.shot, target.region) },
      ],
    });
  }

  const H3_RECOMMENDED_MIN_WORDS = 350;

  // CUTTAlogue's current generation adapter always uses R2V and supplies the
  // stored vocal stem as ref_audio_0. Keep compilation explicit about that
  // runtime contract instead of inferring mode from image count alone.
  const H3_GENERATION_COMPILER_OPTIONS = Object.freeze({
    mode: 'reference',
    hasVocalReference: true,
  });
  // H3's own hard API limit (see the "getting close" warning below, which
  // fires ahead of this at 6000). A prompt over this is guaranteed to be
  // rejected by the provider - never write one into shot.prompt, whether it
  // came from the deterministic Compile or an AI expansion that ran long
  // despite its own instructions not to pad length (see expand.py's
  // SYSTEM_PROMPT).
  const H3_MAX_PROMPT_CHARS = 7000;

  function wordCount(text) {
    const trimmed = (text || '').trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }

  // Shared by both the deterministic Compile and the AI-expanded path -
  // surfaces the word-count gap against H3's own 350-500 word expectation
  // for detailed_description without ever fabricating content to close it
  // itself; the human decides whether to add more detail or use "Expand
  // with AI".
  function compileStatusText(fullText, detailedDescription) {
    const words = wordCount(detailedDescription);
    const nearLimit = fullText.length > 6000 ? ' - getting close to the 7,000-character API limit' : '';
    const wordNote = words < H3_RECOMMENDED_MIN_WORDS
      ? ` - H3 recommends 350-500 words for detailed_description; try "Expand with AI" or add more detail`
      : '';
    return `Compiled (${fullText.length} characters, ${words} words)${nearLimit}${wordNote}.`;
  }

  function setCompileStatus(text, spinning) {
    el.compileStatusText.textContent = text;
    el.compileSpinner.hidden = !spinning;
  }

  // The in-flight "Expand with AI" job id, if any - lets the Cancel button
  // (shown only while this is set) call MSE.api.cancelJob without a second
  // job-tracking mechanism, same convention as taskPanel.js's activeJobId.
  let activeExpandJobId = null;

  // The one place a compiled/expanded prompt is actually written into
  // shot.prompt - shared by both wire() handlers below so the 7000-char
  // safety net can't be bypassed by either path. Over the limit, the
  // previous prompt is left untouched rather than saving something H3 would
  // reject outright; the human has to shorten Direction detail (or ask for
  // a shorter AI expansion) and recompile.
  function applyCompiledPrompt(shot, text, detailedDescription) {
    if (text.length > H3_MAX_PROMPT_CHARS) {
      setCompileStatus(
        `Not applied: compiled prompt is ${text.length} characters, over H3's ${H3_MAX_PROMPT_CHARS}-character limit. Shorten the shot's Direction detail and try again.`
      );
      return;
    }
    shotsApi.setShotPrompt(shot.id, text);
    setCompileStatus(compileStatusText(text, detailedDescription));
  }

  function wire() {
    el.snapToggle.addEventListener('click', () => setSnapEnabled(!snapEnabled));
    el.expandBtn.addEventListener('click', expand);
    el.closeBtn.addEventListener('click', collapse);
    el.overlay.addEventListener('click', (e) => {
      if (e.target === el.overlay) collapse();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.overlay.hidden) collapse();
    });

    // Explicit, one-shot action - never runs on save or automatically. Writes
    // into the same prompt field the user can otherwise type into directly,
    // exactly like [Describe image] does for asset descriptions.
    el.compileBtn.addEventListener('click', () => {
      const shot = findShot(currentShotId);
      if (!shot) return;
      const sections = MSE.h3Compiler.compileH3Sections(shot, H3_GENERATION_COMPILER_OPTIONS);
      const text = MSE.h3Compiler.assembleH3Prompt(sections);
      applyCompiledPrompt(shot, text, sections.detailedDescription);
    });

    // The deferred "LLM-based compiler variant" (see docs/h3-shot-direction-
    // roadmap.md), scoped to just detailed_description - the other five
    // sections stay deterministic and untouched. Same explicit-action/job/
    // SSE pattern as [Describe image] (assetLibrary.js), just without a
    // live-visible field to stream into (Direction and Prompt are separate
    // tabs), so this accumulates the full response before writing once.
    el.expandAiBtn.addEventListener('click', async () => {
      const shot = findShot(currentShotId);
      if (!shot) return;
      const sections = MSE.h3Compiler.compileH3Sections(shot, H3_GENERATION_COMPILER_OPTIONS);
      el.expandAiBtn.disabled = true;
      el.compileBtn.disabled = true;
      el.expandCancelBtn.hidden = false;
      el.expandCancelBtn.disabled = false;
      el.expandCancelBtn.textContent = 'Cancel';
      setCompileStatus('Expanding with AI…', true);
      try {
        const { jobId } = await MSE.api.expandDescription(sections.detailedDescription);
        activeExpandJobId = jobId;
        let expanded = '';
        const result = await MSE.api.watchJob(jobId, (event) => {
          if (event.delta) expanded += event.delta;
        });
        if (result.status === 'cancelled') {
          setCompileStatus('Expand cancelled.');
          return;
        }
        const text = MSE.h3Compiler.assembleH3Prompt({ ...sections, detailedDescription: expanded });
        applyCompiledPrompt(shot, text, expanded);
      } catch (err) {
        console.error(err);
        setCompileStatus(`Expand failed: ${err.message}`);
      } finally {
        activeExpandJobId = null;
        el.expandCancelBtn.hidden = true;
        el.expandAiBtn.disabled = false;
        el.compileBtn.disabled = false;
      }
    });

    // Safety net for a slow/stuck provider call - previously there was no
    // way to interrupt "Expand with AI" short of waiting out the backend's
    // own 120s provider timeout (see expand.py's _stream_expansion, which
    // now checks cancellation between streamed chunks).
    el.expandCancelBtn.addEventListener('click', async () => {
      if (!activeExpandJobId) return;
      el.expandCancelBtn.disabled = true;
      el.expandCancelBtn.textContent = 'Cancelling…';
      try {
        await MSE.api.cancelJob(activeExpandJobId);
      } catch (err) {
        console.error(err);
      }
    });

    on('shot-selected', () => {
      const shot = selectedShot();
      currentShotId = shot ? shot.id : null;
      selection = null;
      setCompileStatus('');
      renderAll();
    });
    on('shots-changed', () => {
      if (currentShotId !== null && !findShot(currentShotId)) {
        currentShotId = null;
        selection = null;
      }
      renderAll();
    });
    on('project-loaded', () => {
      currentShotId = null;
      selection = null;
    });
    // A cue added/renamed/moved/deleted on the main timeline changes what
    // this shot's Vocal Cues row shows and what its segments snap to - both
    // are read fresh from MSE.vocalCues on every renderAll(), no local copy.
    on('vocal-cues-changed', () => renderAll());
    // Same reasoning for the Lyrics tab's transient Phrase/Hold analysis
    // result (re-aligned, threshold changed, or discarded on project load) -
    // read fresh via currentRegions() on every renderAll(), never cached.
    on('vocal-regions-changed', () => renderAll());

    el.constraintsInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const value = el.constraintsInput.value.trim();
      const shot = findShot(currentShotId);
      if (!value || !shot) return;
      shotsApi.setShotConstraints(shot.id, [...(shot.constraints || []), value]);
      el.constraintsInput.value = '';
    });

    setupSegmentContextMenu();
    setupRegionContextMenu();
  }

  function buildSpeedDatalist() {
    const list = document.createElement('datalist');
    list.id = 'direction-speed-suggestions';
    SPEED_SUGGESTIONS.forEach((suggestion) => {
      const opt = document.createElement('option');
      opt.value = suggestion;
      list.appendChild(opt);
    });
    document.body.appendChild(list);
  }

  function buildFocalLengthDatalist() {
    const list = document.createElement('datalist');
    list.id = 'direction-focal-length-suggestions';
    FOCAL_LENGTH_SUGGESTIONS.forEach((suggestion) => {
      const opt = document.createElement('option');
      opt.value = suggestion;
      list.appendChild(opt);
    });
    document.body.appendChild(list);
  }

  function buildBodyMotionDatalist() {
    const list = document.createElement('datalist');
    list.id = 'direction-body-motion-suggestions';
    BODY_MOTION_SUGGESTIONS.forEach((suggestion) => {
      const opt = document.createElement('option');
      opt.value = suggestion;
      list.appendChild(opt);
    });
    document.body.appendChild(list);
  }

  function buildConstraintSuggestionsDatalist() {
    const list = document.createElement('datalist');
    list.id = 'direction-constraint-suggestions';
    CONSTRAINT_SUGGESTIONS.forEach((suggestion) => {
      const opt = document.createElement('option');
      opt.value = suggestion;
      list.appendChild(opt);
    });
    document.body.appendChild(list);
  }

  function init() {
    cacheElements();
    buildSpeedDatalist();
    buildFocalLengthDatalist();
    buildBodyMotionDatalist();
    buildConstraintSuggestionsDatalist();
    el.constraintsInput.setAttribute('list', 'direction-constraint-suggestions');
    wire();
    updateSnapToggle();
    MSE.sync.onPlayheadTick(updateDirectionPlayhead);
  }

  document.addEventListener('DOMContentLoaded', init);

  // snapToDirectionGrid is exposed purely for the regression tests (see
  // frontend/tests/directionSnap.test.js) to exercise the grid+cue+region
  // snap union directly, the same way vocalCues.js's own nearestOf is.
  MSE.direction = { expand, collapse, snapToDirectionGrid };
})(window.MSE = window.MSE || {});
