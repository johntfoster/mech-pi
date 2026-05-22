#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
console.log('mech-pi demo package');
console.log('====================');
console.log('Install: pi install ' + root);
console.log('One-shot: pi -e ' + root);
console.log('');
console.log('Resources:');
for (const p of ['extensions/mech-pi.ts', 'skills/mechanics-research/SKILL.md', 'prompts/interrogate-mechanics.md', 'demo/DEMO.md']) {
  console.log(`- ${p} ${fs.existsSync(path.join(root, p)) ? '✓' : '✗'}`);
}
console.log('');
console.log('Try in a LaTeX repo: /mechmap, then ask “focus equation eq:...”.');
