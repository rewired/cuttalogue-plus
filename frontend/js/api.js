// Thin fetch wrapper around the Phase 2 backend: project CRUD plus the
// job/SSE pattern used for the "save" job (and, later, export/describe jobs).
(function (MSE) {
  'use strict';

  async function createProject(initialData) {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initialData),
    });
    if (!res.ok) throw new Error(`create project failed: ${res.status}`);
    return res.json(); // { id, project }
  }

  async function getProjectRecord(id) {
    const res = await fetch(`/api/projects/${id}`);
    if (!res.ok) throw new Error(`get project failed: ${res.status}`);
    const project = await res.json();
    const revision = res.headers.get('X-Project-Revision');
    if (!revision) throw new Error('get project failed: missing project revision');
    return { project, revision };
  }

  async function getProject(id) {
    return (await getProjectRecord(id)).project;
  }

  async function getProjectLive(id) {
    const res = await fetch(`/api/projects/${id}/live`);
    if (!res.ok) throw new Error(`get project live state failed: ${res.status}`);
    return res.json(); // { projectId, revision, activity }
  }

  async function acknowledgeProjectLive(id, revision, ready = true) {
    const res = await fetch(`/api/projects/${id}/live/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision, ready }),
    });
    if (!res.ok) throw new Error(`acknowledge project live state failed: ${res.status}`);
    return res.json();
  }

  async function listProjects() {
    const res = await fetch('/api/projects');
    if (!res.ok) throw new Error(`list projects failed: ${res.status}`);
    return res.json(); // { projects: [{ id, name, shotCount, updatedAt }] }
  }

  async function uploadAssets(id, fileList) {
    const form = new FormData();
    Array.from(fileList).forEach((file) => form.append('files', file));
    const res = await fetch(`/api/projects/${id}/assets`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`asset import failed: ${res.status}`);
    return res.json(); // { assets: [...] }
  }

  async function replaceAsset(id, assetId, file) {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/projects/${id}/assets/${assetId}/replace`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`asset replace failed: ${res.status}`);
    return res.json(); // { id, type, fileName, relativePath, thumbnailPath, metadata }
  }

  async function getDraft(id) {
    const res = await fetch(`/api/projects/${id}/draft`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`get draft failed: ${res.status}`);
    return res.json(); // { basedOnSavedAt, draftUpdatedAt, data } | null
  }

  async function deleteDraft(id) {
    const res = await fetch(`/api/projects/${id}/draft`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`draft delete failed: ${res.status}`);
    return res.json();
  }

  async function putProject(id, data) {
    const res = await fetch(`/api/projects/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`save project failed: ${res.status}`);
    return res.json(); // { jobId }
  }

  async function autosaveProject(id, project, expectedRevision) {
    const res = await fetch(`/api/projects/${id}/autosave`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, expectedRevision }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(body.detail || `autosave project failed: ${res.status}`);
      error.status = res.status;
      error.currentRevision = body.currentRevision || null;
      throw error;
    }
    return body;
  }

  async function uploadAudioTrack(id, track, file) {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/projects/${id}/audio/${track}`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`audio upload failed: ${res.status}`);
    return res.json(); // { relativePath, fileName }
  }

  async function exportProject(id, options) {
    const res = await fetch(`/api/projects/${id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options || {}),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `export failed: ${res.status}`);
    }
    return res.json(); // { jobId, shotCount }
  }

  async function cancelJob(jobId) {
    const res = await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    if (!res.ok) throw new Error(`cancel failed: ${res.status}`);
    return res.json();
  }

  // Resolves once the job reaches a terminal state ('done' or 'cancelled'),
  // rejects on 'error' or a broken stream. onProgress (optional) is called
  // for every intermediate event, e.g. { status: 'running', progressFraction:
  // 0.42, shot: 3, shotCount: 12 } while an ffmpeg job runs.
  function watchJob(jobId, onProgress) {
    return new Promise((resolve, reject) => {
      const source = new EventSource(`/api/jobs/${jobId}/events`);
      source.onmessage = (e) => {
        const event = JSON.parse(e.data);
        if (event.status === 'done' || event.status === 'cancelled') {
          source.close();
          resolve(event);
        } else if (event.status === 'error') {
          source.close();
          reject(new Error(event.message || 'job failed'));
        } else if (onProgress) {
          onProgress(event);
        }
      };
      source.onerror = () => {
        source.close();
        reject(new Error('job event stream failed'));
      };
    });
  }

  function waitForJob(jobId) {
    return watchJob(jobId);
  }

  async function getSettings() {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error(`get settings failed: ${res.status}`);
    return res.json(); // { providers: { ai: {baseUrl, defaultModel, hasApiKey}, comfy: {baseUrl, mode, hasApiKey} } }
  }

  async function saveSettings(providers) {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers }),
    });
    if (!res.ok) throw new Error(`save settings failed: ${res.status}`);
    return res.json();
  }

  // providerValues is the flat {baseUrl, apiKey, ...} form currently typed
  // into just that one provider's fieldset - testing doesn't require (or
  // wait for) the other provider's form to be valid.
  async function testSettings(providerKey, providerValues) {
    const res = await fetch('/api/settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: providerKey, ...providerValues }),
    });
    if (!res.ok) throw new Error(`connection test failed: ${res.status}`);
    return res.json(); // { ok, message, models? }
  }

  async function describeAsset(projectId, assetId) {
    const res = await fetch(`/api/projects/${projectId}/assets/${assetId}/describe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `describe failed: ${res.status}`);
    }
    return res.json(); // { jobId }
  }

  // Stateless (no project/shot lookup) - the caller already has the
  // deterministically-compiled detailed_description text in memory (see
  // h3Compiler.js's compileH3Sections) and just wants it expanded.
  async function expandDescription(text) {
    const res = await fetch('/api/expand-description', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `expand failed: ${res.status}`);
    }
    return res.json(); // { jobId }
  }

  // shot.prompt (already-compiled/edited text) and the shot's currently-cast
  // reference image asset ids - the backend doesn't re-derive either.
  // extendAssetId/extendStartFrame/extendFrameCount describe the single
  // video-continuation source, if the shot has one set to "Extend" mode.
  async function generateTake(projectId, shotId, { prompt, seed, referenceAssetIds, extendAssetId, extendStartFrame, extendFrameCount }) {
    const res = await fetch(`/api/projects/${projectId}/shots/${shotId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, seed, referenceAssetIds, extendAssetId, extendStartFrame, extendFrameCount }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `generate failed: ${res.status}`);
    }
    return res.json(); // { jobId }
  }

  // Phase 3a: local word-level lyrics-to-vocal alignment (see
  // backend/app/alignment.py). lyricsText is sent as-is - the backend never
  // reads/writes project.json for this, so aligning never requires a prior
  // Save of in-progress lyrics edits.
  async function alignLyrics(projectId, lyricsText) {
    const res = await fetch(`/api/projects/${projectId}/align-lyrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lyricsText }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `alignment failed: ${res.status}`);
    }
    return res.json(); // { jobId }
  }

  // Phase 5.1: current on-disk vocal fingerprint, used only to decide
  // whether a persisted lyricsAlignment is still valid (see lyricsAlign.js's
  // getStoredAlignmentStatus) - never triggers alignment itself.
  async function getVocalFingerprint(projectId) {
    const res = await fetch(`/api/projects/${projectId}/audio/vocal/fingerprint`);
    if (!res.ok) throw new Error(`get vocal fingerprint failed: ${res.status}`);
    const body = await res.json();
    return body.fingerprint; // null | { relativePath, sizeBytes, mtimeMs }
  }

  // No FormData needed - the take's output file already lives on the
  // server, this just tells it to copy that file into the asset pool.
  async function promoteTakeToAsset(projectId, shotId, takeId) {
    const res = await fetch(`/api/projects/${projectId}/shots/${shotId}/takes/${takeId}/promote-to-asset`, {
      method: 'POST',
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `promote failed: ${res.status}`);
    }
    return res.json(); // asset descriptor
  }

  MSE.api = {
    createProject,
    getProject,
    getProjectRecord,
    getProjectLive,
    acknowledgeProjectLive,
    listProjects,
    putProject,
    autosaveProject,
    uploadAssets,
    replaceAsset,
    getDraft,
    deleteDraft,
    uploadAudioTrack,
    exportProject,
    cancelJob,
    watchJob,
    waitForJob,
    getSettings,
    saveSettings,
    testSettings,
    describeAsset,
    expandDescription,
    alignLyrics,
    getVocalFingerprint,
    generateTake,
    promoteTakeToAsset,
  };
})(window.MSE = window.MSE || {});
