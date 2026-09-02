// Phase 3a of docs/h3-shot-direction-roadmap.md: local word-level lyrics-to-
// vocal alignment. This module owns the Lyrics tab (textarea persistence,
// the Align job, and the preview/apply flow) but does NOT own any cue state
// - alignment results are converted into real Phase-2 vocal cues purely
// through MSE.vocalCues.add()/remove() when the user clicks Apply. Once
// applied, the main timeline/Direction editor pick them up through the
// existing vocal-cues-changed event, same as any manually authored cue -
// there is no second cue display path here.
//
// Phase 5.1: the expensive word-level result itself IS persisted, as
// state.lyricsAlignment (see project.js's serializeProject/
// normalizeLyricsAlignment) - restored on project load when still valid
// (getStoredAlignmentStatus below), with no MMS run required. Phrases/Holds
// remain purely derived/transient, same as before.
(function (MSE) {
  'use strict';

  const { state, on, emit } = MSE.state;

  const el = {};
  let isVisible = false;
  // The current preview result (array of { text, startSeconds, endSeconds,
  // confidence, lineIndex, wordIndex }, startSeconds/endSeconds null for a
  // word the aligner couldn't place) - null when there's nothing active to
  // show. Mirrors state.lyricsAlignment.words while a valid persisted/fresh
  // result is active; this module-local copy is what rendering reads from,
  // never a second source of truth for the persisted words themselves.
  let previewWords = null;
  // The exact lyrics text that produced previewWords, snapshotted at
  // request time rather than re-read from state.lyrics.text later - phrase
  // derivation needs the original line text for lineIndex lookups, and the
  // user may keep editing the textarea while a job is in flight or after it
  // completes, which must never retroactively change what a *past* result's
  // phrases mean.
  let previewLyricsText = '';
  // Derived from previewWords/previewLyricsText via MSE.vocalRegions - see
  // deriveAndRenderRegions(). Transient, same lifecycle as previewWords;
  // never persisted, never a second cue system (Phase 2's vocalCues remains
  // the only persistent point-cue model - see the file header).
  let previewPhrases = [];
  let previewHolds = [];
  let holdThresholdSeconds = MSE.vocalRegions.DEFAULT_HOLD_THRESHOLD_SECONDS;

  // Phase 5.1: the one schema version this build understands - kept as a
  // single constant, never scattered numeric checks (see project.js's
  // normalizeLyricsAlignment for the corresponding shape validation).
  const SUPPORTED_SCHEMA_VERSION = 1;

  // A word below this confidence is very likely a forced-alignment failure
  // rather than a genuinely-if-weakly-placed word - real project data shows
  // ordinarily-placed words clustering around 0.1-0.3+, while a stretched/
  // misplaced word (the model essentially gave up and let it absorb
  // leftover unaligned audio) sits well under this. Not scientifically
  // calibrated, just a practical default surfaced as a visual warning (see
  // renderPreview/buildRegionRow below) so a bad phrase's *cause* is visible
  // in the tab itself, rather than only showing up later as a strange SRT
  // timestamp - see the README's "Getting good alignment results".
  const LOW_CONFIDENCE_THRESHOLD = 0.05;

  // True if any word whose span falls within [region.startSeconds,
  // region.endSeconds] is below LOW_CONFIDENCE_THRESHOLD - a rendering-time
  // annotation only. Never redefines a Phrase/Hold's boundaries or text;
  // those remain exactly MSE.vocalRegions' own derivation. A Hold's span is
  // exactly one word's span, so this naturally finds that same word; a
  // Phrase's span typically covers several.
  function regionHasLowConfidenceWord(region) {
    return (previewWords || []).some((w) => (
      w.confidence != null
      && w.confidence < LOW_CONFIDENCE_THRESHOLD
      && w.startSeconds != null
      && w.startSeconds >= region.startSeconds
      && w.endSeconds <= region.endSeconds
    ));
  }

  function cacheElements() {
    el.textarea = document.getElementById('lyrics-text');
    el.alignBtn = document.getElementById('align-lyrics-btn');
    el.alignSpinner = document.getElementById('align-spinner');
    el.alignStatusText = document.getElementById('align-status-text');
    el.alignProgressBar = document.getElementById('align-progress-bar');
    el.alignProgressFill = document.getElementById('align-progress-fill');
    el.previewEmpty = document.getElementById('align-preview-empty');
    el.previewDetail = document.getElementById('align-preview-detail');
    el.previewList = document.getElementById('align-preview-list');
    el.regionViz = document.getElementById('lyrics-region-viz');
    el.phrasesList = document.getElementById('align-preview-phrases');
    el.phrasesEmpty = document.getElementById('align-preview-phrases-empty');
    el.holdsList = document.getElementById('align-preview-holds');
    el.holdsEmpty = document.getElementById('align-preview-holds-empty');
    el.holdThresholdInput = document.getElementById('hold-threshold-input');
    el.applyBtn = document.getElementById('apply-alignment-btn');
    el.applyStatusText = document.getElementById('apply-status-text');
    el.modeAdd = document.getElementById('align-apply-mode-add');
    el.modeReplace = document.getElementById('align-apply-mode-replace');
    el.subtitleOffsetInput = document.getElementById('subtitle-offset-input');
    el.exportSrtBtn = document.getElementById('export-srt-btn');
    el.srtExportStatusText = document.getElementById('srt-export-status-text');
  }

  // Same "don't clobber an active edit" guard as syncTextareaFromState.
  function syncSubtitleOffsetFromState() {
    if (document.activeElement === el.subtitleOffsetInput) return;
    el.subtitleOffsetInput.value = state.subtitleExport.offsetSeconds;
  }

  // Mirrors renderShotList's "don't clobber an active edit" guard - a full
  // resync (project load, tab switch) must never overwrite what's mid-typing.
  function syncTextareaFromState() {
    if (document.activeElement === el.textarea) return;
    el.textarea.value = (state.lyrics && state.lyrics.text) || '';
  }

  // Free text mutated directly on state, same convention as shot prompt/
  // notes (contextPanel.js) - canonical autosave's poll-and-diff picks this up
  // without needing its own change event.
  function wireTextarea() {
    el.textarea.addEventListener('input', () => {
      state.lyrics.text = el.textarea.value;
      // Phase 5.1 (spec 18): an active preview/derived-region result no
      // longer corresponds to what's on screen the moment lyrics diverge
      // from the exact text it was derived from - clear it rather than let
      // Direction keep reading stale regions as current. The *persisted*
      // state.lyricsAlignment record itself is left untouched here; only a
      // successful re-align (or an explicit clear) replaces it.
      if (previewWords && el.textarea.value !== previewLyricsText) {
        previewWords = null;
        previewLyricsText = '';
        renderPreview();
        deriveAndRenderRegions();
        setAlignStatus('Lyrics changed — re-align required.', false);
      }
    });
  }

  function renderPreview() {
    el.previewList.innerHTML = '';
    const hasWords = !!(previewWords && previewWords.length);
    el.previewEmpty.style.display = hasWords ? 'none' : '';
    el.previewDetail.style.display = hasWords ? '' : 'none';
    if (!hasWords) return;

    previewWords.forEach((word) => {
      const row = document.createElement('tr');
      const unaligned = word.startSeconds == null;
      const lowConfidence = !unaligned && word.confidence != null && word.confidence < LOW_CONFIDENCE_THRESHOLD;
      row.className = `lyrics-preview-row${unaligned ? ' unaligned' : ''}${lowConfidence ? ' low-confidence' : ''}`;

      const startCell = document.createElement('td');
      startCell.textContent = unaligned ? '—' : MSE.format.formatTime(word.startSeconds);
      row.appendChild(startCell);

      const endCell = document.createElement('td');
      endCell.textContent = unaligned || word.endSeconds == null ? '—' : MSE.format.formatTime(word.endSeconds);
      row.appendChild(endCell);

      const wordCell = document.createElement('td');
      wordCell.textContent = unaligned ? `${word.text} (unaligned)` : word.text;
      if (word.confidence != null) {
        wordCell.title = lowConfidence
          ? `confidence ${word.confidence.toFixed(2)} - low, this timing may be unreliable`
          : `confidence ${word.confidence.toFixed(2)}`;
      }
      row.appendChild(wordCell);

      el.previewList.appendChild(row);
    });
  }

  // Optional per Phase 3b (section 10) - a normal vocal cue at a region
  // boundary, created exclusively through MSE.vocalCues.add(), never a
  // direct state.vocalCues write and never a second "paired" cue. Regions
  // themselves stay analysis-only; this just gives the user a one-click way
  // to promote a boundary they find useful into the persistent Phase-2 cue
  // timeline, same as any other manually authored cue.
  function addCueAtRegionStart(region) {
    MSE.vocalCues.add(region.startSeconds, region.text);
    el.applyStatusText.textContent = `Added a vocal cue at ${MSE.format.formatTime(region.startSeconds)} ("${region.text}").`;
  }

  function buildRegionRow(region) {
    const row = document.createElement('tr');
    if (regionHasLowConfidenceWord(region)) {
      row.className = 'low-confidence';
      row.title = 'Contains a low-confidence word - this timing may be unreliable (see README: Getting good alignment results)';
    }
    const startCell = document.createElement('td');
    startCell.textContent = MSE.format.formatTime(region.startSeconds);
    row.appendChild(startCell);

    const endCell = document.createElement('td');
    endCell.textContent = MSE.format.formatTime(region.endSeconds);
    row.appendChild(endCell);

    const textCell = document.createElement('td');
    textCell.textContent = region.text;
    if (region.type === 'hold' && MSE.vocalRegions.looksElongated(region.text)) {
      textCell.title = 'Elongated spelling - a supporting hint only, not the timing source';
      textCell.className = 'lyrics-elongated-hint';
    }
    row.appendChild(textCell);

    const actionCell = document.createElement('td');
    const cueBtn = document.createElement('button');
    cueBtn.type = 'button';
    cueBtn.className = 'lyrics-region-cue-btn';
    cueBtn.textContent = '+ Cue';
    cueBtn.title = `Create a vocal cue at this ${region.type}'s start`;
    cueBtn.addEventListener('click', () => addCueAtRegionStart(region));
    actionCell.appendChild(cueBtn);
    row.appendChild(actionCell);

    return row;
  }

  function renderPhrases() {
    el.phrasesList.innerHTML = '';
    el.phrasesEmpty.hidden = previewPhrases.length !== 0;
    previewPhrases.forEach((phrase) => el.phrasesList.appendChild(buildRegionRow(phrase)));
  }

  function renderHolds() {
    el.holdsList.innerHTML = '';
    el.holdsEmpty.hidden = previewHolds.length !== 0;
    previewHolds.forEach((hold) => el.holdsList.appendChild(buildRegionRow(hold)));
  }

  // Compact, self-contained proportional strip (word dots / phrase bars /
  // hold bars) scoped to the Lyrics tab preview only - deliberately not
  // wired into the main WaveSurfer timeline or the Direction editor, which
  // would mean a second timeline-overlay system for what's still a
  // transient analysis view (see the file header's three-concepts note).
  function renderRegionViz() {
    el.regionViz.innerHTML = '';
    const usable = (previewWords || []).filter((w) => w.startSeconds != null && w.endSeconds != null && w.endSeconds > w.startSeconds);
    if (!usable.length) {
      el.regionViz.hidden = true;
      return;
    }
    el.regionViz.hidden = false;
    const spanStart = Math.min(...usable.map((w) => w.startSeconds));
    const spanEnd = Math.max(...usable.map((w) => w.endSeconds));
    const span = Math.max(1e-6, spanEnd - spanStart);
    const pct = (t) => `${((t - spanStart) / span) * 100}%`;

    function buildTrack(label, className) {
      const row = document.createElement('div');
      row.className = 'lyrics-viz-row';
      const labelEl = document.createElement('div');
      labelEl.className = 'lyrics-viz-row-label';
      labelEl.textContent = label;
      row.appendChild(labelEl);
      const track = document.createElement('div');
      track.className = `lyrics-viz-track lyrics-viz-track-${className}`;
      row.appendChild(track);
      el.regionViz.appendChild(row);
      return track;
    }

    const wordsTrack = buildTrack('Words', 'words');
    usable.forEach((w) => {
      const dot = document.createElement('div');
      dot.className = 'lyrics-viz-dot';
      dot.style.left = pct(w.startSeconds);
      dot.title = w.text;
      wordsTrack.appendChild(dot);
    });

    const phrasesTrack = buildTrack('Phrases', 'phrases');
    previewPhrases.forEach((p) => {
      const bar = document.createElement('div');
      bar.className = 'lyrics-viz-bar lyrics-viz-bar-phrase';
      bar.style.left = pct(p.startSeconds);
      bar.style.width = `${((p.endSeconds - p.startSeconds) / span) * 100}%`;
      bar.title = p.text;
      phrasesTrack.appendChild(bar);
    });

    const holdsTrack = buildTrack('Holds', 'holds');
    previewHolds.forEach((h) => {
      const bar = document.createElement('div');
      bar.className = 'lyrics-viz-bar lyrics-viz-bar-hold';
      bar.style.left = pct(h.startSeconds);
      bar.style.width = `${((h.endSeconds - h.startSeconds) / span) * 100}%`;
      bar.title = h.text;
      holdsTrack.appendChild(bar);
    });
  }

  // Pure re-derivation over the already-fetched previewWords/
  // previewLyricsText - never re-runs alignment, never touches the backend
  // (see MSE.vocalRegions' own header on why this is safe/cheap to call on
  // every hold-threshold change).
  function deriveAndRenderRegions() {
    if (previewWords && previewWords.length) {
      const derived = MSE.vocalRegions.deriveRegions(previewWords, previewLyricsText, { holdThresholdSeconds });
      previewPhrases = derived.phrases;
      previewHolds = derived.holds;
    } else {
      previewPhrases = [];
      previewHolds = [];
    }
    renderPhrases();
    renderHolds();
    renderRegionViz();
    // Phase 4a: the Direction editor's read-only Vocal Phrases/Holds rows
    // and its region-boundary snap candidates both read the current result
    // fresh via getCurrentRegions() below (never a local copy) - this is
    // the one place that result actually changes, so it's the one place
    // that needs to say so.
    emit('vocal-regions-changed');
  }

  // Phase 4a: the Direction editor consumes the *current* transient
  // analysis result for authoring assistance (read-only reference rows,
  // region -> segment creation, region-boundary snapping) - this is the
  // one accessor for that, returning the same arrays renderPhrases/
  // renderHolds already render from. Never a second derivation: Direction
  // calls MSE.vocalRegions.regionsForShot() itself against whatever this
  // returns, exactly like it already does for MSE.vocalCues.forShot().
  function getCurrentRegions() {
    return { phrases: previewPhrases, holds: previewHolds };
  }

  function setAlignStatus(text, spinning) {
    el.alignStatusText.textContent = text;
    el.alignSpinner.hidden = !spinning;
  }

  // fraction == null hides the bar (no download in progress, or the
  // server gave no Content-Length to compute a real percentage from - see
  // _download_model_with_progress's own comment on why that case never
  // shows a fabricated fraction). Otherwise shows it at the given 0..1.
  function setAlignProgress(fraction) {
    if (fraction == null) {
      el.alignProgressBar.hidden = true;
      return;
    }
    el.alignProgressBar.hidden = false;
    el.alignProgressFill.style.width = `${fraction * 100}%`;
  }

  // Phase 5.1: the one authoritative validity decision for the persisted
  // state.lyricsAlignment record - every restore/invalidation path below
  // calls this rather than re-deriving its own staleness logic. Pure
  // read-only (one network call to learn the *current* on-disk vocal
  // fingerprint; never runs alignment). See project.js's
  // normalizeLyricsAlignment for the shape this reads.
  async function getStoredAlignmentStatus() {
    const stored = state.lyricsAlignment;
    if (!stored) return { status: 'missing', reason: null };
    if (stored.schemaVersion !== SUPPORTED_SCHEMA_VERSION) return { status: 'stale', reason: 'schema' };

    const currentLyrics = (state.lyrics && state.lyrics.text) || '';
    if (currentLyrics !== stored.lyricsSnapshot) return { status: 'stale', reason: 'lyrics_changed' };

    const projectId = MSE.project.getProjectId();
    let currentFingerprint = null;
    if (projectId) {
      try {
        currentFingerprint = await MSE.api.getVocalFingerprint(projectId);
      } catch (err) {
        currentFingerprint = null;
      }
    }
    if (!currentFingerprint) return { status: 'stale', reason: 'vocal_changed' };

    const stale = stored.vocalSource == null
      || currentFingerprint.relativePath !== stored.vocalSource.relativePath
      || currentFingerprint.sizeBytes !== stored.vocalSource.sizeBytes
      || currentFingerprint.mtimeMs !== stored.vocalSource.mtimeMs;
    if (stale) return { status: 'stale', reason: 'vocal_changed' };

    return { status: 'valid', reason: null };
  }

  // One place mapping a status/reason to the short status-line text (spec
  // section 26) - never scattered across call sites.
  function describeStatus({ status, reason }) {
    if (status === 'valid') return 'Aligned result restored.';
    if (reason === 'lyrics_changed') return 'Lyrics changed — re-align required.';
    if (reason === 'vocal_changed') return 'Vocal changed — re-align required.';
    if (reason === 'schema') return 'Alignment source unavailable — re-align required.';
    return '';
  }

  // Restores previewWords/previewLyricsText from a valid persisted
  // state.lyricsAlignment and re-renders through the exact same paths a
  // fresh alignment uses (spec section 12: no separate "restored" UI path).
  // Clears the active preview otherwise. Shared by the project-loaded and
  // vocal-ready handlers below.
  async function syncPreviewWithStoredAlignment() {
    const result = await getStoredAlignmentStatus();
    if (result.status === 'valid') {
      previewWords = state.lyricsAlignment.words;
      previewLyricsText = state.lyricsAlignment.lyricsSnapshot;
    } else {
      previewWords = null;
      previewLyricsText = '';
    }
    renderPreview();
    deriveAndRenderRegions();
    setAlignStatus(describeStatus(result), false);
    return result;
  }

  async function runAlignment() {
    const lyricsText = (state.lyrics && state.lyrics.text) || '';
    if (!lyricsText.trim()) {
      setAlignStatus('Enter lyrics before alignment.', false);
      return;
    }
    const projectId = MSE.project.getProjectId();
    if (!projectId) {
      setAlignStatus('No project loaded.', false);
      return;
    }

    el.alignBtn.disabled = true;
    el.applyStatusText.textContent = '';
    setAlignStatus('Starting…', true);
    try {
      const { jobId } = await MSE.api.alignLyrics(projectId, lyricsText);
      const event = await MSE.api.watchJob(jobId, (progressEvent) => {
        // Real byte progress only while the backend is actually downloading
        // the alignment model (see alignment.py's _download_model_with_progress)
        // - any other phase (audio prep, model load, aligning) hides the bar.
        setAlignProgress(progressEvent.phase === 'downloading_model' ? progressEvent.progressFraction : null);
        if (progressEvent.message) setAlignStatus(progressEvent.message, true);
      });
      const alignment = (event.result && event.result.lyricsAlignment) || null;
      previewWords = (alignment && alignment.words) || [];
      previewLyricsText = lyricsText;
      renderPreview();
      deriveAndRenderRegions();
      // Written only on success (spec section 8) - a failed re-align below
      // never touches state.lyricsAlignment, leaving whatever was
      // previously persisted completely intact. This single assignment is
      // also what makes the project dirty, via project.js's existing
      // serialize-and-diff autosave poll - no explicit dirty call needed.
      state.lyricsAlignment = alignment;
      const alignedCount = previewWords.filter((w) => w.startSeconds != null).length;
      setAlignStatus(`Aligned ${alignedCount} of ${previewWords.length} word(s).`, false);
    } catch (err) {
      console.error(err);
      previewWords = null;
      previewLyricsText = '';
      renderPreview();
      deriveAndRenderRegions();
      setAlignStatus(`Failed: ${err.message}`, false);
    } finally {
      setAlignProgress(null);
      el.alignBtn.disabled = false;
    }
  }

  // Pure: converts alignment words into real Phase-2 vocal cues exclusively
  // through MSE.vocalCues' own API (never a direct state.vocalCues write) -
  // see the file header. Words the aligner couldn't place (startSeconds ==
  // null) are skipped entirely, per Phase 3a's "never invent a timestamp"
  // rule; they simply don't become cues. No DOM here - kept separate from
  // applyAlignment() below so it's directly unit-testable (see
  // frontend/tests/lyricsAlign.test.js) the same way vocalCues.js's own
  // functions are. mode is 'add' or 'replace'.
  function applyAlignmentWords(words, mode) {
    if (mode === 'replace') {
      MSE.vocalCues.list().map((c) => c.id).forEach((id) => MSE.vocalCues.remove(id));
    }
    let created = 0;
    (words || []).forEach((word) => {
      if (word.startSeconds == null) return;
      MSE.vocalCues.add(word.startSeconds, word.text);
      created += 1;
    });
    return { created };
  }

  function applyAlignment() {
    if (!previewWords || !previewWords.length) return;
    const mode = el.modeReplace.checked ? 'replace' : 'add';
    const { created } = applyAlignmentWords(previewWords, mode);
    el.applyStatusText.textContent = mode === 'replace'
      ? `Replaced existing vocal cues with ${created} new one(s).`
      : `Added ${created} new vocal cue(s).`;
  }

  // Separate from describeStatus() above (which is worded for the restore-
  // on-load status line) - SRT export needs its own phrasing ("re-align
  // before exporting", not "re-align required") on the same underlying
  // status/reason values from getStoredAlignmentStatus(), the one
  // authoritative check both call sites share.
  function describeExportBlockedReason({ reason }) {
    if (reason === 'lyrics_changed') return 'Lyrics changed — re-align before exporting SRT.';
    if (reason === 'vocal_changed') return 'Vocal changed — re-align before exporting SRT.';
    return 'Align the lyrics to the current vocal before exporting SRT.';
  }

  // Characters invalid/problematic in local filenames across common
  // filesystems - never a random id (spec section 19). Falls back to
  // 'lyrics' if the project name is empty or sanitizes away to nothing.
  function sanitizeFilenameStem(name) {
    const cleaned = (name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
    return cleaned || 'lyrics';
  }

  // Export SRT never re-runs alignment (spec section 16) - it only ever
  // reads the current, already-derived Phrase list via getCurrentRegions()
  // (the same accessor Direction uses), gated by the same
  // getStoredAlignmentStatus() check restore-on-load uses. Hold regions and
  // Shot boundaries are never consulted - MSE.subtitles.serializeSrt only
  // ever receives (phrases, offsetSeconds).
  async function exportSrt() {
    el.exportSrtBtn.disabled = true;
    el.srtExportStatusText.textContent = 'Checking alignment…';
    try {
      const result = await getStoredAlignmentStatus();
      if (result.status !== 'valid') {
        el.srtExportStatusText.textContent = describeExportBlockedReason(result);
        return;
      }
      const { phrases } = getCurrentRegions();
      const srt = MSE.subtitles.serializeSrt(phrases, state.subtitleExport.offsetSeconds);
      // Empty covers both "no Phrase regions at all" and "every Phrase was
      // clamped/omitted by the current offset" (spec section 22) - either
      // way, never silently download a blank .srt.
      if (!srt) {
        el.srtExportStatusText.textContent = 'No aligned lyric phrases are available to export.';
        return;
      }
      const cueCount = srt.trim().split('\n\n').length;
      const filename = `${sanitizeFilenameStem(state.name)}.srt`;
      MSE.project.triggerDownload(filename, srt, 'application/x-subrip;charset=utf-8');
      el.srtExportStatusText.textContent = `Exported ${cueCount} subtitle(s).`;
    } finally {
      el.exportSrtBtn.disabled = false;
    }
  }

  function wire() {
    wireTextarea();
    el.alignBtn.addEventListener('click', () => runAlignment());
    el.applyBtn.addEventListener('click', () => applyAlignment());
    // Re-derives locally from the already-fetched words - never re-runs
    // alignment (see deriveAndRenderRegions's own comment).
    el.holdThresholdInput.addEventListener('change', () => {
      const parsed = Number(el.holdThresholdInput.value);
      holdThresholdSeconds = Number.isFinite(parsed) && parsed >= 0 ? parsed : MSE.vocalRegions.DEFAULT_HOLD_THRESHOLD_SECONDS;
      el.holdThresholdInput.value = holdThresholdSeconds;
      deriveAndRenderRegions();
    });
    // Direct state mutation, same convention as lyrics.text's own input
    // handler - project.js's existing poll-and-diff autosave picks this up
    // without an explicit dirty call. Unlike the hold threshold above, this
    // value is persisted (spec section 6/8), so no in-memory fallback
    // variable is needed - state.subtitleExport.offsetSeconds *is* the
    // value.
    el.subtitleOffsetInput.addEventListener('change', () => {
      const parsed = Number(el.subtitleOffsetInput.value);
      state.subtitleExport.offsetSeconds = Number.isFinite(parsed) ? parsed : 0;
      el.subtitleOffsetInput.value = state.subtitleExport.offsetSeconds;
    });
    el.exportSrtBtn.addEventListener('click', () => exportSrt());

    on('main-view-changed', ({ detail }) => {
      isVisible = detail.view === 'lyrics';
      if (isVisible) {
        syncTextareaFromState();
        syncSubtitleOffsetFromState();
      }
    });
    // Phase 5.1: restores a valid persisted alignment immediately (no MMS
    // run) instead of unconditionally clearing the preview - see
    // syncPreviewWithStoredAlignment. audio.vocal.relativePath in the just-
    // loaded project (not a browser File) is what the fingerprint check
    // resolves against, so this never requires reselecting the vocal file.
    on('project-loaded', async () => {
      await syncPreviewWithStoredAlignment();
      el.applyStatusText.textContent = '';
      el.srtExportStatusText.textContent = '';
      syncSubtitleOffsetFromState();
      if (isVisible) syncTextareaFromState();
    });
    // Fires both on a fresh vocal file pick and on the backend auto-restore
    // during project load (waveformSync.js) - only re-checks when there's
    // an active preview to (in)validate, so an ordinary playback load never
    // costs an extra fingerprint fetch. On the auto-restore case this just
    // re-confirms what project-loaded already restored (harmless no-op).
    on('vocal-ready', async () => {
      if (!previewWords) return;
      await syncPreviewWithStoredAlignment();
    });
  }

  function init() {
    cacheElements();
    holdThresholdSeconds = MSE.vocalRegions.DEFAULT_HOLD_THRESHOLD_SECONDS;
    el.holdThresholdInput.value = holdThresholdSeconds;
    syncSubtitleOffsetFromState();
    wire();
    renderPreview();
    deriveAndRenderRegions();
  }

  document.addEventListener('DOMContentLoaded', init);

  MSE.lyricsAlign = { applyAlignmentWords, getCurrentRegions, getStoredAlignmentStatus };
})(window.MSE = window.MSE || {});
