'use strict';
// Reading data that other tools write (session transcripts, model caches, settings). It is
// read best effort: a missing, unreadable or malformed file counts as absent and never
// fails the caller, so one damaged session cannot hide all the others.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// Parsed records of a JSON Lines document; blank and malformed lines are skipped (the last
// line of a file another process is writing may be incomplete).
function* jsonLines(text) {
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      /* skip the malformed line */
    }
  }
}

// The first `bytes` of a file as text ('' when unreadable); a trailing partial line is
// dropped by jsonLines.
function readHeadSync(file, bytes) {
  return (
    attemptSync(() => {
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(bytes);
        return buffer.toString('utf8', 0, fs.readSync(fd, buffer, 0, bytes, 0));
      } finally {
        fs.closeSync(fd);
      }
    }) || ''
  );
}

// Files in `dir` with the given extension, newest first ([] when unreadable).
function newestFiles(dir, extension) {
  const names = attemptSync(() => fs.readdirSync(dir)) || [];
  return names
    .filter(name => name.endsWith(extension))
    .map(name => ({ file: path.join(dir, name), mtimeMs: attemptSync(() => fs.statSync(path.join(dir, name)).mtimeMs) || 0 }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(entry => entry.file);
}

function readJsonSync(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

// The task's result, or null if it throws.
async function attempt(task) {
  try {
    return await task();
  } catch {
    return null;
  }
}

function attemptSync(task) {
  try {
    return task();
  } catch {
    return null;
  }
}

module.exports = { jsonLines, readHeadSync, newestFiles, readJsonSync, readJson, attempt, attemptSync };
