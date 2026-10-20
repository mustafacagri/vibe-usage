import assert from 'node:assert/strict';
import test from 'node:test';
import { REDACTED, redactSecrets, redactSecretsWithReview, SECRET_REVIEW_REQUIRED } from '../src/core/redact.ts';

// Bodies are generated so that no credential-shaped literal is stored in the repository.
const repeat = (part: string, length: number): string => part.repeat(Math.ceil(length / part.length)).slice(0, length);

test('every recognized credential shape is redacted in place', () => {
  const cases: [string, string][] = [
    [`key sk-${repeat('aB3_', 40)} end`, `key ${REDACTED} end`],
    [`key sk-ant-api03-${repeat('xY9-', 60)}.`, `key ${REDACTED}.`],
    [`key sk-proj-${repeat('Q1w2', 48)}`, `key ${REDACTED}`],
    [`gh ghp_${repeat('a1B2', 36)}`, `gh ${REDACTED}`],
    [`gh gho_${repeat('c3D4', 36)}`, `gh ${REDACTED}`],
    [`gh ghs_${repeat('e5F6', 36)}`, `gh ${REDACTED}`],
    [`gh github_pat_${repeat('11AB_cd', 82)}`, `gh ${REDACTED}`],
    [`aws AKIA${repeat('ABCDEFGH23', 16)} ok`, `aws ${REDACTED} ok`],
    [`slack xoxb-${repeat('1234-', 40)}x`, `slack ${REDACTED}`],
    [`google AIza${repeat('Sy_9-k', 35)}`, `google ${REDACTED}`],
    [`jwt eyJ${repeat('hbGciOi', 20)}.eyJ${repeat('zdWIiOi', 30)}.${repeat('sIgN-_', 43)} done`, `jwt ${REDACTED} done`],
    [`Authorization: Bearer ${repeat('tOk3n.', 40)}`, `Authorization: Bearer ${REDACTED}`],
    [
      `before\n-----BEGIN RSA PRIVATE KEY-----\n${repeat('MIIEow', 64)}\n-----END RSA PRIVATE KEY-----\nafter`,
      `before\n${REDACTED}\nafter`
    ],
    [`clipped -----BEGIN OPENSSH PRIVATE KEY-----\n${repeat('b3BlbnNzaA', 70)}`, `clipped ${REDACTED}`],
    ['DB_PASSWORD=hunter2hunter2 next', `DB_PASSWORD=${REDACTED} next`],
    ['export GITHUB_TOKEN=abc123def456ghi', `export GITHUB_TOKEN=${REDACTED}`],
    ['https://x.test/cb?api_key=0123456789abcdef&page=2', `https://x.test/cb?api_key=${REDACTED}&page=2`],
    ['{"password": "correct horse battery"}', `{"password": "${REDACTED}"}`],
    ["client_secret: 'abcd1234'", `client_secret: '${REDACTED}'`],
    ['apiKey = "k-1234"', `apiKey = "${REDACTED}"`],
    ['api_key: AbCdEf1234567890xyz', `api_key: ${REDACTED}`],
    ['password: hunter2hunter2\nnext', `password: ${REDACTED}\nnext`],
    [`Authorization: Basic ${repeat('dXNlcjpw', 24)}==`, `Authorization: Basic ${REDACTED}`],
    ['DATABASE_URL=postgres://admin:S3cretPass@db.internal:5432/app', `DATABASE_URL=postgres://admin:${REDACTED}@db.internal:5432/app`]
  ];
  for (const [input, expected] of cases) assert.equal(redactSecrets(input), expected, input);
});

test('ordinary text, paths, hashes and code are left intact', () => {
  const ordinary = [
    'Edited src/core/handover.ts and C:\\Users\\me\\project\\sk-notes\\task-list.md',
    'Last commit 7ea53cd9f1e2b3a4c5d6e7f8091a2b3c4d5e6f70 fixed the desk-lamp-controller-module',
    'const message = getMessage(); const max_tokens = 128000000;',
    'A token is required for every request. Bearer tokens expire.',
    'password reset flow, secret santa, an api key is needed',
    'eyJ alone is not a token; AKIA1234 is too short; sk-short',
    'https://example.test/search?q=tokenizer&page=12345678',
    'Basic usage: open https://example.test:8080/docs or write to me@example.test',
    'max_tokens: 128000 and tokenization: required'
  ];
  for (const text of ordinary) assert.equal(redactSecrets(text), text);
  assert.equal(redactSecrets(redactSecrets('DB_PASSWORD=hunter2hunter2')), `DB_PASSWORD=${REDACTED}`, 'redaction is idempotent');
});

test('the newer shapes stay stable when redacted twice', () => {
  for (const text of ['postgres://admin:S3cretPass@db/app', 'api_key: AbCdEf1234567890xyz', 'Authorization: Basic dXNlcjpwYXNzd29yZA=='])
    assert.equal(redactSecrets(redactSecrets(text)), redactSecrets(text), text);
});

test('framework secrets, more token shapes and quoting styles are redacted too', () => {
  const generated = repeat('q8Zr2LmP', 24);
  const cases: [string, string][] = [
    [`SECRET_KEY = 'django-insecure-${generated}'`, `SECRET_KEY = '${REDACTED}'`],
    [`"secret_key": "${generated}"`, `"secret_key": "${REDACTED}"`],
    [`config.secret_key_base = "${generated}"`, `config.secret_key_base = "${REDACTED}"`],
    [`JWT_SECRET_KEY=${generated}`, `JWT_SECRET_KEY=${REDACTED}`],
    [`ENCRYPTION_KEY=${generated}`, `ENCRYPTION_KEY=${REDACTED}`],
    [`signingKey: "${generated}"`, `signingKey: "${REDACTED}"`],
    [`const apiKey = \`${generated}\`;`, `const apiKey = \`${REDACTED}\`;`],
    [`{"password":"abc\\"${generated}"}`, `{"password":"${REDACTED}"}`],
    [`Server=db;User Id=sa;Pwd=${generated};`, `Server=db;User Id=sa;Pwd=${REDACTED};`],
    [`STRIPE_SECRET_KEY=sk_live_${generated}`, `STRIPE_SECRET_KEY=${REDACTED}`],
    [`stripe rk_test_${generated} end`, `stripe ${REDACTED} end`],
    [`npm npm_${repeat('a1B2', 36)} end`, `npm ${REDACTED} end`],
    [`hf hf_${repeat('a1B2', 34)} end`, `hf ${REDACTED} end`],
    [`gitlab glpat-${repeat('a1B2-', 20)} end`, `gitlab ${REDACTED} end`],
    [`google ya29.${repeat('a1B2-_', 40)} end`, `google ${REDACTED} end`],
    [`-H "x-api-key: ${generated}"`, `-H "x-api-key: ${REDACTED}"`],
    [`"Authorization": "token ${repeat('a1B2', 10)}"`, `"Authorization": "token ${REDACTED}"`],
    ['Authorization: Bearer abc123def456', `Authorization: Bearer ${REDACTED}`],
    [`-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${generated}\n-----END PGP PRIVATE KEY BLOCK-----`, REDACTED],
    ['postgres://admin:p@ssw0rd@db.internal/app', `postgres://admin:${REDACTED}@db.internal/app`]
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactSecrets(input), expected, input);
    assert.equal(redactSecrets(redactSecrets(input)), expected, `${input} twice`);
  }
});

test('ordinary key names with ordinary values stay readable', () => {
  const ordinary = [
    'sortKey: "createdAt", primary_key = "user_id", cacheKey=session:123',
    'The keyboard shortcut key: Ctrl+Alt+U',
    'groupKey = "team-a" and idempotencyKey: "retry-once"',
    'Bearer tokens are short-lived; Basic auth is disabled'
  ];
  for (const text of ordinary) assert.equal(redactSecrets(text), text);
});

test('explicit credential fields are masked regardless of length or character mix', () => {
  const cases: [string, string][] = [
    ['DB_PASSWORD: correcthorsebatterystaple', `DB_PASSWORD: ${REDACTED}`],
    ['password: 1234567890123456', `password: ${REDACTED}`],
    ['password: changeme', `password: ${REDACTED}`],
    ['token: onlyletterssecret', `token: ${REDACTED}`],
    ['token: a', `token: ${REDACTED}`],
    ['const token = lookup("privatevalue", nested("other")); next();', `const token = ${REDACTED}; next();`],
    ['{"password":"abc","max_tokens":128000}', `{"password":"${REDACTED}","max_tokens":128000}`],
    ['{"password":1,"max_tokens":2}', `{"password":${REDACTED},"max_tokens":2}`],
    ['export DB_PASSWORD=x', `export DB_PASSWORD=${REDACTED}`],
    ['client_secret = ""', `client_secret = "${REDACTED}"`],
    ['Authorization: Bearer ab', `Authorization: Bearer ${REDACTED}`],
    ['tool --password x --model small', `tool --password ${REDACTED} --model small`],
    ['tool --api-key="abc" --next', `tool --api-key="${REDACTED}" --next`],
    ['password: correct horse battery staple', `password: ${REDACTED}`]
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(redactSecretsWithReview(input), { text: expected, requiresReview: false }, input);
    assert.equal(redactSecrets(expected), expected, `${input} remains idempotent`);
  }
});

test('multiline quoted, YAML block, nested and flow credential values are removed as a whole', () => {
  const cases: [string, string][] = [
    ['password: |\n  alpha\n  beta\nnext: visible', `password: ${REDACTED}\nnext: visible`],
    ['password: alpha\n  beta\nnext: visible', `password: ${REDACTED}\nnext: visible`],
    ['config:\n  private_key: >-\n    alpha\n    beta\n  next: visible', `config:\n  private_key: ${REDACTED}\n  next: visible`],
    ['DB_PASSWORD="alpha\nbeta"\nSAFE=keep', `DB_PASSWORD="${REDACTED}"\nSAFE=keep`],
    ['credentials:\n  username: admin\n  password: a\nnext: keep', `credentials:${REDACTED}\nnext: keep`],
    ['{"credentials":{"nested":["a",{"key":"b"}]},"next":1}', `{"credentials":${REDACTED},"next":1}`],
    ["password: 'isn''tpublic'", `password: '${REDACTED}'`]
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(redactSecretsWithReview(input), { text: expected, requiresReview: false }, input);
    assert.equal(redactSecrets(expected), expected, `${input} remains idempotent`);
  }
});

test('incomplete sensitive structures require explicit review without retaining their content', () => {
  for (const text of ['password: "unfinished\nsecret-tail', 'credentials: {"nested":"private"', 'private_key: |']) {
    const result = redactSecretsWithReview(text);
    assert.equal(result.requiresReview, true, text);
    assert.ok(result.text.includes(REDACTED));
    assert.ok(result.text.includes(SECRET_REVIEW_REQUIRED));
    assert.equal(result.text.includes('secret-tail'), false);
    assert.equal(result.text.includes('unfinished'), false);
    assert.equal(result.text.includes('nested'), false);
  }
  assert.deepEqual(
    redactSecretsWithReview(`A user can mention ${SECRET_REVIEW_REQUIRED}.`),
    {
      text: `A user can mention ${SECRET_REVIEW_REQUIRED}.`,
      requiresReview: false
    },
    'a display marker is not a security decision'
  );
  assert.equal(redactSecretsWithReview(`credentials: [${'a'.repeat(70_000)}]`).requiresReview, true, 'structured scanning is bounded');
});
