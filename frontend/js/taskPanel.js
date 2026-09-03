// Shared task panel: triggers and shows progress for the whole-project
// export job (Phase 4b). Deliberately handles one job at a time - the
// backend only ever runs one export per project, so there's no queue to model.
(function (MSE) {
  'use strict';

  const { state, on } = MSE.state;

  const el = {};
  let activeJobId = null;

  function cacheElements() {
    el.includeMix = document.getElementById('export-include-mix');
    el.exportProjectBtn = document.getElementById('export-project-btn');
    el.panel = document.getElementById('task-panel');
    el.title = document.getElementById('task-panel-title');
    el.shotLabel = document.getElementById('task-panel-shot-label');
    el.fill = document.getElementById('task-panel-progress-fill');
    el.message = document.getElementById('task-panel-message');
    el.cancelBtn = document.getElementById('task-panel-cancel');
  }

  function showPanel(title) {
    el.panel.hidden = false;
    el.title.textContent = title;
    el.shotLabel.textContent = '';
    el.fill.style.width = '0%';
    el.message.textContent = '';
    el.cancelBtn.disabled = false;
    el.cancelBtn.textContent = 'Cancel';
  }

  function updateProgress(event) {
    const pct = Math.round((event.progressFraction || 0) * 100);
    el.fill.style.width = `${pct}%`;
    el.shotLabel.textContent = event.shotCount ? `Shot ${event.shot} of ${event.shotCount}` : '';
    el.message.textContent = event.message || '';
  }

  function hidePanelAfterDelay(delayMs) {
    setTimeout(() => {
      el.panel.hidden = true;
    }, delayMs);
  }

  async function runExport() {
    const projectId = MSE.project.getProjectId();
    if (!projectId) {
      el.message.textContent = 'Backend unavailable - cannot export.';
      showPanel('Export project');
      el.cancelBtn.disabled = true;
      hidePanelAfterDelay(4000);
      return;
    }

    el.exportProjectBtn.disabled = true;
    showPanel('Exporting project');

    try {
      await MSE.project.saveProjectToBackend();
      const { jobId } = await MSE.api.exportProject(projectId, { includeMixSnippet: el.includeMix.checked });
      activeJobId = jobId;
      const result = await MSE.api.watchJob(jobId, updateProgress);
      activeJobId = null;
      el.cancelBtn.disabled = true;
      if (result.status === 'cancelled') {
        el.message.textContent = 'Cancelled.';
      } else {
        el.fill.style.width = '100%';
        el.message.textContent = `Done - ${result.result.shotCount} shot(s) exported.`;
      }
      hidePanelAfterDelay(4000);
    } catch (err) {
      activeJobId = null;
      console.error(err);
      el.cancelBtn.disabled = true;
      el.message.textContent = `Export failed: ${err.message}`;
      hidePanelAfterDelay(6000);
    } finally {
      el.exportProjectBtn.disabled = false;
    }
  }

  function wire() {
    el.exportProjectBtn.addEventListener('click', runExport);

    el.includeMix.addEventListener('change', () => {
      state.export.includeMixSnippet = el.includeMix.checked;
    });

    el.cancelBtn.addEventListener('click', async () => {
      if (!activeJobId) return;
      el.cancelBtn.disabled = true;
      el.cancelBtn.textContent = 'Cancelling...';
      el.message.textContent = 'Cancelling...';
      try {
        await MSE.api.cancelJob(activeJobId);
      } catch (err) {
        console.error(err);
      }
    });

    on('project-loaded', () => {
      el.includeMix.checked = !!state.export.includeMixSnippet;
    });
  }

  function init() {
    cacheElements();
    el.includeMix.checked = !!state.export.includeMixSnippet;
    wire();
  }

  document.addEventListener('DOMContentLoaded', init);

  MSE.taskPanel = {};
})(window.MSE = window.MSE || {});
