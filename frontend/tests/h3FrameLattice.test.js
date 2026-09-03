// Canonical MiniMax H3 frame-lattice contract.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const FRONTEND = path.join(__dirname, '..');
const JS_DIR = path.join(FRONTEND, 'js');

function load(file) {
  const fullPath = path.join(JS_DIR, file);
  vm.runInThisContext(fs.readFileSync(fullPath, 'utf8'), { filename: fullPath });
}

global.window = global;
global.MSE = {};
load('state.js');
load('frameMath.js');

let failures = 0;
function equal(actual, expected, label) {
  if (actual === expected) console.log(`ok - ${label}`);
  else {
    failures += 1;
    console.error(`FAIL: ${label}; expected ${expected}, got ${actual}`);
  }
}

const defaults = MSE.state.createDefaultState();
equal(defaults.video.fpsNumerator, 24, 'new projects default to 24 fps');
equal(defaults.video.frameRule.stride, 17, 'new projects use the H3 stride');
equal(defaults.video.frameRule.offset, 5, 'new projects use the H3 remainder');

[[1, 5], [5, 5], [6, 22], [22, 22], [23, 39], [233, 243]].forEach(([desired, expected]) => {
  equal(MSE.frames.renderFramesFor(desired), expected, `${desired} advances to legal frame ${expected}`);
  equal(MSE.frames.renderFramesFor(desired) % 17, 5, `${expected} satisfies frameCount % 17 = 5`);
});

const legacyVideo = { fpsNumerator: 25, fpsDenominator: 1, frameRule: { stride: 8, offset: 1 } };
const calculation = MSE.frames.frameCalc(1, legacyVideo);
equal(calculation.cutFrames, 25, 'editorial cut keeps the project frame rate');
equal(calculation.renderFrames, 39, 'legacy rule cannot bypass the H3 lattice');
equal(calculation.renderFps, 24, 'render timing uses H3 fixed 24 fps');

const projectSource = fs.readFileSync(path.join(JS_DIR, 'project.js'), 'utf8');
const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
equal(projectSource.includes('frameRule: { stride: 17, offset: 5 }'), true, 'project loading migrates legacy rules');
equal(projectSource.includes('renderFps: calc.renderFps'), true, 'shot export records the fixed H3 render clock');
equal(projectSource.includes('renderDurationSeconds: calc.renderFrames / calc.renderFps'), true, 'shot export records the actual H3 duration');
equal(html.includes('>17n+5</option>'), true, 'settings show the fixed H3 rule');
equal(html.includes('>4n+1</option>') || html.includes('>8n+1</option>'), false, 'settings expose no incompatible rule');

if (failures) process.exitCode = 1;
else console.log('\nAll H3 frame-lattice checks passed.');
