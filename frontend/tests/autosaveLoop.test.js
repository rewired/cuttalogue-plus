// Regression test for the live-sync/autosave feedback loop.
// Run with: node frontend/tests/autosaveLoop.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const state = {};
const MSE = {
  state: {
    state,
    resetState(next) {
      Object.keys(state).forEach((key) => delete state[key]);
      Object.assign(state, next);
    },
    emit() {},
  },
  frames: { frameCalc() { return {}; } },
  shots: {},
  api: {
    deleteDraft() { return Promise.resolve({}); },
    autosaveProject() { throw new Error('unchanged live state must not autosave'); },
  },
};

const sandbox = {
  window: { MSE },
  document: { addEventListener() {} },
  localStorage: {
    getItem() { return 'project1'; },
    setItem() {},
  },
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Blob: function Blob() {},
  URL: {},
};

const projectPath = path.join(__dirname, '..', 'js', 'project.js');
let source = fs.readFileSync(projectPath, 'utf8');
source = source.replace(
  '  MSE.project = {',
  '  MSE.__projectInternals = { normalizeProjectData, pollForChanges, serializeProject };\n  MSE.project = {'
);
vm.runInNewContext(source, sandbox, { filename: projectPath });

// Persisted shots use the serializer's key order. normalizeProjectData builds
// defaults first and then spreads the persisted shot, producing a different
// key order even though all values remain equal.
const persisted = {
  version: 1,
  name: 'Loop regression',
  audio: { mix: {}, vocal: {}, playbackTrack: 'mix' },
  tempo: {},
  video: { fpsNumerator: 24, fpsDenominator: 1, frameRule: { stride: 17, offset: 5 } },
  shotLimits: {},
  shots: [{
    id: 1,
    startSeconds: 0,
    endSeconds: 1,
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
  }],
  assets: [],
  scenes: [],
  vocalCues: [],
  lyrics: { text: '' },
  lyricsAlignment: null,
  subtitleExport: { offsetSeconds: 0 },
  export: { includeMixSnippet: false },
  loop: { enabled: false, startSeconds: null, endSeconds: null, snapMode: 'grid' },
  savedAt: 123,
};

const normalized = MSE.__projectInternals.normalizeProjectData(persisted);
MSE.state.resetState(normalized);
const serialized = MSE.__projectInternals.serializeProject();
if (JSON.stringify(normalized) === JSON.stringify(serialized)) {
  throw new Error('fixture must reproduce the harmless object-key-order difference');
}

MSE.project.applyLiveProject(persisted, 'revision-1');
MSE.__projectInternals.pollForChanges();

if (MSE.project.isDirty()) {
  throw new Error('an unchanged live revision was marked dirty and would autosave forever');
}

console.log('ok - unchanged live revisions do not trigger autosave');
