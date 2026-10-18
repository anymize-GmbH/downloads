import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Existing Python 3/PyYAML parses actual YAML, including duplicate-key rejection.
// The test installs nothing; this repository has no npm dependencies.
const yamlReader = String.raw`
import json, re, sys, yaml
class UniqueLoader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        result = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if not isinstance(key, str) or key in result:
                raise ValueError('Invalid or duplicate YAML mapping key')
            result[key] = self.construct_object(value_node, deep=deep)
        return result
# YAML 1.2 booleans preserve the Actions on key while retaining real types.
UniqueLoader.yaml_implicit_resolvers = {
    key: [(tag, pattern) for tag, pattern in resolvers if tag != 'tag:yaml.org,2002:bool']
    for key, resolvers in UniqueLoader.yaml_implicit_resolvers.items()
}
UniqueLoader.add_implicit_resolver('tag:yaml.org,2002:bool', re.compile(r'^(?:true|True|TRUE|false|False|FALSE)$'), list('tTfF'))
print(json.dumps(yaml.load(sys.stdin.read(), Loader=UniqueLoader)))
`;
const source = readFileSync(new URL('../.github/workflows/native-preview.yml', import.meta.url), 'utf8');
const safeEnvironment = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};
function parseYaml(text) {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', yamlReader], {
    input: text, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { ...safeEnvironment, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.error, undefined, 'Existing Python 3/PyYAML is required');
  assert.equal(result.status, 0, 'Workflow must be real valid YAML with unique keys');
  return JSON.parse(result.stdout);
}
const workflow = parseYaml(source);
const repository = 'anymize-GmbH/downloads', ref = 'refs/heads/main';
const compileFiles = [
  'private-input/source/artifacts/ios-simulator/anymize-ios-simulator.app.tar.gz',
  'private-input/source/artifacts/ios-simulator/build-info.json',
  'private-input/source/artifacts/ios-simulator/SHA256SUMS',
];
const uploadAction = 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02';
const paths = (step) => step.with.path.trim().split('\n');

// A small declarative parser, never eval/VM/shell interpolation of workflow text.
function condition(text, { target, repo = repository, branch = ref, success = true, steps = {} } = {}) {
  const tokens = []; let cursor = 0;
  const grammar = /\s*(&&|\|\||==|\(|\)|success\(\)|github\.repository|github\.ref|inputs\.target|steps\.[a-z_]+\.outcome|'[^']*')/gy;
  while (cursor < text.length) {
    grammar.lastIndex = cursor; const next = grammar.exec(text);
    assert.ok(next, 'Unsupported workflow condition'); tokens.push(next[1]); cursor = grammar.lastIndex;
  }
  let index = 0;
  const atom = () => {
    const token = tokens[index++];
    if (token === '(') { const value = or(); assert.equal(tokens[index++], ')'); return value; }
    if (token?.startsWith("'")) return token.slice(1, -1);
    if (token === 'success()') return success;
    if (token === 'github.repository') return repo;
    if (token === 'github.ref') return branch;
    if (token === 'inputs.target') return target;
    if (token?.startsWith('steps.')) return steps[token.split('.')[1]];
    assert.fail('Missing workflow condition operand');
  };
  const equal = () => {
    const left = atom(); if (tokens[index] !== '==') return left;
    index++; const right = atom();
    // GitHub string equality is case-insensitive; the real validator below
    // nevertheless rejects noncanonical dispatch targets before dependent jobs.
    return typeof left === 'string' && typeof right === 'string' ? left.toLowerCase() === right.toLowerCase() : left === right;
  };
  const and = () => { let value = equal(); while (tokens[index] === '&&') { index++; const right = equal(); value = Boolean(value) && Boolean(right); } return value; };
  const or = () => { let value = and(); while (tokens[index] === '||') { index++; const right = and(); value = Boolean(value) || Boolean(right); } return value; };
  const result = or(); assert.equal(index, tokens.length); return Boolean(result);
}
function invokeValidator(target) {
  const job = workflow.jobs['validate-target'];
  assert.deepEqual(job.env, { NATIVE_BUILD_TARGET: '${{ inputs.target }}' }); assert.equal(job.steps.length, 1);
  const code = /^node --input-type=module -e "([^"\r\n]+)"\s*$/.exec(job.steps[0].run)?.[1];
  assert.ok(code, 'Target validation must be a fixed command');
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 5000,
    env: { ...safeEnvironment, ...(target === undefined ? {} : { NATIVE_BUILD_TARGET: target }) } });
}
function assertSelection(definition) {
  assert.deepEqual(definition.on.workflow_dispatch.inputs.target, { description: 'Build all native targets or only the iOS simulator', required: true, type: 'choice', default: 'all', options: ['all', 'ios'] });
  assert.deepEqual(Object.keys(definition.jobs).sort(), ['android', 'desktop', 'ios-simulator', 'validate-target']);
  for (const [target, expected] of [['all', ['android', 'desktop', 'ios-simulator']], ['ios', ['ios-simulator']]]) {
    assert.deepEqual(['android', 'desktop', 'ios-simulator'].filter((name) => condition(definition.jobs[name].if, { target })), expected);
    for (const name of ['android', 'desktop', 'ios-simulator']) {
      assert.equal(definition.jobs[name].needs, 'validate-target');
      for (const context of [{ repo: 'other/repository' }, { branch: 'refs/pull/1/merge' }, { branch: 'refs/heads/topic' }]) assert.equal(condition(definition.jobs[name].if, { target, ...context }), false);
    }
    assert.equal(condition(definition.jobs['validate-target'].if, { target }), true);
    assert.equal(condition(definition.jobs['validate-target'].if, { target, repo: 'other/repository' }), false);
    assert.equal(condition(definition.jobs['validate-target'].if, { target, branch: 'refs/heads/topic' }), false);
  }
}

test('actual YAML defaults all and explicit ios skips Android and desktop', () => {
  assertSelection(workflow);
  for (const target of [workflow.on.workflow_dispatch.inputs.target.default, 'all', 'ios']) {
    const result = invokeValidator(target); assert.equal(result.error, undefined); assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  }
});
test('actual missing and invalid target commands fail before any secret-bearing source job', () => {
  for (const target of [undefined, '', 'android', 'desktop', 'ALL', 'ios\n', 'ios; echo injected', '../ios']) {
    const result = invokeValidator(target); assert.equal(result.error, undefined); assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'Invalid native build target.\n');
    for (const name of ['android', 'desktop', 'ios-simulator']) assert.equal(workflow.jobs[name].needs, 'validate-target');
  }
});
test('controls reject missing/invalid defaults, duplicate YAML and weakened repository/ref guards', () => {
  for (const replacement of ['', '        default: android\n']) assert.throws(() => assertSelection(parseYaml(source.replace('        default: all\n', replacement))));
  assert.throws(() => parseYaml(source.replace('        default: all\n', '        default: all\n        default: ios\n')));
  assert.throws(() => assertSelection(parseYaml(source.replace('        required: true\n', '        required: "true"\n'))));
  for (const clause of ["github.repository == 'anymize-GmbH/downloads' && ", "github.ref == 'refs/heads/main' && "]) assert.throws(() => assertSelection(parseYaml(source.replaceAll(clause, ''))));
});
test('exact source/cipher, pinned actions and no-PAT boundaries remain on all real platform jobs', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.concurrency, { group: 'native-preview-${{ inputs.source_commit }}', 'cancel-in-progress': false });
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), ['input_asset_id', 'input_sha256', 'metadata_asset_id', 'metadata_sha256', 'source_commit', 'target']);
  assert.equal(workflow.env.ANYMIZE_EXPECTED_SOURCE_COMMIT, '${{ inputs.source_commit }}'); assert.equal(workflow.env.ANYMIZE_DESKTOP_CHANNEL, 'preview');
  for (const [key, value] of Object.entries(workflow.on.workflow_dispatch.inputs)) if (key !== 'target') { assert.equal(value.required, true); assert.equal(value.type, 'string'); assert.equal(value.default, undefined); }
  for (const name of ['desktop', 'android', 'ios-simulator']) {
    const job = workflow.jobs[name]; assert.equal(job['continue-on-error'], undefined); assert.equal(job.permissions, undefined);
    const fetches = job.steps.filter((step) => step.run === 'node scripts/fetch-build-input.mjs'); assert.equal(fetches.length, 1);
    assert.deepEqual(fetches[0].env, { GH_TOKEN: '${{ github.token }}', BUILD_INPUT_ASSET_ID: '${{ inputs.input_asset_id }}', BUILD_INPUT_METADATA_ID: '${{ inputs.metadata_asset_id }}', BUILD_INPUT_SHA256: '${{ inputs.input_sha256 }}', BUILD_INPUT_METADATA_SHA256: '${{ inputs.metadata_sha256 }}', BUILD_INPUT_DECRYPTION_KEY: '${{ secrets.BUILD_INPUT_DECRYPTION_KEY }}' });
    assert.equal(fetches[0]['continue-on-error'], undefined); assert.equal(fetches[0].if, undefined);
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /^[A-Za-z0-9_/-]+@[a-f0-9]{40}$/);
      if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
      if (step !== fetches[0]) assert.doesNotMatch(JSON.stringify(step), /secrets\.|github\.token|GH_TOKEN|GITHUB_TOKEN/);
    }
    assert.doesNotMatch(JSON.stringify(job.env ?? {}), /secrets\.|github\.token|GH_TOKEN|GITHUB_TOKEN/);
  }
  assert.doesNotMatch(source, /secrets\.(?!BUILD_INPUT_DECRYPTION_KEY\s*\}\})[A-Za-z_]|\bPAT\b|pull_request_target|contents:\s*write/);
});
test('compile-only evidence precedes runtime and cannot claim a successful launch', () => {
  const steps = workflow.jobs['ios-simulator'].steps;
  const compileIndex = steps.findIndex((step) => step.id === 'compile_ios'), compiledIndex = steps.findIndex((step) => step.with?.name?.startsWith('preview-ios-simulator-compile-only-'));
  const runtimeIndex = steps.findIndex((step) => step.id === 'runtime_ios'), bindIndex = steps.findIndex((step) => step.id === 'bind_ios'), verifiedIndex = steps.findIndex((step) => step.with?.name === 'preview-ios-simulator-${{ github.run_id }}-${{ github.run_attempt }}');
  assert.ok(compileIndex >= 0); assert.equal(compiledIndex, compileIndex + 1); assert.equal(runtimeIndex, compiledIndex + 1); assert.equal(bindIndex, runtimeIndex + 1); assert.ok(verifiedIndex > bindIndex);
  assert.equal(steps[compileIndex].run, 'node scripts/run-private.mjs ios'); assert.equal(steps[runtimeIndex].run, 'node scripts/run-private.mjs ios-smoke');
  const compiled = steps[compiledIndex], verified = steps[verifiedIndex];
  assert.equal(compiled.uses, uploadAction); assert.deepEqual(paths(compiled), compileFiles); assert.equal(compiled.with['if-no-files-found'], 'error'); assert.equal(compiled.with['retention-days'], 14);
  assert.equal(verified.uses, uploadAction); assert.deepEqual(paths(verified), ['private-input/source/artifacts/ios-simulator/*.tar.gz', ...compileFiles.slice(1), 'private-input/source/artifacts/ios-simulator-smoke/result.json', 'private-input/source/artifacts/ios-simulator-smoke/*.png']);
  for (const step of [steps[compileIndex], steps[runtimeIndex], steps[bindIndex], compiled, verified]) assert.equal(step['continue-on-error'], undefined);
  assert.equal(condition(compiled.if, { success: true, steps: { compile_ios: 'success' } }), true);
  for (const success of [true, false]) assert.equal(condition(compiled.if, { success, steps: { compile_ios: 'failure' } }), false);
  const complete = { preboot_ios: 'success', compile_ios: 'success', runtime_ios: 'success', bind_ios: 'success' };
  assert.equal(condition(verified.if, { success: true, steps: complete }), true);
  for (const stage of Object.keys(complete)) for (const status of ['failure', 'skipped', undefined]) for (const success of [true, false]) assert.equal(condition(verified.if, { success, steps: { ...complete, [stage]: status } }), false);
  const failure = steps.filter((step) => step.if === 'failure()'); assert.equal(failure.length, 2);
  const encrypted = failure.find((step) => step.with.name === 'encrypted-diagnostics-ios-${{ github.run_id }}');
  assert.ok(encrypted); assert.equal(encrypted.uses, uploadAction); assert.equal(encrypted.with.path, 'artifacts/encrypted-diagnostics/*.json');
  const os = failure.find((step) => step.with.name === 'preview-ios-os-diagnostic-${{ github.run_id }}-${{ github.run_attempt }}');
  assert.ok(os); assert.ok(steps.indexOf(os) > runtimeIndex); assert.equal(os.uses, uploadAction);
  assert.deepEqual(paths(os), ['private-input/source/artifacts/ios-simulator-smoke/os-before-launch.png']);
  assert.equal(os.with['if-no-files-found'], 'warn'); assert.equal(os.with['retention-days'], 7);
  assert.equal(os['continue-on-error'], undefined); assert.doesNotMatch(os.with.name, /runtime|compile-only/);
});

function assertEarlyPreboot(definition) {
  const steps = definition.jobs['ios-simulator'].steps;
  const fetchIndex = steps.findIndex(step => step.run === 'node scripts/fetch-build-input.mjs');
  const prebootIndex = steps.findIndex(step => step.id === 'preboot_ios');
  const installIndex = steps.findIndex(step => step.run === 'node scripts/run-private.mjs install');
  const checkIndex = steps.findIndex(step => step.run === 'node scripts/run-private.mjs check');
  const compileIndex = steps.findIndex(step => step.id === 'compile_ios');
  const runtimeIndex = steps.findIndex(step => step.id === 'runtime_ios');
  const bindIndex = steps.findIndex(step => step.id === 'bind_ios');
  assert.ok(fetchIndex >= 0); assert.equal(prebootIndex, fetchIndex + 1); assert.ok(prebootIndex < installIndex && installIndex < checkIndex && checkIndex < compileIndex);
  assert.equal(steps[prebootIndex].run, 'node scripts/ios-preboot.mjs start'); assert.equal(steps[bindIndex].run, 'node scripts/ios-preboot.mjs verify'); assert.equal(bindIndex, runtimeIndex + 1);
  for (const step of [steps[prebootIndex], steps[bindIndex]]) { assert.equal(step.if, undefined); assert.equal(step.env, undefined); assert.equal(step['continue-on-error'], undefined); }
  assert.equal(steps.filter(step => /ios-preboot\.mjs/.test(step.run || '')).length, 2);
  const receipts = steps.find(step => step.with?.name === 'preview-ios-preboot-binding-${{ github.run_id }}-${{ github.run_attempt }}');
  assert.ok(receipts && steps.indexOf(receipts) > bindIndex); assert.equal(receipts.uses, uploadAction);
  assert.deepEqual(paths(receipts), ['artifacts/ios-preboot/preboot.json', 'artifacts/ios-preboot/runtime-binding.json']);
  assert.equal(receipts.with['if-no-files-found'], 'error'); assert.equal(receipts.with['retention-days'], 14); assert.equal(receipts['continue-on-error'], undefined);
  assert.equal(condition(receipts.if, { success: true, steps: { bind_ios: 'success' } }), true);
  for (const success of [true, false]) for (const status of ['failure', 'skipped', undefined]) assert.equal(condition(receipts.if, { success, steps: { bind_ios: status } }), false);
}

test('real YAML preboots only after authenticated source and before long compilation, then binds before runtime publication', () => {
  assertEarlyPreboot(workflow);
  assert.equal(workflow.jobs['ios-simulator']['runs-on'], 'macos-26');
  assert.deepEqual(workflow.jobs['ios-simulator'].env, { DEVELOPER_DIR: '/Applications/Xcode_26.6.app/Contents/Developer', COCOAPODS_DISABLE_STATS: 'true', RCT_NO_LAUNCH_PACKAGER: '1' });
  // Moving boot early never changes the private 6f smoke, its 180s/60s caps,
  // archive integrity, mandatory bootstatus exit 0, launch, PID or PNG oracle.
  assert.equal(workflow.jobs['ios-simulator'].steps.find(step => step.id === 'runtime_ios').run, 'node scripts/run-private.mjs ios-smoke');
});

test('workflow controls detect late boot, ignored startup, skipped binding and broad receipt uploads', () => {
  for (const mutate of [
    value => { const steps = value.jobs['ios-simulator'].steps; const index = steps.findIndex(step => step.id === 'preboot_ios'); const [step] = steps.splice(index, 1); steps.splice(steps.findIndex(item => item.id === 'compile_ios'), 0, step); },
    value => value.jobs['ios-simulator'].steps.find(step => step.id === 'preboot_ios')['continue-on-error'] = true,
    value => value.jobs['ios-simulator'].steps.find(step => step.id === 'bind_ios').if = 'success()',
    value => value.jobs['ios-simulator'].steps.find(step => step.with?.name?.startsWith('preview-ios-preboot-binding-')).with.path = 'artifacts/**',
  ]) { const changed = structuredClone(workflow); mutate(changed); assert.throws(() => assertEarlyPreboot(changed)); }
});
