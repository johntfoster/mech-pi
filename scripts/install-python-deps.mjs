#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const venv = path.join(root, '.mechpi-python');
const python = process.env.PYTHON || process.env.PYTHON3 || 'python3';
const venvPython = process.platform === 'win32'
  ? path.join(venv, 'Scripts', 'python.exe')
  : path.join(venv, 'bin', 'python');

function run(cmd, args, opts = {}) {
  console.log(`[mech-pi] ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (/^(1|true|yes|on)$/i.test(process.env.MECHPI_SKIP_PYTHON_DEPS ?? '')) {
  console.log('[mech-pi] Skipping Python dependency installation because MECHPI_SKIP_PYTHON_DEPS is set.');
  process.exit(0);
}

if (!existsSync(venvPython)) {
  run(python, ['-m', 'venv', venv]);
}

run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel', 'setuptools']);
run(venvPython, ['-m', 'pip', 'install', 'sentence-transformers']);

console.log(`[mech-pi] Python embedding dependencies installed in ${venv}`);
console.log('[mech-pi] mech-pi will use this environment automatically; override with MECHPI_PYTHON if needed.');
