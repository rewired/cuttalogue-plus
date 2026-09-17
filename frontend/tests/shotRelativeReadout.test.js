// Regression coverage for the header/playhead shot-relative readout.
// Run with: node frontend/tests/shotRelativeReadout.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS_DIR = path.join(__dirname, '..', 'js');
function load(fileName) {
  const filePath = path.join(JS_DIR, fileName);
  vm.runInThisContext(fs.readFileSync(filePath, 'utf8'), { filename: filePath });
}

global.window = global;
global.MSE = undefined;
global.addEventListener = () => {};
global.document = {
  addEventListener() {},
  querySelector() { return null; },
  body: { classList: { toggle() {} } },
};
global.localStorage = { getItem() { return null; }, setItem() {} };
global.requestAnimationFrame = () => 1;
global.cancelAnimationFrame = () => {};
global.WaveSurfer = {};

load('format.js');
load('musicalGrid.js');
load('frameMath.js');
load('state.js');
load('shots.js');

MSE.silence = {};
MSE.laneWidget = {};
MSE.contextMenu = {};
load('waveformSync.js');

const { state } = MSE.state;
const { shotRelativeLabel } = MSE.sync;
state.tempo = { bpm: 120, numerator: 4, denominator: 4, gridOffsetSeconds: 7.25, gridDivision: 'bar' };
state.shots = [
  { id: 1, startSeconds: 10, endSeconds: 12 },
  { id: 2, startSeconds: 12, endSeconds: 16 },
];

let failures = 0;
function equal(actual, expected, label) {
  if (actual === expected) console.log(`ok - ${label}`);
  else {
    failures += 1;
    console.error(`FAIL: ${label}; expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

equal(shotRelativeLabel(9.999), null, 'readout is absent in a gap');
equal(shotRelativeLabel(10), 'Clip +00:00.000 · Beat +0.0.0.000', 'shot start is zero-relative');
equal(shotRelativeLabel(11.25), 'Clip +00:01.250 · Beat +0.2.2.000', 'elapsed time and beats advance from the shot start');
equal(shotRelativeLabel(12), 'Clip +00:00.000 · Beat +0.0.0.000', 'shared boundary belongs to the following shot');
equal(shotRelativeLabel(16), null, 'shot end is exclusive');

if (failures) process.exitCode = 1;
else console.log('\nAll shot-relative readout checks passed.');
