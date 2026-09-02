// Native CUTTAlogue camera preview controller. Camera animation remains
// derived from shot.direction.camera; this module owns only transient view
// and transport state and recreates/disposes WebGL resources per opening.
(function (MSE) {
  'use strict';

  const { state, on, emit } = MSE.state;
  const elements = {};
  let renderer = null;
  let currentShot = null;
  let plan = null;
  let viewMode = 'shot';
  let previewTime = 0;
  let isScrubbing = false;
  let localPlaybackFrame = null;
  let localPlaybackStartedAt = 0;
  let localPlaybackStartTime = 0;
  let projectIsPlaying = false;
  let sceneLoadToken = 0;
  let moodLoadToken = 0;
  let dragPointerId = null;
  let dragPosition = null;
  let pathStatus = { text: '', warning: false };
  let sceneStatus = { text: '', warning: false };

  function cacheElements() {
    elements.open = document.getElementById('camera-preview-btn');
    elements.overlay = document.getElementById('camera-preview-modal');
    elements.close = document.getElementById('camera-preview-close-btn');
    elements.title = document.getElementById('camera-preview-title');
    elements.subtitle = document.getElementById('camera-preview-subtitle');
    elements.canvas = document.getElementById('camera-preview-canvas');
    elements.shotView = document.getElementById('camera-preview-shot-view');
    elements.freeView = document.getElementById('camera-preview-free-view');
    elements.scene = document.getElementById('camera-preview-scene-select');
    elements.diagnostics = document.getElementById('camera-preview-diagnostics');
    elements.empty = document.getElementById('camera-preview-empty');
    elements.time = document.getElementById('camera-preview-time');
    elements.lens = document.getElementById('camera-preview-lens');
    elements.segment = document.getElementById('camera-preview-segment');
    elements.play = document.getElementById('camera-preview-play-btn');
    elements.scrubber = document.getElementById('camera-preview-scrubber');
    elements.duration = document.getElementById('camera-preview-duration');
    elements.export = document.getElementById('camera-preview-export-btn');
    elements.resetView = document.getElementById('camera-preview-reset-view-btn');
    elements.freeHelp = document.getElementById('camera-preview-free-help');
    elements.moodButton = document.getElementById('camera-preview-mood-btn');
    elements.moodPanel = document.getElementById('camera-preview-mood-panel');
    elements.moodSource = document.getElementById('camera-preview-mood-source');
    elements.moodEnabled = document.getElementById('camera-preview-mood-enabled');
    elements.moodBillboard = document.getElementById('camera-preview-mood-billboard');
    elements.moodOpacity = document.getElementById('camera-preview-mood-opacity');
    elements.moodX = document.getElementById('camera-preview-mood-x');
    elements.moodY = document.getElementById('camera-preview-mood-y');
    elements.moodZ = document.getElementById('camera-preview-mood-z');
    elements.moodWidth = document.getElementById('camera-preview-mood-width');
    elements.moodHeight = document.getElementById('camera-preview-mood-height');
    elements.moodYaw = document.getElementById('camera-preview-mood-yaw');
    elements.moodReset = document.getElementById('camera-preview-mood-reset-btn');
  }

  function selectedShot() {
    const id = MSE.context ? MSE.context.getSelectedShotId() : null;
    return id === null ? null : state.shots.find((shot) => shot.id === id) || null;
  }

  function shotDuration() {
    return currentShot ? MSE.shots.shotDuration(currentShot) : 0;
  }

  function isOpen() {
    return elements.overlay && !elements.overlay.hidden;
  }

  function compileCurrentShot() {
    if (!currentShot) return;
    const scene = MSE.scenes ? MSE.scenes.sceneForShot(currentShot) : null;
    const duration = shotDuration();
    plan = MSE.cameraService.compileShot(currentShot, state);
    if (renderer) renderer.setPlan(plan);
    elements.scrubber.max = String(duration);
    elements.duration.textContent = `${duration.toFixed(2)} s`;
    const cameraSegments = (currentShot.direction && currentShot.direction.camera) || [];
    elements.empty.hidden = cameraSegments.some((segment) => segment.enabled !== false);
    const warningCount = plan.warnings.length;
    const unresolved = plan.warnings.find((warning) => warning.code === 'unresolved_target' || warning.code === 'missing_target');
    pathStatus = { text: unresolved
      ? (unresolved.value ? `Unresolved target: ${unresolved.value}` : 'Camera target needs calibration')
      : warningCount
        ? `${warningCount} camera warning${warningCount === 1 ? '' : 's'}`
        : 'Camera path valid', warning: warningCount > 0 };
    if (renderer) renderer.setAnchors(scene ? scene.anchors : {});
    updateDiagnostics();
  }

  function updateDiagnostics() {
    const parts = [pathStatus.text, sceneStatus.text].filter(Boolean);
    elements.diagnostics.textContent = parts.join(' · ');
    elements.diagnostics.classList.toggle('warning', pathStatus.warning || sceneStatus.warning);
  }

  function renderSceneSelect() {
    elements.scene.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = state.scenes.length ? 'No scene' : 'No scene assets imported';
    elements.scene.appendChild(none);
    state.scenes.forEach((scene) => {
      const option = document.createElement('option');
      option.value = scene.id;
      option.textContent = scene.name || scene.id;
      elements.scene.appendChild(option);
    });
    elements.scene.value = currentShot && currentShot.sceneId ? currentShot.sceneId : '';
  }

  function environmentMoodAsset() {
    if (!currentShot) return null;
    const assetId = (currentShot.assetIds || []).find((id) => currentShot.assetRoles && currentShot.assetRoles[id] === 'environment');
    return state.assets.find((asset) => asset.id === assetId && asset.type === 'image') || null;
  }

  function defaultMoodConfig(asset) {
    const metadata = (asset && asset.metadata) || {};
    const aspect = Number(metadata.width) > 0 && Number(metadata.height) > 0
      ? Number(metadata.width) / Number(metadata.height)
      : 16 / 9;
    return {
      enabled: true,
      billboard: false,
      opacity: 0.28,
      position: [0, 1.8, 0],
      width: 6,
      height: 6 / aspect,
      yawDegrees: 0,
    };
  }

  function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function moodConfig(asset = environmentMoodAsset()) {
    const defaults = defaultMoodConfig(asset);
    const stored = currentShot && currentShot.preview && currentShot.preview.moodCard;
    if (!stored || typeof stored !== 'object') return defaults;
    const position = Array.isArray(stored.position) ? stored.position : defaults.position;
    return {
      enabled: stored.enabled !== false,
      billboard: stored.billboard === true,
      opacity: Math.max(0.05, Math.min(0.8, finite(stored.opacity, defaults.opacity))),
      position: defaults.position.map((value, index) => finite(position[index], value)),
      width: Math.max(0.1, finite(stored.width, defaults.width)),
      height: Math.max(0.1, finite(stored.height, defaults.height)),
      yawDegrees: finite(stored.yawDegrees, defaults.yawDegrees),
    };
  }

  function syncMoodControls(config, asset) {
    elements.moodSource.textContent = asset ? asset.fileName : 'No environment image assigned';
    const disabled = !asset;
    [
      elements.moodEnabled, elements.moodBillboard, elements.moodOpacity,
      elements.moodX, elements.moodY, elements.moodZ,
      elements.moodWidth, elements.moodHeight, elements.moodYaw, elements.moodReset,
    ].forEach((control) => { control.disabled = disabled; });
    elements.moodEnabled.checked = !!config.enabled;
    elements.moodBillboard.checked = !!config.billboard;
    elements.moodOpacity.value = String(config.opacity);
    elements.moodX.value = String(config.position[0]);
    elements.moodY.value = String(config.position[1]);
    elements.moodZ.value = String(config.position[2]);
    elements.moodWidth.value = String(config.width);
    elements.moodHeight.value = String(config.height);
    elements.moodYaw.value = String(config.yawDegrees);
  }

  async function loadMoodCard() {
    const token = ++moodLoadToken;
    if (!renderer || !currentShot) return;
    const asset = environmentMoodAsset();
    const config = moodConfig(asset);
    syncMoodControls(config, asset);
    renderer.clearMoodCard();
    renderer.setMoodCardConfig(asset ? config : null);
    if (!asset || !MSE.sceneGeometry) return render();
    try {
      const source = MSE.sceneGeometry.projectFileUrl(MSE.project.getProjectId(), asset.relativePath);
      await renderer.setMoodCardSource(source);
      if (token !== moodLoadToken || !renderer) return;
    } catch (error) {
      console.error(error);
      sceneStatus = { text: error.message, warning: true };
      updateDiagnostics();
    }
    render();
  }

  function persistMoodConfig(config) {
    if (!currentShot || !environmentMoodAsset()) return;
    currentShot.preview = currentShot.preview || {};
    currentShot.preview.moodCard = config;
    renderer.setMoodCardConfig(config);
    syncMoodControls(config, environmentMoodAsset());
    emit('shots-changed', { reason: 'mood-card' });
    render();
  }

  function readMoodControls() {
    const fallback = moodConfig();
    return {
      enabled: elements.moodEnabled.checked,
      billboard: elements.moodBillboard.checked,
      opacity: finite(elements.moodOpacity.value, fallback.opacity),
      position: [
        finite(elements.moodX.value, fallback.position[0]),
        finite(elements.moodY.value, fallback.position[1]),
        finite(elements.moodZ.value, fallback.position[2]),
      ],
      width: Math.max(0.1, finite(elements.moodWidth.value, fallback.width)),
      height: Math.max(0.1, finite(elements.moodHeight.value, fallback.height)),
      yawDegrees: finite(elements.moodYaw.value, fallback.yawDegrees),
    };
  }

  async function loadCurrentScene() {
    const token = ++sceneLoadToken;
    if (!renderer || !currentShot || !MSE.sceneGeometry || !MSE.scenes) return;
    renderer.clearScene();
    const scene = MSE.scenes.sceneForShot(currentShot);
    if (!scene) {
      sceneStatus = { text: '', warning: false };
      updateDiagnostics();
      render();
      return;
    }
    sceneStatus = { text: 'Loading scene…', warning: false };
    updateDiagnostics();
    try {
      const geometry = await MSE.sceneGeometry.loadScene(scene, state.assets, MSE.project.getProjectId());
      if (token !== sceneLoadToken || !renderer) return;
      renderer.setSceneGeometry(geometry);
      const pointCount = geometry.pointCloud ? geometry.pointCloud.positions.length / 3 : 0;
      const blockoutEdges = geometry.blockout ? geometry.blockout.length / 6 : 0;
      const counts = [];
      if (pointCount) counts.push(`${pointCount.toLocaleString()} points`);
      if (blockoutEdges) counts.push(`${blockoutEdges.toLocaleString()} edges`);
      sceneStatus = { text: counts.length ? counts.join(', ') : 'Scene has no preview geometry', warning: !counts.length };
    } catch (error) {
      console.error(error);
      sceneStatus = { text: error.message, warning: true };
    }
    updateDiagnostics();
    render();
  }

  function render() {
    if (!renderer || !plan || !currentShot) return;
    previewTime = Math.max(0, Math.min(shotDuration(), previewTime));
    const pose = MSE.cameraPath.evaluate(plan, previewTime);
    renderer.render(pose, viewMode);
    elements.scrubber.value = String(previewTime);
    elements.time.textContent = previewTime.toFixed(2);
    elements.lens.textContent = pose.focalLengthMm.toFixed(1).replace(/\.0$/, '');
    const source = pose.segmentIndex === null
      ? null
      : ((currentShot.direction && currentShot.direction.camera) || [])[pose.segmentIndex];
    elements.segment.textContent = source ? (source.movement || 'Static shot').replaceAll('_', ' ') : 'No active segment';
  }

  function setViewMode(nextMode) {
    viewMode = nextMode;
    elements.shotView.classList.toggle('active', viewMode === 'shot');
    elements.freeView.classList.toggle('active', viewMode === 'free');
    elements.overlay.classList.toggle('camera-preview-free-active', viewMode === 'free');
    elements.freeHelp.hidden = viewMode !== 'free';
    render();
  }

  function projectRelativeTime() {
    if (!currentShot || !MSE.sync) return previewTime;
    return MSE.sync.getCurrentTime() - currentShot.startSeconds;
  }

  function stopLocalPlayback() {
    if (localPlaybackFrame !== null) cancelAnimationFrame(localPlaybackFrame);
    localPlaybackFrame = null;
    elements.play.textContent = projectIsPlaying ? 'Pause' : 'Play';
  }

  function localPlaybackTick(now) {
    if (!isOpen() || !currentShot) return stopLocalPlayback();
    previewTime = localPlaybackStartTime + (now - localPlaybackStartedAt) / 1000;
    if (previewTime >= shotDuration()) {
      previewTime = shotDuration();
      render();
      stopLocalPlayback();
      return;
    }
    render();
    localPlaybackFrame = requestAnimationFrame(localPlaybackTick);
  }

  function toggleLocalPlayback() {
    if (localPlaybackFrame !== null) {
      stopLocalPlayback();
      return;
    }
    if (previewTime >= shotDuration()) previewTime = 0;
    localPlaybackStartTime = previewTime;
    localPlaybackStartedAt = performance.now();
    elements.play.textContent = 'Pause';
    localPlaybackFrame = requestAnimationFrame(localPlaybackTick);
  }

  async function togglePlayback() {
    if (!currentShot) return;
    if (!MSE.sync || !MSE.sync.isTimelineReady()) {
      toggleLocalPlayback();
      return;
    }
    const projectTime = MSE.sync.getCurrentTime();
    if (projectTime < currentShot.startSeconds || projectTime >= currentShot.endSeconds) {
      MSE.sync.seekTo(currentShot.startSeconds);
    }
    await MSE.sync.togglePlayback();
  }

  function exportCurrentCamera() {
    if (!currentShot) return;
    const document = MSE.cameraService.exportCamera(currentShot, state);
    const shotNumber = String(currentShot.id).padStart(3, '0');
    MSE.project.triggerDownload(`shot-${shotNumber}-camera.json`, JSON.stringify(document, null, 2), 'application/json');
  }

  function open() {
    currentShot = selectedShot();
    if (!currentShot) return;
    if (MSE.sceneCalibrationPanel) MSE.sceneCalibrationPanel.setShot(currentShot);
    if (renderer) renderer.dispose();
    elements.overlay.hidden = false;
    elements.title.textContent = 'Camera preview';
    elements.subtitle.textContent = currentShot.name ? `Shot ${currentShot.id} — ${currentShot.name}` : `Shot ${currentShot.id}`;
    previewTime = Math.max(0, Math.min(shotDuration(), projectRelativeTime()));
    renderSceneSelect();
    try {
      renderer = new MSE.cameraPreviewRenderer.CameraPreviewRenderer(elements.canvas);
      compileCurrentShot();
      setViewMode('shot');
      loadCurrentScene();
      loadMoodCard();
    } catch (error) {
      console.error(error);
      elements.diagnostics.textContent = error.message;
      elements.diagnostics.classList.add('warning');
    }
  }

  function close() {
    sceneLoadToken += 1;
    moodLoadToken += 1;
    stopLocalPlayback();
    if (renderer) renderer.dispose();
    renderer = null;
    plan = null;
    currentShot = null;
    if (MSE.sceneCalibrationPanel) MSE.sceneCalibrationPanel.setShot(null);
    elements.overlay.hidden = true;
  }

  function init() {
    cacheElements();
    elements.open.addEventListener('click', open);
    elements.close.addEventListener('click', close);
    elements.overlay.addEventListener('click', (event) => {
      if (event.target === elements.overlay) close();
    });
    elements.shotView.addEventListener('click', () => setViewMode('shot'));
    elements.freeView.addEventListener('click', () => setViewMode('free'));
    elements.resetView.addEventListener('click', () => {
      if (!renderer) return;
      renderer.resetFreeView();
      render();
    });
    elements.moodButton.addEventListener('click', () => {
      elements.moodPanel.hidden = !elements.moodPanel.hidden;
      elements.moodButton.classList.toggle('active', !elements.moodPanel.hidden);
      elements.moodButton.setAttribute('aria-expanded', String(!elements.moodPanel.hidden));
    });
    [
      elements.moodEnabled, elements.moodBillboard, elements.moodOpacity,
      elements.moodX, elements.moodY, elements.moodZ,
      elements.moodWidth, elements.moodHeight, elements.moodYaw,
    ].forEach((control) => control.addEventListener('change', () => persistMoodConfig(readMoodControls())));
    elements.moodOpacity.addEventListener('input', () => persistMoodConfig(readMoodControls()));
    elements.moodReset.addEventListener('click', () => persistMoodConfig(defaultMoodConfig(environmentMoodAsset())));
    elements.canvas.addEventListener('pointerdown', (event) => {
      if (viewMode !== 'free' || event.button !== 0) return;
      dragPointerId = event.pointerId;
      dragPosition = [event.clientX, event.clientY];
      elements.canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    elements.canvas.addEventListener('pointermove', (event) => {
      if (!renderer || event.pointerId !== dragPointerId || !dragPosition) return;
      const deltaX = event.clientX - dragPosition[0];
      const deltaY = event.clientY - dragPosition[1];
      dragPosition = [event.clientX, event.clientY];
      if (event.shiftKey) renderer.panFreeView(deltaX, deltaY);
      else renderer.orbitFreeView(deltaX, deltaY);
      render();
    });
    const finishDrag = (event) => {
      if (event.pointerId !== dragPointerId) return;
      dragPointerId = null;
      dragPosition = null;
    };
    elements.canvas.addEventListener('pointerup', finishDrag);
    elements.canvas.addEventListener('pointercancel', finishDrag);
    elements.canvas.addEventListener('wheel', (event) => {
      if (!renderer || viewMode !== 'free') return;
      renderer.zoomFreeView(event.deltaY);
      render();
      event.preventDefault();
    }, { passive: false });
    elements.play.addEventListener('click', togglePlayback);
    elements.export.addEventListener('click', exportCurrentCamera);
    elements.scene.addEventListener('change', () => {
      if (currentShot && MSE.scenes) MSE.scenes.setShotScene(currentShot.id, elements.scene.value || null);
    });
    elements.scrubber.addEventListener('pointerdown', () => { isScrubbing = true; });
    elements.scrubber.addEventListener('pointerup', () => { isScrubbing = false; });
    elements.scrubber.addEventListener('input', () => {
      previewTime = Number(elements.scrubber.value) || 0;
      if (MSE.sync && MSE.sync.isTimelineReady()) MSE.sync.seekTo(currentShot.startSeconds + previewTime);
      render();
    });
    window.addEventListener('resize', () => { if (isOpen()) render(); });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isOpen()) close();
    });

    if (MSE.sync && MSE.sync.onPlayheadTick) {
      MSE.sync.onPlayheadTick(() => {
        if (!isOpen() || isScrubbing || localPlaybackFrame !== null) return;
        previewTime = projectRelativeTime();
        render();
      });
    }
  }

  on('playback-state-changed', (event) => {
    projectIsPlaying = !!event.detail.isPlaying;
    if (elements.play) elements.play.textContent = projectIsPlaying ? 'Pause' : 'Play';
  });
  on('shots-changed', (event) => {
    if (!isOpen() || !currentShot) return;
    currentShot = state.shots.find((shot) => shot.id === currentShot.id) || null;
    if (!currentShot) return close();
    if (MSE.sceneCalibrationPanel) MSE.sceneCalibrationPanel.setShot(currentShot);
    compileCurrentShot();
    render();
    if (event.detail && event.detail.reason === 'scene') loadCurrentScene();
    const reason = event.detail && event.detail.reason;
    if (['assign-asset', 'unassign-asset', 'asset-role', 'delete-asset', 'mcp-live'].includes(reason)) {
      loadMoodCard();
    }
  });
  on('shot-selected', () => {
    if (!isOpen()) return;
    currentShot = selectedShot();
    if (!currentShot) return close();
    if (MSE.sceneCalibrationPanel) MSE.sceneCalibrationPanel.setShot(currentShot);
    elements.subtitle.textContent = currentShot.name ? `Shot ${currentShot.id} — ${currentShot.name}` : `Shot ${currentShot.id}`;
    previewTime = Math.max(0, Math.min(shotDuration(), projectRelativeTime()));
    compileCurrentShot();
    renderSceneSelect();
    render();
    loadCurrentScene();
    loadMoodCard();
  });
  on('project-loaded', () => { if (isOpen()) close(); });
  on('scenes-changed', (event) => {
    if (!isOpen()) return;
    renderSceneSelect();
    compileCurrentShot();
    if (!event.detail || ['asset-sync', 'asset-delete'].includes(event.detail.reason)) loadCurrentScene();
  });
  on('assets-changed', () => {
    if (isOpen()) loadMoodCard();
  });

  document.addEventListener('DOMContentLoaded', init);
  MSE.cameraPreview = { open, close };
})(window.MSE = window.MSE || {});
