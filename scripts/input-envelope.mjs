import { createHash, createDecipheriv } from 'node:crypto';

export const inputAad = (commit, repository = 'anymize-GmbH/anymize-apps') => Buffer.from(`anymize-source-input-v1\n${repository}\n${commit}\n`);
export function readBoundMetadata(bytes, expectedSha256) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 65536 || !/^[a-f0-9]{64}$/.test(expectedSha256 ?? '')
    || createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error('Exact metadata digest rejected');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
export function openInputEnvelope(encrypted, metadata, commit, expectedSha, keyText, repository = 'anymize-GmbH/anymize-apps') {
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  if (!Buffer.isBuffer(encrypted) || encrypted.length !== metadata.encryptedBytes || hash(encrypted) !== expectedSha
    || !['anymize-GmbH/anymize-apps', 'attractsoft/anychat'].includes(repository)
    || metadata.encryptedSha256 !== expectedSha || metadata.sourceRepository !== repository || metadata.sourceCommit !== commit
    || !/^[A-Za-z0-9_-]{43}$/.test(keyText)) throw new Error('Ciphertext identity rejected');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyText, 'base64url'), Buffer.from(metadata.iv, 'base64url'));
  decipher.setAAD(inputAad(commit, repository)); decipher.setAuthTag(Buffer.from(metadata.tag, 'base64url'));
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  if (plaintext.length !== metadata.plaintextBytes || hash(plaintext) !== metadata.plaintextSha256) throw new Error('Plaintext digest rejected');
  return plaintext;
}

export function assertInputArchive(paths, types) {
  if (!Array.isArray(paths) || paths.length < 10 || paths.length > 50000 || paths.some((path) => !path.startsWith('source/') || path.includes('\\') || /(^|\/)\.\.(\/|$)|[\x00-\x1f\x7f:]/.test(path))) throw new Error('Unsafe archive paths');
  if (types.length !== paths.length || types.some((line) => !/^[-d]/.test(line))) throw new Error('Links and special archive members are prohibited');
}
