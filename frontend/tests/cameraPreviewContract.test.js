// Static integration contract for the native camera preview workspace.
// Run with: node frontend/tests/cameraPreviewContract.test.js
'use strict';

const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(FRONTEND, 'css', 'style.css'), 'utf8');
const controller = fs.readFileSync(path.join(FRONTEND, 'js', 'cameraPreview.js'), 'utf8');
const renderer = fs.readFileSync(path.join(FRONTEND, 'js', 'cameraPreviewRenderer.js'), 'utf8');
const sceneGeometry = fs.readFileSync(path.join(FRONTEND, 'js', 'sceneGeometry.js'), 'utf8');
const calibrationPanel = fs.readFileSync(path.join(FRONTEND, 'js', 'sceneCalibrationPanel.js'), 'utf8');
const cameraService = fs.readFileSync(path.join(FRONTEND, 'js', 'cameraService.js'), 'utf8');
let failures = 0;

function assert(condition, label) {
  if (condition) console.log(`ok - ${label}`);
  else {
    failures += 1;
    console.error(`FAIL: ${label}`);
  }
}

const requiredIds = [
  'camera-preview-btn',
  'camera-preview-modal',
  'camera-preview-canvas',
  'camera-preview-shot-view',
  'camera-preview-free-view',
  'camera-preview-scrubber',
  'camera-preview-scene-select',
  'camera-preview-calibrate-btn',
  'scene-calibration-panel',
  'camera-preview-export-btn',
  'camera-preview-mood-btn',
  'camera-preview-mood-panel',
  'camera-preview-mood-opacity',
  'camera-preview-mood-billboard',
  'camera-preview-reset-view-btn',
  'camera-preview-free-help',
];
requiredIds.forEach((id) => assert(html.includes(`id="${id}"`), `preview markup contains #${id}`));

const pathIndex = html.indexOf('js/cameraPath.js');
const rendererIndex = html.indexOf('js/cameraPreviewRenderer.js');
const geometryIndex = html.indexOf('js/sceneGeometry.js');
const controllerIndex = html.indexOf('js/cameraPreview.js');
const assetsIndex = html.indexOf('js/assets.js');
const scenesIndex = html.indexOf('js/scenes.js');
const projectIndex = html.indexOf('js/project.js');
assert(pathIndex >= 0 && rendererIndex > pathIndex, 'renderer loads after the canonical camera interpreter');
assert(geometryIndex > pathIndex && geometryIndex < rendererIndex, 'pure scene geometry loader loads before the renderer');
assert(controllerIndex > rendererIndex, 'preview controller loads after the renderer');
assert(scenesIndex > assetsIndex, 'scene registry loads after the asset model');
assert(projectIndex > scenesIndex, 'scene registry loads before project restoration');

assert(css.includes('background: var(--bg)'), 'preview viewport uses the CUTTAlogue background token');
assert(css.includes('border-color: var(--accent)'), 'preview active control uses the CUTTAlogue accent token');

// These are the identifying lime colors from the standalone Shot Visualizer.
// The renderer is being integrated, not its product theme.
['#d8ff3e', '#e2ff70', '#9fbc25'].forEach((color) => {
  assert(!css.toLowerCase().includes(color), `standalone Visualizer color ${color} is not imported`);
});

assert(controller.includes('renderer.dispose()'), 'preview controller explicitly disposes WebGL resources');
assert(controller.includes('MSE.cameraService.compileShot'), 'preview compiles through the shared camera service');
assert(cameraService.includes('MSE.cameraPath.compile'), 'shared service derives animation from CUTTAlogue Camera segments');
assert(cameraService.includes("authoritativeSource: 'shot.direction.camera'"), 'camera export declares Direction as authoritative');
assert(renderer.includes("MSE.cameraPath.evaluate"), 'renderer samples the canonical camera path contract');
assert(renderer.includes('setSceneGeometry'), 'renderer accepts parsed scene geometry');
assert(renderer.includes('gl.POINTS'), 'renderer draws point-cloud scene previews');
assert(renderer.includes('setAnchors'), 'renderer accepts calibrated scene anchors');
assert(renderer.includes('orbitFreeView') && renderer.includes('zoomFreeView'), 'free view exposes orbit and zoom controls');
assert(renderer.includes('cameraFrustumVertices') && renderer.includes('frustumBuffer'), 'free view renders the active shot camera frustum');
assert(renderer.includes('TEXTURE_FRAGMENT_SHADER') && renderer.includes('drawMoodCard'), 'renderer draws the environment image as a translucent 3D card');
assert(controller.includes("assetRoles[id] === 'environment'"), 'mood card automatically follows the shot environment role');
assert(controller.includes("reason: 'mood-card'"), 'mood-card transforms persist through project change tracking');
assert(controller.includes('Shift+drag') || html.includes('Shift+drag'), 'free-view interaction guidance is visible');
assert(html.includes('js/sceneCalibrationPanel.js'), 'native scene calibration editor is loaded');
assert(calibrationPanel.includes('updateSceneCalibration') && calibrationPanel.includes('upsertAnchor'), 'calibration editor writes through the scene model');
assert(controller.includes('Unresolved target:'), 'preview diagnostics name unresolved camera targets');
assert(sceneGeometry.includes('parsePly') && sceneGeometry.includes('parseSplat') && sceneGeometry.includes('parseGlb'), 'scene loader supports PLY, SPLAT, and GLB');
assert(!html.includes('SHOT VISUALIZER'), 'standalone Visualizer branding is absent');

if (failures) {
  console.error(`\n${failures} camera preview contract test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll camera preview contract tests passed.');
}
