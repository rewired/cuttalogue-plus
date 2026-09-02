// Keeps the open browser project synchronized with canonical revisions written
// by the separate MCP STDIO process and renders explicit user-wait sessions.
(function (MSE) {
  'use strict';

  const POLL_INTERVAL_MS = 750;
  const elements = {};
  let observedProjectId = null;
  let observedRevision = null;
  let pollInFlight = false;
  let pollTimer = null;
  let loggedConnectionError = false;

  function cacheElements() {
    elements.overlay = document.getElementById('mcp-live-modal');
    elements.title = document.getElementById('mcp-live-title');
    elements.message = document.getElementById('mcp-live-message');
    elements.scope = document.getElementById('mcp-live-scope');
    elements.progress = document.getElementById('mcp-live-progress');
    elements.progressFill = document.getElementById('mcp-live-progress-fill');
  }

  function hideModal() {
    if (elements.overlay) elements.overlay.hidden = true;
  }

  function renderActivity(activity) {
    if (!elements.overlay) return;
    if (!activity || !activity.active) {
      hideModal();
      return;
    }
    elements.title.textContent = 'CUTTAlogue is being updated';
    elements.message.textContent = activity.message || 'Applying MCP changes…';
    elements.scope.textContent = Number.isInteger(activity.shotId) ? `Shot ${activity.shotId}` : 'Project';
    const hasProgress = Number.isFinite(activity.progressPercent);
    elements.progress.hidden = !hasProgress;
    if (hasProgress) {
      const progress = Math.max(0, Math.min(100, activity.progressPercent));
      elements.progressFill.style.width = `${progress}%`;
    }
    elements.overlay.hidden = false;
  }

  function renderDirtyConflict() {
    if (!elements.overlay) return;
    elements.title.textContent = 'Live update paused';
    elements.scope.textContent = 'Unsaved browser edits';
    elements.message.textContent = 'Save your current edits before MCP continues. They will not be overwritten.';
    elements.progress.hidden = true;
    elements.overlay.hidden = false;
  }

  async function applyRevision(projectId, revision) {
    if (MSE.project.isDirty()) {
      renderDirtyConflict();
      return false;
    }
    const project = await MSE.api.getProject(projectId);
    if (MSE.project.getProjectId() !== projectId) return false;
    MSE.project.applyLiveProject(project);
    observedRevision = revision;
    return true;
  }

  async function poll() {
    if (pollInFlight) return;
    const projectId = MSE.project && MSE.project.getProjectId();
    if (!projectId) {
      hideModal();
      return;
    }
    if (projectId !== observedProjectId) {
      observedProjectId = projectId;
      observedRevision = null;
    }

    pollInFlight = true;
    try {
      const live = await MSE.api.getProjectLive(projectId);
      loggedConnectionError = false;
      renderActivity(live.activity);
      if (observedRevision === null) {
        observedRevision = live.revision;
      } else if (live.revision !== observedRevision) {
        await applyRevision(projectId, live.revision);
      }
    } catch (error) {
      if (!loggedConnectionError) {
        console.warn('MCP live synchronization is temporarily unavailable.', error);
        loggedConnectionError = true;
      }
    } finally {
      pollInFlight = false;
    }
  }

  function resetProjectObservation() {
    observedProjectId = null;
    observedRevision = null;
  }

  function init() {
    cacheElements();
    MSE.state.on('project-loaded', resetProjectObservation);
    poll();
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }

  document.addEventListener('DOMContentLoaded', init);
  MSE.mcpLive = { poll, stop: () => clearInterval(pollTimer) };
})(window.MSE = window.MSE || {});
