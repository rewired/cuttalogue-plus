// Creates and synchronizes the timeline: three real WaveSurfer instances
// (Grid, Mix, Vocal) plus the Shots track, which is a plain hand-rolled DOM
// lane (see the "Shots lane" section below, built on laneWidget.js) rather
// than a fourth WaveSurfer instance - shots.js's regions never contained
// real audio, and running them through the Regions plugin meant two
// independent pointer-handling systems (the plugin's own drag/resize and
// this file's hand-rolled create/split) fighting over the same events.
// shotsWs still holds a value once initTimeline runs, but it's a small
// adapter object (setScrollTime/zoom/setTime), not a real WS instance - see
// initTimeline - so it can keep participating in forEachInstance/
// wireScrollSync/zoomTo without those needing a special case.
// Shared zoom, shared scroll, shared playhead, unified seeking, A/B playback
// switching, and the Timeline/Hover plugin wiring.
(function (MSE) {
  'use strict';

  const { state, emit, on } = MSE.state;
  const { gridStepSeconds, barDuration, barBeatAt, snapToGrid, durationInBarsBeats, positionInBarsBeats } = MSE.grid;
  const { formatTime, formatSeconds } = MSE.format;
  const { frameCalc, fps } = MSE.frames;
  const shotsApi = MSE.shots;
  const silenceApi = MSE.silence;

  const WS = window.WaveSurfer;

  const STATUS_COLOR = {
    valid: 'rgba(76, 175, 80, 0.35)',
    short: 'rgba(255, 193, 7, 0.4)',
    long: 'rgba(244, 67, 54, 0.4)',
  };

  let gridWs = null;
  let shotsWs = null;
  let mixWs = null;
  let vocalWs = null;
  let timelinePlugin = null;

  let pxPerSecond = 80;
  let isSyncingScroll = false;
  let isSyncingTime = false;
  let vocalSilenceGaps = [];

  const AUDIO_TRACK_HEIGHT_KEY = 'mse.audioTrackHeight';
  const AUDIO_TRACK_HEIGHT_MIN = 40;
  const AUDIO_TRACK_HEIGHT_MAX = 200;
  const AUDIO_TRACK_HEIGHT_DEFAULT = 90;

  function loadAudioTrackHeight() {
    const stored = Number(localStorage.getItem(AUDIO_TRACK_HEIGHT_KEY));
    if (!stored || stored < AUDIO_TRACK_HEIGHT_MIN || stored > AUDIO_TRACK_HEIGHT_MAX) return AUDIO_TRACK_HEIGHT_DEFAULT;
    return stored;
  }

  // Machine-local display preference (like pxPerSecond/zoom), not project
  // data - drag-resizing the Mix/Vocal tracks shouldn't round-trip through
  // project.json or affect what a collaborator opening the same project sees.
  let audioTrackHeight = loadAudioTrackHeight();

  // Standing viewing preference for the shot list's Start/End columns, same
  // reasoning/persistence shape as direction.js's GRID_MODE_KEY/SNAP_KEY.
  const SHOT_TIME_FORMAT_KEY = 'cuttalogue.shotTimeFormat';
  let shotTimeFormat = localStorage.getItem(SHOT_TIME_FORMAT_KEY) === 'seconds' ? 'seconds' : 'clock';

  function formatShotTime(seconds) {
    return shotTimeFormat === 'seconds' ? `${formatSeconds(seconds)}s` : formatTime(seconds);
  }

  // Holding Alt during a shot create/resize drag bypasses the selected grid
  // snap for that one drag. The Regions plugin's update-end event doesn't carry
  // modifier-key state, so it's tracked independently here.
  let altHeld = false;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Alt') altHeld = true;
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') altHeld = false;
  });
  window.addEventListener('blur', () => {
    altHeld = false;
  });

  const els = {};

  function cacheElements() {
    els.gridContainer = document.getElementById('track-grid');
    els.gridWrap = document.getElementById('track-grid-wrap');
    els.shotsContainer = document.getElementById('track-shots');
    els.mixContainer = document.getElementById('track-mix');
    els.mixWrap = document.getElementById('track-mix-wrap');
    els.vocalContainer = document.getElementById('track-vocal');
    els.vocalWrap = document.getElementById('track-vocal-wrap');
    els.silenceLayer = document.getElementById('silence-layer');
    els.vocalCueLayer = document.getElementById('vocal-cue-layer');
    els.addCueBtn = document.getElementById('add-cue-at-playhead-btn');
    els.playhead = document.getElementById('current-time-readout');
    els.loopToggleBtn = document.getElementById('loop-toggle-btn');
    els.loopSnapToggle = document.getElementById('loop-snap-toggle');
    els.shotTimeFormatToggle = document.getElementById('shot-time-format-toggle');
    els.shotListWrap = document.querySelector('.shot-list-table-wrap');
  }

  // Pushes the given shot's row as far up the (independently-scrolling,
  // see style.css) shot list as it'll go - all the way under the sticky
  // thead if there's room to scroll that far, less than that if the row is
  // already near the bottom of the list. getBoundingClientRect deltas
  // (rather than row.offsetTop) sidestep offsetParent - the row's nearest
  // positioned ancestor isn't necessarily els.shotListWrap.
  function scrollShotRowIntoView(shotId) {
    const wrap = els.shotListWrap;
    const row = wrap && wrap.querySelector(`tr[data-shot-id="${CSS.escape(String(shotId))}"]`);
    if (!wrap || !row) return;
    const thead = wrap.querySelector('thead');
    const headerHeight = thead ? thead.getBoundingClientRect().height : 0;
    const delta = row.getBoundingClientRect().top - wrap.getBoundingClientRect().top - headerHeight;
    wrap.scrollTop += delta;
  }

  function frameAtTime(seconds) {
    return Math.round(seconds * fps(state.video));
  }

  // Zero-padded to however many digits the loaded audio's own frame count
  // needs, so "F375" doesn't grow/shrink a digit at a time as the playhead
  // moves and jitter the rest of the readout - e.g. "F0375" out of "F9200"
  // total, but plain "F5" out of "F9" total for a near-empty timeline.
  function totalFrameDigits() {
    const totalFrames = frameAtTime(state.audio.mix.durationSeconds || 0);
    return String(totalFrames).length;
  }

  function formatFrame(seconds) {
    return `F${String(frameAtTime(seconds)).padStart(totalFrameDigits(), '0')}`;
  }

  function hoverLabel(seconds) {
    return `${formatTime(seconds)} · ${formatFrame(seconds)} · ${positionInBarsBeats(seconds, state.tempo)}`;
  }

  // Shot-relative time deliberately uses duration notation for the musical
  // value: both counters start at zero at the shot boundary, independent of
  // the project's grid offset or whether that boundary itself lands on a
  // beat. Gaps return null so neither the header nor the cursor badge implies
  // that an undefined part of the timeline belongs to a clip.
  function shotRelativeLabel(seconds) {
    const shot = shotsApi.shotAtTime(seconds);
    if (!shot) return null;
    const relativeSeconds = Math.max(0, seconds - shot.startSeconds);
    return `Clip +${formatTime(relativeSeconds)} · Beat +${durationInBarsBeats(relativeSeconds, state.tempo)}`;
  }

  function fullPlayheadLabel(seconds) {
    const relative = shotRelativeLabel(seconds);
    return relative ? `${hoverLabel(seconds)} · ${relative}` : hoverLabel(seconds);
  }

  // 'second'/'frame' are grid divisions that depend on video state, not tempo, so
  // musicalGrid.js (deliberately tempo/bar-only) doesn't know about them - resolve
  // them here instead.
  function currentGridStepSeconds() {
    const division = state.tempo.gridDivision;
    if (division === 'second') return 1;
    if (division === 'frame') return 1 / fps(state.video);
    return gridStepSeconds(state.tempo);
  }

  function timelineLabel(seconds) {
    const division = state.tempo.gridDivision;
    if (division === 'off') return formatTime(seconds);
    if (division === 'second') return `${Math.round(seconds)}`;
    if (division === 'frame') return formatFrame(seconds);
    // The Timeline plugin accumulates notch times via repeated += rather than
    // index*step, so the `seconds` it hands back can carry tiny float drift
    // (worse at BPMs like 180 that aren't exact in binary). Snapping to the
    // grid here keeps bar.beat text clean (e.g. "8" instead of "7.4").
    const snapped = snapToGrid(seconds, state.tempo);
    const { bar, beat } = barBeatAt(snapped, state.tempo);
    return beat === 1 ? `${bar}` : `${bar}.${beat}`;
  }

  function buildTimelineOptions() {
    const division = state.tempo.gridDivision;
    const step = currentGridStepSeconds();
    const base = {
      height: 26,
      timeOffset: state.tempo.gridOffsetSeconds,
      formatTimeCallback: timelineLabel,
      style: { color: 'var(--grid-label)' },
    };
    if (!step) return base;
    // The Timeline plugin decides which notches get a label by comparing
    // Math.round(100*t) against Math.round(100*interval) as it accumulates
    // t += timeInterval. For BPM values whose bar/step duration isn't exact
    // in binary floating point (e.g. 180 BPM -> 1.3333...s bars), that sum
    // drifts past the 2-decimal rounding tolerance after a couple of bars
    // and labels silently stop appearing. primaryLabelSpacing/
    // secondaryLabelSpacing instead compare the integer notch INDEX, which
    // can't drift, so use those rather than the time-based intervals.
    const bar = barDuration(state.tempo.bpm, state.tempo.numerator);
    const primarySpacing = division === 'second' || division === 'frame' ? 1 : Math.max(1, Math.round(bar / step));
    return Object.assign(base, {
      timeInterval: step,
      primaryLabelSpacing: primarySpacing,
      secondaryLabelSpacing: 1,
      // The plugin bolds a notch when EITHER the spacing above matches OR a
      // separate, density-derived primaryLabelInterval/secondaryLabelInterval
      // (real seconds, defaults ~10s/5s, nothing to do with bars/beats) is
      // hit - left unset, that default occasionally coincides with a notch
      // near but not at a real bar boundary, bolding two adjacent notches at
      // once. Infinity can only match at t=0 (already primary via spacing),
      // so this leaves spacing as the sole source of truth.
      primaryLabelInterval: Infinity,
      secondaryLabelInterval: Infinity,
    });
  }

  function rebuildTimelinePlugin() {
    if (!gridWs) return;
    if (timelinePlugin) {
      gridWs.unregisterPlugin(timelinePlugin);
      timelinePlugin = null;
    }
    timelinePlugin = gridWs.registerPlugin(WS.Timeline.create(buildTimelineOptions()));
  }

  function silentPeaks() {
    return [new Float32Array(2)];
  }

  // interactive: true lets clicking/dragging in this proxy seek the whole
  // group, same as Mix/Vocal - only used for the Grid row. The Shots track
  // isn't a WaveSurfer instance anymore at all (see the shots-lane section
  // below) - it hand-rolls its own pointer handling directly, so there's no
  // dual-system race to avoid here anymore either.
  // cursorWidth: 0 on every instance - the single #playhead-line overlay
  // (see renderPlayheadLoop) is now the only visible cursor, decoupled from
  // each instance's own .setTime() sync so it never inherits the throttled
  // cross-instance sync's jitter (see REAL_SYNC_INTERVAL_MS below).
  function createProxyInstance(container, height, interactive) {
    return WS.create({
      container,
      height,
      duration: state.audio.mix.durationSeconds,
      peaks: silentPeaks(),
      waveColor: 'transparent',
      progressColor: 'transparent',
      cursorWidth: 0,
      interact: !!interactive,
      dragToSeek: !!interactive,
      hideScrollbar: true,
      minPxPerSec: pxPerSecond,
      fillParent: false,
      normalize: false,
    });
  }

  function createAudioInstance(container, url) {
    return WS.create({
      container,
      height: audioTrackHeight,
      url,
      waveColor: '#5b7ea3',
      progressColor: '#8fb8e0',
      cursorWidth: 0,
      interact: true,
      dragToSeek: true,
      hideScrollbar: true,
      minPxPerSec: pxPerSecond,
      fillParent: false,
      normalize: true,
    });
  }

  function forEachInstance(fn) {
    [gridWs, shotsWs, mixWs, vocalWs].forEach((ws) => ws && fn(ws));
  }

  function wireScrollSync(ws) {
    ws.on('scroll', (startTime) => {
      if (isSyncingScroll) return;
      isSyncingScroll = true;
      forEachInstance((other) => {
        if (other !== ws) other.setScrollTime(startTime);
      });
      isSyncingScroll = false;
      updatePlayheadPosition();
      repositionLoopOverlay();
      repositionVocalCues();
    });
  }

  // mixWs/vocalWs wrap real <audio> elements: other.setTime() writes to
  // media.currentTime, a genuine seek. timeupdate fires on every animation
  // frame (~60Hz) while playing, so mirroring it to the other real audio
  // element at full rate means ~60 seeks/sec on an element that isn't even
  // playing - enough contention to audibly stutter the track that is
  // playing. The silent grid/shots proxies have no real media, so syncing
  // those every frame stays cheap and keeps the visual cursor smooth.
  const REAL_SYNC_INTERVAL_MS = 80;
  let lastRealSync = 0;

  function wireTimeSync(ws) {
    ws.on('timeupdate', (currentTime) => {
      if (isSyncingTime) return;
      // Loop playback: only the instance actually driving playback
      // (activeWs()) should trigger the seek-back - gridWs/shotsWs also get
      // wireTimeSync'd (their own timeupdate only ever fires from the cross-
      // instance .setTime() calls below, never real playback), so without
      // this guard the same boundary crossing could be detected 4x.
      if (
        state.loop.enabled &&
        ws === activeWs() &&
        state.loop.endSeconds != null &&
        currentTime >= state.loop.endSeconds
      ) {
        ws.setTime(state.loop.startSeconds);
        return;
      }
      isSyncingTime = true;
      const now = performance.now();
      const syncReal = now - lastRealSync >= REAL_SYNC_INTERVAL_MS;
      if (syncReal) lastRealSync = now;
      forEachInstance((other) => {
        if (other === ws) return;
        if ((other === mixWs || other === vocalWs) && !syncReal) return;
        other.setTime(currentTime);
      });
      isSyncingTime = false;
      updatePlayheadReadout(currentTime);
    });
    ws.on('interaction', (newTime) => {
      isSyncingTime = true;
      lastRealSync = performance.now();
      forEachInstance((other) => {
        if (other !== ws) other.setTime(newTime);
      });
      isSyncingTime = false;
      updatePlayheadReadout(newTime);
      updatePlayheadPosition();
    });
  }

  function updatePlayheadReadout(seconds) {
    if (els.playhead) els.playhead.textContent = fullPlayheadLabel(seconds);
    updateShotRelativeBadge(seconds);
  }

  // The visible cursor line is now a single overlay per track row (see
  // createPlayheadSegments/updatePlayheadPosition below), driven by its own
  // rAF loop while playing rather than each WaveSurfer instance's native
  // cursor - see the cursorWidth:0 note on createProxyInstance/
  // createAudioInstance for why. The throttled cross-instance .setTime()
  // sync above still runs unchanged: it's what keeps Mix/Vocal's own
  // progress-fill (the waveform's played/unplayed coloring) reasonably
  // accurate on whichever of the two isn't currently playing, which is a
  // much coarser visual than a thin cursor line and doesn't need every-
  // frame precision the way the line did.
  function wirePlaybackStateEvents(ws) {
    ws.on('play', () => {
      emit('playback-state-changed', { isPlaying: true });
      startPlayheadLoop();
    });
    ws.on('pause', () => {
      emit('playback-state-changed', { isPlaying: false });
      stopPlayheadLoop();
    });
    ws.on('finish', () => {
      emit('playback-state-changed', { isPlaying: false });
      stopPlayheadLoop();
    });
  }

  let playheadEls = [];
  let shotPlayheadEl = null;
  let shotRelativeBadgeEl = null;
  let playheadRafId = null;
  // Other modules that draw their own playhead in a different coordinate
  // system (e.g. direction.js's shot-relative % lanes) hook in here instead
  // of duplicating the rAF/scrub/pause plumbing above - see onPlayheadTick.
  const playheadTickListeners = [];

  function onPlayheadTick(fn) {
    playheadTickListeners.push(fn);
  }

  function createPlayheadSegments() {
    shotPlayheadEl = null;
    shotRelativeBadgeEl = null;
    playheadEls = [els.gridWrap, els.shotsContainer, els.mixWrap, els.vocalWrap]
      .filter(Boolean)
      .map((container) => {
        const seg = document.createElement('div');
        seg.className = 'playhead-segment';
        if (container === els.shotsContainer) {
          shotPlayheadEl = seg;
          shotRelativeBadgeEl = document.createElement('div');
          shotRelativeBadgeEl.className = 'playhead-relative-readout';
          shotRelativeBadgeEl.hidden = true;
          shotRelativeBadgeEl.title = 'Relative time and beat position within the current shot';
          seg.appendChild(shotRelativeBadgeEl);
        }
        container.appendChild(seg);
        return seg;
      });
  }

  function updateShotRelativeBadge(seconds) {
    if (!shotRelativeBadgeEl || !shotPlayheadEl) return;
    const relative = shotRelativeLabel(seconds);
    shotRelativeBadgeEl.hidden = !relative;
    if (!relative) return;
    shotRelativeBadgeEl.textContent = relative;
    const container = shotPlayheadEl.parentElement;
    const left = Number.parseFloat(shotPlayheadEl.style.left) || 0;
    shotRelativeBadgeEl.classList.toggle('align-right', !!container && left > container.clientWidth / 2);
  }

  function updatePlayheadPosition() {
    const currentTime = getCurrentTime();
    if (gridWs && playheadEls.length) {
      const left = currentTime * pxPerSecond - gridWs.getScroll();
      playheadEls.forEach((el) => {
        el.style.left = `${left}px`;
      });
    }
    updateShotRelativeBadge(currentTime);
    playheadTickListeners.forEach((fn) => fn());
  }

  function playheadLoop() {
    updatePlayheadPosition();
    playheadRafId = requestAnimationFrame(playheadLoop);
  }

  function startPlayheadLoop() {
    if (playheadRafId !== null) return;
    playheadLoop();
  }

  function stopPlayheadLoop() {
    if (playheadRafId !== null) {
      cancelAnimationFrame(playheadRafId);
      playheadRafId = null;
    }
    updatePlayheadPosition();
  }

  function activeWs() {
    return state.audio.playbackTrack === 'vocal' ? vocalWs : mixWs;
  }

  // Loop locators: rendered as a single laneWidget segment ({startSeconds,
  // endSeconds}-shaped, which state.loop already is) directly in
  // #track-grid-wrap, mirroring the playhead overlay's mount point/scroll
  // math (gridWs.getScroll()) rather than the Shots track's CSS-transform
  // scroll - the two tracks scroll via different mechanisms even though
  // they stay visually in sync.
  let loopSegmentEl = null;

  function loopMetrics() {
    return {
      pxPerSecond: () => pxPerSecond,
      position(el, seg) {
        const scroll = gridWs ? gridWs.getScroll() : 0;
        el.style.left = `${seg.startSeconds * pxPerSecond - scroll}px`;
        el.style.width = `${Math.max(1, (seg.endSeconds - seg.startSeconds) * pxPerSecond)}px`;
      },
    };
  }

  function clampLoopTime(t) {
    return Math.max(0, Math.min(state.audio.mix.durationSeconds || 0, t));
  }

  function moveLoopEdge(side, timeValue) {
    const t = clampLoopTime(timeValue);
    if (side === 'start') {
      if (t >= state.loop.endSeconds) return null;
      state.loop.startSeconds = t;
    } else {
      if (t <= state.loop.startSeconds) return null;
      state.loop.endSeconds = t;
    }
    return t;
  }

  function moveLoopRegion(newStart) {
    const span = state.loop.endSeconds - state.loop.startSeconds;
    const duration = state.audio.mix.durationSeconds || 0;
    const clampedStart = Math.max(0, Math.min(duration - span, newStart));
    state.loop.startSeconds = clampedStart;
    state.loop.endSeconds = clampedStart + span;
    return clampedStart;
  }

  // Cheap reposition-only pass (scroll/zoom) - never tears down the element
  // mid-drag, unlike renderLoopOverlay() which fully rebuilds it.
  function repositionLoopOverlay() {
    if (loopSegmentEl) loopMetrics().position(loopSegmentEl, state.loop);
  }

  function renderLoopOverlay() {
    if (loopSegmentEl) {
      loopSegmentEl.remove();
      loopSegmentEl = null;
    }
    if (!gridWs || !els.gridWrap) return;
    if (state.loop.startSeconds == null || state.loop.endSeconds == null) return;
    loopSegmentEl = MSE.laneWidget.buildSegment(state.loop, 0, loopMetrics(), {
      className: 'lane-segment loop-region-segment',
      isSelected: () => false,
      isDisabled: () => !state.loop.enabled,
      renderLabel: () => {},
      moveSegment: (i, t) => moveLoopRegion(t),
      moveSegmentEdge: (i, side, t) => moveLoopEdge(side, t),
      onSelect: () => {},
      onCommit: () => renderLoopOverlay(),
      onClickOnly: () => {},
      snapTime: (current, altKey, mode) => {
        if (altKey) return current;
        if (state.loop.snapMode === 'events') {
          return mode === 'end' ? shotsApi.nearestShotEnd(current) : shotsApi.nearestShotStart(current);
        }
        return shotsApi.snapSeconds(current);
      },
    });
    els.gridWrap.appendChild(loopSegmentEl);
  }

  // First activation with no region yet defaults to the shot under the
  // playhead - looping the whole project by default was confusing (a very
  // wide region fills the entire visible ruler at any zoom/scroll position,
  // with both handles off-screen). Falls back to the next shot if the
  // playhead is sitting in a gap, then the last shot if it's past
  // everything, then (no shots authored at all yet) a short window starting
  // at the playhead.
  function defaultLoopRegion() {
    const t = getCurrentTime();
    const shot = shotsApi.shotAtTime(t) || state.shots.find((s) => s.startSeconds >= t) || state.shots[state.shots.length - 1];
    if (shot) return { startSeconds: shot.startSeconds, endSeconds: shot.endSeconds };
    const duration = state.audio.mix.durationSeconds || 0;
    const span = state.shotLimits.minimumSeconds || 8;
    return { startSeconds: t, endSeconds: Math.min(duration, t + span) };
  }

  function setLoopEnabled(v) {
    state.loop.enabled = v;
    if (v && (state.loop.startSeconds == null || state.loop.endSeconds == null)) {
      const region = defaultLoopRegion();
      state.loop.startSeconds = region.startSeconds;
      state.loop.endSeconds = region.endSeconds;
    }
    updateLoopToggle();
    renderLoopOverlay();
  }

  function updateLoopToggle() {
    if (!els.loopToggleBtn) return;
    els.loopToggleBtn.classList.toggle('active', state.loop.enabled);
    els.loopToggleBtn.title = state.loop.enabled ? 'Loop: on' : 'Loop: off';
  }

  function setLoopSnapMode(mode) {
    state.loop.snapMode = mode;
    updateLoopSnapToggle();
  }

  function updateLoopSnapToggle() {
    if (!els.loopSnapToggle) return;
    const isEvents = state.loop.snapMode === 'events';
    els.loopSnapToggle.textContent = isEvents ? 'Events' : 'Grid';
    els.loopSnapToggle.title = `Loop locators snap to: ${isEvents ? 'shot boundaries' : 'the grid'} (click to switch)`;
    els.loopSnapToggle.classList.toggle('active', isEvents);
  }

  function setShotTimeFormat(format) {
    shotTimeFormat = format;
    localStorage.setItem(SHOT_TIME_FORMAT_KEY, format);
    updateShotTimeFormatToggle();
    renderShotList();
  }

  function updateShotTimeFormatToggle() {
    if (!els.shotTimeFormatToggle) return;
    const isSeconds = shotTimeFormat === 'seconds';
    els.shotTimeFormatToggle.textContent = isSeconds ? 'sec.msec' : 'min:sec';
    els.shotTimeFormatToggle.title = `Shot start/end format: ${isSeconds ? 'seconds.msec' : 'min:sec.msec'} (click to switch)`;
    els.shotTimeFormatToggle.classList.toggle('active', isSeconds);
  }

  async function togglePlayback() {
    const ws = activeWs();
    if (!ws) return;
    await ws.playPause();
  }

  function getCurrentTime() {
    const ws = activeWs() || gridWs;
    return ws ? ws.getCurrentTime() : 0;
  }

  // Public seek contract for other native CUTTAlogue workspaces (camera
  // preview first). Keeping this here preserves one project playback clock;
  // consumers must not seek individual WaveSurfer instances themselves.
  function seekTo(seconds) {
    if (!gridWs && !activeWs()) return false;
    const duration = Math.max(0, state.audio.mix.durationSeconds || 0);
    const target = Math.max(0, Math.min(duration || Number.POSITIVE_INFINITY, Number(seconds) || 0));
    isSyncingTime = true;
    lastRealSync = performance.now();
    forEachInstance((ws) => ws.setTime(target));
    isSyncingTime = false;
    updatePlayheadReadout(target);
    updatePlayheadPosition();
    emit('playhead-seeked', { timeSeconds: target });
    return true;
  }

  async function setPlaybackTrack(track) {
    if (track === state.audio.playbackTrack) return;
    const wasPlaying = activeWs() && activeWs().isPlaying();
    const currentTime = activeWs() ? activeWs().getCurrentTime() : 0;
    if (activeWs()) activeWs().pause();
    state.audio.playbackTrack = track;
    const next = activeWs();
    if (next) {
      next.setTime(currentTime);
      if (wasPlaying) await next.play();
    }
    emit('playback-track-changed', { track });
  }

  function zoomTo(px) {
    pxPerSecond = Math.max(10, px);
    forEachInstance((ws) => ws.zoom(pxPerSecond));
    layoutSilenceOverlay();
    updatePlayheadPosition();
    repositionLoopOverlay();
    repositionVocalCues();
  }

  function setAudioTrackHeight(px) {
    audioTrackHeight = Math.min(AUDIO_TRACK_HEIGHT_MAX, Math.max(AUDIO_TRACK_HEIGHT_MIN, Math.round(px)));
    localStorage.setItem(AUDIO_TRACK_HEIGHT_KEY, String(audioTrackHeight));
    if (mixWs) mixWs.setOptions({ height: audioTrackHeight });
    if (vocalWs) vocalWs.setOptions({ height: audioTrackHeight });
  }

  function layoutSilenceOverlay() {
    if (!els.silenceLayer || !vocalWs) return;
    const scroll = vocalWs.getScroll();
    els.silenceLayer.innerHTML = '';
    vocalSilenceGaps.forEach((gap) => {
      const left = gap.start * pxPerSecond - scroll;
      const width = Math.max(1, (gap.end - gap.start) * pxPerSecond);
      const div = document.createElement('div');
      div.className = 'silence-band';
      div.style.left = `${left}px`;
      div.style.width = `${width}px`;
      els.silenceLayer.appendChild(div);
    });
  }

  // --- Vocal cue markers ------------------------------------------------
  // Manually-authored, project-absolute song-timing anchors (MSE.vocalCues,
  // Phase 2 of docs/h3-shot-direction-roadmap.md), shown as point markers on
  // the Vocal track rather than a fourth WaveSurfer region - same
  // untransformed px-per-second space as the silence overlay above (left =
  // absolute time * pxPerSecond, minus the real vocalWs instance's own
  // scroll), not the Shots lane's translateX'd content div.
  function vocalCueLeft(cue) {
    const scroll = vocalWs ? vocalWs.getScroll() : 0;
    return cue.timeSeconds * pxPerSecond - scroll;
  }

  // Only one rename input can be open at a time - tracks how to tear the
  // current one down (committing whatever's typed) if another interaction
  // (a full re-render, or opening a second rename) needs it gone first.
  let cancelVocalCueRename = null;

  function startVocalCueRename(labelEl, cue) {
    if (cancelVocalCueRename) cancelVocalCueRename();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'vocal-cue-label-input';
    input.placeholder = 'Cue label';
    input.value = cue.label || '';
    labelEl.hidden = true;
    labelEl.insertAdjacentElement('afterend', input);
    input.focus();
    input.select();

    function finish(commit) {
      cancelVocalCueRename = null;
      input.removeEventListener('blur', onBlur);
      input.remove();
      labelEl.hidden = false;
      if (commit) MSE.vocalCues.rename(cue.id, input.value.trim());
    }
    function onBlur() {
      finish(true);
    }
    input.addEventListener('blur', onBlur);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') finish(false);
    });
    cancelVocalCueRename = () => finish(true);
  }

  // Drag mutates cue.timeSeconds directly and repositions just this one
  // marker on every pointermove (no emit, no re-render) - same "live-mutate,
  // commit-on-release" discipline as laneWidget.js's wireSegmentDrag, so a
  // drag in progress never has its own DOM element torn out from under it by
  // a vocal-cues-changed-triggered full rebuild.
  function wireVocalCueDrag(dot, marker, cue) {
    dot.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX;
      const startTime = cue.timeSeconds;
      let moved = false;

      function onMove(ev) {
        const dx = ev.clientX - startX;
        if (!moved && Math.abs(dx) < 3) return;
        moved = true;
        const duration = state.audio.mix.durationSeconds || 0;
        cue.timeSeconds = Math.max(0, Math.min(duration, startTime + dx / pxPerSecond));
        marker.style.left = `${vocalCueLeft(cue)}px`;
      }
      function onUp() {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        if (moved) MSE.vocalCues.move(cue.id, cue.timeSeconds);
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  function renderVocalCues() {
    if (!els.vocalCueLayer) return;
    if (cancelVocalCueRename) cancelVocalCueRename();
    els.vocalCueLayer.innerHTML = '';
    state.vocalCues.forEach((cue) => {
      const marker = document.createElement('div');
      marker.className = 'vocal-cue-marker';
      marker.style.left = `${vocalCueLeft(cue)}px`;
      marker.dataset.cueId = cue.id;

      const dot = document.createElement('div');
      dot.className = 'vocal-cue-dot';
      dot.title = cue.label || '(untitled cue)';
      marker.appendChild(dot);
      wireVocalCueDrag(dot, marker, cue);

      const label = document.createElement('div');
      label.className = 'vocal-cue-label';
      label.textContent = cue.label || '(untitled)';
      label.title = cue.label || '(untitled cue)';
      label.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startVocalCueRename(label, cue);
      });
      marker.appendChild(label);

      els.vocalCueLayer.appendChild(marker);
    });
  }

  // Cheap reposition-only pass for scroll/zoom - mirrors
  // repositionLoopOverlay vs renderLoopOverlay: never tears down a marker
  // mid-drag or mid-rename, unlike renderVocalCues()'s full rebuild.
  function repositionVocalCues() {
    if (!els.vocalCueLayer) return;
    els.vocalCueLayer.querySelectorAll('.vocal-cue-marker').forEach((el) => {
      const cue = state.vocalCues.find((c) => c.id === el.dataset.cueId);
      if (cue) el.style.left = `${vocalCueLeft(cue)}px`;
    });
  }

  function setupVocalCueContextMenu() {
    const menu = document.getElementById('vocal-cue-context-menu');
    const renameBtn = document.getElementById('vocal-cue-context-rename');
    const deleteBtn = document.getElementById('vocal-cue-context-delete');
    if (!menu || !renameBtn || !deleteBtn || !els.vocalCueLayer) return;
    MSE.contextMenu.create({
      container: els.vocalCueLayer,
      menuEl: menu,
      resolveTarget: (e) => {
        const marker = e.target.closest('.vocal-cue-marker');
        return marker ? marker.dataset.cueId : null;
      },
      actions: [
        {
          btn: renameBtn,
          onClick: (cueId) => {
            const marker = els.vocalCueLayer.querySelector(`.vocal-cue-marker[data-cue-id="${CSS.escape(cueId)}"]`);
            const cue = state.vocalCues.find((c) => c.id === cueId);
            const label = marker && marker.querySelector('.vocal-cue-label');
            if (label && cue) startVocalCueRename(label, cue);
          },
        },
        { btn: deleteBtn, onClick: (cueId) => MSE.vocalCues.remove(cueId) },
      ],
    });
  }

  // Primary manual creation workflow (see docs/h3-shot-direction-roadmap.md
  // Phase 2 §10): uses the exact current playback position, never quantized
  // to the grid - a vocal cue represents performed audio timing, not the
  // nominal musical grid. Opens the label straight into rename so typing the
  // heard lyric is the very next keystroke.
  function addCueAtPlayhead() {
    const cue = MSE.vocalCues.add(getCurrentTime(), '');
    renderVocalCues();
    const marker = els.vocalCueLayer && els.vocalCueLayer.querySelector(`.vocal-cue-marker[data-cue-id="${CSS.escape(cue.id)}"]`);
    const label = marker && marker.querySelector('.vocal-cue-label');
    if (label) startVocalCueRename(label, cue);
  }

  // --- Shots lane -----------------------------------------------------
  // Plain DOM, built on laneWidget.js's pixel-mode segment engine (see its
  // file header) instead of WaveSurfer's Regions plugin - see the comment
  // at the top of this file for why. shotsContentEl is the one scrollable/
  // zoomable element: its own width is duration*pxPerSecond, and it shifts
  // via a CSS transform for scroll (setShotsScrollTime) - every shot inside
  // it is positioned in that same untransformed time*pxPerSecond space, so
  // none of them need to know the current scroll offset themselves.
  let shotsContentEl = null;
  let shotsScrollTime = 0;

  function shotsTimeAtClientX(clientX) {
    const rect = shotsContentEl.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left) / pxPerSecond);
  }

  function shotsMetrics() {
    return {
      pxPerSecond: () => pxPerSecond,
      position(el, seg) {
        el.style.left = `${seg.startSeconds * pxPerSecond}px`;
        el.style.width = `${Math.max(1, (seg.endSeconds - seg.startSeconds) * pxPerSecond)}px`;
      },
    };
  }

  function buildShotLabel(shot, status, calc) {
    const el = document.createElement('div');
    el.className = `shot-region-label status-${status}`;
    const title = document.createElement('strong');
    const name = (shot.name || '').trim() || 'unnamed';
    title.textContent = `#${shot.id} ${name}`;
    el.appendChild(title);
    const durationSeconds = shotsApi.shotDuration(shot);
    const info = document.createElement('span');
    info.textContent = `${durationInBarsBeats(durationSeconds, state.tempo)} / ${durationSeconds.toFixed(2)}s / ${calc.cutFrames}f`;
    el.appendChild(info);
    return el;
  }

  function renderShots() {
    if (!shotsContentEl) return;
    shotsContentEl.innerHTML = '';
    shotsContentEl.style.width = `${state.audio.mix.durationSeconds * pxPerSecond}px`;
    const metrics = shotsMetrics();
    state.shots.forEach((shot, index) => {
      const status = shotsApi.shotStatus(shot);
      const calc = frameCalc(shotsApi.shotDuration(shot), state.video);
      const segEl = MSE.laneWidget.buildSegment(shot, index, metrics, {
        className: 'lane-segment shot-lane-segment',
        isSelected: () => MSE.context && shot.id === MSE.context.getSelectedShotId(),
        renderLabel: (el) => el.appendChild(buildShotLabel(shot, status, calc)),
        // shot.id is closed over from this exact build - safe within a
        // single render pass, same as Direction's index-into-a-fixed-array
        // closures (shots.js's own move/split/create functions are what
        // rebuild the array; nothing here re-renders mid-drag).
        moveSegment: (i, timeValue) => shotsApi.moveShot(shot.id, timeValue, { snap: false }),
        moveSegmentEdge: (i, side, timeValue) => shotsApi.moveEdge(shot.id, side, timeValue, { snap: false }),
        // Fires on every pointerup (click or drag alike) - dragging a shot
        // to move/resize it makes it "the" shot you're working on too, so
        // it becomes selected the same as a plain click would.
        onSelect: () => {
          if (MSE.context) MSE.context.selectShot(shot.id);
        },
        onCommit: () => shotsApi.notifyBoundaryMoved(),
        // A plain click on the shot's body now just selects it (onSelect,
        // above, already did that) - splitting used to be the plain-click
        // behavior, which made a stray click destructively slice a shot in
        // two. Ctrl+click on the body still splits. mode is 'start'/'end'
        // for the resize handles, which should do nothing on a click-
        // without-drag either way.
        onClickOnly: (ev, mode) => {
          if (mode !== 'move' || !ev.ctrlKey) return;
          shotsApi.splitShotAt(shotsTimeAtClientX(ev.clientX));
        },
        snapTime: (current, altKey) => (altKey ? current : shotsApi.snapSeconds(current)),
        datasetAttrs: { shotId: String(shot.id) },
      });
      segEl.style.background = STATUS_COLOR[status];

      // Double-click a shared boundary to merge - a genuine browser dblclick
      // on the resize handle, independent of the drag/click state machine
      // buildSegment already wired onto it.
      const startHandle = segEl.querySelector('.lane-segment-handle-start');
      const endHandle = segEl.querySelector('.lane-segment-handle-end');
      if (startHandle) startHandle.addEventListener('dblclick', () => shotsApi.removeBoundary(index - 1));
      if (endHandle) endHandle.addEventListener('dblclick', () => shotsApi.removeBoundary(index));

      shotsContentEl.appendChild(segEl);
    });
    renderShotList();
  }

  function setShotsScrollTime(t) {
    shotsScrollTime = Math.max(0, t);
    if (shotsContentEl) shotsContentEl.style.transform = `translateX(${-shotsScrollTime * pxPerSecond}px)`;
  }

  // Centers the shots/grid/mix/vocal tracks (they scroll in sync) on the given
  // shot's midpoint.
  function scrollToShot(shot) {
    if (!gridWs || !els.shotsContainer) return;
    const center = (shot.startSeconds + shot.endSeconds) / 2;
    const target = Math.max(0, center * pxPerSecond - els.shotsContainer.clientWidth / 2);
    gridWs.setScroll(target);
  }

  // Single-line "#N name" display; the name is only ever editable here (the
  // timeline region label, above, just displays it), and only on double-click
  // - the input isn't permanently in the DOM, so the common case (just
  // reading/selecting shots) never shows an idle textbox for every row.
  function buildNumberDisplay(shot) {
    const span = document.createElement('span');
    span.className = 'shot-number-display';
    const num = document.createElement('strong');
    num.textContent = `#${shot.id}`;
    span.appendChild(num);
    span.appendChild(document.createTextNode(' '));
    const nameSpan = document.createElement('span');
    if (shot.name) {
      nameSpan.textContent = shot.name;
    } else {
      nameSpan.className = 'shot-name-placeholder';
      nameSpan.textContent = 'unnamed';
    }
    span.appendChild(nameSpan);
    return span;
  }

  function buildNumberCell(shot) {
    const cell = document.createElement('td');
    cell.className = 'shot-number-cell';
    cell.title = 'Double-click to rename';
    cell.appendChild(buildNumberDisplay(shot));

    // Prevents the row's own click handler (which selects the shot and can
    // trigger a re-render via 'shot-selected') from firing on the same
    // double-click that enters edit mode - a re-render mid-click would
    // rebuild this cell out from under the browser's pending focus.
    cell.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      cell.innerHTML = '';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'shot-name-input';
      nameInput.placeholder = 'unnamed';
      nameInput.value = shot.name || '';
      nameInput.addEventListener('click', (ev) => ev.stopPropagation());
      nameInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') nameInput.blur();
        if (ev.key === 'Escape') {
          nameInput.value = shot.name || '';
          nameInput.blur();
        }
      });
      // Committed on 'change' (blur/Enter) rather than every keystroke so
      // typing a name never gets interrupted by an unrelated re-render
      // mid-edit - renderShotList() itself also skips rebuilding entirely
      // while this input is focused, as a second layer of protection.
      nameInput.addEventListener('change', () => shotsApi.setShotName(shot.id, nameInput.value.trim()));
      nameInput.addEventListener('blur', () => {
        cell.innerHTML = '';
        cell.appendChild(buildNumberDisplay(shot));
      });

      cell.appendChild(nameInput);
      nameInput.focus();
      nameInput.select();
    });

    return cell;
  }

  function renderShotList() {
    const list = document.getElementById('shot-list');
    if (!list) return;
    // A full rebuild while a shot name is mid-edit would tear out the
    // focused input (and its unsaved keystrokes) out from under the user -
    // same guard shape as the Prompt/Notes activeElement check elsewhere.
    if (document.activeElement && document.activeElement.classList.contains('shot-name-input')) return;
    list.innerHTML = '';
    const selectedId = MSE.context ? MSE.context.getSelectedShotId() : null;
    state.shots.forEach((shot) => {
      const status = shotsApi.shotStatus(shot);
      const calc = frameCalc(shotsApi.shotDuration(shot), state.video);
      const row = document.createElement('tr');
      row.className = `status-${status}${shot.id === selectedId ? ' selected' : ''}`;
      row.dataset.shotId = String(shot.id);

      row.appendChild(buildNumberCell(shot));

      const statusCell = document.createElement('td');
      statusCell.className = 'status-cell status-col';
      const swatch = document.createElement('span');
      swatch.className = `status-swatch status-${status}`;
      swatch.title = statusLabel(status);
      statusCell.appendChild(swatch);
      row.appendChild(statusCell);

      const startCell = document.createElement('td');
      startCell.className = 'numeric-col';
      startCell.textContent = formatShotTime(shot.startSeconds);
      row.appendChild(startCell);

      const endCell = document.createElement('td');
      endCell.className = 'numeric-col';
      endCell.textContent = formatShotTime(shot.endSeconds);
      row.appendChild(endCell);

      const durCell = document.createElement('td');
      durCell.className = 'numeric-col';
      durCell.appendChild(document.createTextNode(`${shotsApi.shotDuration(shot).toFixed(3)} s `));
      const cutFramesSpan = document.createElement('span');
      cutFramesSpan.className = 'cell-subvalue';
      cutFramesSpan.textContent = `· ${calc.cutFrames}f`;
      durCell.appendChild(cutFramesSpan);
      row.appendChild(durCell);

      const renderCell = document.createElement('td');
      renderCell.className = 'numeric-col';
      renderCell.appendChild(document.createTextNode(`${calc.renderFrames}f `));
      const overhangSpan = document.createElement('span');
      overhangSpan.className = 'cell-subvalue';
      overhangSpan.title = `${calc.overhangSeconds.toFixed(3)}s padding, trimmed after render`;
      overhangSpan.textContent = `+${calc.overhangFrames}f`;
      renderCell.appendChild(overhangSpan);
      row.appendChild(renderCell);

      row.addEventListener('click', () => {
        scrollToShot(shot);
        if (MSE.context) MSE.context.selectShot(shot.id);
      });
      list.appendChild(row);
    });
  }

  function statusLabel(status) {
    if (status === 'short') return 'too short';
    if (status === 'long') return 'too long';
    return 'valid';
  }

  // Clicking inside an existing shot splits it (unchanged). Dragging on empty
  // space (a gap) draws a new shot instead - the two are disambiguated by
  // whether the pointerdown time falls inside a shot or in a gap
  // (shotsApi.gapAt). A plain click in a gap (no real drag) is a no-op.
  // Drag-to-create on empty space only - move/resize/click-to-split/merge
  // for existing shots are all wired per-segment in renderShots() instead
  // (buildSegment's own pointerdown handlers stopPropagation, so this
  // container-level listener only ever fires for genuinely empty space).
  function setupShotsInteraction() {
    const CLICK_MOVE_THRESHOLD_PX = 4;

    let down = null; // { x, y, time, gap }
    let dragging = false;
    let draftEl = null;
    let draftLabelEl = null;

    function removeDraft() {
      if (draftEl) {
        draftEl.remove();
        draftEl = null;
        draftLabelEl = null;
      }
    }

    // Shows the *snapped* start/end/duration while dragging out a new shot
    // (unless Alt is held, matching the final drop behavior) - the box
    // visibly jumping to each grid line as the pointer moves is the "future
    // snap destination" feedback; a class toggle marks the unsnapped
    // (Alt-held) case so it can be styled differently. Positioned in the
    // same untransformed time*pxPerSecond space as shot segments (see the
    // Shots lane section above) - no scroll subtraction needed here either.
    function updateDraft(startTime, endTime, snapped) {
      if (!draftEl) {
        draftEl = document.createElement('div');
        draftEl.className = 'shot-draft';
        draftLabelEl = document.createElement('div');
        draftLabelEl.className = 'shot-draft-label';
        draftEl.appendChild(draftLabelEl);
        shotsContentEl.appendChild(draftEl);
      }
      draftEl.classList.toggle('unsnapped', !snapped);
      const lo = Math.min(startTime, endTime);
      const hi = Math.max(startTime, endTime);
      draftEl.style.left = `${lo * pxPerSecond}px`;
      draftEl.style.width = `${Math.max(1, (hi - lo) * pxPerSecond)}px`;
      draftLabelEl.textContent = `${formatTime(lo)} – ${formatTime(hi)} · ${(hi - lo).toFixed(2)}s`;
    }

    // Shared by the live preview (onPointerMove) and the actual creation
    // (onPointerUp) so what you see while dragging is exactly what you get on
    // release - snapped to the active grid unless Alt is held, then re-clamped
    // to the gap being dragged in (snapping alone can push a point past the
    // gap boundary, e.g. onto a neighboring shot snapped to the same grid).
    function computeDragRange(clientX) {
      const rawTime = shotsTimeAtClientX(clientX);
      const clamped = Math.min(down.gap.end, Math.max(down.gap.start, rawTime));
      const snap = !altHeld;
      let start = snap ? shotsApi.snapSeconds(Math.min(down.time, clamped)) : Math.min(down.time, clamped);
      let end = snap ? shotsApi.snapSeconds(Math.max(down.time, clamped)) : Math.max(down.time, clamped);
      start = Math.min(Math.max(start, down.gap.start), down.gap.end);
      end = Math.min(Math.max(end, down.gap.start), down.gap.end);
      return { start, end, snap };
    }

    function onPointerMove(e) {
      if (!down) return;
      if (!dragging) {
        const movedEnough =
          Math.abs(e.clientX - down.x) > CLICK_MOVE_THRESHOLD_PX || Math.abs(e.clientY - down.y) > CLICK_MOVE_THRESHOLD_PX;
        if (!movedEnough || !down.gap) return;
        dragging = true;
      }
      const { start, end, snap } = computeDragRange(e.clientX);
      updateDraft(start, end, snap);
    }

    function onPointerUp(e) {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);

      if (dragging && down.gap) {
        const { start, end } = computeDragRange(e.clientX);
        shotsApi.createShot(start, end);
      }
      // A plain click in a gap (no real drag) is a no-op, same as before.

      removeDraft();
      down = null;
      dragging = false;
    }

    shotsContentEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target !== shotsContentEl) return;
      const time = shotsTimeAtClientX(e.clientX);
      down = { x: e.clientX, y: e.clientY, time, gap: shotsApi.gapAt(time) };
      dragging = false;
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    });
  }

  function setupShotContextMenu() {
    const menu = document.getElementById('shot-context-menu');
    const deleteBtn = document.getElementById('shot-context-delete');
    if (!menu || !deleteBtn) return;
    MSE.contextMenu.create({
      container: shotsContentEl,
      menuEl: menu,
      actions: [{ btn: deleteBtn, onClick: (shotId) => shotsApi.deleteShot(shotId) }],
      resolveTarget: (e) => {
        const segEl = e.target.closest('.lane-segment');
        return segEl ? Number(segEl.dataset.shotId) : null;
      },
    });
  }

  // Ctrl+click on a shot body splits it (see onClickOnly in renderShots) -
  // swap in a razor-blade cursor (style.css) the whole time Ctrl is held so
  // that intent is visible before the click, not just after. Scoped via the
  // body class + CSS selector to #track-shots, not tracked per pointer-
  // enter/leave, so this is just two module-lifetime listeners.
  function wireCutCursor() {
    const setHeld = (held) => document.body.classList.toggle('ctrl-cut-cursor', held);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Control') setHeld(true);
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Control') setHeld(false);
    });
    // Alt-tabbing away while Ctrl is physically held never fires keyup -
    // without this the blade cursor would stick until the next keydown.
    window.addEventListener('blur', () => setHeld(false));
  }

  // WaveSurfer hides its native scrollbar (hideScrollbar:true) and the grid/shots
  // tracks have interact:false, so there is no built-in way to pan horizontally.
  // Translate wheel input (vertical wheel or trackpad horizontal swipe) into a
  // scroll on one instance; wireScrollSync() propagates it to the other three.
  function wireWheelScroll() {
    const area = document.querySelector('.timeline-area');
    if (!area) return;
    area.addEventListener(
      'wheel',
      (e) => {
        if (!gridWs) return;
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (!delta) return;
        e.preventDefault();
        gridWs.setScroll(gridWs.getScroll() + delta);
      },
      { passive: false }
    );
  }

  async function initTimeline(mixDurationSeconds) {
    cacheElements();
    state.audio.mix.durationSeconds = mixDurationSeconds;

    gridWs = createProxyInstance(els.gridContainer, 2, true);
    rebuildTimelinePlugin();

    shotsContentEl = document.createElement('div');
    shotsContentEl.className = 'shots-lane-content';
    els.shotsContainer.appendChild(shotsContentEl);
    // A lightweight stand-in for a WaveSurfer instance (see the file-header
    // comment on shotsWs) - just enough surface for forEachInstance/
    // wireScrollSync/zoomTo to keep treating it as one of the four synced
    // tracks without a special case. setTime is a no-op: the Shots lane
    // never rendered a per-instance cursor even before the switch to the
    // shared #playhead overlay, so there's nothing for it to sync.
    shotsWs = {
      setScrollTime: (t) => setShotsScrollTime(t),
      zoom: () => {
        renderShots();
        setShotsScrollTime(shotsScrollTime);
      },
      setTime: () => {},
    };

    setupShotsInteraction();
    setupShotContextMenu();
    setupVocalCueContextMenu();
    if (els.addCueBtn) {
      els.addCueBtn.disabled = false;
      els.addCueBtn.addEventListener('click', () => addCueAtPlayhead());
    }
    renderVocalCues();
    createPlayheadSegments();
    updatePlayheadReadout(getCurrentTime());
    updatePlayheadPosition();
    renderLoopOverlay();
    updateLoopToggle();
    updateLoopSnapToggle();
    updateShotTimeFormatToggle();

    wireScrollSync(gridWs);
    wireTimeSync(gridWs);

    // Shots may already be in state by the time the timeline is created now
    // that a project can be loaded from the backend before any mix is picked
    // - draw them now that shotsContentEl exists, instead of waiting for the
    // next unrelated shots-changed. Deferred one frame: the shots track
    // container has width 0 until the browser's next layout pass, and
    // startX/pxPerSecond-based drag math would be wrong against a
    // zero-width content div for anything rendered before that pass.
    requestAnimationFrame(() => renderShots());

    emit('timeline-ready');
  }

  async function loadMix(url, fileName) {
    if (!els.mixContainer) cacheElements();
    if (mixWs) mixWs.destroy();
    mixWs = createAudioInstance(els.mixContainer, url);
    wireScrollSync(mixWs);
    wireTimeSync(mixWs);
    wirePlaybackStateEvents(mixWs);
    await new Promise((resolve) => mixWs.on('ready', resolve));

    const duration = mixWs.getDuration();
    state.audio.mix.fileName = fileName;
    state.audio.mix.durationSeconds = duration;

    if (!gridWs) await initTimeline(duration);

    mixWs.registerPlugin(
      WS.Hover.create({
        lineColor: 'var(--cursor)',
        labelBackground: '#1c1c1c',
        labelColor: '#fff',
        formatTimeCallback: hoverLabel,
      })
    );
    mixWs.zoom(pxPerSecond);
    emit('mix-ready');
  }

  async function loadVocal(url, fileName) {
    if (!els.vocalContainer) cacheElements();
    if (vocalWs) vocalWs.destroy();
    vocalWs = createAudioInstance(els.vocalContainer, url);
    wireScrollSync(vocalWs);
    wireTimeSync(vocalWs);
    wirePlaybackStateEvents(vocalWs);
    await new Promise((resolve) => vocalWs.on('ready', resolve));
    state.audio.vocal.fileName = fileName;
    state.audio.vocal.durationSeconds = vocalWs.getDuration();
    vocalWs.zoom(pxPerSecond);
    vocalWs.on('scroll', layoutSilenceOverlay);
    vocalWs.on('zoom', layoutSilenceOverlay);
    vocalWs.on('scroll', repositionVocalCues);
    vocalWs.on('zoom', repositionVocalCues);
    repositionVocalCues();

    const buffer = vocalWs.getDecodedData();
    if (buffer) {
      vocalSilenceGaps = silenceApi.detectSilence(buffer);
      layoutSilenceOverlay();
    }
    emit('vocal-ready');
  }

  on('tempo-changed', () => {
    rebuildTimelinePlugin();
    updatePlayheadReadout(getCurrentTime());
  });
  on('video-changed', () => {
    renderShots();
    updatePlayheadReadout(getCurrentTime());
  });
  on('limits-changed', () => renderShots());
  on('shots-changed', () => {
    renderShots();
    updatePlayheadReadout(getCurrentTime());
  });
  // Re-sync the loop overlay/toggles to whichever project was just loaded -
  // loop.startSeconds/endSeconds are only meaningful against that project's
  // own mix, and gridWs may already exist (switching projects, not the very
  // first mix load - initTimeline()'s own renderLoopOverlay() call covers that).
  on('project-loaded', () => {
    renderLoopOverlay();
    updateLoopToggle();
    updateLoopSnapToggle();
    renderVocalCues();
    updatePlayheadReadout(getCurrentTime());
  });
  on('vocal-cues-changed', () => renderVocalCues());
  // Selecting a shot (from the list, or scrollToShot elsewhere) never changes
  // any row's content, so just toggle the .selected class in place - a full
  // renderShotList() rebuild here would replace the row/cell DOM nodes on
  // every click, which breaks the browser's native double-click detection
  // (it can't accumulate a click count on a target that no longer exists),
  // making the inline shot-rename dblclick handler in buildNumberCell
  // effectively unreachable via a real double-click.
  on('shot-selected', (e) => {
    const shotId = e.detail.shotId;
    const list = document.getElementById('shot-list');
    if (list) {
      list.querySelectorAll('tr').forEach((row) => {
        row.classList.toggle('selected', row.dataset.shotId === String(shotId));
      });
    }
    scrollShotRowIntoView(shotId);
    // Same in-place toggle for the timeline clips - keeps the selection
    // highlight in sync whichever side (list row or clip) was clicked,
    // without rebuilding any DOM (same reasoning as the list rows above).
    if (shotsContentEl) {
      shotsContentEl.querySelectorAll('.lane-segment').forEach((el) => {
        el.classList.toggle('selected', el.dataset.shotId === String(shotId));
      });
    }
  });

  wireWheelScroll();
  wireCutCursor();

  MSE.sync = {
    loadMix,
    loadVocal,
    togglePlayback,
    setPlaybackTrack,
    zoomTo,
    getCurrentTime,
    seekTo,
    onPlayheadTick,
    getPxPerSecond: () => pxPerSecond,
    isTimelineReady: () => !!gridWs,
    setAudioTrackHeight,
    getAudioTrackHeight: () => audioTrackHeight,
    toggleLoopEnabled: () => setLoopEnabled(!state.loop.enabled),
    toggleLoopSnapMode: () => setLoopSnapMode(state.loop.snapMode === 'events' ? 'grid' : 'events'),
    toggleShotTimeFormat: () => setShotTimeFormat(shotTimeFormat === 'seconds' ? 'clock' : 'seconds'),
    shotRelativeLabel,
  };
})(window.MSE = window.MSE || {});
