// Static integration contract for observable MCP edits in the open frontend.
// Run with: node frontend/tests/mcpLiveContract.test.js
'use strict';

const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(FRONTEND, 'css', 'style.css'), 'utf8');
const api = fs.readFileSync(path.join(FRONTEND, 'js', 'api.js'), 'utf8');
const project = fs.readFileSync(path.join(FRONTEND, 'js', 'project.js'), 'utf8');
const live = fs.readFileSync(path.join(FRONTEND, 'js', 'mcpLive.js'), 'utf8');
let failures = 0;

function assert(condition, label) {
  if (condition) console.log(`ok - ${label}`);
  else {
    failures += 1;
    console.error(`FAIL: ${label}`);
  }
}

[
  'mcp-live-modal', 'mcp-live-title', 'mcp-live-message', 'mcp-live-scope',
  'mcp-live-progress', 'mcp-live-progress-fill',
].forEach((id) => assert(html.includes(`id="${id}"`), `live modal contains #${id}`));

const apiIndex = html.indexOf('js/api.js');
const projectIndex = html.indexOf('js/project.js');
const liveIndex = html.indexOf('js/mcpLive.js');
const mainIndex = html.indexOf('js/main.js');
assert(apiIndex >= 0 && projectIndex > apiIndex && liveIndex > projectIndex && mainIndex > liveIndex, 'live controller loads after API/project and before app initialization');
assert(api.includes('/api/projects/${id}/live'), 'frontend API reads the project live-state endpoint');
assert(live.includes('POLL_INTERVAL_MS = 750'), 'live revisions are observed with a sub-second polling interval');
assert(live.includes('MSE.project.isDirty()'), 'live updates guard unsaved browser state');
assert(live.includes('MSE.project.applyLiveProject(project)'), 'revision changes apply through the dedicated live project path');
assert(live.includes('activity.progressPercent'), 'agent progress is rendered in the wait modal');

const liveApply = project.slice(project.indexOf('function applyLiveProject'), project.indexOf('function autoLoadAudioFromBackend'));
assert(liveApply.includes("emit('shots-changed', { reason: 'mcp-live' })"), 'live apply refreshes shot workspaces');
assert(liveApply.includes("emit('scenes-changed', { reason: 'mcp-live' })"), 'live apply refreshes scene and camera workspaces');
assert(!liveApply.includes('resetState(') && !liveApply.includes("emit('project-loaded')"), 'live apply preserves shot selection and an open camera preview');
assert(liveApply.includes('deleteDraft(projectId)'), 'live apply removes a stale pre-MCP browser draft');

assert(css.includes('.mcp-live-overlay') && css.includes('z-index: 80'), 'wait modal stays above existing editor modals');
assert(css.includes('color: var(--accent)'), 'wait modal uses the CUTTAlogue accent token');

if (failures) {
  console.error(`\n${failures} MCP live contract test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll MCP live frontend contract tests passed.');
}
