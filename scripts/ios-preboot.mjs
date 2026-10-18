import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY = 'anymize-GmbH/downloads';
const SOURCE_REPOSITORY = 'anymize-GmbH/anymize-apps';
const RECEIPT_SCOPE = 'simulator boot initiated only; OS readiness and app acceptance not asserted';
const MAX_JSON_BYTES = 8192;
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const POSITIVE = /^[1-9][0-9]*$/;
const UDID = /^[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');

function regular(path, maximum) {
  const before = lstatSync(path);
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size > 0 && before.size <= maximum, 'Bounded regular evidence required.');
  assert(realpathSync(path) === resolve(path), 'Evidence path must be canonical.');
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const actual = fstatSync(descriptor);
    assert(actual.isFile() && actual.nlink === 1 && actual.dev === before.dev && actual.ino === before.ino && actual.size === before.size, 'Evidence changed before read.');
    const bytes = Buffer.alloc(actual.size); let offset = 0;
    while (offset < bytes.length) { const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset); assert(count > 0, 'Evidence truncated while reading.'); offset += count; }
    const after = fstatSync(descriptor);
    assert(after.size === actual.size && after.mtimeMs === actual.mtimeMs && after.ctimeMs === actual.ctimeMs, 'Evidence changed while being read.');
    return bytes;
  } finally { closeSync(descriptor); }
}

function json(path, maximum = MAX_JSON_BYTES) {
  const bytes = regular(path, maximum);
  return { bytes, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
}

function writeReceipt(directory, name, value) {
  mkdirSync(directory, { recursive: true });
  assert(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink() && realpathSync(directory) === resolve(directory), 'Receipt directory must be canonical.');
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  assert(bytes.length <= MAX_JSON_BYTES, 'Receipt exceeds its fixed bound.');
  writeFileSync(join(directory, name), bytes, { flag: 'wx', mode: 0o600 });
  return value;
}

export function assertPrebootEnvironment(env = process.env, platform = process.platform) {
  assert(platform === 'darwin' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
    && env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REF === 'refs/heads/main'
    && COMMIT.test(env.GITHUB_SHA || '') && COMMIT.test(env.ANYMIZE_EXPECTED_SOURCE_COMMIT || '')
    && POSITIVE.test(env.GITHUB_RUN_ID || '') && POSITIVE.test(env.GITHUB_RUN_ATTEMPT || ''), 'Trusted ephemeral simulator execution required.');
}

export function validateSourceIdentity(identity, env) {
  assert(keys(identity, ['source', 'execution'])
    && keys(identity.source, ['repository', 'commit', 'dirty', 'lockSha256'])
    && identity.source.repository === SOURCE_REPOSITORY && identity.source.commit === env.ANYMIZE_EXPECTED_SOURCE_COMMIT
    && COMMIT.test(identity.source.commit) && identity.source.dirty === false && SHA.test(identity.source.lockSha256 || '')
    && keys(identity.execution, ['repository', 'commit', 'runId', 'runAttempt', 'runUrl'])
    && identity.execution.repository === REPOSITORY && identity.execution.commit === env.GITHUB_SHA
    && identity.execution.runId === env.GITHUB_RUN_ID && identity.execution.runAttempt === env.GITHUB_RUN_ATTEMPT
    && identity.execution.runUrl === `https://github.com/${REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`, 'Actual authenticated source and execution differ.');
  return identity;
}

export function validateSelectedDevice(device) {
  const version = typeof device?.runtime === 'string' && device.runtime.match(/^com\.apple\.CoreSimulator\.SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?$/);
  const versionNumber = version && Number(version[1]) * 10000 + Number(version[2]) * 100 + Number(version[3] || 0);
  assert(keys(device, ['udid', 'name', 'runtime', 'state']) && UDID.test(device.udid || '')
    && typeof device.name === 'string' && /^iPhone\b/.test(device.name) && device.name.length <= 120 && !/[\x00-\x1f\x7f]/.test(device.name)
    && version && versionNumber >= 160400 && ['Booted', 'Booting', 'Shutdown'].includes(device.state), 'Selected simulator identity is malformed or unsupported.');
  return device;
}

/** Both modules use guarded CLI entry points and only Node built-ins, before npm ci. */
export async function loadSourceBindings(sourceRoot) {
  const root = realpathSync(sourceRoot);
  const smoke = join(root, 'scripts/ios/simulator-smoke.mjs');
  const identity = join(root, 'scripts/unified/source-checkout.mjs');
  regular(smoke, 128 * 1024); regular(identity, 32 * 1024);
  const [smokeModule, identityModule] = await Promise.all([import(pathToFileURL(smoke)), import(pathToFileURL(identity))]);
  assert(typeof smokeModule.selectAvailableIPhone === 'function' && typeof identityModule.sourceCheckoutIdentity === 'function', 'Verified source interfaces are unavailable.');
  return { select: smokeModule.selectAvailableIPhone, identity: identityModule.sourceCheckoutIdentity };
}

function checkedCommand(run, args, timeout) {
  const result = run('xcrun', args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], killSignal: 'SIGTERM' });
  assert(result && !result.error && result.signal == null && result.status === 0 && typeof result.stdout === 'string'
    && Buffer.byteLength(result.stdout) <= 1024 * 1024, 'Selected simulator command failed; readiness was not established.');
  return result.stdout;
}

export async function startPreboot({ sourceRoot = resolve('private-input/source'), outputRoot = resolve('artifacts/ios-preboot'), env = process.env,
  platform = process.platform, run = spawnSync, now = Date.now } = {}) {
  assertPrebootEnvironment(env, platform);
  const root = realpathSync(sourceRoot), output = resolve(outputRoot);
  const bindings = await loadSourceBindings(root);
  const identity = validateSourceIdentity(bindings.identity(root, env), env);
  const listing = JSON.parse(checkedCommand(run, ['simctl', 'list', 'devices', 'available', '--json'], 15000));
  const device = validateSelectedDevice(bindings.select(listing));
  const startedAt = new Date(now()).toISOString();
  // Deliberately do not wait for boot here. The unchanged later smoke requires
  // actual bootstatus exit 0, then installs/launches/checks processes and images.
  if (device.state === 'Shutdown') checkedCommand(run, ['simctl', 'boot', device.udid], 15000);
  return writeReceipt(output, 'preboot.json', { schemaVersion: 1, status: 'initiated', scope: RECEIPT_SCOPE, startedAt,
    ...identity, simulator: device, bootCommandRequired: device.state === 'Shutdown' });
}

function timestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  assert(Number.isFinite(parsed) && new Date(parsed).toISOString() === value, 'Invalid evidence time.');
  return parsed;
}

function screenshot(path, record, filename) {
  const bytes = regular(path, 16 * 1024 * 1024);
  assert(keys(record, ['path', 'bytes', 'width', 'height', 'sha256']) && record.path === filename && record.bytes === bytes.length
    && record.sha256 === hash(bytes) && bytes.length >= 1000 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && bytes.subarray(12, 16).toString() === 'IHDR' && bytes.readUInt32BE(16) === record.width && bytes.readUInt32BE(20) === record.height
    && record.width >= 100 && record.height >= 100 && record.width <= 10000 && record.height <= 10000, 'Actual selected-device screenshot differs from runtime evidence.');
  return { path: filename, sha256: record.sha256, bytes: bytes.length };
}

function actualLaunch(record) {
  assert(Number.isSafeInteger(record?.pid) && record.pid > 0 && record.pid <= 2147483647, 'Actual app launch PID missing.');
  for (const process of [record.processBeforeScreenshot, record.processAfterScreenshot]) assert(process?.pid === record.pid
    && process.selectedSimulatorVerified === true && typeof process.state === 'string' && !/[ZX]/i.test(process.state), 'Actual selected-device living process required.');
}

export async function verifyPrebootRuntime({ sourceRoot = resolve('private-input/source'), outputRoot = resolve('artifacts/ios-preboot'), env = process.env,
  platform = process.platform, now = Date.now } = {}) {
  assertPrebootEnvironment(env, platform);
  const root = realpathSync(sourceRoot), output = resolve(outputRoot);
  const bindings = await loadSourceBindings(root);
  const identity = validateSourceIdentity(bindings.identity(root, env), env);
  const { bytes: prebootBytes, value: preboot } = json(join(output, 'preboot.json'));
  assert(keys(preboot, ['schemaVersion', 'status', 'scope', 'startedAt', 'source', 'execution', 'simulator', 'bootCommandRequired'])
    && preboot.schemaVersion === 1 && preboot.status === 'initiated' && preboot.scope === RECEIPT_SCOPE
    && JSON.stringify(preboot.source) === JSON.stringify(identity.source) && JSON.stringify(preboot.execution) === JSON.stringify(identity.execution)
    && preboot.bootCommandRequired === (preboot.simulator?.state === 'Shutdown'), 'Preboot receipt does not bind this source and execution.');
  validateSelectedDevice(preboot.simulator);
  const runtimeRoot = join(root, 'artifacts/ios-simulator-smoke');
  const { bytes: runtimeBytes, value: runtime } = json(join(runtimeRoot, 'result.json'), 65536);
  validateSelectedDevice(runtime.simulator);
  const start = timestamp(preboot.startedAt), runtimeStart = timestamp(runtime.startedAt), finish = timestamp(runtime.finishedAt);
  assert(start <= runtimeStart && runtimeStart <= finish && finish <= now() + 5000 && finish - start <= 90 * 60 * 1000, 'Runtime timestamps do not follow this preboot.');
  assert(runtime.schemaVersion === 1 && runtime.status === 'passed' && runtime.sourceCommit === identity.source.commit
    && JSON.stringify(runtime.execution) === JSON.stringify(identity.execution)
    && runtime.simulator?.udid === preboot.simulator.udid && runtime.simulator.runtime === preboot.simulator.runtime && runtime.simulator.name === preboot.simulator.name
    && runtime.checks?.verifiedArchive === true && runtime.checks.boot === true && runtime.checks.install === true && runtime.checks.terminate === true,
  'Successful unchanged runtime must use the prebooted source, execution and simulator.');
  actualLaunch(runtime.checks.firstLaunch); actualLaunch(runtime.checks.relaunch);
  assert(runtime.checks.firstLaunch.pid !== runtime.checks.relaunch.pid, 'Relaunch must have a fresh process.');
  const images = [
    screenshot(join(runtimeRoot, 'os-before-launch.png'), runtime.checks.osBeforeLaunch?.screenshot, 'os-before-launch.png'),
    screenshot(join(runtimeRoot, 'first-launch.png'), runtime.checks.firstLaunch.screenshot, 'first-launch.png'),
    screenshot(join(runtimeRoot, 'relaunch.png'), runtime.checks.relaunch.screenshot, 'relaunch.png'),
  ];
  return writeReceipt(output, 'runtime-binding.json', { schemaVersion: 1, status: 'verified-runtime-binding',
    scope: 'exact simulator preboot and real app launch evidence binding only; authenticated features unverified',
    ...identity, simulator: { udid: preboot.simulator.udid, runtime: preboot.simulator.runtime, name: preboot.simulator.name },
    prebootSha256: hash(prebootBytes), runtimeSha256: hash(runtimeBytes), firstPid: runtime.checks.firstLaunch.pid, relaunchPid: runtime.checks.relaunch.pid, screenshots: images });
}

let direct = false;
try { direct = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* Import stays inert. */ }
if (direct) {
  try {
    assert(process.argv.length === 3 && ['start', 'verify'].includes(process.argv[2]), 'Only fixed start or verify phases are accepted.');
    if (process.argv[2] === 'start') await startPreboot(); else await verifyPrebootRuntime();
    process.stdout.write(process.argv[2] === 'start' ? 'IOS_PREBOOT_INITIATED: readiness remains unverified.\n' : 'IOS_PREBOOT_RUNTIME_BOUND: exact-device runtime evidence verified; account acceptance unverified.\n');
  } catch {
    // Imported source errors and simulator streams never cross the public log boundary.
    process.stderr.write('iOS simulator preboot or runtime binding failed. No readiness or app acceptance inferred.\n');
    process.exitCode = 1;
  }
}
