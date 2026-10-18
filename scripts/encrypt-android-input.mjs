import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENCRYPTED_ANDROID_INPUT_NAME = 'android-app-input-v1.bin';
export const MAX_ANDROID_APK_BYTES = 512 * 1024 ** 2;
export const MAX_ANDROID_METADATA_BYTES = 1024 ** 2;
const MIN_APK_BYTES = 1024 ** 2;
const MAGIC = Buffer.from('ANYMIZE-ANDROID-INPUT-V1\n', 'ascii');
const HEADER_BYTES = MAGIC.length + 12 + 16;
export const MAX_ANDROID_ENVELOPE_BYTES = HEADER_BYTES + 4 + MAX_ANDROID_METADATA_BYTES + MAX_ANDROID_APK_BYTES;
export const MIN_ANDROID_ENVELOPE_BYTES = HEADER_BYTES + 4 + 1 + MIN_APK_BYTES;
const REPOSITORY = 'anymize-GmbH/downloads';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requireInput = (condition) => { if (!condition) throw new Error('Android encrypted input rejected.'); };
const positiveId = (value) => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && Number.isSafeInteger(Number(value));

export function androidInputAad(identity) {
  requireInput(identity && /^[a-f0-9]{40}$/.test(identity.sourceCommit ?? '')
    && /^[a-f0-9]{64}$/.test(identity.apkSha256 ?? '') && /^[a-f0-9]{64}$/.test(identity.metadataSha256 ?? '')
    && positiveId(identity.apkAssetId) && positiveId(identity.metadataAssetId) && identity.apkAssetId !== identity.metadataAssetId);
  return Buffer.from(['anymize-android-input-v1', REPOSITORY, identity.sourceCommit,
    identity.apkAssetId, identity.apkSha256, identity.metadataAssetId, identity.metadataSha256, ''].join('\n'));
}

function exactPlaintext(apk, metadataBytes, identity) {
  requireInput(Buffer.isBuffer(apk) && apk.length >= MIN_APK_BYTES && apk.length <= MAX_ANDROID_APK_BYTES
    && apk.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) && sha(apk) === identity.apkSha256
    && Buffer.isBuffer(metadataBytes) && metadataBytes.length > 0 && metadataBytes.length <= MAX_ANDROID_METADATA_BYTES
    && sha(metadataBytes) === identity.metadataSha256);
}

export function sealAndroidInput(apk, metadataBytes, identity, keyBytes) {
  const aad = androidInputAad(identity); exactPlaintext(apk, metadataBytes, identity);
  requireInput(Buffer.isBuffer(keyBytes) && keyBytes.length === 32);
  const key = Buffer.from(keyBytes), iv = randomBytes(12), length = Buffer.alloc(4);
  length.writeUInt32BE(metadataBytes.length);
  const plaintext = Buffer.concat([length, metadataBytes, apk]);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
  } finally { key.fill(0); plaintext.fill(0); }
}

export function openAndroidInput(envelope, identity, expectedSha256, keyText) {
  const aad = androidInputAad(identity);
  requireInput(Buffer.isBuffer(envelope) && envelope.length >= MIN_ANDROID_ENVELOPE_BYTES && envelope.length <= MAX_ANDROID_ENVELOPE_BYTES
    && envelope.subarray(0, MAGIC.length).equals(MAGIC) && /^[a-f0-9]{64}$/.test(expectedSha256 ?? '') && sha(envelope) === expectedSha256
    && typeof keyText === 'string' && /^[A-Za-z0-9_-]{43}$/.test(keyText));
  const key = Buffer.from(keyText, 'base64url');
  let plaintext;
  try {
    requireInput(key.length === 32 && key.toString('base64url') === keyText);
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(MAGIC.length, MAGIC.length + 12));
    decipher.setAAD(aad); decipher.setAuthTag(envelope.subarray(MAGIC.length + 12, HEADER_BYTES));
    // No bytes are returned or written before authentication final() succeeds.
    const first = decipher.update(envelope.subarray(HEADER_BYTES));
    try { plaintext = Buffer.concat([first, decipher.final()]); } finally { first.fill(0); }
    const metadataLength = plaintext.readUInt32BE(0);
    requireInput(metadataLength > 0 && metadataLength <= MAX_ANDROID_METADATA_BYTES && 4 + metadataLength < plaintext.length);
    const metadataBytes = plaintext.subarray(4, 4 + metadataLength), apk = plaintext.subarray(4 + metadataLength);
    exactPlaintext(apk, metadataBytes, identity);
    return { apk: Buffer.from(apk), metadataBytes: Buffer.from(metadataBytes) };
  } catch { throw new Error('Android encrypted input authentication failed.'); }
  finally { key.fill(0); plaintext?.fill(0); }
}

function readRegular(file, maximum) {
  const info = lstatSync(file);
  requireInput(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maximum && realpathSync(file) === resolve(file));
  return readFileSync(file);
}

/** Operator-only preparation. No upload, secret installation or publication.
 *
 * node scripts/encrypt-android-input.mjs --apk <local-apk> --build-info <local-json>
 *   --apk-asset-id <original-id> --build-info-asset-id <original-id>
 *   --source-commit <40hex> --output <directory>/android-app-input-v1.bin
 *   --key-file <absolute-outside-repository>/one-run.key
 *
 * Only the encrypted .bin goes on a published transport release. Install the
 * generated key file as temporary ANDROID_APP_INPUT_KEY via the operator's
 * secret-file input, dispatch with the original five immutable input values
 * plus encrypted_input_asset_id/encrypted_input_sha256, and remove the secret
 * after that run completes. Never publish the raw APK/metadata before acceptance
 * or add the key/clear input directory to any evidence upload.
 */
export async function prepareEncryptedAndroidInput(options, output = (value) => process.stdout.write(value)) {
  const expected = ['apk', 'build-info', 'apk-asset-id', 'build-info-asset-id', 'source-commit', 'output', 'key-file'];
  requireInput(options && Object.keys(options).length === expected.length && expected.every((key) => typeof options[key] === 'string' && options[key].length > 0));
  const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const keyFile = resolve(options['key-file']), keyRelative = relative(repositoryRoot, keyFile);
  requireInput(basename(options.output) === ENCRYPTED_ANDROID_INPUT_NAME);
  requireInput(isAbsolute(options['key-file']) && keyFile.endsWith('.key') && (isAbsolute(keyRelative) || keyRelative.startsWith(`..${sep}`)));
  // Resolve the parent too: an outside-looking junction may lead into the repo.
  const keyParent = realpathSync(dirname(keyFile)), parentRelative = relative(repositoryRoot, keyParent);
  requireInput(isAbsolute(parentRelative) || parentRelative === '..' || parentRelative.startsWith(`..${sep}`));
  const apk = readRegular(options.apk, MAX_ANDROID_APK_BYTES), metadataBytes = readRegular(options['build-info'], MAX_ANDROID_METADATA_BYTES);
  const { inputIdentity, validateBuildInfo } = await import('./android-app-smoke.mjs');
  const identity = inputIdentity({ GITHUB_REPOSITORY: REPOSITORY, APK_ASSET_ID: options['apk-asset-id'], BUILD_INFO_ASSET_ID: options['build-info-asset-id'],
    APK_SHA256: sha(apk), BUILD_INFO_SHA256: sha(metadataBytes), APP_SOURCE_COMMIT: options['source-commit'] });
  const info = validateBuildInfo(metadataBytes, identity); requireInput(apk.length === info.apkBytes);
  const key = randomBytes(32);
  try {
    const encrypted = sealAndroidInput(apk, metadataBytes, identity, key);
    requireInput(resolve(options.output) !== keyFile);
    writeFileSync(options.output, encrypted, { flag: 'wx', mode: 0o600 });
    try { writeFileSync(keyFile, key.toString('base64url'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { unlinkSync(options.output); throw error; }
    const result = { protocol: 'android-app-input-v1', ...identity, encryptedName: ENCRYPTED_ANDROID_INPUT_NAME,
      encryptedBytes: encrypted.length, encryptedSha256: sha(encrypted) };
    output(`${JSON.stringify(result, null, 2)}\n`); return result;
  } finally { key.fill(0); apk.fill(0); metadataBytes.fill(0); }
}

export function encryptionArguments(argv) {
  requireInput(argv.length === 14);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    requireInput(/^--[a-z][a-z-]*$/.test(argv[index]) && argv[index + 1] && !argv[index + 1].startsWith('--') && !Object.hasOwn(options, argv[index].slice(2)));
    options[argv[index].slice(2)] = argv[index + 1];
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rejected = () => { process.stderr.write('Encrypted Android input preparation rejected.\n'); process.exitCode = 1; };
  // Complete this module before the validator's dynamic import reuses its pure
  // crypto exports. A top-level await here would deadlock that import cycle.
  try { void prepareEncryptedAndroidInput(encryptionArguments(process.argv.slice(2))).catch(rejected); }
  catch { rejected(); }
}
