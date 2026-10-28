'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const modules = ['config-storage.js', 'text-extraction.js', 'ai-images.js', 'ai-endpoints.js', 'ai-models.js', 'ai-adapter.js', 'ai-integration.js', 'chapter-logic.js', 'exam-logic.js', 'page-hooks.js', 'ui-panel.css'];

test('the installable artifact contains every tested source module without drift', () => {
  const artifact = fs.readFileSync(path.join(root, 'ai-course-helper.user.js'), 'utf8').replace(/\r\n/g, '\n');
  for (const filename of modules) {
    const source = fs.readFileSync(path.join(root, filename), 'utf8').replace(/\r\n/g, '\n').trim();
    assert.ok(artifact.includes(source), `${filename} is not the version embedded in the installable artifact`);
  }
  assert.doesNotMatch(artifact, /@ai-helper:|@AI_HELPER_VERSION@/);
});

test('a clean source-only directory builds the identical userscript without the original attachment', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'course-helper-build-'));
  try {
    for (const filename of [...modules, 'build_ai.py', 'userscript.template.js.in']) {
      fs.copyFileSync(path.join(root, filename), path.join(temporary, filename));
    }
    const result = spawnSync('python', [path.join(temporary, 'build_ai.py')], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.deepEqual(fs.readFileSync(path.join(temporary, 'ai-course-helper.user.js')), fs.readFileSync(path.join(root, 'ai-course-helper.user.js')));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
