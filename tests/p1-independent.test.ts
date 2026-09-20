import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OfficeEngine } from "../server/engine.js";
import { Store } from "../server/store.js";
import { defaults } from "../server/defaults.js";
import type { Agent, Config, Snapshot, Workflow } from "../shared/types.js";

const roots: string[] = [];
const engines: OfficeEngine[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-office-p1-"));
  roots.push(root);
  return root;
}

async function fixture(
  root: string,
  source: string,
  name = "fixture.mjs",
): Promise<string> {
  const file = path.join(root, name);
  await writeFile(file, source, { mode: 0o700 });
  return file;
}

async function waitFor(
  engine: OfficeEngine,
  predicate: (snapshot: Snapshot) => boolean,
  timeoutMs = 5000,
): Promise<Snapshot> {
  const current = engine.snapshot();
  if (predicate(current)) return current;
  return new Promise<Snapshot>((resolve, reject) => {
    const timer = setTimeout(() => {
      engine.off("change", onChange);
      reject(
        new Error(
          `timed out waiting for P1 state: ${JSON.stringify(engine.snapshot().run)}`,
        ),
      );
    }, timeoutMs);
    const onChange = (snapshot: Snapshot) => {
      if (!predicate(snapshot)) return;
      clearTimeout(timer);
      engine.off("change", onChange);
      resolve(snapshot);
    };
    engine.on("change", onChange);
  });
}

function agent(
  root: string,
  script: string,
  args: string[],
  id = "worker",
): Agent {
  return {
    id,
    name: id,
    role: "Tester",
    avatar: "TE",
    area: "Dev Lab",
    cli: process.execPath,
    args: [script, ...args],
    model: "fixture-model",
    cwd: root,
    instructions:
      "Run the deterministic fixture and return its structured result.",
    timeoutMs: 3000,
  };
}

function configFor(root: string, agents: Agent[], workflow: Workflow): Config {
  return {
    agents,
    workflows: [workflow],
    projects: [
      {
        id: "project",
        name: "P1 project",
        cwd: root,
        rules: "",
        workflowId: workflow.id,
        agentIds: agents.map((item) => item.id),
      },
    ],
    activeProjectId: "project",
  };
}

async function createEngine(
  root: string,
  config: Config,
  store = new Store(root),
): Promise<OfficeEngine> {
  await store.save(config);
  const engine = await OfficeEngine.create(store);
  engines.push(engine);
  return engine;
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("P1 independent backend validation", () => {
  it("keeps a failed stdin message out of history while later snapshots arrive", async () => {
    const root = await tempRoot();
    const ready = path.join(root, "ready");
    const script = await fixture(
      root,
      `
const fs = await import('node:fs');
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
fs.closeSync(0);
setInterval(() => console.log('snapshot after stdin close'), 40);
`,
    );
    const flow: Workflow = {
      id: "stdin-closed",
      name: "stdin closed",
      start: "step",
      maxSteps: 3,
      steps: [
        {
          id: "step",
          agentId: "worker",
          instruction: "STDIN_CLOSED",
          transitions: { DONE: "done", ERROR: "error" },
        },
      ],
    };
    const engine = await createEngine(
      root,
      configFor(root, [agent(root, script, ["{prompt}"])], flow),
    );

    await engine.runTask("project", flow.id, "stdin closed");
    await waitFor(engine, (snapshot) =>
      snapshot.agents.worker.output.includes("snapshot after stdin close"),
    );
    await assert.rejects(
      engine.send("worker", "KEEP_THIS_TEXT"),
      /live stdin|Unable to send|Timed out sending/,
    );
    const afterFailure = await waitFor(
      engine,
      (snapshot) => snapshot.agents.worker.output.length > 30,
    );

    assert.equal(
      afterFailure.agents.worker.messages.some(
        (message) =>
          message.direction === "user" && message.text === "KEEP_THIS_TEXT",
      ),
      false,
    );
    assert.equal(
      afterFailure.timeline.some(
        (event) =>
          event.kind === "instruction" && event.text.includes("KEEP_THIS_TEXT"),
      ),
      false,
    );
  });

  it("keeps consecutive runs and FAIL correction separate after a server restart", async () => {
    const root = await tempRoot();
    const record = path.join(root, "record.log");
    const script = await fixture(
      root,
      `
const fs = await import('node:fs');
const record = process.argv[2];
const prompt = process.argv.slice(3).join('\\n');
const role = prompt.includes('TEST_STEP') ? 'tester' : prompt.includes('REVIEW_STEP') ? 'reviewer' : 'developer';
const status = role === 'tester' && prompt.includes('FAIL_ONCE') ? 'FAIL' : role === 'tester' ? 'PASS' : 'DONE';
fs.appendFileSync(record, role + ':' + status + '\\n');
console.log(JSON.stringify({status, summary: role + ' ' + status, changed_files: [], issues: [], notes: []}));
`,
    );
    const agents = [
      agent(root, script, [record, "{prompt}"], "developer"),
      agent(root, script, [record, "{prompt}"], "tester"),
      agent(root, script, [record, "{prompt}"], "reviewer"),
    ];
    const flow: Workflow = {
      id: "correction",
      name: "correction",
      start: "develop",
      maxSteps: 8,
      steps: [
        {
          id: "develop",
          agentId: "developer",
          instruction: "DEVELOP_STEP",
          transitions: { DONE: "test", ERROR: "error" },
        },
        {
          id: "test",
          agentId: "tester",
          instruction: "TEST_STEP",
          transitions: { PASS: "done", FAIL: "review", ERROR: "error" },
        },
        {
          id: "review",
          agentId: "reviewer",
          instruction: "REVIEW_STEP",
          transitions: { DONE: "done", ERROR: "error" },
        },
      ],
    };
    const config = configFor(root, agents, flow);
    const engine = await createEngine(root, config);

    await engine.runTask("project", flow.id, "FAIL_ONCE");
    const first = await waitFor(
      engine,
      (snapshot) => snapshot.run?.status === "Done",
    );
    const firstRunId = first.run?.id;
    assert.ok(firstRunId);
    assert.equal(
      first.runHistory.find((run) => run.id === firstRunId)?.attempts.length,
      3,
    );
    assert.equal(
      first.runHistory.find((run) => run.id === firstRunId)?.attempts[1]?.result
        ?.status,
      "FAIL",
    );

    await engine.runTask("project", flow.id, "CORRECTED");
    const secondStarted = engine.snapshot();
    assert.notEqual(secondStarted.run?.id, firstRunId);
    assert.equal(secondStarted.agents.tester.result, undefined);
    assert.equal(secondStarted.agents.tester.messages.length, 0);
    const second = await waitFor(
      engine,
      (snapshot) => snapshot.run?.status === "Done",
    );
    const secondRunId = second.run?.id;
    assert.ok(secondRunId);
    assert.equal(second.runHistory.length, 2);
    assert.deepEqual(
      second.runHistory.map((run) => run.id),
      [firstRunId, secondRunId],
    );
    assert.equal(second.runHistory[0]?.attempts[1]?.result?.status, "FAIL");
    assert.equal(second.runHistory[1]?.attempts[1]?.result?.status, "PASS");
    assert.ok(
      second.timeline.filter((event) => event.runId === firstRunId).length > 0,
    );
    assert.ok(
      second.timeline.filter((event) => event.runId === secondRunId).length > 0,
    );
    assert.equal(
      second.agents.tester.messages.some(
        (message) => message.text === "tester FAIL",
      ),
      false,
    );

    await engine.dispose();
    engines.splice(engines.indexOf(engine), 1);
    const restarted = await OfficeEngine.create(new Store(root));
    engines.push(restarted);
    const restored = restarted.snapshot();
    assert.deepEqual(
      restored.runHistory.map((run) => run.id),
      [firstRunId, secondRunId],
    );
    assert.equal(restored.runHistory[0]?.attempts[1]?.result?.status, "FAIL");
    assert.equal(restored.runHistory[1]?.attempts[1]?.result?.status, "PASS");
    assert.ok(restored.runHistory.every((run) => run.config));
  });

  it("preserves in-memory configuration and revision when a save fails", async () => {
    const root = await tempRoot();
    class FailingStore extends Store {
      failNext = false;
      override async save(config: Config): Promise<void> {
        if (this.failNext) {
          this.failNext = false;
          throw new Error("forced P1 save failure");
        }
        await super.save(config);
      }
    }
    const store = new FailingStore(root);
    const original = defaults(root);
    await store.save(original);
    const engine = await OfficeEngine.create(store);
    engines.push(engine);
    const revision = engine.snapshot().configRevision;
    const draft = structuredClone(original);
    draft.agents[0].instructions = "draft that must remain local after failure";
    store.failNext = true;

    await assert.rejects(
      engine.updateConfig(draft, revision),
      /forced P1 save failure/,
    );
    const failed = engine.snapshot();
    assert.equal(failed.configRevision, revision);
    assert.notEqual(
      failed.config.agents[0].instructions,
      draft.agents[0].instructions,
    );

    const saved = await engine.updateConfig(draft, revision);
    assert.equal(
      saved.config.agents[0].instructions,
      draft.agents[0].instructions,
    );
    assert.notEqual(saved.configRevision, revision);
  });

  it("migrates legacy activity prose into a timestamp without losing the run", async () => {
    const root = await tempRoot();
    const store = new Store(root);
    const config = await store.load();
    const at = "2026-09-20T12:00:00.000Z";
    const agentConfig = config.agents[0];
    await writeFile(
      path.join(root, ".agent-office", "history.json"),
      JSON.stringify({
        agents: {
          [agentConfig.id]: {
            status: "Done",
            task: "legacy task",
            lastActivity: "legacy activity description",
            output: "",
            messages: [
              { at, text: "legacy activity description", direction: "agent" },
            ],
            result: {
              status: "DONE",
              summary: "legacy activity description",
              changed_files: [],
              issues: [],
              notes: [],
            },
          },
        },
        timeline: [
          {
            id: "legacy-event",
            at,
            agentId: agentConfig.id,
            kind: "DONE",
            text: "legacy activity description",
          },
        ],
        run: {
          id: "legacy-run",
          projectId: config.projects[0].id,
          workflowId: config.workflows[0].id,
          task: "legacy task",
          status: "Done",
          stepId: config.workflows[0].start,
          startedAt: at,
          endedAt: at,
        },
      }),
    );

    const history = await store.history();
    assert.equal(history?.run?.id, "legacy-run");
    assert.equal(
      history?.agents[agentConfig.id]?.lastActivity,
      "legacy activity description",
    );
    assert.equal(history?.agents[agentConfig.id]?.lastActivityAt, at);
    assert.equal(history?.timeline[0]?.runId, "legacy-run");
    assert.equal(
      (
        await readFile(path.join(root, ".agent-office", "history.json"), "utf8")
      ).includes("legacy activity description"),
      true,
    );
  });
});
