import type { ErrorCode, ErrorPayload, ProviderErrorCode } from '../shared/types.ts';

type Params = Readonly<Record<string, string>>;

// A failure the user can act on. `code` maps to an i18n message; the main process and the
// CLI translate it, so no layer below them produces display text.
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly params: Params;

  constructor(code: ErrorCode, params: Params = {}, options?: ErrorOptions) {
    super(code, options);
    this.name = 'AppError';
    this.code = code;
    this.params = params;
  }
}

const RETRY_AFTER_BOUNDS_SECONDS = { min: 60, max: 900 };

// A failed quota read. `retryAfterSeconds` is the server's back-off hint, kept within bounds.
export class ProviderError extends AppError {
  declare readonly code: ProviderErrorCode;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ProviderErrorCode, { retryAfterSeconds, cause }: { retryAfterSeconds?: number; cause?: unknown } = {}) {
    super(code, {}, cause === undefined ? undefined : { cause });
    this.name = 'ProviderError';
    this.retryAfterSeconds =
      retryAfterSeconds === undefined
        ? undefined
        : Math.max(
            RETRY_AFTER_BOUNDS_SECONDS.min,
            Math.min(RETRY_AFTER_BOUNDS_SECONDS.max, Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 0)
          );
  }
}

// Settings that do not match the schema. `reason` names the rule, for logs and tests.
export class InvalidSettingsError extends AppError {
  readonly reason: string;

  constructor(reason: string) {
    super('invalid_settings');
    this.name = 'InvalidSettingsError';
    this.reason = reason;
    this.message = `invalid_settings: ${reason}`;
  }
}

// The code a failed read is reported with; anything but a ProviderError is internal.
export function providerErrorCode(error: unknown): ProviderErrorCode {
  return error instanceof ProviderError ? error.code : 'provider_failed';
}

// Errors cross the IPC boundary as plain data: Electron would otherwise flatten them into
// "Error invoking remote method …" strings and drop the code. Anything that is not an
// AppError is an internal fault; its message is never exposed.
export function toErrorPayload(error: unknown): ErrorPayload {
  return error instanceof AppError ? { code: error.code, params: error.params } : { code: 'unexpected', params: {} };
}
