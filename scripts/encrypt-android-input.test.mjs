import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidInputAad, sealAndroidInput, openAndroidInput, prepareEncryptedAndroidInput, encryptionArguments,
  MAX_ANDROID_ENVELOPE_BYTES, ENCRYPTED_ANDROID_INPUT_NAME } from './encrypt-android-input.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const apk = Buffer.alloc(1024 ** 2, 73); apk.set([80, 75, 3, 4]);
const info = { schemaVersion: 1, distribution: 'sideload-preview-only', signing: 'public-expo-template-debug-certificate',
  variant: 'release', embeddedJavaScript: true, applicationId: 'ai.anymize.mobile', versionCode: 2, versionName: '0.2.0',
  apk: 'anymize-preview-debug-signed.apk', apkBytes: apk.length, apkSha256: hash(apk), signingCertificateSha256: 'a'.repeat(64),
  supportedAbis: ['arm64-v8a', 'x86_64'], minSdk: 24, targetSdk: 36, sourceCommit: 'b'.repeat(40), runId: '12345' };
const raw = Buffer.from(JSON.stringify(info));
const identity = { apkAssetId: '123', metadataAssetId: '124', apkSha256: hash(apk), metadataSha256: hash(raw), sourceCommit: info.sourceCommit };
const key = randomBytes(32), keyText = key.toString('base64url');

test('real AES-256-GCM roundtrip keeps APK and raw metadata exact and randomizes each envelope', () => {
  const first = sealAndroidInput(apk, raw, identity, key), second = sealAndroidInput(apk, raw, identity, key);
  assert.notDeepEqual(first, second); assert.equal(first.includes(raw), false); assert.equal(first.includes(apk.subarray(0, 256)), false);
  const opened = openAndroidInput(first, identity, hash(first), keyText);
  assert.deepEqual(opened.apk, apk); assert.deepEqual(opened.metadataBytes, raw);
  assert.deepEqual(key, Buffer.from(keyText, 'base64url'), 'Caller-owned key is not modified');
});

test('authenticated additional data binds source, both original assets and both raw plaintext hashes', () => {
  const envelope = sealAndroidInput(apk, raw, identity, key);
  for (const patch of [{ sourceCommit: 'c'.repeat(40) }, { apkAssetId: '125' }, { metadataAssetId: '126' },
    { apkSha256: 'd'.repeat(64) }, { metadataSha256: 'e'.repeat(64) }]) {
    assert.throws(() => openAndroidInput(envelope, { ...identity, ...patch }, hash(envelope), keyText), /authentication failed/);
  }
  for (const patch of [{ sourceCommit: '../source' }, { apkAssetId: '123?x' }, { metadataAssetId: '123' }, { apkSha256: 'A'.repeat(64) }]) assert.throws(() => androidInputAad({ ...identity, ...patch }));
});

test('tampered ciphertext, nonce and tag reject even when a new ciphertext hash is supplied', () => {
  const envelope = sealAndroidInput(apk, raw, identity, key);
  const magicLength = Buffer.byteLength('ANYMIZE-ANDROID-INPUT-V1\n');
  for (const offset of [magicLength, magicLength + 12, envelope.length - 1]) {
    const changed = Buffer.from(envelope); changed[offset] ^= 1;
    assert.throws(() => openAndroidInput(changed, identity, hash(changed), keyText));
  }
  assert.throws(() => openAndroidInput(envelope, identity, '0'.repeat(64), keyText));
  assert.throws(() => openAndroidInput(envelope, identity, hash(envelope), randomBytes(32).toString('base64url')), /authentication failed/);
  for (const bad of ['', keyText + '=', keyText + '\n', 'x'.repeat(42), 'A'.repeat(42) + 'B']) assert.throws(() => openAndroidInput(envelope, identity, hash(envelope), bad));
});

test('bounded binary format rejects truncated, unknown, oversized and authenticated malformed payloads', () => {
  const envelope = sealAndroidInput(apk, raw, identity, key);
  const changedMagic = Buffer.from(envelope); changedMagic[0] ^= 1;
  for (const bad of [Buffer.from('not a bundle'), envelope.subarray(0, 100), changedMagic, Buffer.alloc(MAX_ANDROID_ENVELOPE_BYTES + 1)]) {
    assert.throws(() => openAndroidInput(bad, identity, hash(bad), keyText));
  }
  const magic = Buffer.from('ANYMIZE-ANDROID-INPUT-V1\n'), iv = randomBytes(12);
  const signedPayload = (metadataLength, body) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(metadataLength);
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(androidInputAad(identity));
    const ciphertext = Buffer.concat([cipher.update(Buffer.concat([length, body])), cipher.final()]);
    return Buffer.concat([magic, iv, cipher.getAuthTag(), ciphertext]);
  };
  for (const bytes of [signedPayload(0, Buffer.concat([raw, apk])), signedPayload(1024 ** 2 + 1, Buffer.concat([raw, apk])),
    signedPayload(raw.length, Buffer.concat([raw, Buffer.from(apk).fill(0)]))]) assert.throws(() => openAndroidInput(bytes, identity, hash(bytes), keyText));
  assert.throws(() => sealAndroidInput(apk.subarray(0, 1024), raw, identity, key));
  assert.throws(() => sealAndroidInput(apk, Buffer.from('{}'), identity, key));
});

test('operator command validates full existing build contract, creates private fresh key and logs no secret', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'anymize-android-envelope-')));
  try {
    const apkPath = join(root, 'source.apk'), metadataPath = join(root, 'build-info.json'), output = join(root, ENCRYPTED_ANDROID_INPUT_NAME), keyFile = join(root, 'one-run.key');
    writeFileSync(apkPath, apk); writeFileSync(metadataPath, raw);
    const options = { apk: apkPath, 'build-info': metadataPath, 'apk-asset-id': '123', 'build-info-asset-id': '124',
      'source-commit': info.sourceCommit, output, 'key-file': keyFile };
    let printed = '';
    const result = await prepareEncryptedAndroidInput(options, (value) => { printed += value; });
    const secret = readFileSync(keyFile, 'utf8'); assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(printed.includes(secret), false); assert.equal(result.encryptedSha256, hash(readFileSync(output)));
    const opened = openAndroidInput(readFileSync(output), identity, result.encryptedSha256, secret);
    assert.deepEqual(opened.apk, apk); assert.deepEqual(opened.metadataBytes, raw);
    await assert.rejects(prepareEncryptedAndroidInput(options, () => {}));
    assert.equal(readFileSync(keyFile, 'utf8'), secret); assert.equal(hash(readFileSync(output)), result.encryptedSha256);
    await assert.rejects(prepareEncryptedAndroidInput({ ...options, 'key-file': join(process.cwd(), 'unsafe.key') }, () => {}));
    unlinkSync(output); unlinkSync(keyFile);
    const bad = Buffer.from(JSON.stringify({ ...info, variant: 'debug' })); writeFileSync(metadataPath, bad);
    await assert.rejects(prepareEncryptedAndroidInput(options, () => {}), /selected standalone release/);
    assert.equal(existsSync(output), false); assert.equal(existsSync(keyFile), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('existing key is never overwritten and failed preparation removes only its own new ciphertext', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'anymize-android-key-')));
  try {
    const output = join(root, ENCRYPTED_ANDROID_INPUT_NAME), keyFile = join(root, 'one-run.key');
    writeFileSync(join(root, 'source.apk'), apk); writeFileSync(join(root, 'build-info.json'), raw); writeFileSync(keyFile, 'keep existing key');
    await assert.rejects(prepareEncryptedAndroidInput({ apk: join(root, 'source.apk'), 'build-info': join(root, 'build-info.json'),
      'apk-asset-id': '123', 'build-info-asset-id': '124', 'source-commit': info.sourceCommit, output, 'key-file': keyFile }, () => {}));
    assert.equal(existsSync(output), false); assert.equal(readFileSync(keyFile, 'utf8'), 'keep existing key');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('operator CLI rejects duplicate, missing, unknown and switch-shaped arguments', async () => {
  const valid = ['--apk', 'a', '--build-info', 'b', '--apk-asset-id', '123', '--build-info-asset-id', '124', '--source-commit', info.sourceCommit, '--output', 'c', '--key-file', 'd'];
  assert.equal(encryptionArguments(valid)['apk-asset-id'], '123');
  for (const bad of [[], valid.slice(0, -2), [...valid, '--extra', 'x'], valid.map((value) => value === '--build-info' ? '--apk' : value), valid.map((value) => value === 'a' ? '--other' : value)]) assert.throws(() => encryptionArguments(bad));
  await assert.rejects(prepareEncryptedAndroidInput({ ...encryptionArguments(valid), unsupported: 'x' }, () => {}));
});

test('actual operator process completes validation/imports and writes only ciphertext and a separate key', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'anymize-android-cli-')));
  try {
    const output = join(root, ENCRYPTED_ANDROID_INPUT_NAME), keyFile = join(root, 'one-run.key');
    writeFileSync(join(root, 'input.apk'), apk); writeFileSync(join(root, 'build-info.json'), raw);
    const script = fileURLToPath(new URL('./encrypt-android-input.mjs', import.meta.url));
    const args = [script, '--apk', join(root, 'input.apk'), '--build-info', join(root, 'build-info.json'), '--apk-asset-id', '123',
      '--build-info-asset-id', '124', '--source-commit', identity.sourceCommit, '--output', output, '--key-file', keyFile];
    const printed = execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = JSON.parse(printed), secret = readFileSync(keyFile, 'utf8');
    assert.equal(result.encryptedSha256, hash(readFileSync(output))); assert.equal(printed.includes(secret), false);
    assert.deepEqual(openAndroidInput(readFileSync(output), identity, result.encryptedSha256, secret).apk, apk);
    assert.throws(() => execFileSync(process.execPath, [script, '--unsupported', secret], { timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }), (error) => {
      assert.equal(error.status, 1); assert.equal(error.stdout.length, 0); assert.equal(error.stderr.toString(), 'Encrypted Android input preparation rejected.\n');
      assert.equal(error.stderr.includes(Buffer.from(secret)), false); return true;
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
