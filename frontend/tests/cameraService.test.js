// Shared camera application-service and export contract.
// Run with: node frontend/tests/cameraService.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS_DIR = path.join(__dirname, '..', 'js');
function load(file) {
  const fullPath = path.join(JS_DIR, file);
  vm.runInThisContext(fs.readFileSync(fullPath, 'utf8'), { filename: fullPath });
}

global.window = global;
global.MSE = {};
load('state.js');
load('cameraPath.js');
load('scenes.js');
load('cameraService.js');

let failures = 0;
function equal(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) console.log(`ok - ${label}`);
  else { failures += 1; console.error(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}

equal(MSE.state.createDefaultState().video.fpsNumerator, 24, 'new projects default to 24 fps');

const scene = {
  id: 'scene-1', unitsPerMeter: 1,
  defaultCamera: { position: [0, 0, 4], target: [0, 0, 0], focalLengthMm: 35 },
  anchors: { performer: { position: [0, 0, 0] } },
  motionProfile: { smallAngleDegrees: 90 },
};
const shot = {
  id: 7, startSeconds: 10, endSeconds: 11, sceneId: 'scene-1',
  preview: { interpreterProfile: 'cinematic-v1', initialCameraOverride: null, targetBindings: {} },
  direction: { camera: [{ startSeconds: 0, endSeconds: 1, movement: 'arc_shot', direction: 'right', amplitude: 'small', target: 'performer', speed: 'linear' }] },
};
const project = {
  scenes: [scene],
  video: { fpsNumerator: 25, fpsDenominator: 1, frameRule: { stride: 8, offset: 1 } },
};

const validation = MSE.cameraService.validateShot(shot, project);
equal(validation.valid, true, 'a calibrated target-aware path validates');
equal(MSE.cameraService.evaluateShot(shot, project, 1).position.map((value) => Math.round(value)), [4, 0, 0], 'service evaluation uses scene calibration');

const exported = MSE.cameraService.exportCamera(shot, project);
equal(exported.schema, 'cuttalogue.camera-path', 'export uses the versioned CUTTAlogue camera schema');
equal(exported.version, 1, 'export declares schema version 1');
equal(exported.frameRate, { numerator: 25, denominator: 1, fps: 25 }, 'export declares the exact project frame rate');
equal(exported.samples.length, 26, 'one second at 25 fps exports frames 0 through 25');
equal(exported.samples[25].timeSeconds, 1, 'the final sample lands on the shot endpoint');
equal(exported.samples[25].sourceSegmentIndex, 0, 'samples retain their source Camera-segment reference');
equal(exported.samples[25].sampleType, 'frame', 'a frame-aligned endpoint remains a regular FPS frame');
equal(exported.authoritativeSource, 'shot.direction.camera', 'export identifies Direction as its authoritative source');
equal(
  JSON.stringify(MSE.cameraService.exportCamera(shot, project)),
  JSON.stringify(MSE.cameraService.exportCamera(shot, project)),
  'camera export is byte-deterministic for identical input'
);

const defaultFrameRate = MSE.cameraService.exportCamera(shot, { ...project, video: {} }).frameRate;
equal(defaultFrameRate, { numerator: 24, denominator: 1, fps: 24 }, 'camera export fallback is 24 fps');

const fractionalShot = { ...shot, endSeconds: 10.1, direction: { camera: [] } };
const fractional = MSE.cameraService.exportCamera(fractionalShot, { ...project, video: { fpsNumerator: 24, fpsDenominator: 1 } });
equal(fractional.samples.at(-1).timeSeconds, 0.09999999999999964, 'non-frame-aligned shots still include their exact endpoint');
equal(fractional.samples.at(-1).frame, null, 'a non-frame-aligned endpoint is not mislabeled as a regular FPS frame');
equal(fractional.samples.at(-1).sampleType, 'endpoint', 'a non-frame-aligned endpoint is explicitly typed');

const invalidShot = {
  ...shot,
  sceneId: 'missing-scene',
  preview: { ...shot.preview, interpreterProfile: 'future-v9' },
  direction: { camera: [] },
};
const invalid = MSE.cameraService.validateShot(invalidShot, project);
equal(invalid.valid, false, 'invalid scene/profile references fail service validation');
equal(
  invalid.warnings.map((warning) => warning.code),
  ['unresolved_scene', 'unsupported_interpreter_profile'],
  'service validation reports stable machine-readable reference/profile codes'
);

if (failures) { console.error(`\n${failures} failure(s)`); process.exitCode = 1; }
else console.log('\nAll camera service checks passed.');
