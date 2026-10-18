import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cpus, totalmem, homedir } from 'node:os';

const root = 'artifacts/baseline';
mkdirSync(root, { recursive: true });
const api = process.env.EXPECTED_API;
const pageSize = process.env.EXPECTED_PAGE_SIZE;
if (!['35', '36', '37'].includes(api) || !['4096', '16384'].includes(pageSize)) throw new Error('Explicit supported OS identity required');
const receipts = [];
const adb = (args, timeout = 20000) => execFileSync('adb', ['-s', 'emulator-5554', ...args], { timeout, maxBuffer: 8 * 1024 * 1024 });
const shell = (...args) => adb(['shell', ...args]).toString('utf8').trim();
const store = (name, bytes) => {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  writeFileSync(join(root, name), buffer);
  const item = { name, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
  receipts.push(item); return item;
};
const sleep = async (ms) => new Promise(resolve => setTimeout(resolve, ms));
let stable = 0, previousPid = '', accepted = false;
const observations = [];
try {
  if (cpus().length < 4 || totalmem() < 14 * 1024 ** 3) throw new Error('Expected actual four-CPU public runner with at least14GiB RAM');
  const runtimeApi = store('runtime-api.txt', shell('getprop', 'ro.build.version.sdk'));
  if (readFileSync(join(root, runtimeApi.name), 'utf8') !== api) throw new Error('Wrong actual runtime API');
  const actualPages = shell('getconf', 'PAGE_SIZE');
  store('runtime-page-size.txt', actualPages);
  if (actualPages !== pageSize) throw new Error('Wrong actual guest page size');
  store('runtime-properties.txt', shell('getprop'));
  store('guest-data-filesystem.txt', shell('df', '-k', '/data', '/data/local/tmp'));
  for (const name of ['config.ini', 'hardware-qemu.ini']) {
    const path = join(homedir(), '.android', 'avd', 'test.avd', name);
    if (existsSync(path)) store(`avd-${name}.txt`, readFileSync(path));
  }
  const until = Date.now() + 180000;
  while (Date.now() < until) {
    const boot = shell('getprop', 'sys.boot_completed');
    const animation = shell('getprop', 'init.svc.bootanim');
    const pid = shell('pidof', 'com.android.systemui');
    const activity = shell('dumpsys', 'activity', 'activities');
    const window = shell('dumpsys', 'window', 'windows');
    const events = shell('logcat', '-b', 'events', '-d', '-v', 'threadtime');
    if (/\bam_anr\b/.test(events)) { store('events-anr.txt', events); throw new Error('Actual guest ANR observed'); }
    const launcher = /(?:mResumedActivity|topResumedActivity)[^\n]*(?:launcher|Launcher)/.test(activity);
    const focused = /(?:mCurrentFocus|mFocusedApp)[^\n]*(?:launcher|Launcher)/.test(window);
    observations.push({ at: new Date().toISOString(), boot, animation, pid, launcher, focused });
    stable = boot === '1' && animation === 'stopped' && pid && pid === previousPid && launcher && focused ? stable + 1 : 0;
    previousPid = pid;
    if (stable >= 3) { store('activities.txt', activity); store('windows.txt', window); accepted = true; break; }
    await sleep(2000);
  }
  if (!accepted) throw new Error('Stable real launcher/SystemUI not observed');
  const dump = shell('uiautomator', 'dump', '/sdcard/anymize-os-baseline.xml');
  store('hierarchy-command.txt', dump);
  const xml = adb(['shell', 'cat', '/sdcard/anymize-os-baseline.xml']);
  store('launcher.xml', xml);
  if (!xml.toString('utf8').includes('<hierarchy') || !/package="[^"]*launcher[^"]*"/i.test(xml.toString('utf8')) || !/enabled="true"/.test(xml.toString('utf8'))) throw new Error('No actual enabled launcher XML');
  const png = adb(['exec-out', 'screencap', '-p']);
  if (!png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || png.length < 10000 || png.readUInt32BE(16) < 300 || png.readUInt32BE(20) < 500) throw new Error('Invalid actual screen pixels');
  store('launcher.png', png);
  store('events.txt', shell('logcat', '-b', 'events', '-d', '-v', 'threadtime'));
  store('system.txt', shell('logcat', '-b', 'system', '-d', '-v', 'threadtime'));
  store('observations.json', JSON.stringify(observations, null, 2));
  store('result.json', JSON.stringify({ schemaVersion: 1, scope: 'real-emulator-os-only-no-app-acceptance', status: 'passed', capturedAt: new Date().toISOString(), repository: process.env.GITHUB_REPOSITORY, commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, api, pageSize, image: process.env.EXPECTED_IMAGE, actualHost: { cpus: cpus().length, bytes: totalmem() }, stableObservations: stable, files: [...receipts] }, null, 2));
  process.stdout.write(`ANDROID_OS_BASELINE_PASSED api=${api} pages=${pageSize}\n`);
} catch (error) {
  store('observations.json', JSON.stringify(observations, null, 2));
  for (const [name, args] of [['failure-events.txt', ['shell', 'logcat', '-b', 'events', '-d']], ['failure-window.txt', ['shell', 'dumpsys', 'window', 'windows']], ['failure-system.txt', ['shell', 'logcat', '-b', 'system', '-d']], ['failure.png', ['exec-out', 'screencap', '-p']]]) {
    try { store(name, adb(args, 15000)); } catch { /* An unavailable diagnostic is not accepted as success. */ }
  }
  store('failure.json', JSON.stringify({ status: 'failed', message: error.message, files: [...receipts] }, null, 2));
  throw error;
}
