import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const resultBytes = readFileSync('private-input/source/.git/private-auth-results.json');
const result = JSON.parse(resultBytes);
const actualPg = result.testResults.flatMap((suite) => suite.assertionResults ?? []).filter((test) => test.fullName === 'actual PostgreSQL consumes once across two store instances and preserves wrong-proof tickets');
if (result.success !== true || result.numFailedTests !== 0 || result.numPendingTests !== 0 || result.numPassedTests < 100
  || actualPg.length !== 1 || actualPg[0].status !== 'passed') throw new Error('Real isolated PostgreSQL and auth acceptance did not pass completely');
const input = JSON.parse(readFileSync('private-input/source/.git/anymize-build-input.json', 'utf8'));
if (input.source.repository !== 'attractsoft/anychat' || input.source.commit !== process.env.ANYMIZE_EXPECTED_SOURCE_COMMIT
  || input.workflow.repository !== process.env.GITHUB_REPOSITORY || input.workflow.commit !== process.env.GITHUB_SHA
  || input.workflow.runId !== process.env.GITHUB_RUN_ID || input.workflow.runAttempt !== process.env.GITHUB_RUN_ATTEMPT) throw new Error('Actual auth execution identity rejected');
mkdirSync('artifacts/auth-test', { recursive: true });
writeFileSync('artifacts/auth-test/receipt.json', JSON.stringify({ schemaVersion: 1, scope: 'isolated-server-auth-and-real-postgresql-concurrency-no-hosted-login',
  status: 'passed', source: input.source, execution: input.workflow, database: 'ephemeral-loopback-PostgreSQL-17-with-two-real-connections',
  tests: { passed: result.numPassedTests, failed: 0, skipped: 0 }, privateRawResultSha256: createHash('sha256').update(resultBytes).digest('hex'), capturedAt: new Date().toISOString() }, null, 2));
process.stdout.write('Real isolated PostgreSQL and source auth acceptance passed.\n');
