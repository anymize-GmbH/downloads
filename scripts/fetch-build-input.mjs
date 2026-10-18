import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openInputEnvelope, assertInputArchive, readBoundMetadata } from './input-envelope.mjs';

const stages = new Set(['identity', 'target', 'metadata-download', 'metadata-binding', 'metadata-policy', 'ciphertext-download',
  'envelope-authentication', 'archive-write', 'archive-list', 'archive-policy', 'archive-extract', 'source-identity', 'log-recipient', 'receipt-write']);

/** Fixed public labels only: never return child stderr, error messages or paths. */
export function sourceInputFailure(stage, error) {
  const safeStage = stages.has(stage) ? stage : 'internal';
  let reason = 'rejected';
  if (safeStage === 'metadata-download' || safeStage === 'ciphertext-download') {
    if (error?.code === 'ETIMEDOUT') reason = 'timeout';
    else if (error?.code === 'ENOBUFS') reason = 'size-limit';
    else {
      const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.subarray(0, 8192).toString('utf8')
        : typeof error?.stderr === 'string' ? error.stderr.slice(0, 8192) : '';
      const status = /\bHTTP\s+(\d{3})\b/.exec(stderr)?.[1];
      if (status) reason = ['401', '403', '404', '429', '500', '502', '503', '504'].includes(status) ? `http-${status}` : 'http-other';
    }
  }
  return `Source input rejected [${safeStage}:${reason}].\n`;
}

export function fetchBuildInput(env = process.env) {
let stage = 'identity';
let ownsRoot = false;
const root = resolve('private-input');
const plainFile = join(root, 'source.tgz');
try {
const repository = 'anymize-GmbH/downloads';
const sourceRepository = env.ANYMIZE_EXPECTED_SOURCE_REPOSITORY ?? 'anymize-GmbH/anymize-apps';
const commit = env.ANYMIZE_EXPECTED_SOURCE_COMMIT;
const asset = env.BUILD_INPUT_ASSET_ID;
const metadataAsset = env.BUILD_INPUT_METADATA_ID;
const expectedEncryptedSha = env.BUILD_INPUT_SHA256;
const metadataSha256 = env.BUILD_INPUT_METADATA_SHA256;
const keyText = env.BUILD_INPUT_DECRYPTION_KEY?.trim();
if (!['anymize-GmbH/anymize-apps', 'attractsoft/anychat'].includes(sourceRepository) || env.GITHUB_REPOSITORY !== repository || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
  || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')
  || !/^[a-f0-9]{40}$/.test(commit ?? '') || !/^[1-9][0-9]*$/.test(asset ?? '') || !/^[1-9][0-9]*$/.test(metadataAsset ?? '')
  || asset === metadataAsset || !/^[a-f0-9]{64}$/.test(expectedEncryptedSha ?? '')
  || !/^[a-f0-9]{64}$/.test(metadataSha256 ?? '')
  || !/^[A-Za-z0-9_-]{43}$/.test(keyText ?? '') || !env.GH_TOKEN) throw new Error('Explicit trusted execution/input identity required');
stage = 'target';
if (existsSync(root)) throw new Error('Source extraction target must be fresh');
mkdirSync(root);
ownsRoot = true;
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');
const download = (id, maxBuffer) => execFileSync('gh', ['api', '-H', 'Accept: application/octet-stream', `repos/${repository}/releases/assets/${id}`], { maxBuffer, timeout: 600000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  stage = 'metadata-download';
  const metadataBytes = download(metadataAsset, 65536);
  stage = 'metadata-binding';
  const metadata = readBoundMetadata(metadataBytes, metadataSha256);
  stage = 'metadata-policy';
  if (metadata.schemaVersion !== 1 || metadata.sourceRepository !== sourceRepository || metadata.sourceCommit !== commit
    || metadata.encryptedSha256 !== expectedEncryptedSha || !/^[a-f0-9]{64}$/.test(metadata.lockSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(metadata.plaintextSha256 ?? '') || !/^[A-Za-z0-9_-]{16}$/.test(metadata.iv ?? '')
    || !/^[A-Za-z0-9_-]{22}$/.test(metadata.tag ?? '') || !Number.isSafeInteger(metadata.encryptedBytes) || metadata.encryptedBytes < 1 || metadata.encryptedBytes > 1073741824
    || metadata.plaintextBytes !== metadata.encryptedBytes) throw new Error('Input metadata rejected');
  stage = 'ciphertext-download';
  const encrypted = download(asset, 1073741824);
  stage = 'envelope-authentication';
  const plaintext = openInputEnvelope(encrypted, metadata, commit, expectedEncryptedSha, keyText, sourceRepository);
  stage = 'archive-write';
  writeFileSync(plainFile, plaintext, { mode: 0o600, flag: 'wx' });
  stage = 'archive-list';
  const paths = execFileSync('tar', ['-tzf', plainFile], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(/\r?\n/);
  const types = execFileSync('tar', ['-tvzf', plainFile], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(/\r?\n/);
  stage = 'archive-policy';
  assertInputArchive(paths, types);
  stage = 'archive-extract';
  execFileSync('tar', ['-xzf', plainFile, '-C', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  stage = 'source-identity';
  const source = join(root, 'source');
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git('rev-parse', 'HEAD') !== commit || git('status', '--porcelain', '--untracked-files=normal')
    || hash(readFileSync(join(source, 'package-lock.json'))) !== metadata.lockSha256
    || git('remote', 'get-url', 'origin') !== `https://github.com/${sourceRepository}.git`) throw new Error('Actual extracted source identity rejected');
  stage = 'log-recipient';
  const logKey = createPublicKey(metadata.logPublicKey);
  if (logKey.asymmetricKeyType !== 'rsa' || logKey.asymmetricKeyDetails.modulusLength < 3072) throw new Error('Private diagnostics public key rejected');
  writeFileSync(join(source, '.git', 'anymize-build-log-public.pem'), logKey.export({ type: 'spki', format: 'pem' }));
  stage = 'receipt-write';
  writeFileSync(join(source, '.git', 'anymize-build-input.json'), JSON.stringify({ schemaVersion: 1,
    source: { repository: metadata.sourceRepository, commit, lockSha256: metadata.lockSha256 },
    workflow: { repository, commit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT },
    input: { encryptedSha256: expectedEncryptedSha, plaintextSha256: metadata.plaintextSha256, metadataSha256, assetId: asset } }));
  process.stdout.write('Exact encrypted source input authenticated and extracted.\n');
} catch (error) {
  // Never expose private tar paths/source/error payload or key through public logs.
  process.stderr.write(sourceInputFailure(stage, error)); process.exitCode = 1;
} finally {
  try { if (ownsRoot && existsSync(plainFile)) rmSync(plainFile); }
  catch { process.stderr.write('Source input cleanup rejected.\n'); process.exitCode = 1; }
}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) fetchBuildInput();
