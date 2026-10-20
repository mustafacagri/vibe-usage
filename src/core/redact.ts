// Removes recognizable credentials from text the app passes on to another tool (a handover
// brief). Known token shapes and explicitly sensitive field names are recognized. Unknown
// secret shapes (for example a wallet's word list) still require the user's review.
export const REDACTED = '[REDACTED_SECRET]';
// A visible cue only; security decisions use RedactionResult.requiresReview, never matching
// this string. The transcript preserves that flag before clipping or repeated redaction.
export const SECRET_REVIEW_REQUIRED = '[SECRET_REVIEW_REQUIRED]';

// Names that always announce a credential in `name=value` or `"name": "value"` form, optionally
// prefixed (DB_PASSWORD, STRIPE_SECRET_KEY, config.secret_key_base). The name must end there:
// `max_tokens` is not one.
const SECRET_NAME = String.raw`\b([\w.-]*?(?:password|passwd|pwd|secret|token|credentials?|api[_-]?key|access[_-]?key|private[_-]?key|secret[_-]?key|key[_-]?base))\b`;
// Any other name ending in `key` (ENCRYPTION_KEY, signingKey) counts only with a value that
// looks generated, since `sortKey: "createdAt"` is not a secret.
const KEY_NAME = String.raw`\b([\w.-]*?key)\b`;
const GENERATED = (quote: string) => String.raw`(?=[^${quote}\s]*\d)(?=[^${quote}\s]*[A-Za-z])[^${quote}\s]{16,}`;
// A value in double, single or back quotes, which may contain escaped quotes.
const quoted = (body: (quote: string) => string) => ['"', "'", '`'].map(quote => String.raw`${quote}${body(quote)}${quote}`).join('|');
// The end of an unquoted value.
const UNQUOTED_END = String.raw`(?=$|[\s"'\`,;&)}\]])`;
const NAMED_VALUE = new RegExp(String.raw`${SECRET_NAME}(["'\`]?[ \t]*[:=][ \t]*)`, 'gi');
const CLI_VALUE = /(?<!\w)--(?:password|passwd|pwd|secret|token|api[-_]key|access[-_]key|private[-_]key)(?:=|[ \t]+)/gi;
const MAX_VALUE_SCAN = 64 * 1024;

type Replacement = string | ((match: string, ...groups: string[]) => string);

// Keeps the name, the separator and the quotes; only the value goes.
const keepQuotes = (_match: string, name: string, separator: string, value: string): string =>
  `${name}${separator}${value.charAt(0)}${REDACTED}${value.charAt(0)}`;

// Ordered: whole key blocks first, then token shapes, then values announced by their name.
const PATTERNS: readonly (readonly [RegExp, Replacement])[] = [
  // PEM and PGP private keys. An unterminated block (a clipped message) is redacted to the end.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, REDACTED],
  // OpenAI (sk-, sk-proj-) and Anthropic (sk-ant-) API keys.
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  // Stripe secret and restricted keys.
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED],
  // GitHub personal, OAuth, app and refresh tokens, and fine-grained tokens.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  // GitLab personal access tokens, npm and Hugging Face tokens.
  [/\b(?:glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,})/g, REDACTED],
  // AWS access key ids (long-term and temporary).
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  // Slack bot, user, app and refresh tokens.
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  // Google API keys and OAuth access tokens.
  [/\b(?:AIza[0-9A-Za-z_-]{35}|ya29\.[A-Za-z0-9_-]{20,})/g, REDACTED],
  // JSON Web Tokens: two base64url JSON segments (`{"` encodes as `eyJ`) and a signature.
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Any credential in an Authorization header (also as a JSON field), whatever its length.
  [/(\bAuthorization["']?\s*:\s*["']?(?:Bearer|Basic|token)\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`],
  // A bearer token elsewhere is recognized by its length: "Bearer" alone is an ordinary word.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, `Bearer ${REDACTED}`],
  // The password in a URL's user info (postgres://user:password@host), up to the last `@`
  // before the host, since a password may contain one.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/]*@/gi, `$1${REDACTED}@`],
  // Less explicit names such as sortKey need a generated-looking value. Strong credential
  // names below do not depend on entropy, length or a mixture of letters and numbers.
  [new RegExp(String.raw`${KEY_NAME}(["'\`]?\s*[:=]\s*)(${quoted(GENERATED)})`, 'gi'), keepQuotes],
  [new RegExp(String.raw`${KEY_NAME}(\s*[:=]\s*)${GENERATED(String.raw`"'\`,;&(){}<>[\]`)}${UNQUOTED_END}`, 'gi'), `$1$2${REDACTED}`]
];

interface SecretValue {
  end: number;
  replacement: string;
  requiresReview?: boolean;
}

// Read a quoted/flow value with a bounded linear scan. On incomplete syntax, remove the
// remainder and require review rather than leave a possible continuation in the brief.
function delimitedValue(text: string, start: number): SecretValue {
  const first = text[start];
  const quotedValue = first === '"' || first === "'" || first === '`';
  const stack = quotedValue ? [] : [first === '{' ? '}' : first === '[' ? ']' : ')'];
  let quote = quotedValue ? first : '';
  const limit = Math.min(text.length, start + MAX_VALUE_SCAN);
  for (let index = start + 1; index < limit; index++) {
    const char = text[index];
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote) {
        // YAML escapes a single quote by doubling it.
        if (quote === "'" && text[index + 1] === "'") index++;
        else if (quotedValue) return { end: index + 1, replacement: `${first}${REDACTED}${first}` };
        else quote = '';
      }
    } else if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '{' || char === '[' || char === '(') stack.push(char === '{' ? '}' : char === '[' ? ']' : ')');
    else if (char === '}' || char === ']' || char === ')') {
      if (stack.pop() !== char) break;
      if (!stack.length) return { end: index + 1, replacement: REDACTED };
    }
  }
  return { end: text.length, replacement: `${REDACTED} ${SECRET_REVIEW_REQUIRED}`, requiresReview: true };
}

function indentedValue(text: string, fieldStart: number, valueStart: number): SecretValue | null {
  const lineStart = text.lastIndexOf('\n', fieldStart - 1) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart))?.[0].length ?? 0;
  const firstEnd = text.indexOf('\n', valueStart);
  if (firstEnd < 0) return null;
  let end = firstEnd;
  let cursor = firstEnd + 1;
  let body = false;
  while (cursor < text.length) {
    const next = text.indexOf('\n', cursor);
    const lineEnd = next < 0 ? text.length : next;
    const line = text.slice(cursor, lineEnd);
    if (line.trim() && (/^[ \t]*/.exec(line)?.[0].length ?? 0) <= indent) break;
    if (line.trim()) body = true;
    end = lineEnd;
    cursor = lineEnd + 1;
  }
  return body ? { end, replacement: REDACTED } : null;
}

function secretValue(text: string, fieldStart: number, start: number, colon: boolean): SecretValue | null {
  const char = text[start];
  if (char === undefined) return null;
  if (char === '"' || char === "'" || char === '`' || char === '{' || char === '[' || char === '(') return delimitedValue(text, start);
  if (colon && (char === '|' || char === '>' || char === '\n' || char === '\r')) {
    const block = indentedValue(text, fieldStart, start);
    if (block) return block;
    if (char === '|' || char === '>')
      return { end: text.length, replacement: `${REDACTED} ${SECRET_REVIEW_REQUIRED}`, requiresReview: true };
    return null;
  }
  const call = /^[\w.$]+[ \t]*\(/.exec(text.slice(start));
  if (call) return delimitedValue(text, start + call[0].lastIndexOf('('));
  if (colon) {
    const lineStart = text.lastIndexOf('\n', fieldStart - 1) + 1;
    if (/^[ \t]*(?:- )?["']?$/.test(text.slice(lineStart, fieldStart))) {
      const continuation = indentedValue(text, fieldStart, start);
      if (continuation) return continuation;
    }
  }
  // YAML's plain scalar can contain spaces; assignment/CLI values stop at whitespace.
  const value = (colon ? /^[^\r\n,;)}\]&#]+/ : /^[^\s"'`,;&(){}<>[\]]+/).exec(text.slice(start))?.[0];
  if (!value) return null;
  const keptSpace = /[ \t]+$/.exec(value)?.[0] ?? '';
  return { end: start + value.length, replacement: `${REDACTED}${keptSpace}` };
}

function redactNamedValues(text: string, review: () => void): string {
  let result = '';
  let cursor = 0;
  for (const match of text.matchAll(NAMED_VALUE)) {
    if (match.index < cursor) continue;
    const start = match.index + match[0].length;
    const separator = match[2] ?? '';
    const value = secretValue(text, match.index, start, separator.includes(':'));
    if (!value) continue;
    if (value.requiresReview) review();
    result += text.slice(cursor, start) + value.replacement;
    cursor = value.end;
  }
  return result + text.slice(cursor);
}

function redactCliValues(text: string, review: () => void): string {
  let result = '';
  let cursor = 0;
  for (const match of text.matchAll(CLI_VALUE)) {
    if (match.index < cursor) continue;
    const start = match.index + match[0].length;
    const value = secretValue(text, match.index, start, false);
    if (!value) continue;
    if (value.requiresReview) review();
    result += text.slice(cursor, start) + value.replacement;
    cursor = value.end;
  }
  return result + text.slice(cursor);
}

export interface RedactionResult {
  text: string;
  requiresReview: boolean;
}

export function redactSecretsWithReview(text: string): RedactionResult {
  let requiresReview = false;
  const review = (): void => {
    requiresReview = true;
  };
  const shaped = PATTERNS.reduce(
    (result, [pattern, replacement]) =>
      typeof replacement === 'string' ? result.replace(pattern, replacement) : result.replace(pattern, replacement),
    text
  );
  return { text: redactCliValues(redactNamedValues(shaped, review), review), requiresReview };
}

export function redactSecrets(text: string): string {
  return redactSecretsWithReview(text).text;
}
