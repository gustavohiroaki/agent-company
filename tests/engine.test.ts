import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfficeEngine } from '../server/engine.js';
import { Store } from '../server/store.js';
import type { Agent, Config, Snapshot, Workflow } from '../shared/types.js';

const tempRoots: string[] = [];
const engines: OfficeEngine[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-office-engine-'));
  tempRoots.push(root);
  return root;
}

async function fixture(root: string, source: string): Promise<string> {
  const file = path.join(root, 'fixture.mjs');
  await writeFile(file, source, { mode: 0o700 });
  return file;
}

async function waitFor(engine: OfficeEngine, predicate: (snapshot: Snapshot) => boolean, timeoutMs = 5000): Promise<Snapshot> {
  const current = engine.snapshot();
  if (predicate(current)) return current;
  return new Promise<Snapshot>((resolve, reject) => {
    const timer = setTimeout(() => {
      engine.off('change', onChange);
      reject(new Error(`Timed out waiting for engine state; last state: ${JSON.stringify(engine.snapshot().run)}`));
    }, timeoutMs);
    const onChange = (snapshot: Snapshot) => {
      if (!predicate(snapshot)) return;
      clearTimeout(timer);
      engine.off('change', onChange);
      resolve(snapshot);
    };
    engine.on('change', onChange);
  });
}

async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await processAlive(pid))) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`fixture process ${pid} was not cleaned up`);
}

async function waitForFile(file: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(file);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  assert.fail(`timed out waiting for fixture file ${file}`);
}

function worker(root: string, cli: string, args: string[], id = 'worker'): Agent {
  return {
    id,
    name: id,
    role: 'Tester',
    avatar: 'TE',
    area: 'Dev Lab',
    cli,
    args,
    model: 'fixture-model',
    cwd: root,
    instructions: 'Follow the step instruction and report a machine-readable result.',
    timeoutMs: 3000,
  };
}

function configFor(root: string, agents: Agent[], workflow: Workflow): Config {
  return {
    agents,
    workflows: [workflow],
    projects: [{ id: 'project', name: 'Fixture project', cwd: root, rules: '', workflowId: workflow.id, agentIds: agents.map(agent => agent.id) }],
    activeProjectId: 'project',
  };
}

function workflow(id: string, steps: Workflow['steps'], maxSteps = 20): Workflow {
  return { id, name: id, start: steps[0].id, steps, maxSteps };
}

async function createEngine(root: string, config: Config): Promise<OfficeEngine> {
  const store = new Store(root);
  await store.save(config);
  const engine = await OfficeEngine.create(store);
  engines.push(engine);
  return engine;
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map(engine => engine.dispose()));
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const branchingFixture = `
const fs = await import('node:fs');
const record = process.argv[2];
const prompt = process.argv.slice(3).join('\\n');
const marker = prompt.includes('TESTER_STEP') ? 'tester' : prompt.includes('REVIEWER_STEP') ? 'reviewer' : 'developer';
const status = prompt.includes('FAIL_BRANCH') && marker === 'tester' ? 'FAIL' : marker === 'tester' ? 'PASS' : 'DONE';
fs.appendFileSync(record, marker + ':' + status + '\\n');
console.log(JSON.stringify({status, summary: marker + ' ' + status, changed_files: [], issues: [], notes: []}));
`;

const doneFixture = `
console.log(JSON.stringify({status:'DONE', summary:'done', changed_files:[], issues:[], notes:[]}));
`;

const lifecycleFixture = `
const fs = await import('node:fs');
const mode = process.argv[3];
const record = process.argv[2];
const prompt = process.argv.slice(4).join('\\n');
if (mode === 'hang') {
  fs.writeFileSync(record, String(process.pid));
  setInterval(() => {}, 1000);
} else if (mode === 'counted') {
  const countFile = process.argv[4];
  const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : '0') + 1;
  fs.writeFileSync(countFile, String(count));
  if (count === 1) {
    fs.writeFileSync(record, String(process.pid));
    setInterval(() => {}, 1000);
  } else {
    console.log(JSON.stringify({status:'DONE', summary:'restart done', changed_files:[], issues:[], notes:[]}));
  }
} else if (mode === 'stdin') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    fs.appendFileSync(record + '.messages', chunk);
    if (chunk.includes('USER_MESSAGE')) {
      console.log(JSON.stringify({status:'DONE', summary:'message received', changed_files:[], issues:[], notes:[]}));
      process.exit(0);
    }
  });
  fs.writeFileSync(record, String(process.pid));
} else {
  console.log(JSON.stringify({status:'DONE', summary:prompt, changed_files:[], issues:[], notes:[]}));
}
`;

describe('OfficeEngine workflow execution', () => {
  it('executes a PASS workflow branch, emits changes, and persists its terminal snapshot', async () => {
    const root = await tempRoot();
    const record = path.join(root, 'record.log');
    const script = await fixture(root, branchingFixture);
    const agents = [worker(root, process.execPath, [script, record, '{prompt}'], 'developer'), worker(root, process.execPath, [script, record, '{prompt}'], 'tester'), worker(root, process.execPath, [script, record, '{prompt}'], 'reviewer')];
    const flow = workflow('branch', [
      { id: 'develop', agentId: 'developer', instruction: 'DEVELOPER_STEP', transitions: { DONE: 'test', ERROR: 'error' } },
      { id: 'test', agentId: 'tester', instruction: 'TESTER_STEP', transitions: { PASS: 'done', FAIL: 'error', ERROR: 'error' } },
    ]);
    const engine = await createEngine(root, configFor(root, agents, flow));
    let changes = 0;
    engine.on('change', () => changes++);

    const initial = await engine.runTask('project', 'branch', 'PASS_BRANCH');
    assert.equal(initial.run?.status, 'Running');
    const done = await waitFor(engine, snapshot => snapshot.run?.status === 'Done');

    assert.equal(done.run?.stepId, 'test');
    assert.ok(changes >= 3);
    assert.match(await readFile(record, 'utf8'), /developer:DONE\ntester:PASS/);
    assert.deepEqual(done.agents.tester.result?.status, 'PASS');
    assert.equal(done.agents.tester.status, 'Done');
    await engine.dispose();
    engines.splice(engines.indexOf(engine), 1);

    const persisted = await new Store(root).history();
    assert.equal(persisted?.run?.status, 'Done');
    assert.ok(persisted?.timeline.some(event => event.kind === 'PASS'));
    assert.equal(persisted?.version, 2);
    assert.equal(persisted?.runHistory.length, 1);
    assert.equal(persisted?.runHistory[0]?.configRevision, done.runHistory[0]?.configRevision);
    assert.equal(persisted?.runHistory[0]?.attempts.length, 2);
    assert.ok(persisted?.runHistory[0]?.attempts.every(attempt => attempt.runId === done.run?.id));
    assert.ok(persisted?.timeline.filter(event => event.runId === done.run?.id).length);
    assert.match(done.agents.tester.lastActivityAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(done.agents.tester.lastActivity, 'tester PASS');

    const reloaded = await OfficeEngine.create(new Store(root));
    engines.push(reloaded);
    const restored = reloaded.snapshot();
    assert.equal(restored.runHistory.length, 1);
    assert.equal(restored.runHistory[0]?.attempts[1]?.result?.status, 'PASS');
    assert.equal(restored.timeline.filter(event => event.runId === restored.run?.id).length, persisted?.timeline.filter(event => event.runId === persisted.run?.id).length);
  });

  it('follows a FAIL transition into a remediation step', async () => {
    const root = await tempRoot();
    const record = path.join(root, 'record.log');
    const script = await fixture(root, branchingFixture);
    const agents = [worker(root, process.execPath, [script, record, '{prompt}'], 'developer'), worker(root, process.execPath, [script, record, '{prompt}'], 'tester'), worker(root, process.execPath, [script, record, '{prompt}'], 'reviewer')];
    const flow = workflow('branch', [
      { id: 'develop', agentId: 'developer', instruction: 'DEVELOPER_STEP', transitions: { DONE: 'test', ERROR: 'error' } },
      { id: 'test', agentId: 'tester', instruction: 'TESTER_STEP', transitions: { PASS: 'done', FAIL: 'review', ERROR: 'error' } },
      { id: 'review', agentId: 'reviewer', instruction: 'REVIEWER_STEP', transitions: { DONE: 'done', ERROR: 'error' } },
    ]);
    const engine = await createEngine(root, configFor(root, agents, flow));

    await engine.runTask('project', 'branch', 'FAIL_BRANCH');
    const done = await waitFor(engine, snapshot => snapshot.run?.status === 'Done');
    const steps = done.timeline.filter(event => event.kind === 'step').map(event => event.text);
    assert.deepEqual(steps, ['developer: DEVELOPER_STEP', 'tester: TESTER_STEP', 'reviewer: REVIEWER_STEP']);
    assert.match(await readFile(record, 'utf8'), /developer:DONE\ntester:FAIL\nreviewer:DONE/);
    const attempts = done.runHistory[0]?.attempts ?? [];
    assert.equal(attempts.length, 3);
    assert.deepEqual(attempts.map(attempt => attempt.stepId), ['develop', 'test', 'review']);
    assert.equal(new Set(attempts.map(attempt => attempt.id)).size, 3);
    assert.ok(attempts.every(attempt => attempt.runId === done.run?.id));
    assert.equal(attempts[1]?.result?.status, 'FAIL');
    const stepEvents = done.timeline.filter(event => event.kind === 'step');
    assert.deepEqual(stepEvents.map(event => event.attemptId), attempts.map(attempt => attempt.id));
  });

  it('clears the active runtime between consecutive runs while retaining isolated history', async () => {
    const root = await tempRoot();
    const script = await fixture(root, doneFixture);
    const agent = worker(root, process.execPath, [script, '{prompt}']);
    const flow = workflow('repeat', [{ id: 'step', agentId: 'worker', instruction: 'REPEAT_STEP', transitions: { DONE: 'done', ERROR: 'error' } }]);
    const engine = await createEngine(root, configFor(root, [agent], flow));

    await engine.runTask('project', 'repeat', 'first run');
    const first = await waitFor(engine, snapshot => snapshot.run?.status === 'Done');
    const firstRunId = first.run?.id;
    const firstOutput = first.agents.worker.output;
    assert.ok(firstOutput.length > 0);

    await engine.runTask('project', 'repeat', 'second run');
    const secondStarted = engine.snapshot();
    assert.notEqual(secondStarted.run?.id, firstRunId);
    assert.equal(secondStarted.agents.worker.output, '');
    assert.equal(secondStarted.agents.worker.result, undefined);
    assert.equal(secondStarted.agents.worker.messages.length, 0);
    assert.equal(secondStarted.agents.worker.task, 'second run');

    const second = await waitFor(engine, snapshot => snapshot.run?.status === 'Done');
    assert.equal(second.runHistory.length, 2);
    assert.equal(second.runHistory[0]?.id, firstRunId);
    assert.equal(second.runHistory[1]?.id, second.run?.id);
    assert.equal(second.runHistory[0]?.attempts[0]?.output, firstOutput);
    assert.equal(second.runHistory[1]?.attempts[0]?.result?.summary, 'done');
  });

  it('stops on a cycle after maxSteps', async () => {
    const root = await tempRoot();
    const script = await fixture(root, doneFixture);
    const agent = worker(root, process.execPath, [script, '{prompt}']);
    const flow = workflow('cycle', [{ id: 'loop', agentId: 'worker', instruction: 'CYCLE_STEP', transitions: { DONE: 'loop', ERROR: 'error' } }], 3);
    const engine = await createEngine(root, configFor(root, [agent], flow));

    await engine.runTask('project', 'cycle', 'cycle');
    const terminal = await waitFor(engine, snapshot => snapshot.run?.status === 'Error');
    assert.match(terminal.timeline.at(-1)?.text ?? '', /Limite de 3 etapas atingido/);
    assert.equal(terminal.run?.stepId, 'loop');
  });
});

describe('OfficeEngine process lifecycle', () => {
  it('reports a missing CLI as an Error and leaves no active run', async () => {
    const root = await tempRoot();
    const agent = worker(root, path.join(root, 'does-not-exist'), [], 'worker');
    const flow = workflow('failure', [{ id: 'step', agentId: 'worker', instruction: 'FAIL_TO_START', transitions: { DONE: 'done', ERROR: 'error' } }]);
    const engine = await createEngine(root, configFor(root, [agent], flow));

    await engine.runTask('project', 'failure', 'missing cli');
    const terminal = await waitFor(engine, snapshot => snapshot.run?.status === 'Error');
    assert.equal(terminal.agents.worker.status, 'Error');
    assert.match(terminal.run?.endedAt ?? '', /^\d{4}-/);
  });

  it('stops and restarts a run while cleaning up the child process', async () => {
    const root = await tempRoot();
    const pidFile = path.join(root, 'pid');
    const countFile = path.join(root, 'count');
    const script = await fixture(root, lifecycleFixture);
    const agent = worker(root, process.execPath, [script, pidFile, 'counted', countFile, '{prompt}']);
    const flow = workflow('lifecycle', [{ id: 'step', agentId: 'worker', instruction: 'LIFECYCLE_STEP', transitions: { DONE: 'done', ERROR: 'error' } }]);
    const engine = await createEngine(root, configFor(root, [agent], flow));

    await engine.runTask('project', 'lifecycle', 'restartable');
    await waitForFile(pidFile);
    const firstPid = Number(await readFile(pidFile, 'utf8'));
    assert.ok(firstPid > 0);
    const stopped = await engine.stopRun();
    assert.equal(stopped.run?.status, 'Stopped');
    await waitForProcessExit(firstPid);

    const restarted = await engine.restartRun();
    assert.equal(restarted.run?.status, 'Running');
    assert.notEqual(restarted.run?.id, stopped.run?.id);
    const done = await waitFor(engine, snapshot => snapshot.run?.status === 'Done');
    assert.equal(done.agents.worker.result?.summary, 'restart done');
  });

  it('restarts the active agent step and can deliver stdin messages', async () => {
    const root = await tempRoot();
    const pidFile = path.join(root, 'pid');
    const countFile = path.join(root, 'count');
    const script = await fixture(root, lifecycleFixture);
    const agent = worker(root, process.execPath, [script, pidFile, 'counted', countFile, '{prompt}']);
    const flow = workflow('restart-agent', [{ id: 'step', agentId: 'worker', instruction: 'RESTART_STEP', transitions: { DONE: 'done', ERROR: 'error' } }]);
    const engine = await createEngine(root, configFor(root, [agent], flow));

    await engine.runTask('project', 'restart-agent', 'restart agent');
    await waitForFile(pidFile);
    const restarted = await engine.restartAgent('worker');
    assert.equal(restarted.run?.status, 'Running');
    const done = await waitFor(engine, snapshot => snapshot.run?.status === 'Done');
    assert.equal(done.agents.worker.result?.summary, 'restart done');

    const stdinRoot = await tempRoot();
    const stdinRecord = path.join(stdinRoot, 'pid');
    const stdinScript = await fixture(stdinRoot, lifecycleFixture);
    const stdinAgent = worker(stdinRoot, process.execPath, [stdinScript, stdinRecord, 'stdin', '{prompt}']);
    const stdinEngine = await createEngine(stdinRoot, configFor(stdinRoot, [stdinAgent], flow));
    await stdinEngine.runTask('project', 'restart-agent', 'stdin');
    await waitForFile(stdinRecord);
    const sent = await stdinEngine.send('worker', 'USER_MESSAGE');
    assert.ok(sent.agents.worker.messages.some(message => message.direction === 'user' && message.text === 'USER_MESSAGE'));
    const stdinDone = await waitFor(stdinEngine, snapshot => snapshot.run?.status === 'Done');
    assert.equal(stdinDone.agents.worker.result?.summary, 'message received');
    assert.match(await readFile(stdinRecord + '.messages', 'utf8'), /USER_MESSAGE/);
  });
});
