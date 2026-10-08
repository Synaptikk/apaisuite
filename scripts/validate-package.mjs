import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Modules that run on the owner's own unpacked install only and must never
// reach a distributed build; release.sh un-registers and deletes them in the
// staged copy, and this check fails the build if one slips through.
//   incidentintake — prototype, gitignored, needs a local helper
//   punchlookup    — one associate's punches + device GPS; owner's use only
export const LOCAL_ONLY_MODULES = ['incidentintake', 'punchlookup'];

export function validatePackage(root) {
  const errors = [];
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const registry = fs.readFileSync(path.join(root, 'modules/_registry.js'), 'utf8');
  for (const id of LOCAL_ONLY_MODULES) {
    if (new RegExp(`^\\s*(?:import\\s+${id}\\b|${id}\\s*,)`, 'm').test(registry)) errors.push(`Local-only ${id} is registered`);
    if (fs.existsSync(path.join(root, 'modules', id))) errors.push(`Local-only ${id} is packaged`);
  }
  const refs = [manifest.background.service_worker, ...Object.values(manifest.icons || {}),
    ...(manifest.content_scripts || []).flatMap(c => c.js || [])];
  const seen = new Set();
  function check(file) {
    const full = path.resolve(root, file);
    if (seen.has(full)) return;
    seen.add(full);
    if (!fs.existsSync(full)) { errors.push(`Missing runtime file: ${file}`); return; }
    if (!/\.(?:m?js)$/.test(full)) return;
    const source = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"']+)["']/g)) {
      check(path.relative(root, path.resolve(path.dirname(full), match[1])));
    }
  }
  for (const ref of [...refs, 'app.js']) check(ref);
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const errors = validatePackage(path.resolve(process.argv[2]));
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Runtime package dependencies verified.');
}
