import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import type { Agent, Config, Snapshot, Workflow } from '../shared/types.js';

type RunningServer = Awaited<ReturnType<typeof startServer>>;

const roots: string[] = [];
const servers: RunningServer[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-office-e2e-'));
  roots.push(root);
  return root;
}

async function fixture(root: string, source: string): Promise<string> {
  const file = path.join(root, 'fixture.mjs');
  await writeFile(file, source, { mode: 0o700 });
  return file;
}

async function waitForSnapshot(baseUrl: string, predicate: (snapshot: Snapshot) => boolean, timeoutMs = 5000): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/state`);
    const snapshot = (await response.json()) as Snapshot;
    if (predicate(snapshot)) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for server snapshot at ${baseUrl}`);
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

async function jsonRequest<T>(baseUrl: string, method: string, route: string, body?: unknown): Promise<{ response: Response; value: T }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, value: (await response.json()) as T };
}

function testAgent(root: string, script: string, args: string[], id = 'worker'): Agent {
  return {
    id,
    name: id,
    role: 'Tester',
    avatar: 'TE',
    area: 'Dev Lab',
    cli: process.execPath,
    args: [script, ...args],
    model: 'fixture-model',
    cwd: root,
    instructions: 'Run the fixture and return the requested structured result.',
    timeoutMs: 3000,
  };
}

function testConfig(root: string, agents: Agent[], flow: Workflow): Config {
  return {
    agents,
    workflows: [flow],
    projects: [{ id: 'project', name: 'E2E project', cwd: root, rules: '', workflowId: flow.id, agentIds: agents.map(agent => agent.id) }],
    activeProjectId: 'project',
  };
}

async function openServer(root: string): Promise<RunningServer> {
  const app = await startServer({ root, port: 0, production: true });
  servers.push(app);
  return app;
}

function baseUrl(app: RunningServer): string {
  return `http://127.0.0.1:${app.port}`;
}

function websocketSnapshots(socket: WebSocket): { next(predicate: (snapshot: Snapshot) => boolean, timeoutMs?: number): Promise<Snapshot> } {
  const backlog: Snapshot[] = [];
  const pending: { predicate: (snapshot: Snapshot) => boolean; resolve: (snapshot: Snapshot) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }[] = [];
  socket.on('message', (data: WebSocket.RawData) => {
    let message: { type?: string; data?: Snapshot };
    try {
      message = JSON.parse(data.toString()) as { type?: string; data?: Snapshot };
    } catch {
      return;
    }
    if (message.type !== 'snapshot' || !message.data) return;
    const index = pending.findIndex(waiter => waiter.predicate(message.data!));
    if (index === -1) {
      backlog.push(message.data);
      return;
    }
    const waiter = pending.splice(index, 1)[0];
    clearTimeout(waiter.timer);
    waiter.resolve(message.data);
  });
  return {
    next(predicate, timeoutMs = 5000) {
      const index = backlog.findIndex(predicate);
      if (index !== -1) return Promise.resolve(backlog.splice(index, 1)[0]);
      return new Promise<Snapshot>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = pending.findIndex(waiter => waiter.resolve === resolve);
          if (index !== -1) pending.splice(index, 1);
          reject(new Error('timed out waiting for websocket snapshot'));
        }, timeoutMs);
        pending.push({ predicate, resolve, reject, timer });
      });
    },
  };
}

async function rawGet(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/state', method: 'GET', headers }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    req.once('error', reject);
    req.end();
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const doneFixture = `
console.log(JSON.stringify({status:'DONE', summary:'fixture done', changed_files:[], issues:[], notes:[]}));
`;

const hangFixture = `
const fs = await import('node:fs');
const pidFile = process.argv[2];
fs.writeFileSync(pidFile, String(process.pid));
setInterval(() => {}, 1000);
`;

describe('Agent Office HTTP and WebSocket integration', () => {
  it('serves state, runs a real fixture, broadcasts snapshots, and persists history', async () => {
    const root = await tempRoot();
    const script = await fixture(root, doneFixture);
    const flow: Workflow = {
      id: 'e2e',
      name: 'E2E',
      start: 'step',
      maxSteps: 5,
      steps: [{ id: 'step', agentId: 'worker', instruction: 'E2E_STEP', transitions: { DONE: 'done', ERROR: 'error' } }],
    };
    const app = await openServer(root);
    const url = baseUrl(app);
    const config = testConfig(root, [testAgent(root, script, ['{prompt}'])], flow);

    const initial = await fetch(`${url}/api/state`);
    assert.equal(initial.status, 200);
    const initialSnapshot = (await initial.json()) as Snapshot;
    assert.equal(initialSnapshot.run, null);

    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    const socketMessages = websocketSnapshots(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const firstWs = await socketMessages.next(snapshot => snapshot.run === null);
    assert.equal(firstWs.config.projects[0]?.id, 'local');

    const update = await jsonRequest<Snapshot>(url, 'PUT', '/api/config', { config, expectedRevision: initialSnapshot.configRevision });
    assert.equal(update.response.status, 200);
    assert.equal(update.value.config.projects[0]?.id, 'project');

    const run = await jsonRequest<Snapshot>(url, 'POST', '/api/run', { projectId: 'project', workflowId: 'e2e', task: 'integration' });
    assert.equal(run.response.status, 200);
    assert.equal(run.value.run?.status, 'Running');
    const done = await socketMessages.next(snapshot => snapshot.run?.status === 'Done');
    assert.equal(done.agents.worker.result?.summary, 'fixture done');
    assert.ok(done.timeline.some(event => event.kind === 'DONE'));
    socket.close();

    const state = await waitForSnapshot(url, snapshot => snapshot.run?.status === 'Done');
    assert.equal(state.run?.status, 'Done');
    await app.close();
    servers.splice(servers.indexOf(app), 1);

    const restarted = await openServer(root);
    const restored = await (await fetch(`${baseUrl(restarted)}/api/state`)).json() as Snapshot;
    assert.equal(restored.run?.status, 'Done');
    assert.equal(restored.configRevision, state.configRevision);
    assert.equal(restored.runHistory[0]?.configRevision, state.runHistory[0]?.configRevision);
    assert.ok(restored.timeline.some(event => event.kind === 'DONE'));
  });

  it('enforces JSON mutation requests and supports HTTP stop/restart with process cleanup', async () => {
    const root = await tempRoot();
    const pidFile = path.join(root, 'pid');
    const script = await fixture(root, hangFixture);
    const flow: Workflow = {
      id: 'hang',
      name: 'Hang',
      start: 'step',
      maxSteps: 5,
      steps: [{ id: 'step', agentId: 'worker', instruction: 'HANG_STEP', transitions: { DONE: 'done', ERROR: 'error' } }],
    };
    const app = await openServer(root);
    const url = baseUrl(app);
    const config = testConfig(root, [testAgent(root, script, [pidFile, '{prompt}'])], flow);
    const initial = await (await fetch(`${url}/api/state`)).json() as Snapshot;
    const update = await jsonRequest<Snapshot>(url, 'PUT', '/api/config', { config, expectedRevision: initial.configRevision });
    assert.equal(update.response.status, 200);

    const noContentType = await fetch(`${url}/api/run`, { method: 'POST', body: JSON.stringify({ projectId: 'project', workflowId: 'hang', task: 'x' }) });
    assert.equal(noContentType.status, 400);
    assert.match(((await noContentType.json()) as { error: string }).error, /Content-Type/);

    const run = await jsonRequest<Snapshot>(url, 'POST', '/api/run', { projectId: 'project', workflowId: 'hang', task: 'x' });
    assert.equal(run.value.run?.status, 'Running');
    await waitForFile(pidFile);
    const stopped = await jsonRequest<Snapshot>(url, 'POST', '/api/run/stop');
    assert.equal(stopped.response.status, 200);
    assert.equal(stopped.value.run?.status, 'Stopped');
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.ok(pid > 0);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.throws(() => process.kill(pid, 0));

    const restarted = await jsonRequest<Snapshot>(url, 'POST', '/api/run/restart');
    assert.equal(restarted.response.status, 200);
    assert.equal(restarted.value.run?.status, 'Running');
    const stoppedAgain = await jsonRequest<Snapshot>(url, 'POST', '/api/run/stop');
    assert.equal(stoppedAgain.value.run?.status, 'Stopped');
  });

  it('rejects a stale configuration revision without overwriting the first tab', async () => {
    const root = await tempRoot();
    const app = await openServer(root);
    const url = baseUrl(app);
    const initial = await (await fetch(`${url}/api/state`)).json() as Snapshot;
    const firstConfig = structuredClone(initial.config);
    firstConfig.projects[0].name = 'Saved by first tab';
    const first = await jsonRequest<Snapshot>(url, 'PUT', '/api/config', {
      config: firstConfig,
      expectedRevision: initial.configRevision,
    });
    assert.equal(first.response.status, 200);
    assert.notEqual(first.value.configRevision, initial.configRevision);

    const staleConfig = structuredClone(initial.config);
    staleConfig.projects[0].name = 'Stale tab must not win';
    const stale = await jsonRequest<{ error: string; currentRevision: string }>(url, 'PUT', '/api/config', {
      config: staleConfig,
      expectedRevision: initial.configRevision,
    });
    assert.equal(stale.response.status, 409);
    assert.match(stale.value.error, /alterada em outra aba/);
    assert.equal(stale.value.currentRevision, first.value.configRevision);

    const state = await (await fetch(`${url}/api/state`)).json() as Snapshot;
    assert.equal(state.config.projects[0]?.name, 'Saved by first tab');
    assert.equal(state.configRevision, first.value.configRevision);
  });

  it('rejects non-local host and cross-origin requests before mutation', async () => {
    const root = await tempRoot();
    const app = await openServer(root);
    const url = baseUrl(app);
    const hostStatus = await rawGet(app.port, { Host: `localhost:${app.port + 1}` });
    assert.equal(hostStatus, 403);
    const origin = await fetch(`${url}/api/state`, { headers: { Origin: 'http://evil.example' } });
    assert.equal(origin.status, 403);
  });
});
