import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePackage } from './validate-package.mjs';
test('release rejects missing imports and local-only prototypes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-package-test-'));
  try {
    fs.mkdirSync(path.join(root, 'modules'));
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ background: { service_worker: 'app.js' } }));
    fs.writeFileSync(path.join(root, 'app.js'), 'import modules from "./modules/_registry.js";');
    fs.writeFileSync(path.join(root, 'modules/_registry.js'), 'export default [];');
    assert.deepEqual(validatePackage(root), []);
    fs.writeFileSync(path.join(root, 'modules/_registry.js'), 'import x from "./missing.js";');
    assert.ok(validatePackage(root).some(x => x.includes('Missing runtime file')));
    fs.writeFileSync(path.join(root, 'modules/_registry.js'), 'import incidentintake from "./incidentintake/module.js";');
    assert.ok(validatePackage(root).some(x => x.includes('Local-only')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
