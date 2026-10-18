import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { assertPrebootEnvironment, loadSourceBindings, startPreboot, validateSelectedDevice, validateSourceIdentity, verifyPrebootRuntime } from './ios-preboot.mjs';

// All local authority/OS inputs below are synthetic fixtures. They never grant
// product access or claim a real simulator, native app, or paid-account test.
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'anymize-GmbH/downloads', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'b'.repeat(40), ANYMIZE_EXPECTED_SOURCE_COMMIT: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
const device = { udid: '01234567-89AB-CDEF-0123-456789ABCDEF', name: 'iPhone Fixture', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5', state: 'Shutdown' };
const identity = { source: { repository: 'anymize-GmbH/anymize-apps', commit: env.ANYMIZE_EXPECTED_SOURCE_COMMIT, dirty: false, lockSha256: 'c'.repeat(64) },
  execution: { repository: env.GITHUB_REPOSITORY, commit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    runUrl: `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` } };
const clock = Date.parse('2026-10-18T22:00:00.000Z');
const clone = value => structuredClone(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'anymize-ios-preboot-'))), sourceRoot = join(root, 'source'), outputRoot = join(root, 'receipts');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const smoke = join(sourceRoot, 'scripts/ios/simulator-smoke.mjs'), authority = join(sourceRoot, 'scripts/unified/source-checkout.mjs');
  mkdirSync(dirname(smoke), { recursive: true }); mkdirSync(dirname(authority), { recursive: true });
  writeFileSync(smoke, `import { resolve } from 'node:path';import { fileURLToPath } from 'node:url';
export function selectAvailableIPhone(value){if(value.fixture!=='synthetic-shared-selector')throw new Error('selector input missing');return value.selectedDevice;}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))throw new Error('Synthetic CLI was invoked instead of inert import');\n`);
  writeFileSync(authority, `export function sourceCheckoutIdentity(root){if(root!==${JSON.stringify(sourceRoot)})throw new Error('wrong source root');return ${JSON.stringify(identity)};}\n`);
  const calls = [];
  const options = { sourceRoot, outputRoot, env: { ...env }, platform: 'darwin', now: () => clock,
    run(program, args, config) {
      calls.push({ program, args, config });
      return { status: 0, signal: null, stdout: args[1] === 'list' ? JSON.stringify({ fixture: 'synthetic-shared-selector', selectedDevice: clone(device) }) : '', stderr: '' };
    } };
  return { root, sourceRoot, outputRoot, smoke, authority, options, calls, preboot: join(outputRoot, 'preboot.json'), binding: join(outputRoot, 'runtime-binding.json') };
}

function png() {
  const crc32 = bytes => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (type, bytes) => { const label = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([label, bytes]))); return Buffer.concat([length, label, bytes, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(128, 0); header.writeUInt32BE(128, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(128 * (1 + 128 * 3)); let number = 123456789;
  for (let y = 0; y < 128; y++) for (let x = 1; x <= 384; x++) { number ^= number << 13; number ^= number >>> 17; number ^= number << 5; rows[y * 385 + x] = number & 255; }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function runtimeFixture(f) {
  const runtimeRoot = join(f.sourceRoot, 'artifacts/ios-simulator-smoke'); mkdirSync(runtimeRoot, { recursive: true });
  const image = png(), imageRecord = name => ({ path: name, bytes: image.length, width: 128, height: 128, sha256: hash(image) });
  for (const name of ['os-before-launch.png', 'first-launch.png', 'relaunch.png']) writeFileSync(join(runtimeRoot, name), image);
  const launch = (pid, name) => ({ pid, processBeforeScreenshot: { pid, state: 'S', executable: 'anymize', selectedSimulatorVerified: true },
    processAfterScreenshot: { pid, state: 'S', executable: 'anymize', selectedSimulatorVerified: true }, screenshot: imageRecord(name) });
  const result = { schemaVersion: 1, status: 'passed', startedAt: new Date(clock + 20 * 60 * 1000).toISOString(), finishedAt: new Date(clock + 21 * 60 * 1000).toISOString(),
    sourceCommit: identity.source.commit, execution: clone(identity.execution), simulator: { ...device, state: 'Booted' },
    checks: { verifiedArchive: true, boot: true, install: true, terminate: true, osBeforeLaunch: { screenshot: imageRecord('os-before-launch.png') }, firstLaunch: launch(100, 'first-launch.png'), relaunch: launch(101, 'relaunch.png') } };
  const path = join(runtimeRoot, 'result.json');
  const save = () => writeFileSync(path, JSON.stringify(result)); save();
  return { result, save, path, runtimeRoot, now: () => clock + 22 * 60 * 1000 };
}

test('only trusted explicit hosted-macOS source/run identity can reach OS commands', async t => {
  assert.doesNotThrow(() => assertPrebootEnvironment(env, 'darwin'));
  for (const mutation of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_REPOSITORY: 'other/repository' }, { GITHUB_REF: 'refs/pull/1/merge' },
    { GITHUB_SHA: 'B'.repeat(40) }, { ANYMIZE_EXPECTED_SOURCE_COMMIT: '' }, { GITHUB_RUN_ID: '0' }, { GITHUB_RUN_ATTEMPT: '1\n' }]) assert.throws(() => assertPrebootEnvironment({ ...env, ...mutation }, 'darwin'));
  assert.throws(() => assertPrebootEnvironment(env, 'linux'));
  const f = fixture(t); await assert.rejects(startPreboot({ ...f.options, platform: 'win32' })); assert.equal(f.calls.length, 0);
  assert.deepEqual(validateSourceIdentity(identity, env), identity);
  for (const change of [value => value.source.dirty = true, value => value.source.commit = 'd'.repeat(40), value => value.source.repository = 'fork/apps', value => value.source.lockSha256 = 'x',
    value => value.execution.commit = 'd'.repeat(40), value => value.execution.runId = '124', value => value.execution.runUrl = 'https://example.com']) { const value = clone(identity); change(value); assert.throws(() => validateSourceIdentity(value, env)); }
});

test('guarded source selector imports before npm and starts only the exact selected device, without readiness', async t => {
  const f = fixture(t); const direct = spawnSync(process.execPath, [f.smoke], { encoding: 'utf8', timeout: 5000 }); assert.equal(direct.status, 1);
  const bindings = await loadSourceBindings(f.sourceRoot); assert.equal(typeof bindings.select, 'function');
  const receipt = await startPreboot(f.options);
  assert.deepEqual(f.calls.map(({ program, args }) => [program, args]), [['xcrun', ['simctl', 'list', 'devices', 'available', '--json']], ['xcrun', ['simctl', 'boot', device.udid]]]);
  assert.ok(f.calls.every(call => call.config.timeout === 15000 && call.config.maxBuffer === 1048576 && call.config.killSignal === 'SIGTERM'));
  assert.deepEqual(receipt.simulator, device); assert.equal(receipt.status, 'initiated'); assert.equal(receipt.bootCommandRequired, true);
  assert.deepEqual(receipt.source, identity.source); assert.deepEqual(receipt.execution, identity.execution);
  assert.match(receipt.scope, /readiness and app acceptance not asserted/); assert.doesNotMatch(JSON.stringify(receipt), /"(?:ready|paid|allowed|bootComplete)"/);
  assert.ok(readFileSync(f.preboot).length < 8192); assert.equal(existsSync(f.binding), false);
});

test('already Booting or Booted uses no second boot and still makes no success claim', async t => {
  for (const state of ['Booted', 'Booting']) {
    const f = fixture(t); const run = f.options.run;
    f.options.run = (...args) => { const result = run(...args); if (args[1][1] === 'list') { const value = JSON.parse(result.stdout); value.selectedDevice.state = state; result.stdout = JSON.stringify(value); } return result; };
    const receipt = await startPreboot(f.options); assert.equal(f.calls.length, 1); assert.equal(receipt.bootCommandRequired, false); assert.equal(receipt.status, 'initiated');
  }
});

test('failed, signaled, timed-out or oversized OS commands never write a successful preboot receipt', async t => {
  for (const invocation of [{ status: 1, signal: null, stdout: '' }, { status: null, signal: 'SIGTERM', stdout: '', error: { code: 'ETIMEDOUT' } }, { status: 0, signal: 'SIGTERM', stdout: '' },
    { status: 0, signal: null, stdout: '', error: new Error('') }, { status: 0, signal: null, stdout: 'x'.repeat(1048577) }]) {
    const f = fixture(t), run = f.options.run;
    f.options.run = (...args) => args[1][1] === 'boot' ? invocation : run(...args);
    await assert.rejects(startPreboot(f.options)); assert.equal(existsSync(f.preboot), false);
  }
  const f = fixture(t); await assert.rejects(startPreboot({ ...f.options, run: () => ({ status: 0, signal: null, stdout: '{not-json' }) })); assert.equal(existsSync(f.preboot), false);
});

test('malformed, old, injected, non-iPhone and ambiguous selected identities are rejected', async t => {
  for (const mutation of [{ udid: `${device.udid};touch bad` }, { udid: `${device.udid}\n` }, { name: 'iPad Fixture' }, { name: 'iPhone\nFixture' }, { runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-16-3' },
    { runtime: 'com.apple.CoreSimulator.SimRuntime.tvOS-26-5' }, { state: 'Ready' }, { unexpected: true }]) assert.throws(() => validateSelectedDevice({ ...device, ...mutation }));
  const f = fixture(t); await assert.rejects(startPreboot({ ...f.options, run: () => ({ status: 0, signal: null, stdout: JSON.stringify({ fixture: 'synthetic-shared-selector', selectedDevice: { ...device, udid: 'bad' } }) }) }));
  assert.equal(existsSync(f.preboot), false);
});

test('exclusive receipts preserve a pre-existing caller file', async t => {
  const f = fixture(t); mkdirSync(f.outputRoot); writeFileSync(f.preboot, 'caller-owned');
  await assert.rejects(startPreboot(f.options)); assert.equal(readFileSync(f.preboot, 'utf8'), 'caller-owned');
});

test('real runtime-byte binding requires the unchanged successful smoke on the early device', async t => {
  const f = fixture(t); await startPreboot(f.options); const runtime = runtimeFixture(f);
  const receipt = await verifyPrebootRuntime({ ...f.options, now: runtime.now });
  assert.equal(receipt.status, 'verified-runtime-binding'); assert.deepEqual(receipt.source, identity.source); assert.deepEqual(receipt.execution, identity.execution);
  assert.equal(receipt.simulator.udid, device.udid); assert.equal(receipt.prebootSha256, hash(readFileSync(f.preboot))); assert.equal(receipt.runtimeSha256, hash(readFileSync(runtime.path)));
  assert.equal(receipt.firstPid, 100); assert.equal(receipt.relaunchPid, 101); assert.equal(receipt.screenshots.length, 3); assert.ok(readFileSync(f.binding).length < 8192);
  await assert.rejects(verifyPrebootRuntime({ ...f.options, now: runtime.now }));
});

test('source, execution, device, runtime, OS, process and relaunch mismatches block runtime publication', async t => {
  for (const change of [r => r.sourceCommit = 'd'.repeat(40), r => r.execution.runId = '124', r => r.execution.commit = 'd'.repeat(40), r => r.simulator.udid = '11234567-89AB-CDEF-0123-456789ABCDEF',
    r => r.simulator.runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-4', r => r.simulator.name = 'iPhone Other', r => r.simulator.state = 'Unavailable', r => r.status = 'failed', r => r.checks.boot = false,
    r => r.checks.install = false, r => r.checks.verifiedArchive = false, r => r.checks.terminate = false, r => r.checks.firstLaunch.processAfterScreenshot.selectedSimulatorVerified = false,
    r => r.checks.relaunch.pid = 100, r => r.checks.firstLaunch.pid = 0, r => r.checks.relaunch.processBeforeScreenshot.state = 'Z', r => r.startedAt = '2026-10-18T21:59:00.000Z',
    r => r.finishedAt = '2026-10-19T22:00:00.000Z']) {
    const f = fixture(t); await startPreboot(f.options); const runtime = runtimeFixture(f); change(runtime.result); runtime.save();
    await assert.rejects(verifyPrebootRuntime({ ...f.options, now: runtime.now })); assert.equal(existsSync(f.binding), false);
  }
});

test('altered screenshots, receipt extras, oversized JSON and hard-linked files fail closed', async t => {
  for (const sabotage of [
    (f, r) => { const path = join(r.runtimeRoot, 'first-launch.png'), bytes = readFileSync(path); bytes[bytes.length - 1] ^= 1; writeFileSync(path, bytes); },
    (f, r) => { r.result.checks.relaunch.screenshot.path = '../other.png'; r.save(); },
    f => { const value = JSON.parse(readFileSync(f.preboot)); value.ready = true; writeFileSync(f.preboot, JSON.stringify(value)); },
    f => writeFileSync(f.preboot, ' '.repeat(8193)),
    f => linkSync(f.preboot, join(f.outputRoot, 'extra-hardlink.json')),
  ]) { const f = fixture(t); await startPreboot(f.options); const runtime = runtimeFixture(f); sabotage(f, runtime); await assert.rejects(verifyPrebootRuntime({ ...f.options, now: runtime.now })); assert.equal(existsSync(f.binding), false); }
});

test('helper import is inert and its actual CLI rejects custom paths without private diagnostics', () => {
  const path = fileURLToPath(new URL('./ios-preboot.mjs', import.meta.url));
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path).href)});`], { encoding: 'utf8', timeout: 5000 });
  assert.equal(imported.status, 0); assert.equal(imported.stdout, ''); assert.equal(imported.stderr, '');
  const direct = spawnSync(process.execPath, [path, 'start', '--device', device.udid], { encoding: 'utf8', timeout: 5000 });
  assert.equal(direct.status, 1); assert.equal(direct.stdout, ''); assert.equal(direct.stderr, 'iOS simulator preboot or runtime binding failed. No readiness or app acceptance inferred.\n');
});
