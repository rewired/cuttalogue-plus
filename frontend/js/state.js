// Central project state, matching the project JSON data model, plus a tiny event bus
// so UI, shot logic and the waveform layer can react to changes without tight coupling.
(function (MSE) {
  'use strict';

  const bus = new EventTarget();

  function on(eventName, handler) {
    bus.addEventListener(eventName, handler);
  }

  function off(eventName, handler) {
    bus.removeEventListener(eventName, handler);
  }

  function emit(eventName, detail) {
    bus.dispatchEvent(new CustomEvent(eventName, { detail }));
  }

  function createDefaultState() {
    return {
      version: 1,
      name: '',
      audio: {
        mix: { fileName: null, durationSeconds: 0, relativePath: null },
        vocal: { fileName: null, durationSeconds: 0, relativePath: null },
        playbackTrack: 'mix', // 'mix' | 'vocal'
      },
      tempo: {
        bpm: 120,
        numerator: 4,
        denominator: 4,
        gridOffsetSeconds: 0,
        gridDivision: 'bar', // 'off' | 'beat' | 'half-bar' | 'bar' | 'two-bar'
      },
      video: {
        fpsNumerator: 24,
        fpsDenominator: 1,
        frameRule: { stride: 17, offset: 5 }, // MiniMax H3: frameCount % 17 === 5
      },
      shotLimits: {
        minimumSeconds: 8,
        maximumSeconds: 12,
      },
      shots: [], // { id, startSeconds, endSeconds, prompt, notes, assetIds, sceneId, preview }
      assets: [], // { id, type, fileName, relativePath, thumbnailPath, tags, metadata }
      scenes: [], // { id, name, splatAssetId, blockoutAssetId, unitsPerMeter, defaultCamera, anchors, motionProfile }
      // Project-absolute song timing anchors (Phase 2 of docs/h3-shot-direction-
      // roadmap.md) - { id, timeSeconds, label }, sorted ascending by timeSeconds.
      // Manually authored only; NOT duplicated per-shot - see vocalCues.js.
      vocalCues: [],
      // Phase 3a: the user's pasted lyrics, kept verbatim (line breaks and
      // all) as project data - see lyrics.js. Alignment results derived from
      // this are transient (never persisted) until explicitly applied as
      // vocalCues above.
      lyrics: { text: '' },
      // Phase 5.1: persisted word-level forced-alignment result (see
      // lyricsAlign.js) - null until a successful alignment. Phrase/Hold
      // regions stay derived-on-demand from this, never persisted
      // themselves. See project.js's normalizeLyricsAlignment for the
      // validated shape.
      lyricsAlignment: null,
      // Phase 5.2: a constant, export-only offset applied when serializing
      // Phrase regions to .srt (see subtitles.js/lyricsAlign.js) - the
      // final delivered video may have a logo/preroll before the song that
      // CUTTAlogue's own song-relative timeline never models. Deliberately
      // its own top-level key, not folded into `export` (Phase 4b's
      // whole-project video-export settings, a different feature that just
      // happens to share the word) or into `lyrics` (this is output
      // configuration, not lyric content).
      subtitleExport: { offsetSeconds: 0 },
      export: {
        includeMixSnippet: false,
      },
      loop: { enabled: false, startSeconds: null, endSeconds: null, snapMode: 'grid' }, // snapMode: 'grid' | 'events'
      savedAt: null, // stamped on every real save - see project.js's draft-recovery mechanism
    };
  }

  const state = createDefaultState();

  function resetState(next) {
    Object.keys(state).forEach((key) => delete state[key]);
    Object.assign(state, next);
    emit('project-loaded');
  }

  MSE.state = { state, on, off, emit, createDefaultState, resetState };
})(window.MSE = window.MSE || {});
