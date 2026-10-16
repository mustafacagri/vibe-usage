'use strict';
const { isProviderId } = require('./catalog.cjs');
const { AppError, toErrorPayload } = require('./core/errors.cjs');

// Privileged calls are accepted only from the app's own top-level page.
function assertSender(event, expectedUrl) {
  if (event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== expectedUrl) throw new AppError('sender_rejected');
}

function validateRefresh(value) {
  if (value !== undefined && !isProviderId(value)) throw new AppError('invalid_provider');
  return value;
}

// Every IPC result is an envelope so that error codes survive the process boundary;
// the preload script unwraps it back into a resolved value or a thrown error.
function envelope(promise) {
  return Promise.resolve(promise).then(value => ({ ok: true, value }), error => ({ ok: false, error: toErrorPayload(error) }));
}

module.exports = { assertSender, validateRefresh, envelope };
