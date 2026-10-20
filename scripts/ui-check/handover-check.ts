// Exercise the real renderer and preload with delayed IPC replies. No provider is launched.
import assert from 'node:assert/strict';
import { ipcMain } from 'electron';
import { envelope } from '../../src/main/ipc-policy.ts';
import { IPC_PREFIX, type HandoverPreview, type HandoverRequest } from '../../src/shared/ipc.ts';
import { openFixtureWindow, quiet, run } from '../fixture-app.ts';
import { sessions } from './fixture.ts';

export async function checkHandoverOrdering(): Promise<void> {
  const base = sessions()[0];
  assert.ok(base);
  const listed = [
    { ...base, source: { id: 'profile-a', version: 'version-a', accountId: 'claude:a' } },
    { ...base, source: { id: 'profile-b', version: 'version-b', accountId: 'claude:b' } }
  ];
  type Pending = { request: HandoverRequest } & ReturnType<typeof Promise.withResolvers<HandoverPreview>>;
  let received = Promise.withResolvers<Pending>();
  const executed: HandoverRequest[] = [];
  for (const channel of ['listSessions', 'previewHandover', 'executeHandover']) ipcMain.removeHandler(`${IPC_PREFIX}${channel}`);
  ipcMain.handle(`${IPC_PREFIX}listSessions`, () => envelope(() => listed));
  ipcMain.handle(`${IPC_PREFIX}previewHandover`, (_event, request: HandoverRequest) => {
    const pending = { request, ...Promise.withResolvers<HandoverPreview>() };
    received.resolve(pending);
    received = Promise.withResolvers<Pending>();
    return envelope(() => pending.promise);
  });
  ipcMain.handle(`${IPC_PREFIX}executeHandover`, (_event, request: HandoverRequest) =>
    envelope(() => {
      executed.push(request);
      return { from: 'claude', to: request.toProvider, model: null, mode: 'terminal' };
    })
  );
  const win = await openFixtureWindow(430, 900);
  const click = (selector: string) => run(win, `document.querySelector(${JSON.stringify(selector)}).click()`);
  const choose = (selector: string, value: string) =>
    run(
      win,
      `(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    control.value = ${JSON.stringify(value)};
    control.dispatchEvent(new Event('change', { bubbles: true }));
  })()`
    );
  const requestPreview = async (): Promise<Pending> => {
    const promise = received.promise;
    await click('#handover-preview-btn');
    return promise;
  };
  const preview = (request: HandoverRequest, brief: string): HandoverPreview => ({
    from: 'claude',
    to: request.toProvider === 'auto' ? 'codex' : request.toProvider,
    model: null,
    sessionId: base.id,
    sessionProvider: 'claude',
    sessionSource: { id: 'profile-b', version: 'reviewed-version', accountId: 'claude:b' },
    brief
  });
  const disabled = () => run(win, "document.querySelector('#handover-execute-btn').disabled");
  try {
    await quiet(win);
    await click('#handover-btn');
    await quiet(win);
    assert.deepEqual(await run(win, "[...document.querySelector('#handover-session-select').options].map(o => o.value)"), [
      'auto',
      'profile-a',
      'profile-b'
    ]);
    await choose('#handover-session-select', 'profile-b');
    await quiet(win);
    const stale = await requestPreview();
    assert.deepEqual(stale.request.sessionSource, listed[1]?.source, 'same logical session id retains its selected physical source');
    await choose('#handover-to', 'cursor');
    await quiet(win);
    stale.resolve(preview(stale.request, 'STALE BRIEF'));
    await quiet(win);
    assert.equal(await disabled(), true, 'a late response cannot enable execution for another target');
    await click('#handover-execute-btn');
    assert.equal(executed.length, 0);

    const first = await requestPreview();
    const latest = await requestPreview();
    latest.resolve(preview(latest.request, 'CURRENT BRIEF'));
    await quiet(win);
    first.resolve(preview(first.request, 'OLDER BRIEF'));
    await quiet(win);
    assert.equal(await run(win, "document.querySelector('#handover-preview').textContent"), 'CURRENT BRIEF');
    assert.equal(await disabled(), false);
    await click('#handover-execute-btn');
    await quiet(win);
    assert.equal(executed.length, 1);
    const execution = executed[0];
    assert.ok(execution);
    assert.equal(execution.toProvider, 'cursor');
    assert.deepEqual(execution.sessionSource, preview(latest.request, '').sessionSource, 'execution pins the reviewed version');

    await click('#handover-btn');
    await quiet(win);
    const closed = await requestPreview();
    await click('#handover-cancel-btn');
    await quiet(win);
    await click('#handover-btn');
    await quiet(win);
    closed.resolve(preview(closed.request, 'CLOSED BRIEF'));
    await quiet(win);
    assert.equal(await disabled(), true, 'a closed dialog cannot populate a reopened dialog');
    const oldError = await requestPreview();
    await choose('#handover-to', 'antigravity');
    await quiet(win);
    const toastBefore = await run(win, "document.querySelector('#toast').textContent");
    oldError.reject(new Error('stale failure'));
    await quiet(win);
    assert.equal(await run(win, "document.querySelector('#toast').textContent"), toastBefore, 'stale failures stay out of the new form');
    assert.equal(await disabled(), true);
    const empty = await requestPreview();
    empty.resolve({ from: null, to: 'antigravity', model: null, sessionId: null, sessionProvider: null, brief: 'NO SESSION' });
    await quiet(win);
    await click('#handover-execute-btn');
    await quiet(win);
    assert.equal(executed.length, 2);
    assert.equal(executed[1]?.sessionSource, null, 'an empty preview cannot silently select a later session');
  } finally {
    win.destroy();
  }
}
