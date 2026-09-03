// DOM wiring: connects UI controls to state, waveformSync and project modules.
(function (MSE) {
  'use strict';

  const { state, on, emit } = MSE.state;

  const el = {
    mixFile: document.getElementById('mix-file'),
    vocalFile: document.getElementById('vocal-file'),
    mixFilename: document.getElementById('mix-filename'),
    vocalFilename: document.getElementById('vocal-filename'),
    trackLabelMix: document.getElementById('track-label-mix'),
    trackLabelVocal: document.getElementById('track-label-vocal'),
    playPauseBtn: document.getElementById('play-pause-btn'),
    loopToggleBtn: document.getElementById('loop-toggle-btn'),
    loopSnapToggle: document.getElementById('loop-snap-toggle'),
    shotTimeFormatToggle: document.getElementById('shot-time-format-toggle'),
    zoomSlider: document.getElementById('zoom-slider'),
    placeholder: document.getElementById('timeline-placeholder'),

    bpm: document.getElementById('bpm-input'),
    timeSigNum: document.getElementById('time-sig-num'),
    timeSigDen: document.getElementById('time-sig-den'),
    gridOffset: document.getElementById('grid-offset-input'),
    setOffsetBtn: document.getElementById('set-offset-to-playhead-btn'),
    gridDivision: document.getElementById('grid-division-select'),

    fps: document.getElementById('fps-input'),
    frameRule: document.getElementById('frame-rule-select'),

    minLength: document.getElementById('min-length-input'),
    maxLength: document.getElementById('max-length-input'),

    saveProjectBtn: document.getElementById('save-project-btn'),
    projectStatus: document.getElementById('project-status'),
    autosaveStatus: document.getElementById('autosave-status'),
    exportJsonBtn: document.getElementById('export-json-btn'),
    exportCsvBtn: document.getElementById('export-csv-btn'),
  };

  function syncSettingsPanelFromState() {
    el.bpm.value = state.tempo.bpm;
    el.timeSigNum.value = state.tempo.numerator;
    el.timeSigDen.value = state.tempo.denominator;
    el.gridOffset.value = state.tempo.gridOffsetSeconds;
    el.gridDivision.value = state.tempo.gridDivision;

    el.fps.value = state.video.fpsNumerator;
    el.frameRule.value = '17';

    el.minLength.value = state.shotLimits.minimumSeconds;
    el.maxLength.value = state.shotLimits.maximumSeconds;

    el.trackLabelMix.classList.toggle('active', state.audio.playbackTrack === 'mix');
    el.trackLabelVocal.classList.toggle('active', state.audio.playbackTrack === 'vocal');
  }

  // Copies the picked file to the backend project folder alongside local
  // playback, since export needs the real audio bytes on disk to run ffmpeg
  // against - not just the in-browser object URL used for the waveform.
  // Fire-and-forget: a missing/unreachable backend shouldn't block playback.
  function uploadAudioTrackInBackground(track, file) {
    const projectId = MSE.project.getProjectId();
    if (!projectId) return;
    MSE.api
      .uploadAudioTrack(projectId, track, file)
      .then((result) => {
        state.audio[track].relativePath = result.relativePath;
      })
      .catch((err) => console.warn(`Audio upload (${track}) failed - export won't work until it succeeds.`, err));
  }

  function wireFileInputs() {
    el.mixFile.addEventListener('change', async () => {
      const file = el.mixFile.files[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      await MSE.sync.loadMix(url, file.name);
      uploadAudioTrackInBackground('mix', file);
    });

    el.vocalFile.addEventListener('change', async () => {
      const file = el.vocalFile.files[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      await MSE.sync.loadVocal(url, file.name);
      uploadAudioTrackInBackground('vocal', file);
    });

    // Fires from both a manual file pick above and an automatic restore from
    // the backend (project.js, when a loaded/switched project already has an
    // uploaded audio copy) - either way, the UI updates the same way.
    on('mix-ready', () => {
      el.mixFilename.textContent = state.audio.mix.fileName;
      el.placeholder.style.display = 'none';
      el.playPauseBtn.disabled = false;
      el.loopToggleBtn.disabled = false;
      el.loopSnapToggle.disabled = false;
    });
    on('vocal-ready', () => {
      el.vocalFilename.textContent = state.audio.vocal.fileName;
    });
  }

  function wireTransport() {
    el.playPauseBtn.addEventListener('click', () => MSE.sync.togglePlayback());
    el.loopToggleBtn.addEventListener('click', () => MSE.sync.toggleLoopEnabled());
    el.loopSnapToggle.addEventListener('click', () => MSE.sync.toggleLoopSnapMode());
    el.shotTimeFormatToggle.addEventListener('click', () => MSE.sync.toggleShotTimeFormat());

    el.trackLabelMix.addEventListener('click', () => MSE.sync.setPlaybackTrack('mix'));
    el.trackLabelVocal.addEventListener('click', () => MSE.sync.setPlaybackTrack('vocal'));
    // Buttons, not native radios - nothing updates the active-track highlight
    // on its own, so re-sync it explicitly on every switch.
    on('playback-track-changed', syncSettingsPanelFromState);

    el.zoomSlider.addEventListener('input', () => {
      MSE.sync.zoomTo(Number(el.zoomSlider.value));
    });

    on('playback-state-changed', (e) => {
      el.playPauseBtn.textContent = e.detail.isPlaying ? '⏸ Pause' : '▶ Play';
    });

    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space') return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      MSE.sync.togglePlayback();
    });
  }

  function wireTempoSettings() {
    function applyTempo() {
      state.tempo.bpm = Math.max(1, Number(el.bpm.value) || 120);
      state.tempo.numerator = Math.max(1, Number(el.timeSigNum.value) || 4);
      state.tempo.denominator = Math.max(1, Number(el.timeSigDen.value) || 4);
      state.tempo.gridOffsetSeconds = Number(el.gridOffset.value) || 0;
      state.tempo.gridDivision = el.gridDivision.value;
      emit('tempo-changed');
    }
    [el.bpm, el.timeSigNum, el.timeSigDen, el.gridOffset, el.gridDivision].forEach((input) =>
      input.addEventListener('change', applyTempo)
    );

    el.setOffsetBtn.addEventListener('click', () => {
      el.gridOffset.value = MSE.sync.getCurrentTime().toFixed(3);
      applyTempo();
    });
  }

  function wireVideoSettings() {
    function applyVideo() {
      state.video.fpsNumerator = Math.max(0.001, Number(el.fps.value) || 24);
      state.video.fpsDenominator = 1;
      state.video.frameRule = { stride: 17, offset: 5 };
      emit('video-changed');
    }
    [el.fps, el.frameRule].forEach((input) => input.addEventListener('change', applyVideo));
  }

  function wireShotLimits() {
    function applyLimits() {
      state.shotLimits.minimumSeconds = Math.max(0, Number(el.minLength.value) || 0);
      state.shotLimits.maximumSeconds = Math.max(state.shotLimits.minimumSeconds, Number(el.maxLength.value) || 0);
      emit('limits-changed');
    }
    [el.minLength, el.maxLength].forEach((input) => input.addEventListener('change', applyLimits));
  }

  function setProjectStatus(text) {
    if (el.projectStatus) el.projectStatus.textContent = text;
  }

  let toastEl = null;
  function renderAutosaveState(detail) {
    const status = detail && detail.status;
    const labels = {
      pending: 'Saving soon…',
      saving: 'Saving…',
      saved: 'Saved',
      error: 'Save failed — retrying',
      conflict: 'Syncing latest version…',
    };
    const label = labels[status] || 'Saved';
    if (el.autosaveStatus) {
      el.autosaveStatus.textContent = label;
      el.autosaveStatus.classList.toggle('saving', status === 'pending' || status === 'saving');
      el.autosaveStatus.classList.toggle('error', status === 'error' || status === 'conflict');
      el.autosaveStatus.title = detail && detail.error ? detail.error : '';
    }
    setProjectStatus(label);
  }

  let toastHideTimer = null;

  // Transient confirmation, separate from the persistent #project-status
  // text (which stays "Saved" until the next edit) - a keyboard-triggered
  // save has no button to visibly react, so this gives feedback wherever
  // the user's eyes actually are.
  function showToast(message) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.add('visible');
    clearTimeout(toastHideTimer);
    toastHideTimer = setTimeout(() => toastEl.classList.remove('visible'), 2000);
  }

  async function saveProject() {
    el.saveProjectBtn.disabled = true;
    renderAutosaveState({ status: 'saving' });
    try {
      await MSE.project.saveProjectToBackend();
      renderAutosaveState({ status: 'saved' });
      showToast('Everything saved');
    } catch (err) {
      console.error(err);
      renderAutosaveState({ status: 'error', error: err.message });
    } finally {
      el.saveProjectBtn.disabled = false;
    }
  }

  function wireProjectActions() {
    el.saveProjectBtn.addEventListener('click', () => saveProject());

    el.exportJsonBtn.addEventListener('click', () => MSE.project.exportShotsJson());
    el.exportCsvBtn.addEventListener('click', () => MSE.project.exportShotsCsv());

    on('project-loaded', syncSettingsPanelFromState);
    on('project-save-state', ({ detail }) => {
      renderAutosaveState(detail);
      el.saveProjectBtn.disabled = detail.status === 'saving';
    });

    // Browser's native Ctrl+S opens a "Save Page As" dialog - always
    // intercepted here (unlike the Space-bar transport shortcut, this isn't
    // valid text input anywhere, so no focused-element guard is needed).
    document.addEventListener('keydown', (e) => {
      if (!e.ctrlKey || e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      if (el.saveProjectBtn.disabled) return;
      saveProject();
    });
  }

  async function init() {
    syncSettingsPanelFromState();
    wireFileInputs();
    wireTransport();
    wireTempoSettings();
    wireVideoSettings();
    wireShotLimits();
    wireProjectActions();
    await MSE.project.initBackendProject();
    syncSettingsPanelFromState();
  }

  document.addEventListener('DOMContentLoaded', init);
})(window.MSE = window.MSE || {});
