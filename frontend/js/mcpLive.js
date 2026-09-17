// Keeps the open browser project synchronized with canonical revisions written
// by the separate MCP STDIO process and renders explicit user-wait sessions.
(function (MSE) {
  'use strict';

  const elements = {};
  let observedProjectId = null;
  let observedRevision = null;
  let observedLiveToken = null;
  let pollInFlight = false;
  let pollController = null;
  let stopped = false;
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

  async function applyRevision(projectId) {
    if (MSE.project.isDirty()) return false;
    const record = await MSE.api.getProjectRecord(projectId);
    if (MSE.project.getProjectId() !== projectId) return false;
    MSE.project.applyLiveProject(record.project, record.revision);
    observedRevision = record.revision;
    return true;
  }

  async function poll() {
    if (pollInFlight || stopped) return;
    const projectId = MSE.project && MSE.project.getProjectId();
    if (!projectId) {
      hideModal();
      return;
    }
    if (projectId !== observedProjectId) {
      observedProjectId = projectId;
      observedRevision = null;
      observedLiveToken = null;
    }

    pollInFlight = true;
    pollController = new AbortController();
    try {
      const live = await MSE.api.getProjectLive(projectId, {
        afterToken: observedLiveToken,
        revision: observedRevision,
        ready: MSE.project.isSynced(),
        signal: pollController.signal,
      });
      loggedConnectionError = false;
      observedLiveToken = live.token;
      renderActivity(live.activity);
      if (observedRevision === null || live.revision !== observedRevision) {
        await applyRevision(projectId);
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (!loggedConnectionError) {
        console.warn('MCP live synchronization is temporarily unavailable.', error);
        loggedConnectionError = true;
      }
    } finally {
      pollInFlight = false;
      pollController = null;
      if (!stopped && MSE.project.getProjectId() === projectId) queueMicrotask(poll);
    }
  }

  function restartPoll() {
    observedLiveToken = null;
    if (pollController) pollController.abort();
    else queueMicrotask(poll);
  }

  function resetProjectObservation() {
    observedProjectId = null;
    observedRevision = null;
    observedLiveToken = null;
    restartPoll();
  }

  function init() {
    cacheElements();
    MSE.state.on('project-loaded', resetProjectObservation);
    MSE.state.on('project-save-state', restartPoll);
    poll();
  }

  document.addEventListener('DOMContentLoaded', init);
  MSE.mcpLive = {
    poll,
    stop: () => {
      stopped = true;
      if (pollController) pollController.abort();
    },
  };
})(window.MSE = window.MSE || {});
