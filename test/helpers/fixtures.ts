// Test fixtures mirroring the on-disk formats the providers really write (verified against
// local installs), at minimal size, plus builders for the app's own data.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { SpawnProcess } from '../../src/core/launch.ts';
import { normalizeWindow } from '../../src/core/model.ts';
import type { FetchResult } from '../../src/providers/types.ts';
import type { Account, MeasuredAccount, QuotaWindow } from '../../src/shared/types.ts';

export function account(fields: Partial<Account> = {}): Account {
  return { id: 'claude:a', providerId: 'claude', labelKey: 'defaultAccount', primary: true, enabled: true, ...fields };
}

export function quotaWindow(fields: Partial<QuotaWindow> = {}): QuotaWindow {
  return { id: 'w', usedPercent: null, remainingPercent: null, resetsAt: null, ...fields };
}

export function measuredAccount(fields: Partial<MeasuredAccount> = {}): MeasuredAccount {
  return { ...account(), status: 'ok', windows: [], ...fields };
}

// An adapter's windows as the service stores them.
export const windowsOf = (result: FetchResult): QuotaWindow[] => result.windows.map(window => normalizeWindow(window));

// A temporary directory removed when the test ends.
export async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

export function writeAntigravityDb(file: string, projectDir: string, modelName?: string): void {
  const uri = Buffer.from(pathToFileURL(path.resolve(projectDir)).href);
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE trajectory_metadata_blob (id TEXT DEFAULT "main", data BLOB, PRIMARY KEY (id)); CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (idx));'
  );
  db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run(
    'main',
    Buffer.concat([Buffer.from([0x0a, uri.length]), uri, Buffer.from([0x12, 0x02, 0x08, 0x01])])
  );
  if (modelName) {
    const name = Buffer.from(modelName);
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
      0,
      Buffer.concat([Buffer.from([0x0a, 0x01, 0x41, 0xaa, 0x01, name.length]), name])
    );
  }
  db.close();
}

// The readable transcript Antigravity keeps next to each conversation database.
export function writeAntigravityTranscript(home: string, id: string, prompts: string[], replies: string[] = []): void {
  const dir = path.join(home, '.gemini', 'antigravity-ide', 'brain', id, '.system_generated', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const lines = prompts.flatMap((content, i) => [
    { type: 'USER_INPUT', content },
    ...(replies[i] ? [{ type: 'PLANNER_RESPONSE', content: replies[i] }] : [])
  ]);
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), lines.map(line => JSON.stringify(line)).join('\n'));
}

interface Conversation {
  id: string;
  cwd: string;
  user?: string[];
  assistant?: string[];
}

export function codexRollout({
  id,
  cwd,
  source = 'vscode',
  model = 'gpt-6-luna',
  user = [],
  assistant = []
}: Conversation & { source?: unknown; model?: string }): string {
  const message = (role: string, type: string, text: string) => ({
    type: 'response_item',
    payload: { type: 'message', role, content: [{ type, text }] }
  });
  const lines = [
    { type: 'session_meta', payload: { session_id: id, id, cwd, source, base_instructions: { text: 'x'.repeat(200) } } },
    { type: 'turn_context', payload: { cwd, model } },
    message('user', 'input_text', `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>x</INSTRUCTIONS>`),
    message('user', 'input_text', '<environment_context>\n  <cwd>x</cwd>\n</environment_context>'),
    ...user.flatMap((prompt, i) => [
      message('user', 'input_text', prompt),
      ...(assistant[i] ? [message('assistant', 'output_text', assistant[i])] : [])
    ])
  ];
  return `${lines.map(line => JSON.stringify({ timestamp: '2026-10-16T10:00:00.000Z', ...line })).join('\n')}\n`;
}

export function writeCursorChat(chatsRoot: string, { id, cwd, name, user = [], assistant = [] }: Conversation & { name: string }): void {
  const dir = path.join(chatsRoot, 'a1b2c3', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ schemaVersion: 1, hasConversation: true, updatedAtMs: Date.now(), cwd }));
  const db = new DatabaseSync(path.join(dir, 'store.db'));
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);');
  db.prepare("INSERT INTO meta VALUES ('0', ?)").run(Buffer.from(JSON.stringify({ agentId: id, name })).toString('hex'));
  const put = (key: string, value: unknown): void => {
    db.prepare('INSERT INTO blobs VALUES (?, ?)').run(key, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
  };
  put('sys', { role: 'system', content: 'You are an AI coding assistant' });
  put('info', { role: 'user', content: `<user_info>\nWorkspace Path: ${cwd}\n</user_info>` });
  put('tree', '\x0a\x20internal-node');
  user.forEach((prompt, i) => {
    put(`u${i}`, { role: 'user', content: [{ type: 'text', text: `<user_query>\n${prompt}\n</user_query>` }] });
    const reply = assistant[i];
    if (reply)
      put(`a${i}`, {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '' },
          { type: 'text', text: reply }
        ]
      });
  });
  db.close();
}

// A spawn that records the command line and reports a successful start.
export function fakeSpawn(calls: string[][]): SpawnProcess {
  return (command, args) => {
    calls.push([command, ...args]);
    const child = new EventEmitter();
    setImmediate(() => child.emit('spawn'));
    return Object.assign(child, { unref: () => child });
  };
}
