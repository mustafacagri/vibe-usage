// A separate application process for the shared settings protocol tests. No real providers.
import { createService } from '../../src/core/service.ts';
import { transactSettings } from '../../src/core/settings.ts';
import { isObject } from '../../src/core/files.ts';
import type { Account } from '../../src/shared/types.ts';

const file = process.argv[2];
if (!file) throw new Error('settings path required');
let accounts: Account[] = [{ id: 'claude:main', providerId: 'claude', primary: true, enabled: true }];
const service = await createService({
  settingsPath: file,
  providers: [{ id: 'claude', discover: () => Promise.resolve(accounts), fetch: () => Promise.resolve({ windows: [] }) }]
});
let release: (() => void) | undefined;
process.on('message', (message: unknown) => {
  if (!isObject(message)) return;
  if (message.command === 'release') {
    release?.();
    return;
  }
  void (async () => {
    if (message.command === 'discover') {
      accounts = [...accounts, { id: 'claude:spare', providerId: 'claude', primary: false, enabled: true }];
      await service.reconcileDiscovery();
    } else if (message.command === 'hold') {
      await transactSettings(file, async transaction => {
        await new Promise<void>(resolve => {
          release = resolve;
          process.send?.({ event: 'locked' });
        });
        await transaction.save({ ...transaction.settings, language: 'tr' });
      });
    }
    process.send?.({ event: 'done' });
  })().catch(() => process.send?.({ event: 'failed' }));
});
process.send?.({ event: 'ready' });
