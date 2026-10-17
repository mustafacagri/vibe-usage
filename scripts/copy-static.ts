// Copies the files the compiler does not emit (page, styles, launcher scripts) into build/.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATIC = ['ui/index.html', 'ui/style.css', 'launchers'];

for (const entry of STATIC) fs.cpSync(path.join(ROOT, 'src', entry), path.join(ROOT, 'build', entry), { recursive: true });
