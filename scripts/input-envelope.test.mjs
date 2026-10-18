import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { openInputEnvelope, inputAad, assertInputArchive, readBoundMetadata } from './input-envelope.mjs';
import { sourceInputFailure } from './fetch-build-input.mjs';

test('public fetch diagnostics identify only fixed stages and bounded HTTP categories without private child output', () => {
  const privateText = 'PRIVATE_SOURCE_PATH/private-secret.ts session=NEVER_LOG_THIS_KEY';
  for (const status of ['401', '403', '404', '429', '500', '502', '503', '504']) {
    const error = { stderr: Buffer.from(`gh: ${privateText} (HTTP ${status})`), message: privateText, stack: privateText };
    assert.equal(sourceInputFailure('metadata-download', error), `Source input rejected [metadata-download:http-${status}].\n`);
    assert.equal(sourceInputFailure('ciphertext-download', error), `Source input rejected [ciphertext-download:http-${status}].\n`);
  }
  assert.equal(sourceInputFailure('metadata-download', { stderr: 'HTTP 418: ' + privateText }), 'Source input rejected [metadata-download:http-other].\n');
  assert.equal(sourceInputFailure('ciphertext-download', { code: 'ETIMEDOUT', stderr: privateText }), 'Source input rejected [ciphertext-download:timeout].\n');
  assert.equal(sourceInputFailure('ciphertext-download', { code: 'ENOBUFS', stderr: privateText }), 'Source input rejected [ciphertext-download:size-limit].\n');
  assert.equal(sourceInputFailure('source-identity', { stderr: 'HTTP 404: ' + privateText }), 'Source input rejected [source-identity:rejected].\n');
  assert.equal(sourceInputFailure('metadata-download', { stderr: 'x'.repeat(8192) + ' HTTP 404' }), 'Source input rejected [metadata-download:rejected].\n');
  for (const stage of [privateText, 'metadata-download\n::error::' + privateText, undefined]) {
    const output = sourceInputFailure(stage, { stderr: privateText, message: privateText });
    assert.equal(output, 'Source input rejected [internal:rejected].\n');
    assert.equal(output.includes(privateText), false);
  }
});

test('exact operator metadata digest binds the private diagnostic recipient before parsing', () => {
  const record = { sourceCommit: 'a'.repeat(40), logPublicKey: 'synthetic-operator-public-key' };
  const bytes = Buffer.from(JSON.stringify(record));
  const sha = createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(readBoundMetadata(bytes, sha), record);
  assert.throws(() => readBoundMetadata(Buffer.from(JSON.stringify({ ...record, logPublicKey: 'substituted-recipient' })), sha));
  assert.throws(() => readBoundMetadata(Buffer.from(JSON.stringify(record, null, 2)), sha));
  assert.throws(() => readBoundMetadata(bytes, 'latest'));
  const invalid = Buffer.from([0xff]);
  assert.throws(() => readBoundMetadata(invalid, createHash('sha256').update(invalid).digest('hex')));
});

test('authenticated encrypted source cannot be substituted, mutated or opened under another source identity', () => {
  const commit = 'a'.repeat(40), key = randomBytes(32), iv = randomBytes(12), payload = Buffer.from('Synthetic private fixture, never real application source');
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(inputAad(commit));
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const metadata = { sourceRepository: 'anymize-GmbH/anymize-apps', sourceCommit: commit, encryptedBytes: encrypted.length, plaintextBytes: payload.length,
    encryptedSha256: hash(encrypted), plaintextSha256: hash(payload), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
  const open = (bytes = encrypted, record = metadata, revision = commit, digest = hash(encrypted), secret = key.toString('base64url')) => openInputEnvelope(bytes, record, revision, digest, secret);
  assert.deepEqual(open(), payload);
  const changed = Buffer.from(encrypted); changed[0] ^= 1;
  assert.throws(() => open(changed));
  assert.throws(() => open(changed, { ...metadata, encryptedSha256: hash(changed) }, commit, hash(changed)));
  assert.throws(() => open(encrypted, { ...metadata, sourceCommit: 'b'.repeat(40) }, 'b'.repeat(40)));
  assert.throws(() => open(encrypted, { ...metadata, plaintextSha256: '0'.repeat(64) }));
  assert.throws(() => open(encrypted, { ...metadata, tag: randomBytes(16).toString('base64url') }));
  assert.throws(() => open(encrypted, metadata, commit, hash(encrypted), randomBytes(32).toString('base64url')));
});

test('archive extraction rejects traversal, absolute paths, alternate streams, symlinks and hardlinks', () => {
  const paths = Array.from({ length: 10 }, (_, i) => `source/file${i}`), types = paths.map((name) => `-rw-r--r-- 0/0 1 date ${name}`);
  assert.doesNotThrow(() => assertInputArchive(paths, types));
  for (const name of ['/etc/passwd', '../source/x', 'source/../../x', 'source/x/../y', 'source/C:x', 'source/a\\b', 'source/a\nb']) assert.throws(() => assertInputArchive([name, ...paths.slice(1)], types));
  for (const type of ['l', 'h', 'p', 'b', 'c', 's']) assert.throws(() => assertInputArchive(paths, [`${type}rw-r--r-- link`, ...types.slice(1)]));
  assert.throws(() => assertInputArchive(paths, types.slice(1)));
});
