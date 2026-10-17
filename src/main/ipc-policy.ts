// Rules every IPC call passes before it reaches a handler: who may call, and how results and
// errors cross the process boundary.
import { AppError, toErrorPayload } from '../core/errors.ts';
import { isObject, type JsonObject } from '../core/files.ts';
import { isProviderId, type ProviderId } from '../shared/catalog.ts';
import type { Envelope } from '../shared/ipc.ts';

interface Frame {
  url: string;
}

export interface Sender {
  senderFrame: Frame | null;
  sender: { mainFrame: Frame };
}

// Privileged calls are accepted only from the app's own top-level page.
export function assertSender(event: Sender, expectedUrl: string): void {
  if (event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== expectedUrl) throw new AppError('sender_rejected');
}

// Every result is an envelope so that error codes survive the hop; the preload script unwraps
// it back into a resolved value or a thrown error.
export async function envelope<T>(task: () => T): Promise<Envelope<Awaited<T>>> {
  try {
    return { ok: true, value: await task() };
  } catch (error) {
    return { ok: false, error: toErrorPayload(error) };
  }
}

// Arguments arrive from the renderer untyped; these narrow them or reject the call.
export function optionalProvider(value: unknown): ProviderId | undefined {
  if (value !== undefined && !isProviderId(value)) throw new AppError('invalid_provider');
  return value;
}

export function options(value: unknown): JsonObject {
  if (value === undefined) return {};
  if (!isObject(value)) throw new AppError('invalid_argument');
  return value;
}

export function optionalString(value: unknown): string | undefined {
  if (value !== undefined && typeof value !== 'string') throw new AppError('invalid_argument');
  return value;
}

export function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new AppError('invalid_argument');
  return value;
}
