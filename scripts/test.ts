// Pass file names directly to Node: shell glob quoting differs on Windows and POSIX.
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';

const coverage = process.argv.includes('--coverage');
const patterns = process.argv.slice(2).filter(arg => arg !== '--coverage');
// A pattern that matches nothing is a typo, not an empty selection: it fails the run.
const matches = (patterns.length ? patterns : ['test/**/*.test.ts']).map(pattern => ({ pattern, files: globSync(pattern) }));
const unmatched = matches.filter(m => !m.files.length).map(m => m.pattern);
if (unmatched.length) throw new Error(`No test files matched ${unmatched.join(', ')}`);
const files = [...new Set(matches.flatMap(m => m.files))];
const result = spawnSync(
  process.execPath,
  [
    '--test',
    '--test-reporter=tap',
    ...(coverage
      ? [
          '--experimental-test-coverage',
          '--test-coverage-include=src/**',
          // Static translations are validated for key/placeholder parity, not counted as
          // executable behavior. Renderer/startup behavior has a separate Electron UI gate.
          '--test-coverage-exclude=src/shared/i18n/locales/**',
          '--test-coverage-lines=95',
          '--test-coverage-branches=85',
          '--test-coverage-functions=90'
        ]
      : []),
    ...files
  ],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
);
if (result.error) throw result.error;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (!/^# tests [1-9]\d*$/m.test(result.stdout)) throw new Error('No tests ran');
process.exitCode = result.status ?? 1;
