// The "fiddly" per-asset editing (tags, description, [Describe image],
// delete, kind classification) lives in the top-level Assets tab, separate
// from a shot's Cast & Locations tab, since that's occasional housekeeping,
// not the every-click assign workflow the picker (assetPicker.js) is used
// for constantly. Assigning assets to shots stays out of here entirely -
// this view has no concept of "the selected shot".
//
// Master-detail layout: a compact thumbnail grid on the left to pick an
// asset, a roomy detail panel on the right for whichever one is selected -
// the description text especially needs real space, not a 3-row textarea
// squeezed into a 140px-wide grid card.
(function (MSE) {
  'use strict';

  const { state, on } = MSE.state;

  const el = {};
  let selectedAssetId = null;
  let isVisible = false;

  function cacheElements() {
    el.fileInput = document.getElementById('asset-library-file-input');
    el.tagFilter = document.getElementById('asset-library-tag-filter');
    el.status = document.getElementById('asset-library-status');
    el.empty = document.getElementById('asset-library-empty');
    el.grid = document.getElementById('asset-library-grid');
    el.detail = document.getElementById('asset-library-detail');
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

  function selectAsset(assetId) {
    selectedAssetId = assetId;
    renderGrid();
    renderDetail();
  }

  // Asset kind (location/character/prop/...) is required before an asset can
  // be assigned to a shot (see contextPanel.js) - this <select> is the one
  // place it's ever set, right on the card the moment the asset shows up, so
  // classifying it never needs a separate blocking step after import.
  function buildKindSelect(asset) {
    const options = MSE.assets.kindOptionsFor(asset.type);
    const select = document.createElement('select');
    select.className = 'asset-kind-select';

    if (options.length === 0) {
      select.disabled = true;
      const opt = document.createElement('option');
      opt.textContent = 'N/A';
      select.appendChild(opt);
      return select;
    }

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'What is this?';
    placeholder.disabled = true;
    placeholder.selected = !asset.kind;
    select.appendChild(placeholder);

    options.forEach(({ value, label }) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      opt.selected = asset.kind === value;
      select.appendChild(opt);
    });

    select.classList.toggle('unclassified', !asset.kind);
    // Lives inside a clickable card/button - without this, opening the
    // dropdown or picking an option would also fire the card's own click
    // handler and swap the selected asset out from under the user.
    select.addEventListener('click', (e) => e.stopPropagation());
    select.addEventListener('change', () => MSE.assets.setAssetKind(asset.id, select.value));
    return select;
  }

  function renderGridCard(asset) {
    const card = document.createElement('div');
    card.className = 'asset-card asset-card-pick';
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.classList.toggle('selected', asset.id === selectedAssetId);
    card.classList.toggle('needs-classification', !MSE.assets.isClassified(asset));

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

    card.appendChild(buildKindSelect(asset));

    card.addEventListener('click', () => selectAsset(asset.id));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectAsset(asset.id);
      }
    });
    return card;
  }

  function renderGrid() {
    const filterText = el.tagFilter.value.trim().toLowerCase();
    const filtered = state.assets.filter((asset) => {
      if (!filterText) return true;
      return (asset.tags || []).some((tag) => tag.toLowerCase().includes(filterText));
    });
    el.grid.innerHTML = '';
    el.empty.style.display = state.assets.length === 0 ? '' : 'none';
    filtered.forEach((asset) => el.grid.appendChild(renderGridCard(asset)));
  }

  function renderDetail() {
    el.detail.innerHTML = '';
    const asset = MSE.assets.findAsset(selectedAssetId);
    if (!asset) {
      selectedAssetId = null;
      const empty = document.createElement('p');
      empty.className = 'placeholder-hint';
      empty.id = 'asset-library-detail-empty';
      empty.textContent = 'Select an asset on the left to see its details.';
      el.detail.appendChild(empty);
      return;
    }

    const previewUrl = assetPreviewUrl(asset);
    if (previewUrl) {
      const img = document.createElement('img');
      img.className = 'asset-detail-preview';
      img.src = previewUrl;
      img.alt = asset.fileName;
      el.detail.appendChild(img);
    }

    const name = document.createElement('h3');
    name.className = 'asset-detail-filename';
    name.title = asset.fileName;
    name.textContent = MSE.format.stripFileExtension(asset.fileName);
    el.detail.appendChild(name);

    if (MSE.assets.kindOptionsFor(asset.type).length > 0) {
      const kindLabel = document.createElement('div');
      kindLabel.className = 'asset-description-label';
      kindLabel.textContent = 'Kind';
      el.detail.appendChild(kindLabel);
      el.detail.appendChild(buildKindSelect(asset));
    }

    const tagLabel = document.createElement('div');
    tagLabel.className = 'asset-description-label';
    tagLabel.textContent = 'Tags';
    el.detail.appendChild(tagLabel);

    const tagInput = document.createElement('input');
    tagInput.type = 'text';
    tagInput.className = 'asset-tag-input';
    tagInput.placeholder = 'tags, comma, separated';
    tagInput.value = (asset.tags || []).join(', ');
    tagInput.addEventListener('change', () => {
      const tags = tagInput.value
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      MSE.assets.setAssetTags(asset.id, tags);
    });
    el.detail.appendChild(tagInput);

    if (asset.type === 'image') {
      const descLabel = document.createElement('div');
      descLabel.className = 'asset-description-label';
      descLabel.textContent = 'Description';
      el.detail.appendChild(descLabel);

      const descArea = document.createElement('textarea');
      descArea.className = 'asset-description asset-description-large';
      descArea.rows = 12;
      descArea.placeholder = 'Description...';
      descArea.value = asset.description || '';
      descArea.addEventListener('change', () => {
        MSE.assets.setAssetDescription(asset.id, descArea.value);
      });
      el.detail.appendChild(descArea);

      const describeBtn = document.createElement('button');
      describeBtn.type = 'button';
      describeBtn.className = 'asset-describe-btn';
      describeBtn.textContent = 'Describe image';
      el.detail.appendChild(describeBtn);

      const describeStatus = document.createElement('span');
      describeStatus.className = 'asset-describe-status';
      describeStatus.hidden = true;
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      describeStatus.appendChild(spinner);
      describeStatus.appendChild(document.createTextNode('Working...'));
      el.detail.appendChild(describeStatus);

      // Streams deltas straight into this textarea without going through
      // setAssetDescription (and its assets-changed event) on every token -
      // that would rebuild the whole grid and detail panel on every streamed
      // word. The state is mutated directly instead, then persisted with one
      // real event once streaming finishes.
      describeBtn.addEventListener('click', async () => {
        const projectId = MSE.project.getProjectId();
        if (!projectId) return;
        describeBtn.disabled = true;
        describeStatus.hidden = false;
        descArea.value = '';
        const assetRef = MSE.assets.findAsset(asset.id);
        let firstDelta = true;
        try {
          await MSE.project.saveProjectToBackend();
          const { jobId } = await MSE.api.describeAsset(projectId, asset.id);
          await MSE.api.watchJob(jobId, (event) => {
            if (event.delta) {
              if (firstDelta) {
                describeStatus.hidden = true;
                firstDelta = false;
              }
              descArea.value += event.delta;
              if (assetRef) assetRef.description = descArea.value;
            }
          });
          MSE.assets.setAssetDescription(asset.id, descArea.value);
        } catch (err) {
          console.error(err);
          descArea.value = `Describe failed: ${err.message}`;
        } finally {
          describeBtn.disabled = false;
          describeStatus.hidden = true;
        }
      });
    }

    const actions = document.createElement('div');
    actions.className = 'asset-detail-actions';

    const replaceInput = document.createElement('input');
    replaceInput.type = 'file';
    replaceInput.hidden = true;
    replaceInput.addEventListener('change', async () => {
      const file = replaceInput.files && replaceInput.files[0];
      replaceInput.value = '';
      if (!file) return;
      const projectId = MSE.project.getProjectId();
      if (!projectId) return;
      replaceBtn.disabled = true;
      replaceBtn.textContent = 'Replacing...';
      try {
        const descriptor = await MSE.api.replaceAsset(projectId, asset.id, file);
        MSE.assets.replaceAssetFile(asset.id, descriptor);
        // The backend already deleted the old file on disk as part of the
        // replace - leaving project.json unsaved would point it at a file
        // that no longer exists (breaking describe, exports, etc.) until
        // the next manual save, so this one save isn't optional.
        await MSE.project.saveProjectToBackend();
      } catch (err) {
        console.error(err);
        window.alert(`Replace failed: ${err.message}`);
      } finally {
        replaceBtn.disabled = false;
        replaceBtn.textContent = 'Replace file...';
      }
    });
    el.detail.appendChild(replaceInput);

    const replaceBtn = document.createElement('button');
    replaceBtn.type = 'button';
    replaceBtn.className = 'asset-replace-btn';
    replaceBtn.textContent = 'Replace file...';
    replaceBtn.addEventListener('click', () => replaceInput.click());
    actions.appendChild(replaceBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'asset-delete-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
      if (!window.confirm(`Delete "${asset.fileName}"? This also unassigns it from every shot.`)) return;
      MSE.assets.removeAsset(asset.id);
    });
    actions.appendChild(deleteBtn);

    el.detail.appendChild(actions);
  }

  function render() {
    renderGrid();
    renderDetail();
  }

  function wire() {
    el.tagFilter.addEventListener('input', renderGrid);

    el.fileInput.addEventListener('change', async () => {
      const files = el.fileInput.files;
      if (!files || files.length === 0) return;
      const projectId = MSE.project.getProjectId();
      if (!projectId) {
        el.status.textContent = 'Backend unavailable - cannot import assets.';
        el.fileInput.value = '';
        return;
      }
      el.status.textContent = `Importing ${files.length} file(s)...`;
      try {
        const result = await MSE.api.uploadAssets(projectId, files);
        MSE.assets.addAssets(result.assets);
        el.status.textContent = `Imported ${result.assets.length} file(s).`;
      } catch (err) {
        console.error(err);
        el.status.textContent = 'Import failed - is the backend running?';
      } finally {
        el.fileInput.value = '';
      }
    });

    on('assets-changed', () => {
      if (isVisible) render();
    });
    on('main-view-changed', ({ detail }) => {
      isVisible = detail.view === 'assets';
      if (isVisible) {
        el.status.textContent = '';
        render();
      }
    });
  }

  function init() {
    cacheElements();
    wire();
  }

  document.addEventListener('DOMContentLoaded', init);
})(window.MSE = window.MSE || {});
