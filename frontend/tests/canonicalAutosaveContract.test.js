// Static integration contract for canonical browser autosave and MCP handoff.
'use strict';

const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..');
const ROOT = path.join(FRONTEND, '..');
const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
const project = fs.readFileSync(path.join(FRONTEND, 'js', 'project.js'), 'utf8');
const api = fs.readFileSync(path.join(FRONTEND, 'js', 'api.js'), 'utf8');
const main = fs.readFileSync(path.join(FRONTEND, 'js', 'main.js'), 'utf8');
const live = fs.readFileSync(path.join(FRONTEND, 'js', 'mcpLive.js'), 'utf8');
const backend = fs.readFileSync(path.join(ROOT, 'backend', 'app', 'projects.py'), 'utf8');
const legacyDraft = fs.readFileSync(path.join(ROOT, 'backend', 'app', 'draft.py'), 'utf8');
const activity = fs.readFileSync(path.join(ROOT, 'backend', 'app', 'live_activity.py'), 'utf8');
let failures = 0;

function assert(condition, label) {
  if (condition) console.log(`ok - ${label}`);
  else {
    failures += 1;
    console.error(`FAIL: ${label}`);
  }
}

assert(html.includes('id="autosave-status"'), 'header exposes a persistent autosave status');
assert(html.includes('>Save now</button>'), 'manual save is an optional immediate flush');
assert(project.includes('AUTOSAVE_DEBOUNCE_MS'), 'browser changes use a short debounce');
assert(project.includes('saveInFlight'), 'autosaves are serialized');
assert(project.includes('api.autosaveProject(projectId, payload, expectedRevision)'), 'autosave sends the exact expected revision');
assert(project.includes("emitSaveState('saving')") && project.includes("emitSaveState('saved')"), 'autosave emits visible lifecycle states');
assert(project.includes('document.addEventListener(\'input\', noteLocalChange, true)'), 'typing marks the project pending immediately');
assert(project.includes('setInterval(pollForChanges, AUTOSAVE_POLL_MS)'), 'polling still captures programmatic mutations');
assert(!project.includes('api.putDraft('), 'normal browser edits no longer write a parallel draft');
assert(!legacyDraft.includes('@router.put'), 'legacy draft recovery is no longer a writable API');
assert(api.includes('/autosave') && api.includes('expectedRevision'), 'frontend uses the canonical autosave endpoint');
assert(backend.includes('repository.write(project_id, project, expected_revision)'), 'backend autosave is atomic and revision guarded');
assert(live.includes('MSE.project.isSynced()'), 'MCP handshake reports only fully synced browser state');
assert(!live.includes('renderDirtyConflict'), 'manual live-update pause modal is removed');
assert(activity.includes('BROWSER_SYNC_WAIT_SECONDS') && activity.includes('browser["ready"]'), 'MCP automatically waits for a short in-flight autosave');
assert(main.includes("'Save failed — retrying'"), 'autosave failures are visible and automatically retried');

if (failures) {
  console.error(`\n${failures} canonical autosave contract test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll canonical autosave contract tests passed.');
}

