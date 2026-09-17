// Setup modal: application-level audio-render quality and provider
// connections (AI chat API for "Describe image"/"Expand with AI", and the
// ComfyUI Pod for per-shot generation) - stored on the backend outside of any
// project, never part of project.json or an export. Neither provider's API key is ever sent back
// down from the backend (see settings.py's _public_view), so this form only
// shows whether one is saved, not what it is; leaving a key field blank on
// save keeps whatever is already stored for that provider.
(function (MSE) {
  'use strict';

  const el = {};

  function cacheElements() {
    el.openBtn = document.getElementById('setup-btn');
    el.overlay = document.getElementById('settings-modal');
    el.closeBtn = document.getElementById('settings-close-btn');
    el.audioRenderQuality = document.getElementById('settings-audio-render-quality');
    el.audioRenderFormat = document.getElementById('settings-audio-render-format');

    el.ai = {
      baseUrl: document.getElementById('settings-ai-base-url'),
      apiKey: document.getElementById('settings-ai-api-key'),
      keyStatus: document.getElementById('settings-ai-key-status'),
      defaultModel: document.getElementById('settings-ai-default-model'),
      modelList: document.getElementById('settings-ai-model-list'),
      testBtn: document.getElementById('settings-ai-test-btn'),
      testResult: document.getElementById('settings-ai-test-result'),
    };
    el.comfy = {
      baseUrl: document.getElementById('settings-comfy-base-url'),
      apiKey: document.getElementById('settings-comfy-api-key'),
      keyStatus: document.getElementById('settings-comfy-key-status'),
      testBtn: document.getElementById('settings-comfy-test-btn'),
      testResult: document.getElementById('settings-comfy-test-result'),
    };

    el.saveBtn = document.getElementById('settings-save-btn');
    el.saveStatus = document.getElementById('settings-save-status');
  }

  // Also called right after a successful save, to refresh the "an API key is
  // saved" prefill - must NOT touch saveStatus itself, or it would immediately
  // wipe out the "Saved." confirmation the save handler just set.
  async function loadIntoForm() {
    try {
      const { providers, audio } = await MSE.api.getSettings();
      el.audioRenderQuality.value = (audio && audio.renderQuality) || 'mono-32000';
      el.audioRenderFormat.value = (audio && audio.renderFormat) || 'flac';
      el.ai.baseUrl.value = providers.ai.baseUrl || '';
      el.ai.defaultModel.value = providers.ai.defaultModel || '';
      el.ai.apiKey.value = '';
      el.ai.apiKey.placeholder = providers.ai.hasApiKey ? 'Saved - leave blank to keep it' : 'sk-...';
      el.ai.keyStatus.textContent = providers.ai.hasApiKey ? 'An API key is saved.' : 'No API key saved yet.';

      el.comfy.baseUrl.value = providers.comfy.baseUrl || '';
      el.comfy.apiKey.value = '';
      el.comfy.apiKey.placeholder = providers.comfy.hasApiKey ? 'Saved - leave blank to keep it' : '(optional for now)';
      el.comfy.keyStatus.textContent = providers.comfy.hasApiKey ? 'An API key is saved.' : 'No API key saved yet.';
    } catch (err) {
      console.error(err);
      el.saveStatus.textContent = 'Could not load settings - is the backend running?';
    }
  }

  function currentAiValues() {
    return {
      baseUrl: el.ai.baseUrl.value.trim(),
      apiKey: el.ai.apiKey.value.trim(),
      defaultModel: el.ai.defaultModel.value.trim(),
    };
  }

  function currentComfyValues() {
    return {
      baseUrl: el.comfy.baseUrl.value.trim(),
      apiKey: el.comfy.apiKey.value.trim(),
    };
  }

  function currentAudioValues() {
    return {
      renderQuality: el.audioRenderQuality.value,
      renderFormat: el.audioRenderFormat.value,
    };
  }

  function openModal() {
    el.overlay.hidden = false;
    el.ai.testResult.textContent = '';
    el.comfy.testResult.textContent = '';
    el.saveStatus.textContent = '';
    loadIntoForm();
  }

  function closeModal() {
    el.overlay.hidden = true;
  }

  function wireTest(providerKey, section, currentValues) {
    section.testBtn.addEventListener('click', async () => {
      section.testBtn.disabled = true;
      section.testResult.textContent = 'Testing...';
      section.testResult.style.color = '';
      try {
        const result = await MSE.api.testSettings(providerKey, currentValues());
        if (Array.isArray(result.models) && section.modelList) {
          section.modelList.innerHTML = '';
          result.models.forEach((id) => {
            const option = document.createElement('option');
            option.value = id;
            section.modelList.appendChild(option);
          });
        }
        section.testResult.textContent = result.message || (result.ok ? 'OK' : 'Failed');
        section.testResult.style.color = result.ok ? '#4caf50' : '#f44336';
      } catch (err) {
        console.error(err);
        section.testResult.textContent = 'Test request failed.';
        section.testResult.style.color = '#f44336';
      } finally {
        section.testBtn.disabled = false;
      }
    });
  }

  function wire() {
    el.openBtn.addEventListener('click', openModal);
    el.closeBtn.addEventListener('click', closeModal);
    el.overlay.addEventListener('click', (e) => {
      if (e.target === el.overlay) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.overlay.hidden) closeModal();
    });

    wireTest('ai', el.ai, currentAiValues);
    wireTest('comfy', el.comfy, currentComfyValues);

    el.saveBtn.addEventListener('click', async () => {
      el.saveBtn.disabled = true;
      el.saveStatus.textContent = 'Saving...';
      try {
        // mode is fixed to 'pod' until Serverless support exists - not a form
        // field yet, just sent through so the backend always has a value.
        await MSE.api.saveSettings(
          { ai: currentAiValues(), comfy: { ...currentComfyValues(), mode: 'pod' } },
          currentAudioValues()
        );
        el.saveStatus.textContent = 'Saved.';
        await loadIntoForm();
      } catch (err) {
        console.error(err);
        el.saveStatus.textContent = 'Save failed.';
      } finally {
        el.saveBtn.disabled = false;
      }
    });
  }

  function init() {
    cacheElements();
    wire();
  }

  document.addEventListener('DOMContentLoaded', init);

  MSE.settings = {};
})(window.MSE = window.MSE || {});
