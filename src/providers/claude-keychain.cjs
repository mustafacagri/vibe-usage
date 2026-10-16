'use strict';
const crypto = require('node:crypto');
const common = require('./common.cjs');

// Selector semantics verified against quota-axi's own implementation:
// https://github.com/kunchenguid/quota-axi/blob/main/src/lib/claude-profile.ts
// claudeProfileLocations/suffixedKeychainService. Also observed upstream in
// https://github.com/anthropics/claude-code/issues/92252 and #79223.
// These are explicit raw selectors, not resolved filesystem paths. An explicitly
// supplied default directory is a different Keychain item from an unset selector.
function resolveClaudeKeychainService({ configDir, configDirExplicit = false, secureStorageConfigDir } = {}) {
  const selected = secureStorageConfigDir || (configDirExplicit ? configDir : undefined);
  if (selected === undefined || selected === '') return 'Claude Code-credentials';
  if (typeof selected !== 'string' || selected.length > 1024 || /[\x00-\x1f\x7f]/.test(selected)) throw new common.ProviderError('unsupported_profile');
  const suffix = crypto.createHash('sha256').update(selected.normalize('NFC')).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
}
async function readClaudeKeychain(options = {}) {
  if ((options.platform || process.platform) !== 'darwin') throw new common.ProviderError('unsupported_platform');
  const service = resolveClaudeKeychainService(options);
  try {
    const output = await (options.runProcess || common.runProcess)('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { timeoutMs: 8000, maxBytes: 1024 * 1024 });
    const credentials = JSON.parse(output);
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) || typeof credentials.claudeAiOauth?.accessToken !== 'string' || !credentials.claudeAiOauth.accessToken.trim()) throw new Error();
    return credentials;
  } catch { throw new common.ProviderError('keychain_unavailable'); }
}
module.exports = { resolveClaudeKeychainService, readClaudeKeychain };
