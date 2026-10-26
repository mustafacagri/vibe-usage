// Failures the app did not foresee, and times its main thread was blocked. The window can only
// say that something went wrong, so the latest few are kept in memory for the diagnostics, which
// say what: the action, when, and the error's type and system codes (or how long the thread was
// blocked). Never an error's message, which may name folders or people.
import type { Fault } from '../shared/types.ts';
import { systemErrorCode } from './errors.ts';

const MAX_FAULTS = 10;
// Error names and system codes (TypeError, EPERM, spawn); nothing longer or freer than that.
const TOKEN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

// "Error EPERM spawn": the type, then the system code and call when the error carries them.
export function describeFault(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error value';
  const syscall = 'syscall' in error ? error.syscall : undefined;
  return [error.name, systemErrorCode(error), syscall]
    .filter((part): part is string => typeof part === 'string' && TOKEN.test(part))
    .join(' ');
}

// The main thread runs the window: blocked for 5 s, Windows reports the app as not responding.
export const MAIN_THREAD_ACTION = 'mainThread';

export interface FaultLog {
  record(action: string, error: unknown): void;
  // The main thread did not run for `ms`.
  stall(ms: number): void;
  // Newest first.
  list(): Fault[];
}

// A failure passed on through several handlers is kept once.
export function createFaultLog(clock: () => number = Date.now): FaultLog {
  const faults: Fault[] = [];
  const kept = new WeakSet<object>();
  const keep = (fault: Fault): void => {
    faults.unshift(fault);
    faults.length = Math.min(faults.length, MAX_FAULTS);
  };
  return {
    stall(ms) {
      keep({ at: clock(), action: MAIN_THREAD_ACTION, error: `blocked ${(ms / 1000).toFixed(1)} s` });
    },
    record(action, error) {
      if (typeof error === 'object' && error !== null) {
        if (kept.has(error)) return;
        kept.add(error);
      }
      keep({ at: clock(), action: TOKEN.test(action) ? action : 'unknown', error: describeFault(error) });
    },
    list: () => faults.map(fault => ({ ...fault }))
  };
}
