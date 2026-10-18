import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { createCipheriv, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { join, resolve } from 'node:path';

const root = resolve('private-input/source');
const [phase, platform, arch] = process.argv.slice(2);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const commands = {
  install: [[npm, ['ci', '--no-audit', '--no-fund']]],
  check: [[npm, ['run', 'check:all']], ['node', ['--test', 'distribution/site/render.test.mjs']]],
  package: [['node', ['desktop/scripts/package.mjs', '--platform', platform, '--arch', arch]], ['node', ['desktop/scripts/prepare-smoke.mjs', '--platform', platform, '--arch', arch]]],
  sandbox: [['node', ['desktop/scripts/linux-sandbox.mjs', '--platform', 'linux', '--arch', 'x64']]],
  smoke: [process.platform === 'linux' ? ['xvfb-run', ['-a', 'node', 'desktop/scripts/packaged-smoke.mjs', '--platform', platform, '--arch', arch]] : ['node', ['desktop/scripts/packaged-smoke.mjs', '--platform', platform, '--arch', arch]]],
  verify: [['node', ['desktop/scripts/verify-artifacts.mjs', '--platform', platform, '--arch', arch]]],
  cleanup: [['node', ['desktop/scripts/cleanup-smoke.mjs', '--platform', 'win', '--arch', 'x64']]],
  prebuild: [[npx, ['--no-install', 'expo', 'prebuild', '--platform', 'android', '--no-install']], ['node', ['scripts/android/check-preview-project.mjs']]],
  android: [['chmod', ['+x', 'android/gradlew']], ['bash', ['-c', 'cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a,x86_64 --no-daemon --max-workers=3 --stacktrace']], ['node', ['scripts/android/collect-preview.mjs']]],
  ios: [['node', ['scripts/ios/run-logged.mjs', 'prebuild']], ['node', ['scripts/ios/run-logged.mjs', 'pods']], ['node', ['scripts/ios/check-native-project.mjs']], ['node', ['scripts/ios/run-logged.mjs', 'build']], ['node', ['scripts/ios/run-logged.mjs', 'adhoc-sign']], ['node', ['scripts/ios/collect-simulator.mjs']]],
  'ios-smoke': [['node', ['scripts/ios/simulator-smoke.mjs']]],
  'web-auth': [[npx, ['--no-install', 'vitest', 'run', 'src/server/services/__tests__/native-login-code.test.ts', 'src/server/lib/__tests__/native-login-code.test.ts', 'src/lib/florentin/__tests__/desktop-auth-intent.test.ts', 'src/lib/florentin/__tests__/desktop-redirect.test.ts', 'src/app/api/florentin/auth/native-code/route.test.ts', 'src/app/api/florentin/auth/desktop-token-exchange/__tests__/native-code.test.ts', 'src/app/after-signin/__tests__/native-auth.test.tsx', 'src/server/middleware/__tests__/api-logger.middleware.test.ts', 'src/app/api/florentin/auth/__tests__/exchange-log-privacy.test.ts', 'src/app/__tests__/auth-client-log-privacy.test.tsx', 'src/app/api/florentin/auth/signin-redirect-token-exchange/__tests__/locale.test.ts', 'src/server/services/__tests__/request-logger-oauth-redaction.test.ts', 'src/server/middleware/__tests__/rate-limit-coverage.test.ts', '--pool', 'threads', '--maxWorkers', '1', '--reporter=json', '--outputFile=.git/private-auth-results.json']]],
  'web-types': [[npx, ['--no-install', 'next', 'typegen', '--webpack']], [npx, ['--no-install', 'tsc', '--noEmit', '-p', 'tsconfig.json']], [npx, ['--no-install', 'tsc', '--noEmit', '-p', 'tsconfig.server.typecheck.json']]],
};
if (!Object.hasOwn(commands, phase) || platform && !['win', 'mac', 'linux'].includes(platform) || arch && !['x64', 'arm64'].includes(arch)
  || ['package', 'smoke', 'verify'].includes(phase) && (!platform || !arch)) throw new Error('Unsupported fixed build phase');
const logPath = join(root, `.git/private-${phase}.log`);
const descriptor = openSync(logPath, 'w', 0o600);
let failed = false;
try {
  for (const [program, args] of commands[phase]) {
    const result = spawnSync(program, args, { cwd: root, windowsHide: true, shell: process.platform === 'win32' && [npm, npx].includes(program), stdio: ['ignore', descriptor, descriptor], timeout: 2700000 });
    if (result.error || result.status !== 0) { failed = true; break; }
  }
} finally { closeSync(descriptor); }
if (failed) {
  const key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(readFileSync(logPath)), cipher.final()]);
  const wrapped = publicEncrypt({ key: readFileSync(join(root, '.git/anymize-build-log-public.pem')), oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, key);
  mkdirSync('artifacts/encrypted-diagnostics', { recursive: true });
  writeFileSync(`artifacts/encrypted-diagnostics/${phase}.json`, JSON.stringify({ schemaVersion: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), wrappedKey: wrapped.toString('base64url'), ciphertext: encrypted.toString('base64url') }));
  process.stderr.write(`Private build phase failed: ${phase}. Diagnostics encrypted for operator.\n`); process.exitCode = 1;
} else process.stdout.write(`Private build phase passed: ${phase}.\n`);
unlinkSync(logPath);
