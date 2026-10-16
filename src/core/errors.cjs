'use strict';

// A failure the user can act on. `code` maps to the i18n key `error_<code>`; the main
// process and the CLI translate it, so no layer below them produces display text.
class AppError extends Error {
  constructor(code, params = {}) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.params = params;
  }
}

const UNEXPECTED = 'unexpected';

// Errors cross the IPC boundary as plain data: Electron would otherwise flatten them
// into "Error invoking remote method …" strings and drop the code.
function toErrorPayload(error) {
  return typeof error?.code === 'string' && (error instanceof AppError || error.name === 'ProviderError')
    ? { code: error.code, params: error.params || {} }
    : { code: UNEXPECTED, params: {} };
}

module.exports = { AppError, toErrorPayload };
