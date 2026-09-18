// Static contract for export completion actions.
// Run with: node frontend/tests/taskPanelContract.test.js
'use strict';

const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(FRONTEND, 'css', 'style.css'), 'utf8');
const panel = fs.readFileSync(path.join(FRONTEND, 'js', 'taskPanel.js'), 'utf8');
let failures = 0;

function assert(condition, label) {
  if (condition) console.log(`ok - ${label}`);
  else {
    failures += 1;
    console.error(`FAIL: ${label}`);
  }
}

assert(html.includes('id="task-panel-copy-path"'), 'task panel exposes the optional copy-path action');
assert(html.includes('id="task-panel-actions"') && html.includes('task-panel-actions" hidden'), 'copy action starts hidden');
assert(panel.includes("exportPath = result.result.exportPath || ''"), 'completion uses the backend-native export path');
assert(panel.includes('navigator.clipboard.writeText(text)'), 'secure contexts use the Clipboard API');
assert(panel.includes("document.execCommand('copy')"), 'non-secure local contexts have a copy fallback');
assert(panel.includes("el.cancelBtn.textContent = 'Close'"), 'completed exports remain dismissible');
const completionBlock = panel.slice(panel.indexOf('const result ='), panel.indexOf('} catch (err)'));
assert(!completionBlock.includes('hidePanelAfterDelay'), 'successful export remains visible for optional path copying');
assert(css.includes('.task-panel-actions[hidden]'), 'hidden copy actions do not consume panel space');

if (failures) {
  console.error(`\n${failures} task-panel contract test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll task-panel export completion checks passed.');
}
