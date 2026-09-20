import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OfficeEngine } from "../server/engine.js";
import { diagnoseConfig, analyzeWorkflow } from "../server/diagnostics.js";
import { Store } from "../server/store.js";
import { startServer } from "../server/index.js";
import type { Agent, Config, Snapshot, Workflow } from "../shared/types.js";

const roots: string[] = [];
const engines: OfficeEngine[] = [];
const servers: Awaited<ReturnType<typeof startServer>>[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-office-p2-"));
  roots.push(root);
  return root;
}

async function fixture(root: string, source: string): Promise<string> {
  const file = path.join(root, "fixture.mjs");
  await writeFile(file, source, { mode: 0o700 });
  return file;
}

async function waitForFile(file: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.fail(`timed out waiting for ${file}`);
}

function worker(root: string, script: string, args: string[] = []): Agent {
  return {
    id: "worker",
    name: "Worker",
    role: "Tester",
    avatar: "TE",
    area: "Dev Lab",
    cli: process.execPath,
    args: [script, ...args],
    model: "fixture-model",
    cwd: root,
    instructions: "Run the deterministic fixture.",
    timeoutMs: 10000,
  };
}

function configFor(root: string, agent: Agent, workflow: Workflow): Config {
  return {
    agents: [agent],
    workflows: [workflow],
    projects: [
      {
        id: "project",
        name: "P2 project",
        cwd: root,
        rules: "",
        workflowId: workflow.id,
        agentIds: [agent.id],
      },
    ],
    activeProjectId: "project",
  };
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
      reject(new Error(`timed out waiting for ${JSON.stringify(engine.snapshot().run)}`));
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

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workflow diagnosis", () => {
  it("accepts bounded correction cycles and reports structural paths", () => {
    const cycle: Workflow = {
      id: "cycle",
      name: "Correction cycle",
      start: "check",
      maxSteps: 8,
      steps: [
        {
          id: "check",
          agentId: "worker",
          instruction: "check",
          transitions: { PASS: "fix", FAIL: "check", DONE: "done", ERROR: "error" },
        },
        {
          id: "fix",
          agentId: "worker",
          instruction: "fix",
          transitions: { PASS: "check", DONE: "done", ERROR: "error" },
        },
      ],
    };
    const valid = analyzeWorkflow(cycle, ["worker"], ["worker"]);
    assert.deepEqual(valid.unreachableStepIds, []);
    assert.deepEqual(valid.reachableStepIds, ["check", "fix"]);
    assert.equal(valid.issues.some((item) => item.severity === "error"), false);
    assert.ok(valid.issues.some((item) => item.code === "missing-transition"));

    const malformed = analyzeWorkflow(
      {
        id: "bad",
        name: "Bad graph",
        start: "start",
        maxSteps: 4,
        steps: [
          {
            id: "start",
            agentId: "outsider",
            instruction: "start",
            transitions: { DONE: "ghost", BROKEN: "start" } as Workflow["steps"][number]["transitions"],
          },
          {
            id: "orphan",
            agentId: "worker",
            instruction: "orphan",
            transitions: { DONE: "done" },
          },
        ],
      },
      ["worker"],
      ["worker", "outsider"],
    );
    const codes = malformed.issues.map((item) => item.code);
    assert.ok(codes.includes("agent-outside-team"));
    assert.ok(codes.includes("orphan-transition"));
    assert.ok(codes.includes("unknown-transition-status"));
    assert.ok(codes.includes("unreachable-step"));
    assert.ok(malformed.issues.every((item) => item.path?.startsWith("workflows.bad.")));
    assert.equal(malformed.issues.find((item) => item.code === "unreachable-step")?.stepId, "orphan");
  });

  it("checks local prerequisites without invoking a CLI or model", async () => {
    const root = await tempRoot();
    const flow: Workflow = {
      id: "local",
      name: "Local",
      start: "step",
      maxSteps: 2,
      steps: [
        {
          id: "step",
          agentId: "worker",
          instruction: "diagnose",
          transitions: { DONE: "done", ERROR: "error" },
        },
      ],
    };
    const report = await diagnoseConfig(
      configFor(root, worker(root, "process.execPath"), flow),
    );
    // A bare command is resolved from PATH only; use the actual Node path for
    // the positive executable check below.
    const valid = await diagnoseConfig(
      configFor(root, { ...worker(root, path.join(root, "unused")), cli: process.execPath }, flow),
    );
    assert.equal(report.agents[0]?.authentication.status, "not-verified");
    assert.equal(report.agents[0]?.model.status, "not-verified");
    assert.equal(valid.ok, true);
    assert.equal(valid.agents[0]?.directory.status, "ok");
    assert.equal(valid.agents[0]?.executable.status, "ok");
    assert.match(valid.agents[0]?.executable.message || "", /sem iniciar/);
    assert.equal(valid.issues.some((item) => item.severity === "error"), false);

    const bad = configFor(root, { ...worker(root, path.join(root, "unused")), cli: path.join(root, "missing-cli") }, flow);
    bad.projects[0].agentIds = ["ghost"];
    const invalid = await diagnoseConfig(bad);
    assert.equal(invalid.ok, false);
    assert.ok(invalid.issues.some((item) => item.code === "agent-executable"));
    assert.ok(invalid.issues.some((item) => item.code === "project-agent-missing"));
    assert.ok(invalid.issues.some((item) => item.code === "agent-outside-team"));
    assert.equal(invalid.agents[0]?.authentication.status, "not-verified");
    assert.equal(invalid.agents[0]?.model.status, "not-verified");
  });

  it("exposes diagnosis through a read-only local API", async () => {
    const root = await tempRoot();
    const app = await startServer({ root, port: 0, production: true });
    servers.push(app);
    const response = await fetch(`http://127.0.0.1:${app.port}/api/diagnostics`);
    assert.equal(response.status, 200);
    const report = (await response.json()) as { agents: { authentication: { status: string }; model: { status: string } }[] };
    assert.ok(report.agents.length > 0);
    assert.equal(report.agents[0]?.authentication.status, "not-verified");
    assert.equal(report.agents[0]?.model.status, "not-verified");

    const staleReload = await fetch(`http://127.0.0.1:${app.port}/api/config/reload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: "stale-revision" }),
    });
    assert.equal(staleReload.status, 409);
  });
});

describe("bounded history checkpoints", () => {
  it("persists continuous output at the maximum interval and stops responsively", async () => {
    const root = await tempRoot();
    const pidFile = path.join(root, "pid");
    const script = await fixture(
      root,
      `
const fs = await import('node:fs');
fs.writeFileSync(process.argv[2], String(process.pid));
setInterval(() => process.stdout.write('continuous output\\n'), 20);
`,
    );
    class CountingStore extends Store {
      historyWrites = 0;
      override async saveHistory(snapshot: Snapshot): Promise<void> {
        this.historyWrites += 1;
        await super.saveHistory(snapshot);
      }
    }
    const store = new CountingStore(root);
    const flow: Workflow = {
      id: "continuous",
      name: "Continuous",
      start: "step",
      maxSteps: 2,
      steps: [{ id: "step", agentId: "worker", instruction: "continuous", transitions: { DONE: "done", ERROR: "error" } }],
    };
    await store.save(configFor(root, worker(root, script, [pidFile, "{prompt}"]), flow));
    const engine = await OfficeEngine.create(store);
    engines.push(engine);
    await engine.runTask("project", flow.id, "continuous output");
    await waitForFile(pidFile);
    await waitFor(engine, (snapshot) => snapshot.agents.worker.output.includes("continuous output"));

    // Output events continually reset the trailing debounce timer. Two max
    // interval windows prove that the deadline timer remains active.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.ok(store.historyWrites >= 2, `expected max-interval checkpoints, got ${store.historyWrites}`);
    const persisted = await store.history();
    assert.ok((persisted?.agents.worker.output.length || 0) > 0);
    assert.equal(engine.snapshot().run?.status, "Running");

    const started = Date.now();
    const stopped = await engine.stopRun();
    assert.equal(stopped.run?.status, "Stopped");
    assert.ok(Date.now() - started < 1000, "stop exceeded the responsive cleanup budget");
  });
});
