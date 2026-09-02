// Context panel: [Cast & Locations] / [Direction] / [Prompt] / [Notes] /
// [Generate] tabs on the right of the shot list. Owns the transient (non-
// persisted) selected-shot id and renders that shot's readouts plus its
// editable prompt/notes fields and take history, which live on the shot
// itself and round-trip through the project JSON.
(function (MSE) {
  'use strict';

  const { state, on, emit } = MSE.state;
  const shotsApi = MSE.shots;

  let selectedShotId = null;

  const el = {};

  function cacheElements() {
    el.tabAssetsBtn = document.getElementById('tab-btn-assets');
    el.tabDirectionBtn = document.getElementById('tab-btn-direction');
    el.tabPromptBtn = document.getElementById('tab-btn-prompt');
    el.tabNotesBtn = document.getElementById('tab-btn-notes');
    el.tabGenerateBtn = document.getElementById('tab-btn-generate');
    el.tabAssets = document.getElementById('tab-assets');
    el.tabDirection = document.getElementById('tab-direction');
    el.tabPrompt = document.getElementById('tab-prompt');
    el.tabNotes = document.getElementById('tab-notes');
    el.tabGenerate = document.getElementById('tab-generate');

    el.assetsTabEmpty = document.getElementById('assets-tab-empty');
    el.assetsTabDetail = document.getElementById('assets-tab-detail');
    el.directionEmpty = document.getElementById('direction-tab-empty');
    el.directionDetail = document.getElementById('direction-tab-detail');
    el.promptEmpty = document.getElementById('prompt-tab-empty');
    el.promptDetail = document.getElementById('prompt-tab-detail');
    el.notesEmpty = document.getElementById('notes-tab-empty');
    el.notesDetail = document.getElementById('notes-tab-detail');
    el.generateEmpty = document.getElementById('generate-tab-empty');
    el.generateDetail = document.getElementById('generate-tab-detail');

    el.prompt = document.getElementById('shot-detail-prompt');
    el.notes = document.getElementById('shot-detail-notes');
    el.seed = document.getElementById('shot-detail-seed');
    el.assignedAssets = document.getElementById('shot-detail-assets');

    el.generateBtn = document.getElementById('generate-take-btn');
    el.generateSpinner = document.getElementById('generate-spinner');
    el.generateStatusText = document.getElementById('generate-status-text');
    el.generateSeedReadout = document.getElementById('generate-seed-readout');
    el.takeHistoryList = document.getElementById('take-history-list');
  }

  function findSelectedShot() {
    return state.shots.find((s) => s.id === selectedShotId) || null;
  }

  // Cast & Locations/Direction/Prompt/Notes only make sense for a selected
  // shot, so each tab toggles its own empty-hint vs detail content the same
  // way the old single Shot tab used to as a whole.
  function renderShotSpecificTabs() {
    const shot = findSelectedShot();
    const hasShot = !!shot;

    el.assetsTabEmpty.style.display = hasShot ? 'none' : '';
    el.assetsTabDetail.style.display = hasShot ? '' : 'none';
    el.directionEmpty.style.display = hasShot ? 'none' : '';
    el.directionDetail.style.display = hasShot ? '' : 'none';
    el.promptEmpty.style.display = hasShot ? 'none' : '';
    el.promptDetail.style.display = hasShot ? '' : 'none';
    el.notesEmpty.style.display = hasShot ? 'none' : '';
    el.notesDetail.style.display = hasShot ? '' : 'none';
    el.generateEmpty.style.display = hasShot ? 'none' : '';
    el.generateDetail.style.display = hasShot ? '' : 'none';

    if (hasShot) {
      // Skip the field currently being typed in, so a re-render triggered by
      // e.g. dragging the shot's edge in the timeline can't clobber live input.
      if (document.activeElement !== el.prompt) el.prompt.value = shot.prompt || '';
      if (document.activeElement !== el.notes) el.notes.value = shot.notes || '';
      if (document.activeElement !== el.seed) el.seed.value = shot.seed ?? '';
      el.generateSeedReadout.textContent =
        shot.seed != null ? `Next seed: ${shot.seed} (edit in the Prompt tab)` : 'Next seed: random (set one in the Prompt tab to pin it)';
    }

    renderAssignedAssets();
    renderTakeHistory();
  }

  function assetPreviewUrl(asset) {
    const projectId = MSE.project.getProjectId();
    const path = asset.thumbnailPath || (asset.type === 'image' ? asset.relativePath : null);
    if (!projectId || !path) return null;
    return `/project-files/${projectId}/${path}?v=${asset.version || 0}`;
  }

  function assetTypeLabel(type) {
    if (type === 'audio') return 'AUDIO';
    if (type === 'video') return 'VIDEO';
    if (type === 'other') return 'FILE';
    if (type === 'pointcloud') return 'SPLAT';
    if (type === 'model3d') return 'GLB';
    return 'IMAGE';
  }

  // Keep persisted Extend assignments visible and removable, but never imply
  // that the current R2V_H3_V1 workflow can consume them.
  const VIDEO_MODE_OPTIONS = [
    { value: '', label: 'Not used', disabled: false },
    { value: 'extend', label: 'Extend (workflow unavailable)', disabled: true },
  ];

  // Free start-frame + frame-count range, with a one-click "last N frames"
  // shortcut (sets startFrame from the asset's known total and the current
  // count) rather than a separate always-last-N mode - same two backend
  // params either way, see comfy_workflow_template.py's VHS_LoadVideo node.
  function buildExtendRangeControls(shot, asset, current) {
    const wrap = document.createElement('div');
    wrap.className = 'assigned-asset-video-range';
    const total = (asset.metadata && asset.metadata.frameCount) || null;

    const startInput = document.createElement('input');
    startInput.type = 'number';
    startInput.min = 0;
    startInput.title = 'Start frame';
    if (total) startInput.max = Math.max(0, total - 1);
    startInput.value = current.startFrame ?? 0;

    const countInput = document.createElement('input');
    countInput.type = 'number';
    countInput.min = 1;
    countInput.title = 'Frame count';
    if (total) countInput.max = total;
    countInput.value = current.frameCount ?? (total ? Math.min(16, total) : 16);

    function commit() {
      const startFrame = parseInt(startInput.value, 10) || 0;
      const frameCount = Math.max(1, parseInt(countInput.value, 10) || 1);
      shotsApi.setVideoRef(shot.id, asset.id, { mode: 'extend', startFrame, frameCount });
    }
    startInput.addEventListener('change', commit);
    countInput.addEventListener('change', commit);
    wrap.appendChild(startInput);
    wrap.appendChild(countInput);

    if (total) {
      const lastNBtn = document.createElement('button');
      lastNBtn.type = 'button';
      lastNBtn.className = 'assigned-asset-video-preset';
      lastNBtn.title = 'Set start frame so the range ends at the video\'s last frame';
      lastNBtn.textContent = 'Last N';
      lastNBtn.addEventListener('click', () => {
        const frameCount = Math.max(1, parseInt(countInput.value, 10) || 1);
        startInput.value = Math.max(0, total - frameCount);
        commit();
      });
      wrap.appendChild(lastNBtn);
    }

    return wrap;
  }

  function renderVideoRefControls(card, shot, asset) {
    const current = (shot.videoRefs || {})[asset.id] || null;

    const select = document.createElement('select');
    select.className = 'assigned-asset-role-select';
    VIDEO_MODE_OPTIONS.forEach(({ value, label, disabled }) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      opt.disabled = disabled;
      opt.selected = value === (current ? current.mode : '');
      select.appendChild(opt);
    });
    select.addEventListener('change', () => {
      if (!select.value) {
        shotsApi.setVideoRef(shot.id, asset.id, null);
      } else {
        shotsApi.setVideoRef(shot.id, asset.id, {
          mode: select.value,
          startFrame: current ? current.startFrame : 0,
          frameCount: current ? current.frameCount : null,
        });
      }
    });
    card.appendChild(select);

    if (current && current.mode === 'extend') {
      card.appendChild(buildExtendRangeControls(shot, asset, current));
    }
  }

  // Assigned assets render as thumbnail cards - this is also where an
  // asset's H3 role for THIS shot gets picked (only images have one; casting
  // is a per-shot fact, unlike an asset's kind which is fixed everywhere -
  // see assets.js). Adding happens via the trailing "+" tile, which opens
  // the asset picker modal (assetPicker.js); removing stays right here via
  // each card's own x.
  function renderAssignedAssets() {
    const shot = findSelectedShot();
    el.assignedAssets.innerHTML = '';
    if (!shot) return;

    MSE.assets.assetsForShot(shot).forEach((asset) => {
      const card = document.createElement('div');
      card.className = 'asset-card assigned-asset-card';

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'assigned-asset-remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove from this shot';
      removeBtn.addEventListener('click', () => MSE.assets.removeAssetFromShot(shot.id, asset.id));
      card.appendChild(removeBtn);

      const previewUrl = assetPreviewUrl(asset);
      if (previewUrl) {
        const img = document.createElement('img');
        img.src = previewUrl;
        img.alt = asset.fileName;
        card.appendChild(img);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'asset-icon';
        placeholder.textContent = assetTypeLabel(asset.type);
        card.appendChild(placeholder);
      }

      const name = document.createElement('div');
      name.className = 'asset-filename';
      name.title = asset.fileName;
      name.textContent = MSE.format.stripFileExtension(asset.fileName);
      card.appendChild(name);

      if (asset.type === 'image') {
        const options = MSE.assets.roleOptionsFor(asset.kind);
        if (options) {
          const currentRole = (shot.assetRoles || {})[asset.id] || '';
          const select = document.createElement('select');
          select.className = 'assigned-asset-role-select';
          options.forEach(([value, label]) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            opt.selected = value === currentRole;
            select.appendChild(opt);
          });
          select.addEventListener('change', () => shotsApi.setAssetRole(shot.id, asset.id, select.value || null));
          card.appendChild(select);
        } else {
          // Shouldn't normally happen - the picker blocks assigning an
          // unclassified asset - but projects saved before classification
          // existed can still have one here, so this stays a safe fallback.
          const note = document.createElement('div');
          note.className = 'asset-tags-readout asset-kind-warning';
          note.textContent = 'Not classified';
          card.appendChild(note);
        }
      } else if (asset.type === 'video') {
        renderVideoRefControls(card, shot, asset);
      }

      el.assignedAssets.appendChild(card);
    });

    const addCard = document.createElement('button');
    addCard.type = 'button';
    addCard.className = 'asset-card assigned-asset-add-card';
    addCard.title = 'Assign an asset to this shot';
    addCard.textContent = '+';
    addCard.addEventListener('click', () => MSE.assetPicker.open(shot.id));
    el.assignedAssets.appendChild(addCard);
  }

  function formatTakeTimestamp(ms) {
    return ms ? new Date(ms).toLocaleString() : '';
  }

  // Newest first, one card per take - never fewer than what's in
  // shot.takes (regenerating always adds, never overwrites, per the
  // "keep every take" requirement).
  function renderTakeHistory() {
    const shot = findSelectedShot();
    el.takeHistoryList.innerHTML = '';
    if (!shot) return;

    const projectId = MSE.project.getProjectId();
    const takes = (shot.takes || []).slice().reverse();
    takes.forEach((take) => {
      const isActive = shot.activeTakeId === take.id;
      const card = document.createElement('div');
      card.className = `take-card take-status-${take.status}`;

      const header = document.createElement('div');
      header.className = 'take-card-header';
      const seedLabel = document.createElement('span');
      seedLabel.className = 'take-seed';
      seedLabel.textContent = take.seed != null ? `Seed ${take.seed}` : 'Seed random';
      header.appendChild(seedLabel);
      const statusBadge = document.createElement('span');
      statusBadge.className = `take-status-badge take-status-badge-${take.status}`;
      statusBadge.textContent = take.status;
      header.appendChild(statusBadge);
      if (isActive) {
        const activeBadge = document.createElement('span');
        activeBadge.className = 'take-active-badge';
        activeBadge.textContent = 'Active';
        header.appendChild(activeBadge);
      }
      card.appendChild(header);

      const timeEl = document.createElement('div');
      timeEl.className = 'take-timestamp';
      timeEl.textContent = formatTakeTimestamp(take.createdAt);
      card.appendChild(timeEl);

      if (take.status === 'done' && take.relativePath && projectId) {
        const video = document.createElement('video');
        video.controls = true;
        video.className = 'take-video';
        video.src = `/project-files/${projectId}/${take.relativePath}?v=${take.id}`;
        card.appendChild(video);
      } else if (take.status === 'error') {
        const err = document.createElement('div');
        err.className = 'take-error';
        err.textContent = take.errorMessage || 'Generation failed.';
        card.appendChild(err);
      }

      const actions = document.createElement('div');
      actions.className = 'take-actions';
      if (take.status === 'done') {
        const setActiveBtn = document.createElement('button');
        setActiveBtn.type = 'button';
        setActiveBtn.textContent = isActive ? 'Active' : 'Set active';
        setActiveBtn.disabled = isActive;
        setActiveBtn.addEventListener('click', () => shotsApi.setActiveTake(shot.id, take.id));
        actions.appendChild(setActiveBtn);

        // Copies this take's video into the asset pool so it can be
        // assigned to any shot (e.g. picked as the "Extend" source for a
        // continuation) - the promoted asset survives even if this take or
        // its shot is later deleted (see assets.py's promote-to-asset).
        const useAsAssetBtn = document.createElement('button');
        useAsAssetBtn.type = 'button';
        useAsAssetBtn.textContent = 'Use as asset';
        useAsAssetBtn.addEventListener('click', async () => {
          useAsAssetBtn.disabled = true;
          useAsAssetBtn.textContent = 'Adding…';
          try {
            const descriptor = await MSE.api.promoteTakeToAsset(projectId, shot.id, take.id);
            MSE.assets.addAssets([descriptor]);
          } catch (err) {
            console.error(err);
            window.alert(`Use as asset failed: ${err.message}`);
            useAsAssetBtn.disabled = false;
            useAsAssetBtn.textContent = 'Use as asset';
          }
        });
        actions.appendChild(useAsAssetBtn);
      }
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => shotsApi.deleteTake(shot.id, take.id));
      actions.appendChild(deleteBtn);
      card.appendChild(actions);

      el.takeHistoryList.appendChild(card);
    });
  }

  // Optimistic take: appended as 'queued' the instant the button is
  // clicked, then carried through 'running'/'done'/'error' via the job's
  // SSE events, mirroring direction.js's "Expand with AI" job flow.
  function wireGenerateTab() {
    el.generateBtn.addEventListener('click', async () => {
      const shot = findSelectedShot();
      const projectId = MSE.project.getProjectId();
      if (!shot || !projectId) return;

      // Canonical binding (references.js) - the exact same order the H3
      // compiler used for <Picture N>, so an assigned-but-uncast asset (no
      // H3 role) never sneaks into the reference list and shifts numbering.
      const referenceAssetIds = MSE.references.referenceAssetIds(shot);

      // At most one video asset can be in "extend" mode per shot - it's a
      // single continuation source, not a list like image references.
      const videoRefs = shot.videoRefs || {};
      const extendAsset = MSE.assets
        .assetsForShot(shot)
        .find((a) => a.type === 'video' && videoRefs[a.id] && videoRefs[a.id].mode === 'extend');
      const extendAssetId = extendAsset ? extendAsset.id : null;
      const extendStartFrame = extendAsset ? videoRefs[extendAsset.id].startFrame || 0 : null;
      const extendFrameCount = extendAsset ? videoRefs[extendAsset.id].frameCount || null : null;

      const takeId = `local-${Date.now()}`;
      shotsApi.addTake(shot.id, {
        id: takeId,
        seed: shot.seed ?? null,
        status: 'queued',
        jobId: null,
        relativePath: null,
        createdAt: Date.now(),
        errorMessage: null,
      });

      el.generateBtn.disabled = true;
      el.generateSpinner.hidden = false;
      el.generateStatusText.textContent = 'Starting…';

      try {
        await MSE.project.saveProjectToBackend();
        const { jobId } = await MSE.api.generateTake(projectId, shot.id, {
          prompt: shot.prompt || '',
          seed: shot.seed ?? null,
          referenceAssetIds,
          extendAssetId,
          extendStartFrame,
          extendFrameCount,
        });
        shotsApi.updateTake(shot.id, takeId, { jobId, status: 'running' });
        el.generateStatusText.textContent = 'Generating…';

        const event = await MSE.api.watchJob(jobId, (progressEvent) => {
          if (progressEvent.message) el.generateStatusText.textContent = progressEvent.message;
        });
        const result = event.result || {};
        shotsApi.updateTake(shot.id, takeId, {
          status: 'done',
          relativePath: result.relativePath,
          seed: result.seed,
        });
        if (shot.activeTakeId == null) shotsApi.setActiveTake(shot.id, takeId);
        el.generateStatusText.textContent = 'Done.';
      } catch (err) {
        console.error(err);
        shotsApi.updateTake(shot.id, takeId, { status: 'error', errorMessage: err.message });
        el.generateStatusText.textContent = `Failed: ${err.message}`;
      } finally {
        el.generateBtn.disabled = false;
        el.generateSpinner.hidden = true;
      }
    });
  }

  function selectShot(shotId) {
    selectedShotId = shotId;
    renderShotSpecificTabs();
    emit('shot-selected', { shotId });
  }

  function getSelectedShotId() {
    return selectedShotId;
  }

  function wireTextInputs() {
    el.prompt.addEventListener('input', () => {
      const shot = findSelectedShot();
      if (shot) shot.prompt = el.prompt.value;
    });
    el.notes.addEventListener('input', () => {
      const shot = findSelectedShot();
      if (shot) shot.notes = el.notes.value;
    });
    el.seed.addEventListener('input', () => {
      const shot = findSelectedShot();
      if (!shot) return;
      const parsed = parseInt(el.seed.value, 10);
      shot.seed = Number.isNaN(parsed) ? null : parsed;
    });
  }

  function wireTabs() {
    const buttons = {
      assets: el.tabAssetsBtn,
      direction: el.tabDirectionBtn,
      prompt: el.tabPromptBtn,
      notes: el.tabNotesBtn,
      generate: el.tabGenerateBtn,
    };
    const panels = {
      assets: el.tabAssets,
      direction: el.tabDirection,
      prompt: el.tabPrompt,
      notes: el.tabNotes,
      generate: el.tabGenerate,
    };
    function activate(tab) {
      Object.keys(buttons).forEach((key) => {
        buttons[key].classList.toggle('active', key === tab);
        panels[key].hidden = key !== tab;
      });
    }
    Object.keys(buttons).forEach((key) => buttons[key].addEventListener('click', () => activate(key)));
  }

  function init() {
    cacheElements();
    wireTabs();
    wireTextInputs();
    wireGenerateTab();
    renderShotSpecificTabs();
  }

  on('shots-changed', () => {
    // The selected shot's id can disappear from under it (delete/merge/split
    // renumbers), in which case fall back to the empty state instead of
    // showing stale data for an id that no longer exists.
    if (selectedShotId !== null && !findSelectedShot()) selectedShotId = null;
    renderShotSpecificTabs();
  });
  on('assets-changed', () => renderShotSpecificTabs());
  on('project-loaded', () => {
    selectedShotId = null;
    renderShotSpecificTabs();
  });

  document.addEventListener('DOMContentLoaded', init);

  MSE.context = { selectShot, getSelectedShotId };
})(window.MSE = window.MSE || {});
