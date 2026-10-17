// Builds the app into build/ from scratch, so the output of a removed or renamed source can
// never be packaged: compiles every project, then copies the files the compiler does not emit
// (page, styles, launcher scripts).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD = path.join(ROOT, 'build');
const STATIC = ['ui/index.html', 'ui/style.css', 'launchers'];
const TSC = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));

fs.rmSync(BUILD, { recursive: true, force: true });
execFileSync(process.execPath, [TSC, '--build'], { cwd: ROOT, stdio: 'inherit' });
for (const entry of STATIC) fs.cpSync(path.join(ROOT, 'src', entry), path.join(BUILD, entry), { recursive: true });
