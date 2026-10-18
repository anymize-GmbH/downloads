import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { assertNoAnr, validateExpectedIdentity } from './emulator-baseline.mjs';

export const REPOSITORY = 'anymize-GmbH/downloads';
export const APP = 'ai.anymize.mobile';
export const HELPER = 'ai.anymize.smokefixture';
export const PHRASE = 'ANYMIZE_SMOKE_731';
export const SECOND_PHRASE = 'ANYMIZE_SMOKE_942';
const ASSET_NAME = 'anymize-preview-debug-signed.apk';
const MAX_JSON_BYTES = 1024 * 1024;
const INPUT = 'artifacts/android-app-input';
const OUTPUT = 'artifacts/android-app-smoke';
const FIXTURES = fileURLToPath(new URL('./android-app-smoke-fixtures/', import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
const positiveId = (value) => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && Number.isSafeInteger(Number(value));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const regular = (path, max) => {
  const info = lstatSync(path);
  assert(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= max && realpathSync(path) === resolve(path), 'Expected bounded regular evidence file.');
  return readFileSync(path);
};

export function strictJson(text) {
  assert(typeof text === 'string' && Buffer.byteLength(text) <= MAX_JSON_BYTES, 'Bounded JSON required.');
  const value = JSON.parse(text); const stack = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '"') {
      const start = index++;
      for (; index < text.length; index++) { if (text[index] === '\\') index++; else if (text[index] === '"') break; }
      const frame = stack.at(-1);
      if (frame?.keys && frame.key) { const key = JSON.parse(text.slice(start, index + 1)); assert(!frame.keys.has(key), 'Duplicate JSON key.'); frame.keys.add(key); frame.key = false; }
    } else if (text[index] === '{') stack.push({ keys: new Set(), key: true });
    else if (text[index] === '[') stack.push({});
    else if (['}', ']'].includes(text[index])) stack.pop();
    else if (text[index] === ',' && stack.at(-1)?.keys) stack.at(-1).key = true;
  }
  return value;
}

export function inputIdentity(env) {
  const result = { apkAssetId: env.APK_ASSET_ID, apkSha256: env.APK_SHA256, metadataAssetId: env.BUILD_INFO_ASSET_ID, metadataSha256: env.BUILD_INFO_SHA256, sourceCommit: env.APP_SOURCE_COMMIT };
  assert(env.GITHUB_REPOSITORY === REPOSITORY && positiveId(result.apkAssetId) && positiveId(result.metadataAssetId) && result.apkAssetId !== result.metadataAssetId && hex(result.apkSha256, 64) && hex(result.metadataSha256, 64) && hex(result.sourceCommit, 40), 'Explicit immutable own-repository APK and metadata identity required.');
  return result;
}

export function validateBuildInfo(bytes, identity) {
  assert(Buffer.isBuffer(bytes) && bytes.length <= MAX_JSON_BYTES && sha(bytes) === identity.metadataSha256, 'Raw build metadata hash differs or exceeds 1 MiB.');
  const value = strictJson(bytes.toString('utf8'));
  assert(value?.schemaVersion === 1 && value.distribution === 'sideload-preview-only' && value.signing === 'public-expo-template-debug-certificate'
    && value.variant === 'release' && value.embeddedJavaScript === true && value.applicationId === APP && value.sourceCommit === identity.sourceCommit
    && value.apk === ASSET_NAME && value.apkSha256 === identity.apkSha256 && hex(value.signingCertificateSha256, 64)
    && Number.isSafeInteger(value.apkBytes) && value.apkBytes >= 1024 * 1024 && value.apkBytes <= 512 * 1024 ** 2
    && Number.isSafeInteger(value.versionCode) && value.versionCode > 0 && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.versionName ?? '')
    && Array.isArray(value.supportedAbis) && value.supportedAbis.length === 2 && value.supportedAbis.includes('arm64-v8a') && value.supportedAbis.includes('x86_64')
    && Number.isSafeInteger(value.minSdk) && value.minSdk > 0 && value.minSdk <= 35 && Number.isSafeInteger(value.targetSdk) && value.targetSdk >= 36
    && positiveId(String(value.runId ?? '')), 'Build metadata is not the selected standalone release preview.');
  return value;
}

export function validateAsset(value, { id, name, size, digest }) {
  assert(value?.id === Number(id) && Number.isSafeInteger(value.id) && value.state === 'uploaded' && value.name === name && value.size === size
    && value.url === `https://api.github.com/repos/${REPOSITORY}/releases/assets/${id}`
    && (value.digest == null || value.digest === `sha256:${digest}`), 'Actual release asset differs from its immutable selection.');
  return value;
}

export function fetchInput({ env = process.env, root = INPUT, execute = execFileSync } = {}) {
  const identity = inputIdentity(env);
  assert(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'Read-only own-repository GitHub token required.');
  mkdirSync(root, { recursive: true });
  const api = (id, binary, max) => execute('gh', ['api', ...(binary ? ['-H', 'Accept: application/octet-stream'] : []), `repos/${REPOSITORY}/releases/assets/${id}`], { timeout: 180000, maxBuffer: max, stdio: ['ignore', 'pipe', 'pipe'] });
  const metadataBytes = api(identity.metadataAssetId, true, MAX_JSON_BYTES);
  const info = validateBuildInfo(metadataBytes, identity);
  const metadataAsset = strictJson(api(identity.metadataAssetId, false, MAX_JSON_BYTES).toString('utf8'));
  validateAsset(metadataAsset, { id: identity.metadataAssetId, name: 'build-info.json', size: metadataBytes.length, digest: identity.metadataSha256 });
  const apkAsset = strictJson(api(identity.apkAssetId, false, MAX_JSON_BYTES).toString('utf8'));
  validateAsset(apkAsset, { id: identity.apkAssetId, name: ASSET_NAME, size: info.apkBytes, digest: identity.apkSha256 });
  const apk = api(identity.apkAssetId, true, 512 * 1024 ** 2);
  assert(apk.length === info.apkBytes && sha(apk) === identity.apkSha256 && apk.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])), 'Downloaded APK bytes differ.');
  writeFileSync(join(root, ASSET_NAME), apk);
  writeFileSync(join(root, 'build-info.json'), metadataBytes);
  writeFileSync(join(root, 'selection.json'), JSON.stringify(identity, null, 2));
  process.stdout.write(`ANDROID_APP_INPUT_VERIFIED source=${identity.sourceCommit} sha256=${identity.apkSha256}\n`);
  return { identity, info };
}

/** Original public-domain synthetic PDF, independent of the application renderer. */
export function fixturePdf(phrase = PHRASE) {
  assert([PHRASE, SECOND_PHRASE].includes(phrase), 'Only fixed synthetic search phrases are permitted.');
  const stream = `q\n1 0.03 0.10 rg\n70 110 32 32 re f\n0.05 0.13 1 rg\n170 110 32 32 re f\nQ\nBT /F1 13 Tf 24 170 Td (${phrase}) Tj 0 -20 Td (Synthetic local PDF. No personal data.) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let text = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(text, 'ascii');
}

export function inspectSavedPdf(bytes) {
  assert(Buffer.isBuffer(bytes) && bytes.length >= 512 && bytes.length <= 2 * 1024 ** 2 && bytes.subarray(0, 8).toString('ascii').startsWith('%PDF-') && /%%EOF\s*$/.test(bytes.toString('latin1').slice(-1024)) && sha(bytes) !== sha(fixturePdf()), 'Save As did not produce a new bounded PDF.');
  const raw = bytes.toString('latin1'); const texts = [raw];
  for (const match of raw.matchAll(/<<[^<>]*(?:<[^<>]*>[^<>]*)*>>\s*stream\r?\n/g)) {
    const start = match.index + match[0].length; const end = raw.indexOf('endstream', start);
    assert(end >= start && end - start <= 2 * 1024 ** 2, 'Saved PDF stream is malformed.');
    if (/\/FlateDecode\b/.test(match[0])) texts.push(inflateSync(bytes.subarray(start, end), { maxOutputLength: 4 * 1024 ** 2 }).toString('latin1'));
  }
  const expanded = texts.join('\n');
  assert(expanded.includes(PHRASE) && /\/Type\s*\/Page\b/.test(expanded) && /\/Rotate\s+90\b/.test(expanded) && !/\/Rotate\s+(?:180|270)\b/.test(expanded), 'Saved PDF does not preserve the synthetic text and actual 90 degree page edit.');
  return { bytes: bytes.length, sha256: sha(bytes), rotation: 90, phrase: PHRASE };
}

const crcTable = Array.from({ length: 256 }, (_, value) => { for (let index = 0; index < 8; index++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
export function pngCrc(bytes) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8; return (value ^ 0xffffffff) >>> 0; }

export function decodePng(png) {
  assert(Buffer.isBuffer(png) && png.length >= 80 && png.length <= 16 * 1024 ** 2 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Not complete screenshot PNG bytes.');
  let offset = 8; let header; let ended = false; const parts = [];
  while (offset + 12 <= png.length) {
    const count = png.readUInt32BE(offset); const type = png.toString('ascii', offset + 4, offset + 8); const stop = offset + count + 12;
    assert(count <= png.length && stop <= png.length && pngCrc(png.subarray(offset + 4, stop - 4)) === png.readUInt32BE(stop - 4), 'Screenshot PNG chunk checksum differs.');
    const data = png.subarray(offset + 8, stop - 4);
    if (type === 'IHDR') { assert(!header && offset === 8 && count === 13, 'Duplicate PNG header.'); header = data; }
    else if (type === 'IDAT') parts.push(data);
    else if (type === 'IEND') { assert(count === 0 && stop === png.length, 'Invalid PNG end.'); ended = true; }
    offset = stop;
  }
  assert(header && ended && parts.length && offset === png.length, 'Truncated screenshot PNG.');
  const width = header.readUInt32BE(0); const height = header.readUInt32BE(4); const channels = header[9] === 2 ? 3 : header[9] === 6 ? 4 : 0;
  assert(width >= 300 && width <= 2048 && height >= 300 && height <= 4096 && header[8] === 8 && channels && header[10] === 0 && header[11] === 0 && header[12] === 0, 'Unsupported actual screenshot pixel format.');
  const stride = width * channels; const size = (stride + 1) * height;
  const raw = inflateSync(Buffer.concat(parts), { maxOutputLength: size });
  assert(raw.length === size, 'Screenshot scanline bytes differ.');
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; assert(filter <= 4, 'Invalid screenshot filter.');
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x; const left = x >= channels ? pixels[index - channels] : 0; const up = y ? pixels[index - stride] : 0; const upperLeft = y && x >= channels ? pixels[index - stride - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) { const p = left + up - upperLeft; const a = Math.abs(p - left); const b = Math.abs(p - up); const c = Math.abs(p - upperLeft); predictor = a <= b && a <= c ? left : b <= c ? up : upperLeft; }
      pixels[index] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

export function pdfMarkers(png, orientation) {
  assert(['horizontal', 'vertical'].includes(orientation), 'Explicit PDF marker orientation required.');
  const { width, height, channels, pixels } = decodePng(png);
  const markers = [{ count: 0, x: 0, y: 0 }, { count: 0, x: 0, y: 0 }];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * channels; const [r, g, b] = pixels.subarray(offset, offset + 3);
    const index = r > 210 && g < 60 && b < 90 ? 0 : b > 220 && r < 60 && g < 80 ? 1 : -1;
    if (index >= 0) { markers[index].count++; markers[index].x += x; markers[index].y += y; }
  }
  assert(markers.every((marker) => marker.count >= 150), 'Actual rendered synthetic PDF color markers are missing.');
  const [red, blue] = markers.map((marker) => ({ count: marker.count, x: marker.x / marker.count, y: marker.y / marker.count }));
  const dx = Math.abs(blue.x - red.x); const dy = Math.abs(blue.y - red.y);
  assert(orientation === 'horizontal' ? dx >= 30 && dx > 3 * dy : dy >= 30 && dy > 3 * dx, 'Actual PDF pixels do not show the expected page rotation.');
  return { width, height, red, blue, orientation };
}

function unescapeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity) => {
    if (entity.startsWith('#')) { const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)); assert(point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff), 'Invalid XML code point.'); return String.fromCodePoint(point); }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity];
  });
}

export function uiNodes(xml) {
  assert(typeof xml === 'string' && Buffer.byteLength(xml) <= 2 * 1024 ** 2 && xml.includes('<hierarchy') && xml.includes('</hierarchy>') && !/<!DOCTYPE|<!ENTITY/i.test(xml), 'Actual bounded UI hierarchy required.');
  return [...xml.matchAll(/<node\b([^>]*?)\/?\s*>/g)].map((match) => {
    const node = {};
    for (const attribute of match[1].matchAll(/([\w:-]+)="([^"<>]*)"/g)) { assert(!Object.hasOwn(node, attribute[1]), 'Duplicate UI attribute.'); node[attribute[1]] = unescapeXml(attribute[2]); }
    const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(node.bounds ?? '');
    if (bounds) node.rect = bounds.slice(1).map(Number);
    return node;
  });
}

export function selectNode(nodes, label, { editable = false, packageName = APP, width = 720, height = 1280, exact = true } = {}) {
  assert(typeof label === 'string' && label.length > 0 && label.length <= 256, 'Bounded selector label required.');
  const matches = nodes.filter((node) => node.package === packageName && node.enabled === 'true' && node.rect && node.rect[2] > node.rect[0] && node.rect[3] > node.rect[1]
    && node.rect[0] < width && node.rect[1] < height && node.rect[2] <= width && node.rect[3] <= height
    && (!editable || /EditText$/.test(node.class ?? ''))
    && [node.text, node['content-desc'], node.hint].some((value) => typeof value === 'string' && (exact ? value.toLocaleLowerCase() === label.toLocaleLowerCase() : value.toLocaleLowerCase().includes(label.toLocaleLowerCase()))));
  if (!matches.length) return null;
  const clickable = matches.filter((node) => node.clickable === 'true');
  const selected = clickable.length ? clickable : matches;
  const locations = new Set(selected.map((node) => node.rect.join(',')));
  assert(locations.size === 1, `Ambiguous actual UI selector: ${label}`);
  return selected[0];
}

/** The public smoke proves the native entry only, never an authenticated session.
 * A hosted provider form is deliberately a failing control for this receipt. */
export function validateNativeSignIn(nodes) {
  const own = nodes.filter((node) => node.package === APP);
  const button = selectNode(own, 'Sign in with anymize');
  assert(button && button.clickable === 'true'
    && ['native-sign-in-action', `${APP}:id/native-sign-in-action`].includes(button['resource-id'])
    && /^(?:android\.widget\.Button|android\.view\.View)$/.test(button.class ?? ''), 'Actual native anymize sign-in button is missing.');
  assert(!own.some((node) => /EditText$|WebView$/.test(node.class ?? '')
    || /florentin|continue with (?:google|microsoft)/i.test(`${node.text ?? ''} ${node['content-desc'] ?? ''}`)
    || [node.text, node['content-desc']].some((value) => /^(?:email address|password)$/i.test(value ?? ''))), 'Embedded provider credential UI must not appear in the native sign-in entry.');
  return { entry: 'first-party-native', action: 'Sign in with anymize', embeddedProviderForm: false, systemBrowserAcceptance: 'not-tested', authenticatedAccountAcceptance: false };
}

export function validateInstalledPackage(text, info) {
  const versions = [...text.matchAll(/^\s*versionCode=(\d+)\b/gm)]; const names = [...text.matchAll(/^\s*versionName=([^\r\n]+)$/gm)];
  assert(versions.length === 1 && Number(versions[0][1]) === info.versionCode && names.length === 1 && names[0][1].trim() === info.versionName && !/\bDEBUGGABLE\b/.test(text), 'Installed app version or release debug policy differs.');
}

export function launcherComponent(badging) {
  const entries = [...badging.matchAll(/^launchable-activity: name='([^']+)'/gm)];
  assert(entries.length === 1 && entries[0][1] === `${APP}.MainActivity`, 'Exact APK must expose its normal launcher activity.');
  return `${APP}/.MainActivity`;
}

export function validateLauncherStart(text) {
  assert(/^Status: ok\s*$/m.test(text) && !/^Error:|^Status: (?!ok)/m.test(text), 'Actual launcher activity did not start successfully.');
  return text;
}

export function installedApkPath(text) {
  assert(typeof text === 'string' && text.split(/\r?\n/).length === 1 && /^package:\/data\/app\/[A-Za-z0-9_~\-/+=.]+\/base\.apk$/.test(text) && !text.includes('/../'), 'Actual standalone installed APK path unavailable.');
  return text.slice(8);
}

/** Independently parse the single preview signer, including SDK37 range labels.
 * Grammar: AOSP tools/apksig android17-release ApkSignerTool printCertificate.
 * https://android.googlesource.com/platform/tools/apksig/+/refs/heads/android17-release/src/apksigner/java/com/android/apksigner/ApkSignerTool.java
 */
export function signingCertificate(text) {
  assert(typeof text === 'string' && Buffer.byteLength(text) <= 1048576, 'Bounded actual signature verification output required.');
  const lines = text.split(/\r?\n/); const counts = lines.filter((line) => /^Number of signers:/.test(line));
  assert(counts.length === 1 && counts[0] === 'Number of signers: 1', 'Expected exactly one declared APK signer.');
  const digests = new Set();
  for (const line of lines) {
    if (!/certificate SHA-?256 digest:/i.test(line)) continue;
    const certificate = /^(.+) certificate SHA-256 digest: ([0-9a-f]{64})$/i.exec(line);
    assert(certificate, 'Malformed actual signing certificate line.');
    const label = certificate[1];
    if (label === 'Source Stamp Signer' || label === 'Source Stamp Signer:') continue;
    const ordinary = ['Signer #1', 'Signer:', 'V1 Signer:', 'V2 Signer:', 'V3.0 Signer:'].includes(label) || /^(?:V1 |V2 |V3\.0 )?Signer #1:$/.test(label);
    const range = /^(?:Signer|V3\.[01] Signer:) \(minSdkVersion=(\d+)(?: \(dev release=true\))?, maxSdkVersion=(\d+)\)$/.exec(label);
    assert(ordinary || range && Number.isSafeInteger(Number(range[1])) && Number.isSafeInteger(Number(range[2])) && Number(range[1]) <= Number(range[2]), 'Unsupported or contradictory actual signer identity.');
    digests.add(certificate[2].toLowerCase());
  }
  assert(digests.size === 1, 'Actual verification must contain one distinct APK signing certificate.');
  return [...digests][0];
}

export function assertRuntimeHealthy(events, system, runtime, packageName = APP) {
  assertNoAnr(events, system);
  assert(!new RegExp(`Process: ${packageName.replaceAll('.', '\\.')}\\b`).test(runtime) && !/\bFATAL EXCEPTION\b|\bFatal signal\s+\d/i.test(runtime), 'Actual AndroidRuntime crash observed.');
}

export function validateNativeEdges(result, identity) {
  assert(result?.schemaVersion === 1 && result.status === 'passed' && result.scope === 'real-granted-provider-and-intent-lifecycle-only' && result.apkSha256 === identity.apkSha256 && result.appSourceCommit === identity.sourceCommit && Array.isArray(result.cases) && result.cases.length === 2, 'Incomplete real native edge receipt.');
  const [intent, stalled] = result.cases;
  assert(intent.id === 'cold-a-warm-b-foreground' && intent.status === 'passed' && /^[1-9]\d*$/.test(intent.coldPid ?? '') && intent.foregroundPid === intent.coldPid && intent.activeFile === 'anymize-smoke-second.pdf' && intent.activePhrase === SECOND_PHRASE && intent.hubOriginalCount === 1 && intent.hubSecondCount === 1, 'Cold/warm/foreground PDF identity or duplicate-file proof failed.');
  assert(stalled.id === 'stalled-provider-preserves-b-and-recovers' && stalled.status === 'passed' && Number.isSafeInteger(stalled.noticeAfterMs) && stalled.noticeAfterMs >= 28000 && stalled.noticeAfterMs <= 45000 && stalled.priorFile === intent.activeFile && stalled.priorPhrase === SECOND_PHRASE && stalled.priorPdfRetained === true && stalled.recoveryFile === 'anymize-smoke-fixture.pdf' && stalled.recoveryPhrase === PHRASE, 'Real 30-second bounded provider recovery proof failed.');
  return result;
}

function disposableRunner(env) {
  assert(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.RUNNER_OS === 'Linux' && env.GITHUB_REPOSITORY === REPOSITORY && hex(env.GITHUB_SHA, 40) && positiveId(env.GITHUB_RUN_ID), 'APK execution requires a fresh official disposable own-repository Linux runner.');
}

function runner(env) { disposableRunner(env); return validateExpectedIdentity(env); }

export function validateFixtureBadging(text) {
  const packages = [...text.matchAll(/^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/gm)];
  const minima = [...text.matchAll(/^(?:sdkVersion|minSdkVersion):'([^']+)'\s*$/gm)];
  const targets = [...text.matchAll(/^targetSdkVersion:'([^']+)'\s*$/gm)];
  assert(packages.length === 1 && packages[0][1] === HELPER && packages[0][2] === '1' && packages[0][3] === '1.0'
    && minima.length === 1 && minima[0][1] === '35' && targets.length === 1 && targets[0][1] === '35' && /^application-debuggable\b/m.test(text), 'Actual compiled synthetic helper package/SDK/debug identity differs.');
}

export function buildFixture({ env = process.env, output = OUTPUT, execute = execFileSync } = {}) {
  disposableRunner(env); mkdirSync(output, { recursive: true }); let phase = 'toolchain'; const commands = [];
  try {
    assert(env.ANDROID_HOME && env.JAVA_HOME, 'Installed pinned Android and Java toolchains required.');
    const sdk = realpathSync(env.ANDROID_HOME); const buildTools = join(sdk, 'build-tools', '37.0.0');
    const androidJar = join(sdk, 'platforms', 'android-35', 'android.jar');
    assert(existsSync(androidJar), 'Real platform35 compile jar required.');
    const buildProperties = regular(join(buildTools, 'source.properties'), 16384).toString('utf8');
    const platformProperties = regular(join(sdk, 'platforms', 'android-35', 'source.properties'), 16384).toString('utf8');
    assert(/^Pkg\.Revision\s*=\s*37\.0\.0\s*$/m.test(buildProperties) && /^AndroidVersion\.ApiLevel\s*=\s*35\s*$/m.test(platformProperties), 'Actual SDK compiler revision differs.');
    writeFileSync(join(output, 'helper-compile-sdk-properties.txt'), `${buildProperties}\n${platformProperties}`);
    const root = resolve(output, 'fixture-build'); assert(!existsSync(root), 'Synthetic helper requires a fresh build directory.');
    mkdirSync(join(root, 'classes'), { recursive: true }); mkdirSync(join(root, 'dex')); mkdirSync(join(root, 'assets'));
    const invoke = (name, file, args, extension = 'txt') => {
      phase = name;
      const bytes = execute(file, args, { timeout: 120000, maxBuffer: 2 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'] });
      const evidence = `helper-compile-${name}.${extension}`; writeFileSync(join(output, evidence), bytes);
      commands.push({ phase: name, evidence, bytes: bytes.length, sha256: sha(bytes) }); return bytes;
    };
    const java = (name) => join(env.JAVA_HOME, 'bin', name); const android = (name) => join(buildTools, name);
    const compiler = invoke('javac-version', java('javac'), ['-version']).toString('utf8').trim();
    assert(/^javac 17\./.test(compiler), 'Pinned Java17 compiler required.');
    writeFileSync(join(root, 'assets', 'fixture.pdf'), fixturePdf());
    writeFileSync(join(root, 'assets', 'fixture-second.pdf'), fixturePdf(SECOND_PHRASE));
    invoke('javac', java('javac'), ['-encoding', 'UTF-8', '-source', '17', '-target', '17', '-classpath', androidJar, '-d', join(root, 'classes'), join(FIXTURES, 'GrantActivity.java'), join(FIXTURES, 'FixtureProvider.java')]);
    invoke('classes', java('jar'), ['--create', '--file', join(root, 'classes.jar'), '-C', join(root, 'classes'), '.']);
    invoke('d8', android('d8'), ['--release', '--min-api', '35', '--lib', androidJar, '--output', join(root, 'dex'), join(root, 'classes.jar')]);
    invoke('aapt-link', android('aapt2'), ['link', '-I', androidJar, '--manifest', join(FIXTURES, 'AndroidManifest.xml'), '-A', join(root, 'assets'), '-o', join(root, 'unsigned.apk')]);
    invoke('dex-package', java('jar'), ['--update', '--file', join(root, 'unsigned.apk'), '-C', join(root, 'dex'), 'classes.dex']);
    invoke('zipalign', android('zipalign'), ['-f', '-p', '4', join(root, 'unsigned.apk'), join(root, 'aligned.apk')]);
    invoke('synthetic-key', java('keytool'), ['-genkeypair', '-noprompt', '-keystore', join(root, 'synthetic.keystore'), '-storepass', 'android', '-keypass', 'android', '-alias', 'synthetic', '-dname', 'CN=Synthetic PDF Fixture', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2']);
    const certificate = invoke('certificate', java('keytool'), ['-exportcert', '-keystore', join(root, 'synthetic.keystore'), '-storepass', 'android', '-alias', 'synthetic'], 'der');
    const apk = resolve(output, 'synthetic-fixture.apk');
    invoke('sign', android('apksigner'), ['sign', '--ks', join(root, 'synthetic.keystore'), '--ks-key-alias', 'synthetic', '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', apk, join(root, 'aligned.apk')]);
    const signature = invoke('signature', android('apksigner'), ['verify', '--verbose', '--print-certs', apk]).toString('utf8');
    assert(signingCertificate(signature) === sha(certificate), 'Actual helper APK certificate differs from its generated synthetic key.');
    const badging = invoke('badging', android('aapt2'), ['dump', 'badging', apk]).toString('utf8'); validateFixtureBadging(badging);
    invoke('manifest', android('aapt2'), ['dump', 'xmltree', apk, '--file', 'AndroidManifest.xml']);
    const apkBytes = regular(apk, 2 * 1024 ** 2);
    const source = { fixtureSha256: sha(fixturePdf()), secondFixtureSha256: sha(fixturePdf(SECOND_PHRASE)), sources: ['AndroidManifest.xml', 'GrantActivity.java', 'FixtureProvider.java'].map((name) => ({ name, sha256: sha(regular(join(FIXTURES, name), 65536)) })), apkSha256: sha(apkBytes) };
    writeFileSync(join(output, 'fixture-source.json'), JSON.stringify(source, null, 2));
    writeFileSync(join(output, 'helper-compile-result.json'), JSON.stringify({ schemaVersion: 1, status: 'built-and-verified', scope: 'public-synthetic-helper-only-no-application-or-os-acceptance', repository: env.GITHUB_REPOSITORY, commit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, compiler, buildTools: '37.0.0', platform: '35', package: HELPER, apkBytes: apkBytes.length, ...source, signingCertificateSha256: sha(certificate), commands }, null, 2));
    process.stdout.write(`ANDROID_SYNTHETIC_HELPER_COMPILED source=${env.GITHUB_SHA} sha256=${source.apkSha256}\n`);
    return apk;
  } catch (error) {
    writeFileSync(join(output, 'helper-compile-failure.json'), JSON.stringify({ schemaVersion: 1, status: 'failed', repository: env.GITHUB_REPOSITORY, commit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, phase, message: String(error.message).slice(0, 8000), commands }, null, 2));
    throw error;
  }
}

/** Historical free-PDF orchestration retained for regression simulations only.
 * The CLI and new publication contract exclusively use the paid-entry check. */
export async function runLegacyPdfSmoke({ env = process.env, input = INPUT, root = OUTPUT, baselineRoot = 'artifacts/baseline', execute = execFileSync, now = Date.now, pause = sleep, output = (text) => process.stdout.write(text) } = {}) {
  assert(execute !== execFileSync, 'Historical free-PDF harness is disabled for real execution; use the current paid-entry smoke.');
  const os = runner(env); const identity = inputIdentity(env);
  const info = validateBuildInfo(regular(join(input, 'build-info.json'), MAX_JSON_BYTES), identity);
  const apkPath = resolve(input, ASSET_NAME); const apk = regular(apkPath, 512 * 1024 ** 2);
  assert(apk.length === info.apkBytes && sha(apk) === identity.apkSha256, 'Local selected APK differs.');
  mkdirSync(root, { recursive: true }); const files = []; const stages = []; let sequence = 0;
  const adb = (args, timeout = 30000) => execute('adb', ['-s', 'emulator-5554', ...args], { timeout, maxBuffer: 20 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'] });
  const shell = (...args) => adb(['shell', ...args]).toString('utf8').trim();
  // Launchers resolve MAIN/LAUNCHER and then use an explicit component. A plain
  // am start -p is implicit and also requires CATEGORY_DEFAULT, which launcher
  // filters intentionally lack. Keep the binary's launcher check compulsory.
  let mainComponent;
  const launchMain = () => {
    assert(mainComponent, 'Verified APK launcher required before starting.');
    return validateLauncherStart(shell('am','start','-W','-a','android.intent.action.MAIN','-c','android.intent.category.LAUNCHER','-n',mainComponent));
  };
  const store = (name, bytes) => { const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes); writeFileSync(join(root, name), buffer); files.push({ name, bytes: buffer.length, sha256: sha(buffer) }); return buffer; };
  const health = () => {
    const events = shell('logcat', '-b', 'events', '-d', '-v', 'threadtime'); const system = shell('logcat', '-b', 'system', '-d', '-v', 'threadtime'); const runtime = shell('logcat', '-b', 'crash', '-d', '-v', 'threadtime');
    try { assertRuntimeHealthy(events, system, runtime); } catch (error) { store(`health-failure-${++sequence}.json`, JSON.stringify({ events, system, runtime })); throw error; }
    return { events, system, runtime };
  };
  const dump = () => {
    // Never reuse an older hierarchy when UiAutomation has no idle root yet.
    shell('rm','-f','/sdcard/anymize-app-smoke.xml');
    const status = shell('uiautomator', 'dump', '/sdcard/anymize-app-smoke.xml');
    if (!/UI hier(?:archy|chary) dumped to: \/sdcard\/anymize-app-smoke\.xml\s*$/.test(status) || /ERROR:/i.test(status)) {
      store(`ui-not-ready-${++sequence}.txt`,status);
      const error = new Error('Actual UI hierarchy is not ready');error.code='UI_NOT_READY';throw error;
    }
    const xml = shell('cat', '/sdcard/anymize-app-smoke.xml'); return { xml, nodes: uiNodes(xml) };
  };
  const screenshot = (name) => { const png = adb(['exec-out', 'screencap', '-p']); decodePng(png); store(name, png); return png; };
  const focused = () => {
    const activity = shell('dumpsys', 'activity', 'activities');
    assert(activity.split(/\r?\n/).some((line) => /\b(?:mResumedActivity|topResumedActivity)\b/.test(line) && line.includes(`${APP}/`)), 'Actual application is not resumed.');
    return activity;
  };
  const capture = (name, tree = dump(), selectedPng = null, primaryStage = true) => { health(); focused(); store(`${name}.xml`, tree.xml); const png = selectedPng ? store(`${name}.png`, selectedPng) : screenshot(`${name}.png`); if (primaryStage) stages.push({ name, at: new Date(now()).toISOString() }); return { ...tree, png }; };
  const swipe = (direction) => shell('input', 'swipe', '360', direction === 'down' ? '1030' : '380', '360', direction === 'down' ? '380' : '1030', '400');
  const find = async (label, { editable = false, scroll = false, timeout = scroll ? 120000 : 45000, exact = true, packageName = APP } = {}) => {
    const until = now() + timeout; let attempts = 0;
    while (now() < until) {
      health(); let tree;
      try { tree = dump(); }
      catch (error) { if(error.code!=='UI_NOT_READY')throw error;await pause(1000);continue; }
      const node = selectNode(tree.nodes, label, { editable, exact, packageName });
      if (node) return { node, tree };
      if (scroll && attempts < 12) swipe(attempts < 3 || attempts >= 9 ? 'up' : 'down');
      attempts++; await pause(1000);
    }
    const failed = dump(); store(`missing-selector-${++sequence}.xml`, failed.xml); screenshot(`missing-selector-${sequence}.png`); throw new Error(`Actual enabled UI control unavailable: ${label}`);
  };
  const tap = async (label, options) => { const { node, tree } = await find(label, options); const [x1, y1, x2, y2] = node.rect; shell('input', 'tap', String(Math.floor((x1 + x2) / 2)), String(Math.floor((y1 + y2) / 2))); return tree; };
  const waitText = async (label, options = {}) => find(label, { ...options, exact: false });
  const render = async (name, orientation, primaryStage = true) => {
    const until = now() + 60000; let attempts = 0; let last;
    while (now() < until) {
      focused(); health(); const png = screenshot(`${name}-attempt-${++attempts}.png`);
      let markers;
      try { markers = pdfMarkers(png, orientation); } catch (error) { last = error; }
      if (markers) { store(`${name}-markers.json`, JSON.stringify(markers, null, 2)); return capture(name, dump(), png, primaryStage); }
      swipe(attempts <= 6 ? 'down' : 'up'); await pause(1200);
    }
    throw new Error(`${name}: ${last?.message ?? 'Actual PDF pixels unavailable.'}`);
  };
  const grant = (kind) => shell('am', 'start', '-W', '-n', `${HELPER}/.GrantActivity`, '--es', 'fixture', kind);
  const searchFor = async (phrase) => {
    await tap('Find text', { editable: true, scroll: true });
    shell('input', 'keyevent', 'KEYCODE_MOVE_END', ...Array.from({length: 20}, () => 'KEYCODE_DEL'));
    shell('input', 'text', phrase); shell('input', 'keyevent', 'KEYCODE_ENTER');
    const ime = shell('dumpsys', 'input_method'); if (/mInputShown=true\b/.test(ime) || /mIsInputViewShown=true\b/.test(ime)) shell('input', 'keyevent', 'KEYCODE_BACK');
    return waitText(`Page 1: ${phrase}`, { scroll: true });
  };
  const nativeEdges = async (previousPid) => {
    const edgeStart = files.length;
    shell('am', 'force-stop', APP);
    assert(!shell('ps', '-A', '-o', 'PID,NAME').split(/\r?\n/).some((line) => line.trim().split(/\s+/).at(-1) === APP), 'Edge cold-start process did not stop.');
    store('native-edge-cold-a-launch.txt', grant('original'));
    await waitText('anymize-smoke-fixture.pdf', {timeout:120000,scroll:true}); await render('native-edge-cold-a','horizontal',false);
    const coldPid=shell('pidof',APP); assert(/^[1-9]\d*$/.test(coldPid) && coldPid!==previousPid, 'Edge cold A did not create a fresh app process.');
    store('native-edge-warm-b-launch.txt',grant('second'));
    await waitText('anymize-smoke-second.pdf',{scroll:true});await searchFor(SECOND_PHRASE);await render('native-edge-warm-b','horizontal',false);
    shell('input','keyevent','KEYCODE_HOME');await pause(1000);
    store('native-edge-foreground-launch.txt',launchMain());
    await waitText('anymize-smoke-second.pdf',{scroll:true});await searchFor(SECOND_PHRASE);await render('native-edge-foreground-b','horizontal',false);
    const foregroundPid=shell('pidof',APP);assert(foregroundPid===coldPid,'Foreground test changed the app process instead of testing live intent replay.');
    await tap('Workspace',{scroll:true});await find('anymize-smoke-fixture.pdf',{scroll:true});
    const hub=await find('anymize-smoke-second.pdf',{scroll:true});
    const count=(name)=>new Set(hub.tree.nodes.filter((node)=>node.package===APP && node.class==='android.widget.Button' && node.enabled==='true' && node.text===name && node.rect).map((node)=>node.rect.join(','))).size;
    const hubOriginalCount=count('anymize-smoke-fixture.pdf'),hubSecondCount=count('anymize-smoke-second.pdf');
    assert(hubOriginalCount===1 && hubSecondCount===1,'Cold/warm/foreground hub contains a missing or duplicated PDF.');capture('native-edge-hub-no-duplicates',hub.tree,null,false);
    await tap('anymize-smoke-second.pdf',{scroll:true});await waitText('anymize-smoke-second.pdf',{scroll:true});await render('native-edge-before-stall-b','horizontal',false);
    const started=now();store('native-edge-stall-launch.txt',grant('stall'));
    const remaining=45000-(now()-started);assert(remaining>0,'Stalled provider activation exceeded deadline.');
    const errorNotice=await find('This PDF could not be opened.',{exact:false,timeout:remaining});
    const noticeAfterMs=now()-started;assert(noticeAfterMs>=28000 && noticeAfterMs<=45000,'Provider did not produce the actual bounded 30-second idle-timeout notice.');
    capture('native-edge-stall-timeout',errorNotice.tree,null,false);
    await waitText('anymize-smoke-second.pdf',{scroll:true});await searchFor(SECOND_PHRASE);await render('native-edge-retained-b','horizontal',false);
    store('native-edge-valid-recovery-launch.txt',grant('original'));
    await waitText('anymize-smoke-fixture.pdf',{scroll:true});await searchFor(PHRASE);await render('native-edge-valid-recovery-a','horizontal',false);
    const result={schemaVersion:1,status:'passed',scope:'real-granted-provider-and-intent-lifecycle-only',repository:env.GITHUB_REPOSITORY,commit:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT,api:os.api,apkSha256:identity.apkSha256,appSourceCommit:identity.sourceCommit,cases:[{id:'cold-a-warm-b-foreground',status:'passed',coldPid,foregroundPid,activeFile:'anymize-smoke-second.pdf',activePhrase:SECOND_PHRASE,hubOriginalCount,hubSecondCount},{id:'stalled-provider-preserves-b-and-recovers',status:'passed',noticeAfterMs,priorFile:'anymize-smoke-second.pdf',priorPhrase:SECOND_PHRASE,priorPdfRetained:true,recoveryFile:'anymize-smoke-fixture.pdf',recoveryPhrase:PHRASE}],files:files.slice(edgeStart)};
    validateNativeEdges(result,identity);store('native-edge-result.json',JSON.stringify(result,null,2));return result;
  };
  try {
    const baseline = strictJson(regular(join(baselineRoot, 'result.json'), MAX_JSON_BYTES).toString('utf8'));
    assert(baseline.status === 'passed' && baseline.scope === 'real-emulator-os-only-no-app-acceptance' && baseline.commit === env.GITHUB_SHA && baseline.runId === env.GITHUB_RUN_ID && baseline.api === os.api && baseline.pageSize === os.pageSize, 'Fresh unchanged OS baseline must pass in this exact job before app acceptance.');
    store('selected-build-info.json', regular(join(input, 'build-info.json'), MAX_JSON_BYTES)); store('selected-input.json', JSON.stringify(identity, null, 2));
    const tools = join(env.ANDROID_HOME, 'build-tools', '37.0.0');
    const signature = execute(join(tools, 'apksigner'), ['verify', '--verbose', '--print-certs', apkPath], { timeout: 30000, maxBuffer: 1048576 }).toString('utf8');
    assert(signingCertificate(signature) === info.signingCertificateSha256, 'Actual selected APK signing certificate differs.'); store('apk-signature.txt', signature);
    const badging = execute(join(tools, 'aapt2'), ['dump', 'badging', apkPath], { timeout: 30000, maxBuffer: 1048576 }).toString('utf8');
    assert(badging.includes(`package: name='${APP}' versionCode='${info.versionCode}' versionName='${info.versionName}'`) && !/^application-debuggable\b/m.test(badging), 'Selected APK release package metadata or debug flag differs.'); store('apk-badging.txt', badging);
    mainComponent = launcherComponent(badging);
    store('app-install.txt', adb(['install', '--no-streaming', apkPath], 120000));
    store('helper-install.txt', adb(['install', '-t', resolve(root, 'synthetic-fixture.apk')], 120000));
    const installed = shell('dumpsys', 'package', APP); validateInstalledPackage(installed, info); store('installed-package.txt', installed);
    const uidOutput = shell('pm', 'list', 'packages', '-U', APP); const uidMatch = new RegExp(`^package:${APP.replaceAll('.', '\\.')} uid:([1-9]\\d*)$`).exec(uidOutput); assert(uidMatch && Number(uidMatch[1]) >= 10000, 'Actual installed app UID missing.'); store('installed-uid.txt', uidOutput);
    const pathOutput = shell('pm', 'path', APP); const deviceApkPath = installedApkPath(pathOutput); store('installed-path.txt', pathOutput);
    const installedCopy = resolve(root, 'installed-base.apk'); adb(['pull', deviceApkPath, installedCopy], 120000); assert(sha(regular(installedCopy, 512 * 1024 ** 2)) === identity.apkSha256, 'Installed device APK bytes differ from immutable asset.');
    // Keep artifact uploads to allowlisted evidence; a second installer copy is unnecessary.
    store('installed-apk-identity.json', JSON.stringify({ sha256: identity.apkSha256, bytes: info.apkBytes, uid: Number(uidMatch[1]) }, null, 2));
    store('initial-launch.txt',launchMain());
    await waitText('Your workspace', { timeout: 120000 }); capture('01-local-hub');
    const firstPid = shell('pidof', APP); assert(/^[1-9]\d*$/.test(firstPid), 'Actual app PID missing.'); store('app-pid-before.txt', firstPid);
    const sockets = shell('cat', '/proc/net/unix'); assert(!new RegExp(`webview_devtools_remote_${firstPid}(?:\\s|$)`).test(sockets), 'Release WebView debugging socket unexpectedly exposed.'); store('release-webview-debugging.json', JSON.stringify({ appPid: firstPid, devtoolsSocketForApp: false }));
    // All PDF operations below run with real guest networking disabled.
    store('wifi-disable.txt', shell('svc', 'wifi', 'disable')); store('data-disable.txt', shell('svc', 'data', 'disable'));
    let connectivity = ''; const offlineUntil = now() + 30000;
    do { connectivity = shell('dumpsys', 'connectivity'); if (/Active default network:\s*none\b/.test(connectivity)) break; await pause(500); } while (now() < offlineUntil);
    store('offline-connectivity.txt', connectivity);
    assert(/Active default network:\s*none\b/.test(connectivity), 'Guest is not actually offline for local PDF proof.');
    store('original-granted-launch.txt', grant('original'));
    await waitText('anymize-smoke-fixture.pdf', { timeout: 120000 }); await waitText('Unchanged file', { scroll: true });
    await render('02-original-pdf', 'horizontal');
    await tap('Find text', { editable: true, scroll: true }); shell('input', 'text', PHRASE); shell('input', 'keyevent', 'KEYCODE_ENTER');
    const ime = shell('dumpsys', 'input_method'); if (/mInputShown=true\b/.test(ime) || /mIsInputViewShown=true\b/.test(ime)) shell('input', 'keyevent', 'KEYCODE_BACK');
    await waitText(`Page 1: ${PHRASE}`, { scroll: true }); capture('03-search-match');
    await tap('Rotate page', { scroll: true }); await waitText('Unsaved changes', { scroll: true }); await render('04-rotated-pdf', 'vertical');
    shell('rm', '-f', '/sdcard/Download/anymize-smoke-fixture.pdf');
    await tap('Save a copy', { scroll: true });
    const pickerUntil = now() + 45000; let picker;
    while (now() < pickerUntil) { health(); picker = dump(); if (picker.nodes.some((node) => ['com.google.android.documentsui', 'com.android.documentsui'].includes(node.package))) break; await pause(1000); }
    const pickerPackage = picker?.nodes.find((node) => ['com.google.android.documentsui', 'com.android.documentsui'].includes(node.package))?.package;
    assert(pickerPackage, 'Native Android Save As picker did not open.'); store('05-save-picker.xml', picker.xml); screenshot('05-save-picker.png'); stages.push({ name: '05-save-picker', at: new Date(now()).toISOString() });
    const drawer = picker.nodes.find((node) => node.package === pickerPackage && node.enabled === 'true' && /Show roots|Navigate up/i.test(node['content-desc'] ?? '') && node.rect && node.rect[2] > node.rect[0] && node.rect[3] > node.rect[1]);
    if (drawer) { const [x1,y1,x2,y2] = drawer.rect; shell('input', 'tap', String(Math.floor((x1+x2)/2)), String(Math.floor((y1+y2)/2))); await pause(500); }
    await tap('Downloads', { packageName: pickerPackage, timeout: 15000 });
    await tap('Save', { packageName: pickerPackage, timeout: 15000 });
    const savedNotice = await waitText('Copy saved', { timeout: 45000, scroll: true }); capture('06-saved-notice', savedNotice.tree);
    const savedPath = resolve(root, 'saved-copy.pdf'); adb(['pull', '/sdcard/Download/anymize-smoke-fixture.pdf', savedPath]); const saved = regular(savedPath, 2 * 1024 ** 2);
    const savedInfo = inspectSavedPdf(saved); store('saved-copy.pdf', saved); store('saved-copy-verification.json', JSON.stringify(savedInfo, null, 2));
    // Stage only synthetic output for a new legitimate read-only URI grant.
    adb(['push', savedPath, '/data/local/tmp/anymize-smoke-saved.pdf']); shell('chmod', '644', '/data/local/tmp/anymize-smoke-saved.pdf');
    shell('run-as', HELPER, 'cp', '/data/local/tmp/anymize-smoke-saved.pdf', 'files/saved.pdf');
    shell('am', 'force-stop', APP); assert(!shell('ps', '-A', '-o', 'PID,NAME').split(/\r?\n/).some((line) => line.trim().split(/\s+/).at(-1) === APP), 'App process survived force-stop.');
    store('saved-granted-relaunch.txt', grant('saved'));
    await waitText('anymize-smoke-saved.pdf', { timeout: 120000 }); await render('07-relaunched-saved-pdf', 'vertical');
    const secondPid = shell('pidof', APP); assert(/^[1-9]\d*$/.test(secondPid) && secondPid !== firstPid, 'Relaunch did not create a fresh real app process.'); store('app-pid-after.txt', secondPid);
    assert(!new RegExp(`webview_devtools_remote_${secondPid}(?:\\s|$)`).test(shell('cat', '/proc/net/unix')), 'Relaunched release WebView debugging socket unexpectedly exposed.');
    const nativeEdgeResult=await nativeEdges(secondPid);
    store('wifi-enable.txt', shell('svc', 'wifi', 'enable')); store('data-enable.txt', shell('svc', 'data', 'enable'));
    await tap('Workspace', { scroll: true }); await tap('Chat', { scroll: true });
    const login = await find('Sign in with anymize', { timeout: 120000, scroll: true });
    const nativeSignInEntry = validateNativeSignIn(login.tree.nodes);
    capture('08-native-sign-in-entry', login.tree);
    const finalPid=shell('pidof',APP);assert(finalPid===nativeEdgeResult.cases[0].coldPid,'App process changed after native edge proof.');
    assert(!new RegExp(`webview_devtools_remote_${finalPid}(?:\\s|$)`).test(shell('cat', '/proc/net/unix')), 'Cloud release WebView debugging socket unexpectedly exposed.');
    const finalHealth = health(); for (const [name, value] of Object.entries(finalHealth)) store(`final-${name}.txt`, value);
    store('final-activities.txt', focused());
    const result = { schemaVersion: 1, scope: 'real-current-apk-local-pdf-and-native-sign-in-entry-only', status: 'passed', ...os, repository: env.GITHUB_REPOSITORY, commit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, appSourceCommit: identity.sourceCommit, buildRunId: String(info.runId), apkSha256: identity.apkSha256, metadataSha256: identity.metadataSha256, versionName: info.versionName, versionCode: info.versionCode, applicationId: APP, signingCertificateSha256: info.signingCertificateSha256, uid: Number(uidMatch[1]), initialPid: firstPid, relaunchedPid: secondPid, finalPid, nativeEdges:'passed-separate-native-edge-result', nativeSignInEntry, offlinePdf: true, authenticatedAccountAcceptance: false, capturedAt: new Date(now()).toISOString(), stages, files: [...files] };
    store('result.json', JSON.stringify(result, null, 2)); output(`ANDROID_APP_SMOKE_PASSED api=${os.api} apk=${identity.apkSha256}\n`); return result;
  } catch (error) {
    const diagnosticErrors = [];
    for (const [name, args] of [['failure-events.txt', ['shell','logcat','-b','events','-d']], ['failure-system.txt', ['shell','logcat','-b','system','-d']], ['failure-crash.txt', ['shell','logcat','-b','crash','-d']], ['failure-runtime.txt', ['shell','logcat','-b','main','-d','-t','200','-s','ReactNativeJS:E','AndroidRuntime:E','Expo:E']], ['failure-activity.txt', ['shell','dumpsys','activity','activities']], ['failure-window.txt', ['shell','dumpsys','window','displays']], ['failure.png', ['exec-out','screencap','-p']]]) {
      try { store(name, adb(args, 15000)); } catch (diagnostic) { diagnosticErrors.push({ name, message: String(diagnostic.message).slice(0, 2000) }); }
    }
    try { store('failure.xml', dump().xml); } catch (diagnostic) { diagnosticErrors.push({ name: 'failure.xml', message: String(diagnostic.message).slice(0, 2000) }); }
    store('failure.json', JSON.stringify({ schemaVersion: 1, status: 'failed', ...os, identity, stages, message: String(error.message).slice(0, 4000), diagnosticErrors, files: [...files] }, null, 2)); throw error;
  }
}

export function validatePaidEntry(nodes) {
  const entry = validateNativeSignIn(nodes);
  assert(!nodes.some((node) => node.package === APP && (/WebView|EditText/.test(node.class ?? '')
    || (node.enabled === 'true' && node.clickable === 'true' && /^(?:Chat|Co-Workspace|Open PDF|Save a copy|Rotate page|Workspace|Your workspace)$/.test(node.text ?? ''))
    || /^(?:anymize-smoke-(?:fixture|second|stall|saved)\.pdf|Page 1:)/.test(node.text ?? ''))), 'Anonymous suite tool or document content is accessible.');
  return entry;
}
export function providerOpenCount(value) {
  assert(typeof value === 'string' && value.length <= 4096, 'Invalid synthetic provider witness.');
  const lines = value.trim().split(/\r?\n/);
  assert(lines.length >= 1 && lines.every((line) => /^open:\/(?:original|second|stall|saved)$/.test(line)), 'Missing or malformed positive provider witness.');
  return lines.length;
}

/** Real unchanged production APK, real OS UI/URI grants, no account or paid bypass.
 * This establishes anonymous denial only; it never certifies paid tool use. */
export async function runSmoke({ env = process.env, input = INPUT, root = OUTPUT, baselineRoot = 'artifacts/baseline', execute = execFileSync, now = Date.now, pause = sleep, output = (text) => process.stdout.write(text) } = {}) {
  const os = runner(env); const identity = inputIdentity(env);
  const info = validateBuildInfo(regular(join(input, 'build-info.json'), MAX_JSON_BYTES), identity);
  const apkPath = resolve(input, ASSET_NAME); const apk = regular(apkPath, 512 * 1024 ** 2);
  assert(apk.length === info.apkBytes && sha(apk) === identity.apkSha256, 'Local selected APK differs.');
  mkdirSync(root, { recursive: true }); const files = []; const stages = []; let sequence = 0;
  const adb = (args, timeout = 30000) => execute('adb', ['-s', 'emulator-5554', ...args], { timeout, maxBuffer: 20 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'] });
  const shell = (...args) => adb(['shell', ...args]).toString('utf8').trim();
  const store = (name, value) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); writeFileSync(join(root, name), bytes); files.push({ name, bytes: bytes.length, sha256: sha(bytes) }); };
  const health = () => { const result = {}; for (const buffer of ['events', 'system', 'crash']) result[buffer] = shell('logcat', '-b', buffer, '-d', '-v', 'threadtime'); assertRuntimeHealthy(result.events, result.system, result.crash); return result; };
  const focused = () => { const value = shell('dumpsys', 'activity', 'activities'); assert(value.split(/\r?\n/).some((line) => /\b(?:mResumedActivity|topResumedActivity)\b/.test(line) && line.includes(`${APP}/`)), 'Actual application is not resumed.'); return value; };
  const dump = () => {
    shell('rm', '-f', '/sdcard/anymize-app-smoke.xml');
    const value = shell('uiautomator', 'dump', '/sdcard/anymize-app-smoke.xml');
    if (!/UI hier(?:archy|chary) dumped to: \/sdcard\/anymize-app-smoke\.xml\s*$/.test(value) || /ERROR:/i.test(value)) { store(`ui-not-ready-${++sequence}.txt`, value); const error = new Error('Actual UI hierarchy is not ready'); error.code = 'UI_NOT_READY'; throw error; }
    const xml = shell('cat', '/sdcard/anymize-app-smoke.xml'); return { xml, nodes: uiNodes(xml) };
  };
  const entry = async (name) => {
    const until = now() + 120000;
    while (now() < until) {
      health(); let tree;
      try { tree = dump(); } catch (error) { if (error.code !== 'UI_NOT_READY') throw error; await pause(1000); continue; }
      // A visible product tool is always a failure, including while waiting for sign-in.
      assert(!tree.nodes.some((node) => node.package === APP && /^(?:Save a copy|Rotate page|Unchanged file|anymize-smoke-(?:fixture|second)\.pdf)$/.test(node.text ?? '')), 'Anonymous PDF tool or content is accessible.');
      if (selectNode(tree.nodes, 'Sign in with anymize')) {
        const proof = validatePaidEntry(tree.nodes); focused();
        const png = adb(['exec-out', 'screencap', '-p']); decodePng(png);
        store(`${name}.xml`, tree.xml); store(`${name}.png`, png); stages.push({ name, at: new Date(now()).toISOString() }); return proof;
      }
      await pause(1000);
    }
    throw new Error('Actual enabled native paid sign-in entry unavailable.');
  };
  const witness = () => providerOpenCount(shell('run-as', HELPER, 'cat', 'files/provider-opens.log'));
  const assertUnread = (name) => { const count = witness(); store(`${name}-provider.json`, JSON.stringify({ positiveControlOpens: 1, actualOpens: count, anonymousAdditionalOpens: count - 1 })); assert(count === 1, 'Anonymous app read the granted synthetic PDF.'); };
  const grant = (kind) => shell('am', 'start', '-W', '-n', `${HELPER}/.GrantActivity`, '--es', 'fixture', kind);
  try {
    const baseline = strictJson(regular(join(baselineRoot, 'result.json'), MAX_JSON_BYTES).toString('utf8'));
    assert(baseline.status === 'passed' && baseline.scope === 'real-emulator-os-only-no-app-acceptance' && baseline.commit === env.GITHUB_SHA && baseline.runId === env.GITHUB_RUN_ID && baseline.api === os.api && baseline.pageSize === os.pageSize, 'Fresh unchanged OS baseline must pass in this exact job before app acceptance.');
    store('selected-build-info.json', regular(join(input, 'build-info.json'), MAX_JSON_BYTES)); store('selected-input.json', JSON.stringify(identity));
    const tools = join(env.ANDROID_HOME, 'build-tools', '37.0.0');
    const signature = execute(join(tools, 'apksigner'), ['verify', '--verbose', '--print-certs', apkPath], { timeout: 30000, maxBuffer: 1048576 }).toString('utf8');
    assert(signingCertificate(signature) === info.signingCertificateSha256, 'Actual selected APK signing certificate differs.'); store('apk-signature.txt', signature);
    const badging = execute(join(tools, 'aapt2'), ['dump', 'badging', apkPath], { timeout: 30000, maxBuffer: 1048576 }).toString('utf8');
    assert(badging.includes(`package: name='${APP}' versionCode='${info.versionCode}' versionName='${info.versionName}'`) && !/^application-debuggable\b/m.test(badging), 'Selected APK release package metadata or debug flag differs.'); store('apk-badging.txt', badging);
    const component = launcherComponent(badging);
    const launch = () => validateLauncherStart(shell('am', 'start', '-W', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-n', component));
    store('app-install.txt', adb(['install', '--no-streaming', apkPath], 120000)); store('helper-install.txt', adb(['install', '-t', resolve(root, 'synthetic-fixture.apk')], 120000));
    const installed = shell('dumpsys', 'package', APP); validateInstalledPackage(installed, info); store('installed-package.txt', installed);
    const uidOutput = shell('pm', 'list', 'packages', '-U', APP); const uidMatch = new RegExp(`^package:${APP.replaceAll('.', '\\.')} uid:([1-9]\\d*)$`).exec(uidOutput); assert(uidMatch && Number(uidMatch[1]) >= 10000, 'Actual installed app UID missing.'); store('installed-uid.txt', uidOutput);
    const pathOutput = shell('pm', 'path', APP); const deviceApk = installedApkPath(pathOutput); store('installed-path.txt', pathOutput);
    const installedCopy = resolve(root, 'installed-base.apk'); adb(['pull', deviceApk, installedCopy], 120000); assert(sha(regular(installedCopy, 512 * 1024 ** 2)) === identity.apkSha256, 'Installed device APK bytes differ from immutable asset.');
    store('installed-apk-identity.json', JSON.stringify({ sha256: identity.apkSha256, bytes: info.apkBytes, uid: Number(uidMatch[1]) }));
    // Exercise the witness by a genuine read performed only by the synthetic helper.
    store('provider-positive-control.txt', shell('am', 'start', '-W', '-n', `${HELPER}/.GrantActivity`, '--es', 'fixture', 'original', '--ez', 'audit', 'true'));
    assert(witness() === 1, 'Real provider positive control must register exactly one open.');
    store('initial-launch.txt', launch()); const nativeSignInEntry = await entry('01-native-sign-in-entry');
    const firstPid = shell('pidof', APP); assert(/^[1-9]\d*$/.test(firstPid), 'Actual app PID missing.');
    const debugging = (pid) => { assert(!new RegExp(`webview_devtools_remote_${pid}(?:\\s|$)`).test(shell('cat', '/proc/net/unix')), 'Release WebView debugging socket unexpectedly exposed.'); };
    debugging(firstPid); assertUnread('initial');
    store('wifi-disable.txt', shell('svc', 'wifi', 'disable')); store('data-disable.txt', shell('svc', 'data', 'disable'));
    let connectivity = ''; const until = now() + 30000;
    do { connectivity = shell('dumpsys', 'connectivity'); if (/Active default network:\s*none\b/.test(connectivity)) break; await pause(500); } while (now() < until);
    store('offline-connectivity.txt', connectivity); assert(/Active default network:\s*none\b/.test(connectivity), 'Guest must actually be offline for denial proof.');
    await entry('02-offline-entry');
    store('warm-granted-launch.txt', grant('original')); await entry('03-warm-pdf-locked'); await pause(12000); health(); assertUnread('warm');
    shell('am', 'force-stop', APP); assert(!shell('ps', '-A', '-o', 'PID,NAME').split(/\r?\n/).some((line) => line.trim().split(/\s+/).at(-1) === APP), 'App process survived force-stop.');
    store('cold-granted-launch.txt', grant('original')); await entry('04-cold-pdf-locked');
    const secondPid = shell('pidof', APP); assert(/^[1-9]\d*$/.test(secondPid) && secondPid !== firstPid, 'Cold URI did not create a fresh app process.'); debugging(secondPid); assertUnread('cold');
    store('second-granted-launch.txt', grant('second')); await entry('05-second-pdf-locked'); await pause(12000); health(); assertUnread('second');
    shell('input', 'keyevent', 'KEYCODE_HOME'); store('foreground-launch.txt', launch()); await entry('06-foreground-locked');
    assert(shell('pidof', APP) === secondPid, 'Foreground proof must retain the cold URI process.'); assertUnread('foreground');
    store('wifi-enable.txt', shell('svc', 'wifi', 'enable')); store('data-enable.txt', shell('svc', 'data', 'enable'));
    await pause(12000); await entry('07-online-entry'); assertUnread('online'); debugging(secondPid);
    for (const [name, value] of Object.entries(health())) store(`final-${name}.txt`, value); store('final-activities.txt', focused());
    const result = { schemaVersion: 1, status: 'passed', scope: 'real-current-apk-paid-entry-and-anonymous-file-denial-only', ...os, repository: env.GITHUB_REPOSITORY, commit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, appSourceCommit: identity.sourceCommit, buildRunId: String(info.runId), apkSha256: identity.apkSha256, metadataSha256: identity.metadataSha256, versionName: info.versionName, versionCode: info.versionCode, applicationId: APP, signingCertificateSha256: info.signingCertificateSha256, uid: Number(uidMatch[1]), initialPid: firstPid, relaunchedPid: secondPid, finalPid: secondPid, nativeSignInEntry, paidAccess: { required: true, accountState: 'anonymous', anonymousToolsAccessible: false, anonymousPdfReadAttempts: 0, providerOpenPositiveControl: 1, offlineDenied: true, warmIncomingDenied: true, coldIncomingDenied: true, authenticatedPaidAcceptance: false }, offlinePdf: false, authenticatedAccountAcceptance: false, capturedAt: new Date(now()).toISOString(), stages, files: [...files] };
    store('result.json', JSON.stringify(result, null, 2)); output(`ANDROID_APP_SMOKE_PASSED api=${os.api} apk=${identity.apkSha256}\n`); return result;
  } catch (error) {
    const diagnosticErrors = [];
    for (const [name, args] of [['failure-events.txt', ['shell', 'logcat', '-b', 'events', '-d']], ['failure-system.txt', ['shell', 'logcat', '-b', 'system', '-d']], ['failure-crash.txt', ['shell', 'logcat', '-b', 'crash', '-d']], ['failure-runtime.txt', ['shell', 'logcat', '-b', 'main', '-d', '-t', '200', '-s', 'ReactNativeJS:E', 'AndroidRuntime:E', 'Expo:E']], ['failure-activity.txt', ['shell', 'dumpsys', 'activity', 'activities']], ['failure-window.txt', ['shell', 'dumpsys', 'window', 'displays']], ['failure.png', ['exec-out', 'screencap', '-p']]]) {
      try { store(name, adb(args, 15000)); } catch (diagnostic) { diagnosticErrors.push({ name, message: String(diagnostic.message).slice(0, 2000) }); }
    }
    try { store('failure.xml', dump().xml); } catch (diagnostic) { diagnosticErrors.push({ name: 'failure.xml', message: String(diagnostic.message).slice(0, 2000) }); }
    store('failure.json', JSON.stringify({ schemaVersion: 1, status: 'failed', ...os, identity, stages, message: String(error.message).slice(0, 4000), diagnosticErrors, files: [...files] }, null, 2)); throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv.length === 3, 'Use exactly --fetch, --compile-helper, --build-fixture or --run.');
    if (process.argv[2] === '--fetch') fetchInput();
    else if (['--compile-helper', '--build-fixture'].includes(process.argv[2])) buildFixture();
    else if (process.argv[2] === '--run') await runSmoke();
    else throw new Error('Unsupported smoke command.');
  } catch (error) { process.stderr.write(`Android app smoke failed: ${String(error.message).slice(0, 4000)}\n`); process.exitCode = 1; }
}
