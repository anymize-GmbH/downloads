import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cpus, totalmem, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HOME_PACKAGES = new Set(['com.google.android.apps.nexuslauncher', 'com.android.launcher3']);
const COMMAND_TOOLS_BUILD = '15859902';
const COMMAND_TOOLS_REVISION = '22.0';
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export function pinCommandTools({ sdkRoot = process.env.ANDROID_HOME, artifactsRoot = 'artifacts/baseline' } = {}) {
  if (typeof sdkRoot !== 'string' || !sdkRoot) throw new Error('Explicit actual SDK root required');
  const sdk = realpathSync(sdkRoot);
  const toolsRoot = realpathSync(join(sdk, 'cmdline-tools'));
  const selected = realpathSync(join(toolsRoot, COMMAND_TOOLS_BUILD));
  if (toolsRoot !== join(sdk, 'cmdline-tools') || selected !== join(toolsRoot, COMMAND_TOOLS_BUILD)) throw new Error('Pinned command tools must remain inside the actual SDK');
  const properties = readFileSync(join(selected, 'source.properties'), 'utf8');
  if (!new RegExp(`^Pkg\\.Revision[ \\t]*=[ \\t]*${COMMAND_TOOLS_REVISION.replace('.', '\\.')}[ \\t]*$`, 'm').test(properties.replaceAll('\r', ''))) throw new Error('Actual pinned command tools revision rejected');
  const extension = process.platform === 'win32' ? '.bat' : '';
  if (!existsSync(join(selected, 'bin', `sdkmanager${extension}`)) || !existsSync(join(selected, 'bin', `avdmanager${extension}`))) throw new Error('Actual command tools executables unavailable');
  const latest = join(toolsRoot, 'latest');
  const backup = join(toolsRoot, 'anymize-original-latest');
  const entryExists = (path) => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  let current = null;
  try { current = realpathSync(latest); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current !== selected) {
    if (entryExists(backup)) throw new Error('Original tools backup must not be overwritten');
    if (entryExists(latest)) renameSync(latest, backup);
    symlinkSync(selected, latest, process.platform === 'win32' ? 'junction' : 'dir');
  }
  if (realpathSync(latest) !== selected) throw new Error('Emulator action tools alias was not pinned');
  mkdirSync(artifactsRoot, { recursive: true });
  writeFileSync(join(artifactsRoot, 'command-line-tools.properties'), properties);
  const receipt = { build: COMMAND_TOOLS_BUILD, revision: COMMAND_TOOLS_REVISION, selected, actualLatestTarget: realpathSync(latest), priorToolsPreserved: entryExists(backup) };
  writeFileSync(join(artifactsRoot, 'command-line-tools.json'), JSON.stringify(receipt, null, 2));
  return receipt;
}

export function validateAvdTarget(contents, api) {
  const targets = [...contents.matchAll(/^target[ \t]*=[ \t]*([^\r\n]+)$/gm)];
  const expected = `android-${api === '37' ? '37.0' : api}`;
  if (targets.length !== 1 || targets[0][1].trim() !== expected) throw new Error('Actual AVD target does not match its complete system image');
}

export function validateExpectedIdentity(env) {
  const api = env.EXPECTED_API;
  const pages = env.EXPECTED_PAGE_SIZE;
  const image = env.EXPECTED_IMAGE;
  if (!['35', '36', '37'].includes(api) || pages !== (api === '35' ? '4096' : '16384') || image !== (api === '35' ? 'google_apis' : 'google_apis_ps16k')) throw new Error('Explicit matching supported OS identity required');
  return { api, pageSize: pages, image };
}

const componentTokens = (text) => [...text.matchAll(/\b([a-zA-Z0-9_.]+)\/(\.?[a-zA-Z0-9_.$]+)\b/g)].map((match) => `${match[1]}/${match[2].startsWith('.') ? match[1] + match[2] : match[2]}`);

export function parseHomeComponent(text) {
  const components = text.trim().split(/\r?\n/).filter((line) => /^[a-zA-Z0-9_.]+\/\.?[a-zA-Z0-9_.$]+$/.test(line.trim())).flatMap(componentTokens);
  if (components.length !== 1 || !HOME_PACKAGES.has(components[0].split('/')[0])) throw new Error('Actual default HOME component is not a supported system launcher');
  return components[0];
}

export function assertNoAnr(events, system = '', crash = '') {
  if (/\bam_anr\b/.test(events) || /\bANR in\s+/.test(system)) throw new Error('Actual guest ANR observed');
  if (/\bam_crash\b|\bFATAL EXCEPTION:|\bFatal signal [0-9]+/.test(events + '\n' + system + '\n' + crash)) throw new Error('Actual guest crash observed');
}

export function assessBootSample({ boot, animation, pid, surfacePid, activity, displays, homeComponent }) {
  const displaySections = [...displays.matchAll(/^\s*Display: mDisplayId=(\d+)\b[^\n]*\n/gm)];
  const zero = displaySections.filter((match) => match[1] === '0');
  let displayZero = '';
  if (zero.length === 1) {
    const next = displaySections.find((match) => match.index > zero[0].index);
    displayZero = displays.slice(zero[0].index, next?.index ?? displays.length);
  }
  const fieldMatches = (name) => {
    const lines = [...displayZero.matchAll(new RegExp(`^\\s*${name}=([^\\n]*)$`, 'gm'))];
    return lines.length === 1 && componentTokens(lines[0][1]).includes(homeComponent);
  };
  const launcher = activity.split(/\r?\n/).some((line) => /\b(?:mResumedActivity|topResumedActivity)\b/.test(line) && componentTokens(line).includes(homeComponent));
  // A window-list dump has background launcher names but no actual display
  // focus. Both display-zero focus fields must name the resolved HOME activity.
  const focused = fieldMatches('mCurrentFocus') && fieldMatches('mFocusedApp');
  const healthy = boot === '1' && animation === 'stopped' && /^[1-9]\d*$/.test(pid) && /^[1-9]\d*$/.test(surfacePid) && launcher && focused;
  return { launcher, focused, healthy };
}

export function validateLauncherXml(xml, homeComponent) {
  const reject = () => { throw new Error('No actual enabled launcher XML'); };
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 2 * 1024 ** 2) reject();
  let document = xml.trim();
  const declaration = /^<\?xml\s+version=(['"])1\.0\1(?:\s+encoding=(['"])UTF-8\2)?(?:\s+standalone=(['"])(?:yes|no)\3)?\s*\?>/.exec(document);
  if (declaration) document = document.slice(declaration[0].length).trim();
  const packageName = homeComponent.split('/')[0];
  const stack = []; let cursor = 0, rootSeen = false, rootClosed = false, enabled = false;
  const validPoint = (point) => [9, 10, 13].includes(point) || point >= 0x20 && point <= 0xd7ff || point >= 0xe000 && point <= 0xfffd || point >= 0x10000 && point <= 0x10ffff;
  for (const match of document.matchAll(/<(\/?)(hierarchy|node)\b((?:"[^"]*"|'[^']*'|[^'"<>])*)>/g)) {
    if (document.slice(cursor, match.index).trim() || rootClosed) reject();
    cursor = match.index + match[0].length;
    const closing = match[1] === '/', name = match[2], body = match[3];
    if (closing) { if (body.trim() || stack.pop() !== name) reject(); if (name === 'hierarchy') rootClosed = true; continue; }
    if (name === 'hierarchy') { if (rootSeen || stack.length) reject(); rootSeen = true; }
    else if (!rootSeen || !stack.length) reject();
    const selfClosing = /\/\s*$/.test(body), attributes = selfClosing ? body.replace(/\/\s*$/, '') : body;
    const values = new Map(); let end = 0;
    for (const attribute of attributes.matchAll(/([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g)) {
      if (!/^\s+$/.test(attributes.slice(end, attribute.index)) || values.has(attribute[1])) reject();
      end = attribute.index + attribute[0].length;
      const value = attribute[2] ?? attribute[3];
      if (value.replace(/&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g, '').includes('&') || [...value].some((character) => !validPoint(character.codePointAt(0)))) reject();
      for (const entity of value.matchAll(/&#(x[0-9a-fA-F]+|[0-9]+);/g)) if (!validPoint(Number(entity[1][0] === 'x' ? '0' + entity[1] : entity[1]))) reject();
      values.set(attribute[1], value);
    }
    if (attributes.slice(end).trim()) reject();
    if (name === 'node' && values.get('package') === packageName && values.get('enabled') === 'true') enabled = true;
    if (!selfClosing) stack.push(name); else if (name === 'hierarchy') rootClosed = true;
  }
  if (cursor !== document.length || stack.length || !rootSeen || !rootClosed || !enabled) reject();
}

export function validateScreenshot(png) {
  if (!Buffer.isBuffer(png) || png.length < 10000 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(16) < 300 || png.readUInt32BE(20) < 500) throw new Error('Invalid actual screen pixels');
}

export async function runBaseline({ env = process.env, root = 'artifacts/baseline', execute = execFileSync, host = { cpus: cpus().length, bytes: totalmem() }, home = homedir(), now = Date.now, sleep = pause, output = (line) => process.stdout.write(line) } = {}) {
  const { api, pageSize, image } = validateExpectedIdentity(env);
  mkdirSync(root, { recursive: true });
  const receipts = [];
  const observations = [];
  const diagnosticErrors = [];
  const adb = (args, timeout = 20000) => execute('adb', ['-s', 'emulator-5554', ...args], { timeout, maxBuffer: 8 * 1024 * 1024 });
  const shell = (...args) => adb(['shell', ...args]).toString('utf8').trim();
  const store = (name, bytes) => {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    writeFileSync(join(root, name), buffer);
    const receipt = { name, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
    receipts.push(receipt);
    return receipt;
  };
  const anrCheck = (events, system = '', crash = '') => {
    try { assertNoAnr(events, system, crash); } catch (error) { store('events-anr.txt', events); if (system) store('system-anr.txt', system); if (crash) store('crash-fatal.txt', crash); throw error; }
  };
  try {
    if (host.cpus < 4 || host.bytes < 14 * 1024 ** 3) throw new Error('Expected actual four-CPU public runner with at least 14 GiB RAM');
    const runtimeApi = shell('getprop', 'ro.build.version.sdk');
    store('runtime-api.txt', runtimeApi);
    if (runtimeApi !== api) throw new Error('Wrong actual runtime API');
    const actualPages = shell('getconf', 'PAGE_SIZE');
    store('runtime-page-size.txt', actualPages);
    if (actualPages !== pageSize) throw new Error('Wrong actual guest page size');
    store('runtime-properties.txt', shell('getprop'));
    store('guest-data-filesystem.txt', shell('df', '-k', '/data', '/data/local/tmp'));
    store('guest-memory.txt', shell('cat', '/proc/meminfo'));
    store('guest-display-size.txt', shell('wm', 'size'));
    store('guest-display-density.txt', shell('wm', 'density'));
    const avdTarget = readFileSync(join(home, '.android', 'avd', 'test.ini'), 'utf8');
    store('avd-target.ini.txt', avdTarget);
    validateAvdTarget(avdTarget, api);
    for (const name of ['config.ini', 'hardware-qemu.ini']) {
      const path = join(home, '.android', 'avd', 'test.avd', name);
      if (existsSync(path)) store(`avd-${name}.txt`, readFileSync(path));
    }
    const initialEvents = shell('logcat', '-b', 'events', '-d', '-v', 'threadtime');
    const initialSystem = shell('logcat', '-b', 'system', '-d', '-v', 'threadtime');
    store('initial-events.txt', initialEvents);
    store('initial-system.txt', initialSystem);
    const initialCrash = shell('logcat', '-b', 'crash', '-d', '-v', 'threadtime');
    store('initial-crash.txt', initialCrash); anrCheck(initialEvents, initialSystem, initialCrash);
    // A fresh Google image can report its SDK setup activity briefly after
    // sys.boot_completed. Wait for its real default launcher without changing
    // provisioning, disabling packages or accepting that setup activity.
    let homeComponent;
    const homeUntil = now() + 120000;
    const homeAttempts = [];
    while (now() < homeUntil) {
      const resolved = shell('cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME');
      homeAttempts.push({ at: new Date(now()).toISOString(), resolved });
      anrCheck(shell('logcat', '-b', 'events', '-d', '-v', 'threadtime'), shell('logcat', '-b', 'system', '-d', '-v', 'threadtime'), shell('logcat', '-b', 'crash', '-d', '-v', 'threadtime'));
      let candidate;
      try { candidate = parseHomeComponent(resolved); }
      catch { await sleep(2000); continue; }
      store('resolved-home.txt', resolved);
      homeComponent = candidate;
      break;
    }
    store('home-resolution-attempts.json', JSON.stringify(homeAttempts, null, 2));
    if (!homeComponent) throw new Error('Actual supported default HOME did not become ready within 120 seconds');
    // The runner sends MENU to unlock, which opens a launcher popup on these
    // images. HOME is a genuine input action, not a fabricated focus signal.
    store('home-command.txt', shell('input', 'keyevent', 'KEYCODE_HOME'));
    let stable = 0;
    let previousPid = '';
    let previousSurfacePid = '';
    let accepted = false;
    const until = now() + 180000;
    const capture = (command = shell) => {
      const boot = command('getprop', 'sys.boot_completed');
      const animation = command('getprop', 'init.svc.bootanim');
      const pid = command('pidof', 'com.android.systemui');
      const surfacePid = command('pidof', 'surfaceflinger');
      const activity = command('dumpsys', 'activity', 'activities');
      // AOSP's "windows" subcommand omits DisplayContent's focus fields.
      const displays = command('dumpsys', 'window', 'displays');
      const events = command('logcat', '-b', 'events', '-d', '-v', 'threadtime');
      anrCheck(events, command('logcat', '-b', 'system', '-d', '-v', 'threadtime'), command('logcat', '-b', 'crash', '-d', '-v', 'threadtime'));
      const state = assessBootSample({ boot, animation, pid, surfacePid, activity, displays, homeComponent });
      observations.push({ at: new Date(now()).toISOString(), boot, animation, pid, surfacePid, launcher: state.launcher, focused: state.focused });
      return { pid, surfacePid, activity, displays, ...state };
    };
    while (now() < until) {
      const sample = capture();
      stable = sample.healthy && sample.pid === previousPid && sample.surfacePid === previousSurfacePid ? stable + 1 : 0;
      previousPid = sample.pid;
      previousSurfacePid = sample.surfacePid;
      if (stable >= 3) {
        store('activities.txt', sample.activity);
        store('display-focus.txt', sample.displays);
        store('windows.txt', shell('dumpsys', 'window', 'windows'));
        accepted = true;
        break;
      }
      await sleep(2000);
    }
    if (!accepted) throw new Error('Stable real launcher/SystemUI not observed');
    const uiPath = '/sdcard/anymize-os-baseline.xml', uiUntil = now() + 60000, attempts = [];
    const uiAdb = (args) => {
      const remaining = uiUntil - now();
      if (remaining <= 0) throw new Error('Fresh UI evidence collection deadline exceeded');
      return adb(args, Math.min(15000, remaining));
    };
    const uiShell = (...args) => uiAdb(['shell', ...args]).toString('utf8').trim();
    const unchanged = () => {
      const sample = capture(uiShell);
      if (!sample.healthy || sample.pid !== previousPid || sample.surfacePid !== previousSurfacePid) throw new Error('Launcher/SystemUI/SurfaceFlinger changed during UI evidence capture');
    };
    let xml = null, lastCommand = '';
    try {
      for (let attempt = 1; attempt <= 6 && now() < uiUntil; attempt++) {
        unchanged();
        // A zero exit from uiautomator does not guarantee a file was written.
        // Remove and independently require absence before every fresh attempt.
        uiShell('rm', '-f', uiPath); uiShell('test', '!', '-e', uiPath);
        let candidate = null, reason = 'fresh-dump-unavailable';
        lastCommand = '';
        try {
          lastCommand = uiAdb(['shell', 'uiautomator', 'dump', uiPath]).toString('utf8').trim();
          if (/^UI hier(?:archy|chary) dumped to: \/sdcard\/anymize-os-baseline\.xml$/.test(lastCommand)) {
            const bytes = uiAdb(['shell', 'cat', uiPath]);
            validateLauncherXml(new TextDecoder('utf-8', { fatal: true }).decode(bytes), homeComponent);
            candidate = bytes; reason = 'fresh-complete-launcher-xml';
          }
        } catch { reason = 'fresh-dump-or-xml-rejected'; }
        store(`hierarchy-command-${attempt}.txt`, lastCommand);
        attempts.push({ attempt, at: new Date(now()).toISOString(), reason });
        unchanged();
        if (candidate) { xml = candidate; break; }
        await sleep(Math.min(1000, Math.max(0, uiUntil - now())));
      }
    } finally { store('hierarchy-command.txt', lastCommand); store('hierarchy-attempts.json', JSON.stringify(attempts, null, 2)); }
    if (!xml) throw new Error('No actual enabled launcher XML from fresh bounded dumps');
    store('launcher.xml', xml);
    const png = adb(['exec-out', 'screencap', '-p']);
    validateScreenshot(png);
    store('launcher.png', png);
    const events = shell('logcat', '-b', 'events', '-d', '-v', 'threadtime');
    const system = shell('logcat', '-b', 'system', '-d', '-v', 'threadtime');
    store('events.txt', events);
    store('system.txt', system);
    const crash = shell('logcat', '-b', 'crash', '-d', '-v', 'threadtime'); store('crash.txt', crash);
    anrCheck(events, system, crash);
    const finalSample = capture();
    if (!finalSample.healthy || finalSample.pid !== previousPid || finalSample.surfacePid !== previousSurfacePid) throw new Error('Launcher/SystemUI/SurfaceFlinger changed during UI evidence capture');
    store('final-display-focus.txt', finalSample.displays);
    store('final-activities.txt', finalSample.activity);
    store('observations.json', JSON.stringify(observations, null, 2));
    const result = { schemaVersion: 1, scope: 'real-emulator-os-only-no-app-acceptance', status: 'passed', capturedAt: new Date(now()).toISOString(), repository: env.GITHUB_REPOSITORY, commit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, api, pageSize, image, homeComponent, actualHost: host, stableObservations: stable, files: [...receipts] };
    store('result.json', JSON.stringify(result, null, 2));
    output(`ANDROID_OS_BASELINE_PASSED api=${api} pages=${pageSize}\n`);
    return result;
  } catch (error) {
    store('observations.json', JSON.stringify(observations, null, 2));
    for (const [name, args] of [['failure-events.txt', ['shell', 'logcat', '-b', 'events', '-d']], ['failure-display-focus.txt', ['shell', 'dumpsys', 'window', 'displays']], ['failure-window.txt', ['shell', 'dumpsys', 'window', 'windows']], ['failure-activity.txt', ['shell', 'dumpsys', 'activity', 'activities']], ['failure-system.txt', ['shell', 'logcat', '-b', 'system', '-d']], ['failure.png', ['exec-out', 'screencap', '-p']]]) {
      try { store(name, adb(args, 15000)); } catch (diagnostic) { diagnosticErrors.push({ name, message: String(diagnostic.message).slice(0, 2000) }); }
    }
    store('failure.json', JSON.stringify({ status: 'failed', message: error.message, diagnosticErrors, files: [...receipts] }, null, 2));
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--pin-command-tools') {
    const tools = pinCommandTools();
    process.stdout.write(`Actual command-line tools ${tools.revision} bound to emulator action latest path.\n`);
  } else if (process.argv.length === 2) await runBaseline();
  else throw new Error('Unsupported OS baseline command');
}
