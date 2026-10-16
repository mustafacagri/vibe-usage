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
// into "Error invoking remote method …" strings and drop the code. Anything that is not an
// AppError is an internal fault; its message is never exposed.
function toErrorPayload(error) {
  return error instanceof AppError ? { code: error.code, params: error.params } : { code: UNEXPECTED, params: {} };
}

module.exports = { AppError, toErrorPayload };
