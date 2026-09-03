// Project save/load, backed by the Phase 2 backend (project folder on disk),
// plus shot list export (JSON/CSV), which stays a client-side download.
(function (MSE) {
  'use strict';

  const { state, resetState, emit } = MSE.state;
  const { frameCalc } = MSE.frames;
  const shotsApi = MSE.shots;
  const api = MSE.api;

  const PROJECT_ID_STORAGE_KEY = 'cuttalogue.projectId';

  function frameRuleLabel(stride) {
    if (stride === 4) return '4n+1';
    if (stride === 8) return '8n+1';
    return 'free';
  }

  function triggerDownload(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function serializeProject() {
    return {
      version: state.version,
      name: state.name || '',
      audio: state.audio,
      tempo: state.tempo,
      video: state.video,
      shotLimits: state.shotLimits,
      shots: state.shots.map((s) => ({
        id: s.id,
        startSeconds: s.startSeconds,
        endSeconds: s.endSeconds,
        name: s.name || '',
        prompt: s.prompt || '',
        notes: s.notes || '',
        seed: s.seed ?? null,
        takes: s.takes || [],
        activeTakeId: s.activeTakeId ?? null,
        assetIds: s.assetIds || [],
        assetRoles: s.assetRoles || {},
        videoRefs: s.videoRefs || {},
        constraints: s.constraints || [],
        sceneId: s.sceneId ?? null,
        preview: s.preview || { initialCameraOverride: null, targetBindings: {}, interpreterProfile: 'cinematic-v1' },
        direction: s.direction || { camera: [], lighting: [], subjects: {}, props: {}, beatNotes: [] },
      })),
      assets: state.assets,
      scenes: state.scenes || [],
      vocalCues: (state.vocalCues || []).map((c) => ({ id: c.id, timeSeconds: c.timeSeconds, label: c.label || '' })),
      lyrics: { text: (state.lyrics && state.lyrics.text) || '' },
      lyricsAlignment: state.lyricsAlignment || null,
      subtitleExport: { offsetSeconds: (state.subtitleExport && state.subtitleExport.offsetSeconds) || 0 },
      export: state.export,
      loop: state.loop,
      // Stamped by the repository on every canonical save. Concurrency uses
      // the content revision; this timestamp remains migration metadata.
      savedAt: state.savedAt ?? null,
    };
  }

  // Camera/subject direction segments predating the structured-fields phase
  // (see the Direction tab's structured-editor discussion) only had
  // movement/framing/speed (camera) or a single free-text `action` (subject)
  // - default-fill every new field so older segments still round-trip, and
  // fold the one-time `action` -> `notes` rename in on the way. Mutates each
  // segment object in place (already a fresh copy from JSON.parse or the
  // draft/canonical fetch, never the live in-memory segment).
  function normalizeDirectionSegments(direction) {
    if (!direction.props) direction.props = {};
    if (!direction.lighting) direction.lighting = [];
    if (!direction.beatNotes) direction.beatNotes = [];
    (direction.camera || []).forEach((seg) => {
      if (seg.direction === undefined) seg.direction = '';
      if (seg.target === undefined) seg.target = '';
      if (seg.transitionToNext === undefined) seg.transitionToNext = '';
      if (seg.amplitude === undefined) seg.amplitude = '';
      if (seg.focalLength === undefined) seg.focalLength = '';
      if (seg.depthOfField === undefined) seg.depthOfField = '';
      if (seg.focusTarget === undefined) seg.focusTarget = '';
      if (seg.enabled === undefined) seg.enabled = true;
    });
    direction.lighting.forEach((seg) => {
      if (seg.keyLight === undefined) seg.keyLight = '';
      if (seg.fill === undefined) seg.fill = '';
      if (seg.backlight === undefined) seg.backlight = '';
      if (seg.exposure === undefined) seg.exposure = '';
      if (seg.atmosphere === undefined) seg.atmosphere = '';
      if (seg.notes === undefined) seg.notes = '';
      if (seg.enabled === undefined) seg.enabled = true;
    });
    Object.values(direction.subjects || {}).forEach((track) => {
      track.forEach((seg) => {
        if (seg.notes === undefined) {
          seg.notes = seg.action || '';
          delete seg.action;
        }
        if (seg.actionType === undefined) seg.actionType = '';
        if (seg.vocalPerformance === undefined) seg.vocalPerformance = '';
        if (seg.manner === undefined) seg.manner = '';
        if (seg.gaze === undefined) seg.gaze = '';
        if (seg.eyes === undefined) seg.eyes = '';
        if (seg.expression === undefined) seg.expression = '';
        if (seg.gesture === undefined) seg.gesture = '';
        if (seg.bodyMotion === undefined) seg.bodyMotion = '';
        if (seg.enabled === undefined) seg.enabled = true;
      });
    });
    Object.values(direction.props).forEach((track) => {
      track.forEach((seg) => {
        if (seg.state === undefined) seg.state = '';
        if (seg.ownerAssetId === undefined) seg.ownerAssetId = null;
        if (seg.notes === undefined) seg.notes = '';
        if (seg.enabled === undefined) seg.enabled = true;
      });
    });
    direction.beatNotes.forEach((note) => {
      if (note.intent === undefined) note.intent = '';
      if (note.priority === undefined) note.priority = '';
      if (note.endState === undefined) note.endState = '';
    });
  }

  // Defensive-only normalization for a persisted word (Phase 5.1) - protects
  // against a malformed/foreign record (older hand-edited project.json)
  // crashing project load. Never decides staleness/validity - that's the
  // single job of MSE.lyricsAlign.getStoredAlignmentStatus(); this only
  // drops entries that can't be trusted structurally.
  function normalizeAlignmentWord(w) {
    if (!w || typeof w.text !== 'string') return null;
    if (!Number.isInteger(w.lineIndex) || !Number.isInteger(w.wordIndex)) return null;
    return {
      text: w.text,
      startSeconds: Number.isFinite(w.startSeconds) ? w.startSeconds : null,
      endSeconds: Number.isFinite(w.endSeconds) ? w.endSeconds : null,
      confidence: Number.isFinite(w.confidence) ? w.confidence : null,
      lineIndex: w.lineIndex,
      wordIndex: w.wordIndex,
    };
  }

  // Pure: normalizes a persisted lyricsAlignment record (or undefined, for
  // every project predating Phase 5.1) to either a well-shaped object or
  // null. A record with zero usable words after filtering is treated as no
  // alignment at all, not an empty-but-present one - an empty result was
  // never a real successful alignment (see the Phase 5.1 spec's "never
  // restore an empty Phrase/Hold result as though alignment succeeded").
  function normalizeLyricsAlignment(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const words = (Array.isArray(raw.words) ? raw.words : []).map(normalizeAlignmentWord).filter(Boolean);
    if (!words.length) return null;
    return {
      schemaVersion: Number.isFinite(raw.schemaVersion) ? raw.schemaVersion : null,
      engine: typeof raw.engine === 'string' ? raw.engine : null,
      lyricsSnapshot: typeof raw.lyricsSnapshot === 'string' ? raw.lyricsSnapshot : '',
      vocalSource: raw.vocalSource && typeof raw.vocalSource === 'object'
        ? {
            relativePath: raw.vocalSource.relativePath ?? null,
            sizeBytes: Number.isFinite(raw.vocalSource.sizeBytes) ? raw.vocalSource.sizeBytes : null,
            mtimeMs: Number.isFinite(raw.vocalSource.mtimeMs) ? raw.vocalSource.mtimeMs : null,
          }
        : null,
      words,
    };
  }

  // Pure: defaults in fields older/foreign project data predates (name/
  // prompt/notes/assetIds/assets/export/savedAt/constraints) without
  // touching `parsed` or global state - needed so both the canonical
  // project and a draft can be normalized and diffed *before* deciding
  // which one to actually apply (see loadProjectConsideringDraft).
  function normalizeProjectData(parsed) {
    const normalized = { ...parsed };
    normalized.name = normalized.name || '';
    normalized.shots = (normalized.shots || []).map((s) => ({
      name: '',
      prompt: '',
      notes: '',
      seed: null,
      takes: [],
      activeTakeId: null,
      assetIds: [],
      assetRoles: {},
      videoRefs: {},
      constraints: [],
      sceneId: null,
      preview: { initialCameraOverride: null, targetBindings: {}, interpreterProfile: 'cinematic-v1' },
      direction: { camera: [], lighting: [], subjects: {}, props: {}, beatNotes: [] },
      ...s,
    }));
    normalized.shots.forEach((s) => {
      s.preview = {
        initialCameraOverride: null,
        targetBindings: {},
        interpreterProfile: 'cinematic-v1',
        ...(s.preview || {}),
      };
      if (!s.preview.targetBindings || typeof s.preview.targetBindings !== 'object') s.preview.targetBindings = {};
      normalizeDirectionSegments(s.direction);
    });
    normalized.assets = (normalized.assets || []).map((a) => ({ tags: [], description: '', ...a }));
    normalized.scenes = (normalized.scenes || []).map((scene) => {
      const source = scene && typeof scene === 'object' ? scene : {};
      return {
        name: '',
        splatAssetId: null,
        blockoutAssetId: null,
        unitsPerMeter: 1,
        anchors: {},
        motionProfile: {},
        ...source,
        defaultCamera: {
          position: [0, 1.6, 4],
          target: [0, 1.5, 0],
          focalLengthMm: 35,
          ...(source.defaultCamera || {}),
        },
        anchors: source.anchors && typeof source.anchors === 'object' ? source.anchors : {},
        motionProfile: source.motionProfile && typeof source.motionProfile === 'object' ? source.motionProfile : {},
      };
    });
    // Older projects predate vocalCues entirely -> []. Always re-sorted
    // ascending by timeSeconds here (not just wherever a cue is mutated) so a
    // hand-edited or foreign project.json can't load with a stale order.
    normalized.vocalCues = (normalized.vocalCues || [])
      .map((c) => ({ label: '', ...c }))
      .sort((a, b) => a.timeSeconds - b.timeSeconds);
    // Older projects predate lyrics entirely -> ''. Text is preserved
    // verbatim (line breaks and all) - never re-derived or normalized here,
    // that only ever happens transiently inside the alignment call itself.
    normalized.lyrics = { text: '', ...(normalized.lyrics || {}) };
    normalized.lyricsAlignment = normalizeLyricsAlignment(normalized.lyricsAlignment);
    // Older projects predate subtitleExport entirely -> the default offset.
    // A non-finite/malformed offset (foreign or hand-edited project.json)
    // falls back the same way, rather than letting NaN/a string leak into
    // SRT serialization later.
    normalized.subtitleExport = {
      offsetSeconds: Number.isFinite((normalized.subtitleExport || {}).offsetSeconds)
        ? normalized.subtitleExport.offsetSeconds
        : 0,
    };
    normalized.export = { includeMixSnippet: false, ...(normalized.export || {}) };
    normalized.loop = { enabled: false, startSeconds: null, endSeconds: null, snapMode: 'grid', ...(normalized.loop || {}) };
    normalized.savedAt = normalized.savedAt ?? null;
    return normalized;
  }

  function applyNormalizedProject(normalized) {
    resetState(normalized);
    emit('tempo-changed');
    emit('video-changed');
    emit('limits-changed');
    emit('shots-changed');
    emit('assets-changed', { reason: 'load' });
    autoLoadAudioFromBackend();
  }

  function applyLoadedProject(parsed) {
    applyNormalizedProject(normalizeProjectData(parsed));
  }

  // Applies a canonical project revision written by MCP without emitting
  // project-loaded: that event intentionally clears shot selection and closes
  // the camera preview. Live updates instead refresh the same state object and
  // emit the granular events existing workspaces already observe.
  function applyLiveProject(parsed, revision) {
    const normalized = normalizeProjectData(parsed);
    Object.keys(state).forEach((key) => delete state[key]);
    Object.assign(state, normalized);
    markBaseline(JSON.stringify(normalized), revision);
    const projectId = getProjectId();
    if (projectId) api.deleteDraft(projectId).catch(() => {});
    emit('tempo-changed');
    emit('video-changed');
    emit('limits-changed');
    emit('shots-changed', { reason: 'mcp-live' });
    emit('assets-changed', { reason: 'mcp-live' });
    emit('scenes-changed', { reason: 'mcp-live' });
    emit('vocal-cues-changed');
    emit('project-live-updated');
  }

  // The backend already has a copy of the mix/vocal from whenever they were
  // last picked (see uploadAudioTrackInBackground in main.js), so a loaded
  // or switched-to project can restore playback/the timeline without asking
  // the user to reselect the same file again - without this, the shot list
  // has nothing to render into until a mix is picked, since the timeline
  // only exists once one is loaded (see waveformSync.js). Fire-and-forget:
  // large files take a moment to fetch/decode and shouldn't block anything
  // else project-load-related.
  function autoLoadAudioFromBackend() {
    const projectId = getProjectId();
    if (!projectId) return;
    const mix = state.audio.mix;
    const vocal = state.audio.vocal;
    if (mix.relativePath) {
      MSE.sync
        .loadMix(`/project-files/${projectId}/${mix.relativePath}`, mix.fileName)
        .catch((err) => console.warn('Could not auto-load the mix track from the backend.', err));
    }
    if (vocal.relativePath) {
      MSE.sync
        .loadVocal(`/project-files/${projectId}/${vocal.relativePath}`, vocal.fileName)
        .catch((err) => console.warn('Could not auto-load the vocal track from the backend.', err));
    }
  }

  // --- Canonical autosave + dirty tracking ---------------------------
  //
  // The browser has one persistence representation: project.json. Direct
  // typing is detected immediately and a fast poll also catches programmatic
  // mutations that intentionally skip render events. Writes are debounced,
  // serialized, atomic, and guarded by the exact canonical revision so the
  // browser and MCP can never silently overwrite one another. The old draft
  // endpoint remains read-only here solely to migrate interrupted sessions
  // created by earlier releases.
  const AUTOSAVE_POLL_MS = 250;
  const AUTOSAVE_DEBOUNCE_MS = 600;
  const AUTOSAVE_RETRY_MS = 2500;

  let lastSavedSnapshot = null;
  let lastObservedSnapshot = null;
  let dirty = false;
  let autosavePollTimer = null;
  let autosaveTimer = null;
  let saveInFlight = null;
  let canonicalRevision = null;
  let autosaveError = null;

  function setDirty(next) {
    if (dirty === next) return;
    dirty = next;
    emit('project-dirty-changed', { dirty });
  }

  function isDirty() {
    return dirty;
  }

  function isSynced() {
    return !dirty && !saveInFlight && !autosaveTimer && !autosaveError;
  }

  function emitSaveState(status, error = null) {
    emit('project-save-state', { status, dirty, error: error ? error.message : null });
  }

  function markBaseline(snapshot, revision = canonicalRevision) {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = null;
    lastSavedSnapshot = snapshot;
    lastObservedSnapshot = snapshot;
    canonicalRevision = revision;
    autosaveError = null;
    setDirty(false);
    emitSaveState('saved');
  }

  function scheduleAutosave(delay = AUTOSAVE_DEBOUNCE_MS) {
    if (!getProjectId() || !canonicalRevision) return;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      performAutosave().catch(() => {});
    }, delay);
  }

  async function performAutosave() {
    if (saveInFlight) return saveInFlight;
    const projectId = getProjectId();
    if (!projectId || !canonicalRevision) return null;

    const payload = serializeProject();
    const snapshot = JSON.stringify(payload);
    if (snapshot === lastSavedSnapshot) {
      setDirty(false);
      emitSaveState('saved');
      return null;
    }

    const expectedRevision = canonicalRevision;
    autosaveError = null;
    setDirty(true);
    emitSaveState('saving');
    let saveFailed = false;
    saveInFlight = (async () => {
      try {
        const result = await api.autosaveProject(projectId, payload, expectedRevision);
        canonicalRevision = result.revision;
        state.savedAt = result.project.savedAt;
        lastSavedSnapshot = JSON.stringify({ ...payload, savedAt: state.savedAt });
        const currentSnapshot = JSON.stringify(serializeProject());
        lastObservedSnapshot = currentSnapshot;
        setDirty(currentSnapshot !== lastSavedSnapshot);
        autosaveError = null;
        emitSaveState(dirty ? 'pending' : 'saved');
        return result;
      } catch (error) {
        saveFailed = true;
        autosaveError = error;
        setDirty(true);
        emitSaveState(error.status === 409 ? 'conflict' : 'error', error);
        throw error;
      } finally {
        saveInFlight = null;
        if (dirty) scheduleAutosave(saveFailed ? AUTOSAVE_RETRY_MS : AUTOSAVE_DEBOUNCE_MS);
      }
    })();
    return saveInFlight;
  }

  function pollForChanges() {
    const projectId = getProjectId();
    if (!projectId) return;
    const snapshot = JSON.stringify(serializeProject());
    if (snapshot === lastObservedSnapshot) return;
    lastObservedSnapshot = snapshot;
    const changed = snapshot !== lastSavedSnapshot;
    setDirty(changed);
    if (changed) {
      autosaveError = null;
      emitSaveState('pending');
      scheduleAutosave();
    }
  }

  function noteLocalChange() {
    if (!getProjectId()) return;
    setDirty(true);
    autosaveError = null;
    emitSaveState('pending');
    scheduleAutosave();
  }

  function startCanonicalAutosave() {
    if (autosavePollTimer) return;
    autosavePollTimer = setInterval(pollForChanges, AUTOSAVE_POLL_MS);
    document.addEventListener('input', noteLocalChange, true);
    document.addEventListener('change', noteLocalChange, true);
  }

  async function flushAutosave() {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = null;
    if (saveInFlight) await saveInFlight;
    pollForChanges();
    if (dirty) await performAutosave();
  }

  // Runs on every project load (initial page load or switching projects):
  // checks for a draft left behind by an interrupted session and, if it
  // still matches what's on disk (basedOnSavedAt === the canonical file's
  // savedAt), asks the user whether to recover it before applying anything.
  // A draft whose basedOnSavedAt no longer matches was based on a since-
  // superseded save (e.g. saved from elsewhere, or hand-repaired) - nothing
  // safe to recover, so it's discarded without asking (see project chat:
  // "1: still verwerfen").
  async function loadProjectConsideringDraft(rawProject, projectId, revision) {
    const normalizedCanonical = normalizeProjectData(rawProject);
    const canonicalSnapshot = JSON.stringify(normalizedCanonical);

    let draft = null;
    try {
      draft = await api.getDraft(projectId);
    } catch (err) {
      console.warn('Could not check for an unsaved draft.', err);
    }

    if (draft && draft.basedOnSavedAt !== (normalizedCanonical.savedAt ?? null)) {
      api.deleteDraft(projectId).catch(() => {});
      draft = null;
    }

    if (draft) {
      const restore = await MSE.recoveryPrompt.ask(draft.draftUpdatedAt);
      if (restore) {
        const normalizedDraft = normalizeProjectData(draft.data);
        applyNormalizedProject(normalizedDraft);
        canonicalRevision = revision;
        lastSavedSnapshot = canonicalSnapshot;
        lastObservedSnapshot = JSON.stringify(normalizedDraft);
        setDirty(lastObservedSnapshot !== lastSavedSnapshot);
        emitSaveState('pending');
        scheduleAutosave(0);
        return;
      }
      await api.deleteDraft(projectId).catch(() => {});
    }

    applyNormalizedProject(normalizedCanonical);
    markBaseline(canonicalSnapshot, revision);
  }

  // Loads the project last saved to the backend (by id, kept in localStorage
  // so a full page refresh reopens the same project), or creates a fresh one
  // on the backend if there's no stored id yet, or the stored id no longer
  // resolves there. If the backend itself is unreachable, falls back to the
  // in-memory default state so the rest of the editor still works.
  async function initBackendProject() {
    const storedId = localStorage.getItem(PROJECT_ID_STORAGE_KEY);
    try {
      if (storedId) {
        const record = await api.getProjectRecord(storedId);
        await loadProjectConsideringDraft(record.project, storedId, record.revision);
        startCanonicalAutosave();
        return;
      }
    } catch (err) {
      console.warn('Stored project not found on backend, creating a new one.', err);
    }
    try {
      const created = await api.createProject(serializeProject());
      localStorage.setItem(PROJECT_ID_STORAGE_KEY, created.id);
      markBaseline(JSON.stringify(normalizeProjectData(created.project)), created.revision);
      startCanonicalAutosave();
    } catch (err) {
      console.warn('Backend unavailable - project will not persist across reloads.', err);
    }
  }

  // Kept as the public manual-save hook for Ctrl+S and "Save now". It drains
  // the same canonical queue; there is no second manual-save representation.
  async function saveProjectToBackend() {
    await flushAutosave();
  }

  function getProjectId() {
    return localStorage.getItem(PROJECT_ID_STORAGE_KEY);
  }

  // Creates a brand-new, blank project on the backend and switches to it.
  // Does not touch any audio currently loaded in the browser - like project
  // load, the mix/vocal still need to be reselected for the new project.
  async function createNewProject() {
    await flushAutosave();
    const fresh = MSE.state.createDefaultState();
    const created = await api.createProject(fresh);
    localStorage.setItem(PROJECT_ID_STORAGE_KEY, created.id);
    const normalized = normalizeProjectData(created.project);
    applyNormalizedProject(normalized);
    markBaseline(JSON.stringify(normalized), created.revision);
    startCanonicalAutosave();
    return created.id;
  }

  async function openProject(id) {
    await flushAutosave();
    const record = await api.getProjectRecord(id);
    localStorage.setItem(PROJECT_ID_STORAGE_KEY, id);
    await loadProjectConsideringDraft(record.project, id, record.revision);
    startCanonicalAutosave();
  }

  async function listProjects() {
    const { projects } = await api.listProjects();
    return projects;
  }

  function buildShotExportList() {
    return state.shots.map((shot) => {
      const duration = shotsApi.shotDuration(shot);
      const calc = frameCalc(duration, state.video);
      return {
        shot: shot.id,
        startSeconds: shot.startSeconds,
        endSeconds: shot.endSeconds,
        durationSeconds: duration,
        cutFrames: calc.cutFrames,
        renderFrames: calc.renderFrames,
        overhangFrames: calc.overhangFrames,
      };
    });
  }

  function exportShotsJson() {
    const payload = {
      fps: state.video.fpsNumerator / state.video.fpsDenominator,
      frameRule: frameRuleLabel(state.video.frameRule?.stride ?? null),
      shots: buildShotExportList(),
    };
    triggerDownload('shots.json', JSON.stringify(payload, null, 2), 'application/json');
  }

  function exportShotsCsv() {
    const rows = ['shot,start,end,duration,cut_frames,render_frames,overhang_frames'];
    buildShotExportList().forEach((s) => {
      rows.push(
        [
          s.shot,
          s.startSeconds.toFixed(3),
          s.endSeconds.toFixed(3),
          s.durationSeconds.toFixed(3),
          s.cutFrames,
          s.renderFrames,
          s.overhangFrames,
        ].join(',')
      );
    });
    triggerDownload('shots.csv', rows.join('\n'), 'text/csv');
  }

  MSE.project = {
    initBackendProject,
    saveProjectToBackend,
    getProjectId,
    createNewProject,
    openProject,
    listProjects,
    applyLiveProject,
    isDirty,
    isSynced,
    exportShotsJson,
    exportShotsCsv,
    // Generic client-side text-file download (Blob + object URL), reused by
    // Phase 5.2's SRT export (lyricsAlign.js) - same helper exportShotsJson/
    // exportShotsCsv already use above, just not previously exposed outside
    // this module.
    triggerDownload,
    // Pure - exposed for the regression tests (frontend/tests/vocalCues.test.js)
    // to exercise the normalize/serialize round-trip directly.
    normalizeProjectData,
    serializeProject,
  };
})(window.MSE = window.MSE || {});
