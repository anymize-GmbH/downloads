import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { pinCommandTools, validateAvdTarget, validateExpectedIdentity, parseHomeComponent, assessBootSample, assertNoAnr, validateLauncherXml, validateScreenshot, runBaseline } from './emulator-baseline.mjs';

const HOME = 'com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity';
const SHORT_HOME = 'com.google.android.apps.nexuslauncher/.NexusLauncherActivity';
const activity = `topResumedActivity=ActivityRecord{252285825 u0 ${SHORT_HOME} t6}\n`;
const displays = `Display: mDisplayId=0 (organized)\n init=720x1280 320dpi\n mCurrentFocus=Window{c2115b5 u0 ${HOME}}\n mFocusedApp=ActivityRecord{252285825 u0 ${SHORT_HOME} t6}\n`;
// The omitted focus fields are the actual second-run failure shape. A visible
// background/IME target is not substituted for missing display focus proof.
const windowsOnly = `WINDOW MANAGER WINDOWS\nWindow #8 Window{c2115b5 u0 ${HOME}}:\n mTopFocusedDisplayId=0\n imeInputTarget in display# 0 Window{c2115b5 u0 ${HOME}}\n`;
const xml = '<hierarchy rotation="0"><node package="com.google.android.apps.nexuslauncher" enabled="true" clickable="true" /></hierarchy>';
// Parser-only synthetic bytes. These are never stored as actual CI receipts.
function syntheticPng() {
  const bytes = Buffer.alloc(10001);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(720, 16);
  bytes.writeUInt32BE(1280, 20);
  return bytes;
}
const good = (overrides = {}) => ({ boot: '1', animation: 'stopped', pid: '1017', surfacePid: '1747', activity, displays, homeComponent: HOME, ...overrides });
const envFor = (api) => ({ EXPECTED_API: api, EXPECTED_PAGE_SIZE: api === '35' ? '4096' : '16384', EXPECTED_IMAGE: api === '35' ? 'google_apis' : 'google_apis_ps16k', GITHUB_REPOSITORY: 'test-only/not-real-ci', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' });

test('exact API/image/page combinations are required for every matrix entry', () => {
  for (const api of ['35', '36', '37']) assert.equal(validateExpectedIdentity(envFor(api)).api, api);
  for (const patch of [{ EXPECTED_API: '34' }, { EXPECTED_PAGE_SIZE: '4096' }, { EXPECTED_IMAGE: 'google_apis' }, { EXPECTED_API: undefined }, { EXPECTED_PAGE_SIZE: '16384\n' }]) assert.throws(() => validateExpectedIdentity({ ...envFor('37'), ...patch }));
});

test('the action latest alias points to the actual pinned tools and preserves the old SDK tools', () => {
  const directory = mkdtempSync(join(tmpdir(), 'anymize-tools-alias-test-'));
  try {
    const selected = join(directory, 'cmdline-tools', '15859902');
    const latest = join(directory, 'cmdline-tools', 'latest');
    mkdirSync(join(selected, 'bin'), { recursive: true });
    mkdirSync(latest);
    writeFileSync(join(selected, 'source.properties'), 'Pkg.Revision=22.0\r\n');
    writeFileSync(join(latest, 'source.properties'), 'Pkg.Revision=12.0\n');
    const extension = process.platform === 'win32' ? '.bat' : '';
    for (const executable of ['sdkmanager', 'avdmanager']) writeFileSync(join(selected, 'bin', executable + extension), 'test only, never executed');
    const artifactsRoot = join(directory, 'receipts');
    const result = pinCommandTools({ sdkRoot: directory, artifactsRoot });
    assert.equal(result.revision, '22.0');
    assert.equal(realpathSync(latest), realpathSync(selected));
    assert.equal(readFileSync(join(directory, 'cmdline-tools', 'anymize-original-latest', 'source.properties'), 'utf8'), 'Pkg.Revision=12.0\n');
    assert.equal(JSON.parse(readFileSync(join(artifactsRoot, 'command-line-tools.json'), 'utf8')).actualLatestTarget, realpathSync(selected));
    assert.equal(pinCommandTools({ sdkRoot: directory, artifactsRoot }).actualLatestTarget, realpathSync(selected));
    writeFileSync(join(selected, 'source.properties'), 'Pkg.Revision=12.0\n');
    assert.throws(() => pinCommandTools({ sdkRoot: directory, artifactsRoot }), /revision rejected/);
  } finally {
    if (!directory.startsWith(join(tmpdir(), 'anymize-tools-alias-test-'))) throw new Error('Unexpected tools test temporary directory');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('actual AVD targets reject the known android-0 minor-version parsing failure', () => {
  for (const api of ['35', '36', '37']) assert.doesNotThrow(() => validateAvdTarget(`avd.ini.encoding=UTF-8\r\ntarget=android-${api === '37' ? '37.0' : api}\r\n`, api));
  assert.doesNotThrow(() => validateAvdTarget('target\t=\tandroid-37.0\n', '37'));
  for (const value of ['target=android-0\n', 'target=android-37\n', 'target=android-36\n', '', 'target=android-37.0\ntarget=android-37.0\n']) assert.throws(() => validateAvdTarget(value, '37'));
});

test('default HOME is resolved exactly and aliases normalize without accepting arbitrary packages', () => {
  assert.equal(parseHomeComponent(SHORT_HOME), HOME);
  assert.equal(parseHomeComponent(`priority=0 preferredOrder=0\n${HOME}\n`), HOME);
  assert.equal(parseHomeComponent('com.android.launcher3/.Launcher'), 'com.android.launcher3/com.android.launcher3.Launcher');
  for (const value of ['', 'No activity found', 'com.attacker.launcher/.Launcher', `${HOME}\n${HOME}`, `${HOME};reboot`]) assert.throws(() => parseHomeComponent(value));
});

test('current display-zero launcher window and app focus are both needed', () => {
  assert.deepEqual(assessBootSample(good()), { launcher: true, focused: true, healthy: true });
  assert.equal(assessBootSample(good({ displays: displays.replaceAll('\n', '\r\n') })).healthy, true);
  assert.equal(assessBootSample(good({ displays: windowsOnly })).focused, false);
  for (const value of [displays.replace(/mCurrentFocus=.*\n/, 'mCurrentFocus=null\n'), displays.replace(/mFocusedApp=.*\n/, 'mFocusedApp=null\n'), displays.replace('DisplayId=0', 'DisplayId=1'), displays.replace(`mCurrentFocus=Window{c2115b5 u0 ${HOME}}`, 'mCurrentFocus=Window{123 u0 com.android.settings/.Settings}'), displays.replaceAll('com.google.android.apps.nexuslauncher', 'com.google.android.apps.nexuslauncher.evil'), displays + displays]) assert.equal(assessBootSample(good({ displays: value })).healthy, false);
});

test('launcher on another display and stale background launcher strings do not certify default focus', () => {
  const wrongZero = displays.replaceAll('com.google.android.apps.nexuslauncher', 'com.android.settings');
  const launcherOnOne = displays.replace('DisplayId=0', 'DisplayId=1');
  assert.equal(assessBootSample(good({ displays: wrongZero + launcherOnOne })).healthy, false);
  assert.equal(assessBootSample(good({ activity: `mLastPausedActivity=ActivityRecord{123 u0 ${SHORT_HOME} t6}` })).healthy, false);
});

test('boot, animation and a single live SystemUI PID remain hard conditions', () => {
  for (const patch of [{ boot: '0' }, { boot: '' }, { animation: 'running' }, { animation: '' }, { pid: '' }, { pid: '1017 2117' }, { pid: '0' }, { pid: 'dead' }, { surfacePid: '' }, { surfacePid: '1747 2747' }]) assert.equal(assessBootSample(good(patch)).healthy, false);
});

test('actual API 37 launcher and SystemUI ANR signatures remain fatal', () => {
  const actualShape = '10-18 16:47:51.234 1907 3209 I am_anr  : [0,2341,com.google.android.apps.nexuslauncher,885767749,Input dispatching timed out (FocusEvent(hasFocus=true)).]';
  assert.throws(() => assertNoAnr(actualShape), /Actual guest ANR/);
  assert.throws(() => assertNoAnr('', 'E ActivityManager: ANR in com.android.systemui\nReason: failed to complete startup'), /Actual guest ANR/);
  assert.doesNotThrow(() => assertNoAnr('I am_proc_start: [0,1017,com.android.systemui]'));
});

test('enabled XML must belong to the resolved launcher, not another node or incomplete dump', () => {
  assert.doesNotThrow(() => validateLauncherXml(xml, HOME));
  for (const value of ['cat: no such file', xml.replace('</hierarchy>', ''), xml.replace('enabled="true"', 'enabled="false"'), xml.replace('com.google.android.apps.nexuslauncher', 'com.android.settings'), '<hierarchy><node package="com.google.android.apps.nexuslauncher" enabled="false"/><node package="com.android.settings" enabled="true"/></hierarchy>']) assert.throws(() => validateLauncherXml(value, HOME));
});

test('text disguised as PNG, truncated headers and inadequate screen geometry are rejected', () => {
  assert.doesNotThrow(() => validateScreenshot(syntheticPng()));
  for (const bytes of [Buffer.from('screencap: failed to take screenshot'), Buffer.alloc(72), syntheticPng().subarray(0, 9999), Buffer.alloc(10001)]) assert.throws(() => validateScreenshot(bytes));
  const narrow = syntheticPng(); narrow.writeUInt32BE(299, 16); assert.throws(() => validateScreenshot(narrow));
  const short = syntheticPng(); short.writeUInt32BE(499, 20); assert.throws(() => validateScreenshot(short));
});

async function syntheticRun(api, override, check) {
  const directory = mkdtempSync(join(tmpdir(), 'anymize-os-baseline-test-'));
  const calls = [];
  let clock = Date.parse('2026-10-18T20:00:00Z');
  let pidCalls = 0;
  let capturedScreen = false;
  const env = envFor(api);
  const root = join(directory, 'receipts');
  mkdirSync(join(directory, '.android', 'avd'), { recursive: true });
  writeFileSync(join(directory, '.android', 'avd', 'test.ini'), `target=android-${api === '37' ? '37.0' : api}\n`);
  const options = {
    env, root, home: directory, host: { cpus: 4, bytes: 16 * 1024 ** 3 }, now: () => clock,
    sleep: async (ms) => { clock += ms; }, output: (line) => calls.push({ output: line }),
    execute(command, args, settings) {
      assert.equal(command, 'adb');
      assert.deepEqual(args.slice(0, 2), ['-s', 'emulator-5554']);
      assert.ok([15000, 20000].includes(settings.timeout));
      const request = args.slice(2).join(' ');
      calls.push({ request });
      if (request === 'shell pidof com.android.systemui') pidCalls += 1;
      if (request === 'exec-out screencap -p') capturedScreen = true;
      const changed = override?.({ request, pidCalls, capturedScreen, env, calls });
      if (changed !== undefined) return Buffer.isBuffer(changed) ? changed : Buffer.from(changed);
      let response;
      if (request === 'shell getprop ro.build.version.sdk') response = api;
      else if (request === 'shell getconf PAGE_SIZE') response = env.EXPECTED_PAGE_SIZE;
      else if (request === 'shell getprop sys.boot_completed') response = '1';
      else if (request === 'shell getprop init.svc.bootanim') response = 'stopped';
      else if (request === 'shell pidof com.android.systemui') response = '1017';
      else if (request === 'shell pidof surfaceflinger') response = '1747';
      else if (request === 'shell dumpsys activity activities') response = activity;
      else if (request === 'shell dumpsys window displays') response = displays;
      else if (request === 'shell dumpsys window windows') response = windowsOnly;
      else if (request.startsWith('shell logcat ')) response = 'I boot: healthy synthetic test';
      else if (request.startsWith('shell cmd package resolve-activity ')) response = SHORT_HOME;
      else if (request === 'shell input keyevent KEYCODE_HOME') response = '';
      else if (request.startsWith('shell uiautomator dump ')) response = 'UI hierarchy dumped';
      else if (request === 'shell cat /sdcard/anymize-os-baseline.xml') response = xml;
      else if (request === 'exec-out screencap -p') return syntheticPng();
      else if (request === 'shell getprop') response = '[ro.test.fixture]: [true]';
      else if (request === 'shell df -k /data /data/local/tmp') response = 'synthetic unit filesystem';
      else if (request === 'shell cat /proc/meminfo') response = 'MemTotal: 6144000 kB';
      else if (request === 'shell wm size') response = 'Physical size: 720x1280';
      else if (request === 'shell wm density') response = 'Physical density: 320';
      else throw new Error(`Unexpected test command: ${request}`);
      return Buffer.from(response);
    },
  };
  try { await check({ options, calls, root }); }
  finally {
    if (!directory.startsWith(join(tmpdir(), 'anymize-os-baseline-test-'))) throw new Error('Unexpected test temporary directory');
    rmSync(directory, { recursive: true, force: true });
  }
}

test('complete collector requires stable focus, emits receipts matching actual stored bytes and never clears logs', async () => {
  for (const api of ['35', '36', '37']) await syntheticRun(api, undefined, async ({ options, calls, root }) => {
    const result = await runBaseline(options);
    assert.equal(result.scope, 'real-emulator-os-only-no-app-acceptance');
    assert.equal(result.stableObservations, 3);
    assert.equal(result.api, api);
    assert.equal(result.pageSize, api === '35' ? '4096' : '16384');
    assert.equal(result.homeComponent, HOME);
    const observations = JSON.parse(readFileSync(join(root, 'observations.json'), 'utf8'));
    assert.equal(observations.length, 5);
    assert.ok(observations.every((sample) => sample.focused && sample.launcher && sample.pid === '1017' && sample.surfacePid === '1747'));
    for (const receipt of result.files) {
      const bytes = readFileSync(join(root, receipt.name));
      assert.equal(bytes.length, receipt.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.sha256);
    }
    assert.equal(calls.filter((call) => call.output).length, 1);
    assert.match(calls.find((call) => call.output).output, /ANDROID_OS_BASELINE_PASSED/);
    const homeIndex = calls.findIndex((call) => call.request === 'shell input keyevent KEYCODE_HOME');
    const focusIndex = calls.findIndex((call) => call.request === 'shell dumpsys window displays');
    assert.ok(homeIndex >= 0 && focusIndex > homeIndex);
    assert.ok(calls.every((call) => !/logcat.* -c(?: |$)|force-stop|disable-user|setprop.*anr/.test(call.request ?? '')));
    assert.equal(existsSync(join(root, 'failure.json')), false);
  });
});

test('wrong actual API or guest page size cannot produce a success receipt', async () => {
  for (const failing of ['shell getprop ro.build.version.sdk', 'shell getconf PAGE_SIZE']) await syntheticRun('37', ({ request }) => request === failing ? '35' : undefined, async ({ options, root }) => {
    await assert.rejects(runBaseline(options), /Wrong actual/);
    assert.equal(existsSync(join(root, 'result.json')), false);
    assert.equal(JSON.parse(readFileSync(join(root, 'failure.json'), 'utf8')).status, 'failed');
  });
});

test('SDK setup HOME can finish before the original strict launcher proof, without changing guest setup',async()=>{
  let attempts=0;
  await syntheticRun('35',({request})=>request.startsWith('shell cmd package resolve-activity ')&&++attempts<3?'com.google.android.googlesdksetup/.DefaultActivity':undefined,async({options,root,calls})=>{
    const result=await runBaseline(options);assert.equal(result.status,'passed');assert.equal(result.homeComponent,HOME);
    assert.equal(JSON.parse(readFileSync(join(root,'home-resolution-attempts.json'),'utf8')).length,3);
    assert.ok(calls.every((call)=>!/settings put|setprop|disable-user|logcat.* -c/.test(call.request??'')));
  });
});

test('a persistent setup HOME or an ANR during launcher resolution cannot be accepted',async()=>{
  for(const anr of [false,true]){
    let resolved=false;
    await syntheticRun('35',({request})=>{
      if(request.startsWith('shell cmd package resolve-activity ')){resolved=true;return 'com.google.android.googlesdksetup/.DefaultActivity';}
      if(anr&&resolved&&request.startsWith('shell logcat -b events'))return 'I am_anr: [0,1017,com.android.systemui]';
      return undefined;
    },async({options,root,calls})=>{
      await assert.rejects(runBaseline(options),anr?/Actual guest ANR/:/default HOME did not become ready/);
      assert.equal(existsSync(join(root,'result.json')),false);
      assert.ok(calls.every((call)=>!/settings put|setprop|disable-user|logcat.* -c/.test(call.request??'')));
    });
  }
});

test('a missing real focus times out and preserves raw focus/activity diagnostics', async () => {
  await syntheticRun('36', ({ request }) => request === 'shell dumpsys window displays' ? windowsOnly : undefined, async ({ options, root }) => {
    await assert.rejects(runBaseline(options), /Stable real launcher/);
    assert.equal(existsSync(join(root, 'result.json')), false);
    assert.equal(readFileSync(join(root, 'failure-display-focus.txt'), 'utf8'), windowsOnly);
    assert.equal(readFileSync(join(root, 'failure-activity.txt'), 'utf8'), activity);
  });
});

test('boot ANR fails before HOME instead of hiding or clearing its history', async () => {
  await syntheticRun('37', ({ request }) => request.startsWith('shell logcat -b events') ? 'I am_anr: [0,2341,com.google.android.apps.nexuslauncher]' : undefined, async ({ options, root, calls }) => {
    await assert.rejects(runBaseline(options), /Actual guest ANR/);
    assert.equal(calls.some((call) => call.request === 'shell input keyevent KEYCODE_HOME'), false);
    assert.equal(existsSync(join(root, 'events-anr.txt')), true);
    assert.equal(existsSync(join(root, 'result.json')), false);
  });
});

test('ANR during screenshot collection cannot pass after a previously stable launcher', async () => {
  await syntheticRun('37', ({ request, capturedScreen }) => capturedScreen && request.startsWith('shell logcat -b events') ? 'I am_anr: [0,1017,com.android.systemui]' : undefined, async ({ options, root }) => {
    await assert.rejects(runBaseline(options), /Actual guest ANR/);
    assert.equal(existsSync(join(root, 'result.json')), false);
    assert.equal(existsSync(join(root, 'launcher.png')), true);
  });
});

test('SystemUI replacement during UI evidence capture is rejected', async () => {
  await syntheticRun('35', ({ request, pidCalls }) => request === 'shell pidof com.android.systemui' && pidCalls >= 5 ? '2117' : undefined, async ({ options, root }) => {
    await assert.rejects(runBaseline(options), /changed during UI evidence/);
    assert.equal(existsSync(join(root, 'result.json')), false);
  });
});

test('SurfaceFlinger replacement during UI evidence capture is also rejected', async () => {
  await syntheticRun('37', ({ request, capturedScreen }) => request === 'shell pidof surfaceflinger' && capturedScreen ? '2747' : undefined, async ({ options, root }) => {
    await assert.rejects(runBaseline(options), /changed during UI evidence/);
    assert.equal(existsSync(join(root, 'result.json')), false);
  });
});

test('failed XML or failed screencap cannot be converted into launcher acceptance', async () => {
  for (const requestToBreak of ['shell cat /sdcard/anymize-os-baseline.xml', 'exec-out screencap -p']) await syntheticRun('36', ({ request }) => request === requestToBreak ? 'actual command returned an error' : undefined, async ({ options, root }) => {
    await assert.rejects(runBaseline(options), /No actual enabled launcher XML|Invalid actual screen pixels/);
    assert.equal(existsSync(join(root, 'result.json')), false);
  });
});

test('failed diagnostic commands are explicitly recorded while the original failure stays fatal', async () => {
  await syntheticRun('37', ({ request }) => {
    if (request === 'shell getprop ro.build.version.sdk') return '35';
    if (request === 'shell dumpsys window displays') throw new Error('actual ADB diagnostic timeout');
    return undefined;
  }, async ({ options, root }) => {
    await assert.rejects(runBaseline(options), /Wrong actual runtime API/);
    const failed = JSON.parse(readFileSync(join(root, 'failure.json'), 'utf8'));
    assert.equal(failed.diagnosticErrors.length, 1);
    assert.equal(failed.diagnosticErrors[0].name, 'failure-display-focus.txt');
    assert.match(failed.diagnosticErrors[0].message, /actual ADB diagnostic timeout/);
  });
});

test('workflow preserves full official images, acceleration, page-size identity and fatal test status', () => {
  const workflow = readFileSync(new URL('../.github/workflows/emulator-baseline.yml', import.meta.url), 'utf8');
  assert.match(workflow, /api: '35'[\s\S]*image: google_apis\s+pages: '4096'/);
  assert.match(workflow, /api: '36'[\s\S]*image: google_apis_ps16k\s+pages: '16384'/);
  assert.match(workflow, /api: '37'\s+sdk: '37\.0'[\s\S]*image: google_apis_ps16k\s+pages: '16384'/);
  assert.match(workflow, /force-avd-creation: true/);
  assert.match(workflow, /disable-linux-hw-accel: false/);
  assert.match(workflow, /disk-size: '8G'/);
  assert.match(workflow, /ram-size: '6144M'/);
  assert.match(workflow, /-accel on/);
  assert.match(workflow, /-no-snapshot/);
  assert.doesNotMatch(workflow, /-no-boot-anim/);
  assert.match(workflow, /-skin 720x1280 -dpi-device 320/);
  assert.match(workflow, /node --test scripts\/emulator-baseline\.test\.mjs/);
  assert.match(workflow, /node scripts\/emulator-baseline\.mjs --pin-command-tools/);
  assert.ok(workflow.indexOf('node scripts/emulator-baseline.mjs --pin-command-tools') < workflow.indexOf('uses: reactivecircus/android-emulator-runner@'));
  assert.doesNotMatch(workflow, /continue-on-error: true|disable-animations: true|logcat[^\n]* -c/);
});
