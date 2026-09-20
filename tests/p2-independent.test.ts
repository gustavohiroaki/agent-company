import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OfficeEngine } from "../server/engine.js";
import { diagnoseConfig, analyzeWorkflow } from "../server/diagnostics.js";
import { defaults } from "../server/defaults.js";
import { Store } from "../server/store.js";
import type { Agent, Config, Snapshot, Workflow } from "../shared/types.js";

const roots: string[] = [];
const engines: OfficeEngine[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-office-p2-"));
  roots.push(root);
  return root;
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
          `timed out waiting for engine state: ${JSON.stringify(engine.snapshot().run)}`,
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

async function waitForHistory(
  file: string,
  predicate: (value: any) => boolean,
  timeoutMs = 4000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (predicate(value)) return value;
    } catch {
      // The first checkpoint may not have been written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for persisted history: ${file}`);
}

function agent(
  root: string,
  id: string,
  overrides: Partial<Agent> = {},
): Agent {
  return {
    id,
    name: id,
    role: "Tester",
    avatar: "TE",
    area: "Dev Lab",
    cli: process.execPath,
    args: [],
    model: "local-fixture",
    cwd: root,
    instructions: "Run the local deterministic fixture.",
    timeoutMs: 3000,
    ...overrides,
  };
}

function configFor(root: string, agents: Agent[], workflow: Workflow): Config {
  return {
    agents,
    workflows: [workflow],
    projects: [
      {
        id: "project",
        name: "P2 project",
        cwd: root,
        rules: "",
        workflowId: workflow.id,
        agentIds: agents.map((item) => item.id),
      },
    ],
    activeProjectId: "project",
  };
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("P2 independent backend validation", () => {
  it("diagnoses local paths and graph compatibility without launching a CLI", async () => {
    const root = await tempRoot();
    const marker = path.join(root, "diagnostic-must-not-run");
    const probe = path.join(root, "probe.mjs");
    await writeFile(
      probe,
      `#!/usr/bin/env node\nconst fs = await import('node:fs');\nfs.writeFileSync(${JSON.stringify(marker)}, 'started');\n`,
      { mode: 0o700 },
    );
    await chmod(probe, 0o700);

    const flow: Workflow = {
      id: "diagnostic-flow",
      name: "Diagnostic flow",
      start: "start",
      maxSteps: 8,
      steps: [
        {
          id: "start",
          agentId: "probe",
          instruction: "check",
          transitions: { DONE: "cycle", ERROR: "error" },
        },
        {
          id: "cycle",
          agentId: "outsider",
          instruction: "cycle",
          transitions: { PASS: "start", FAIL: "missing-step" },
        },
        {
          id: "unreachable",
          agentId: "missing-agent",
          instruction: "never reached",
          transitions: {},
        },
      ],
    };
    const config = configFor(
      root,
      [
        agent(root, "probe", { cli: probe }),
        agent(root, "outsider", { cli: process.execPath }),
        agent(root, "bad-cwd", {
          cli: process.execPath,
          cwd: path.join(root, "does-not-exist"),
        }),
      ],
      flow,
    );
    config.projects[0].agentIds = ["probe", "bad-cwd"];

    const report = await diagnoseConfig(config, "project", flow.id);
    const codes = new Set(report.issues.map((item) => item.code));
    assert.equal(report.ok, false);
    assert.equal(
      report.agents.find((item) => item.agentId === "probe")?.authentication
        .status,
      "not-verified",
    );
    assert.equal(
      report.agents.find((item) => item.agentId === "probe")?.model.status,
      "not-verified",
    );
    assert.equal(
      report.agents.find((item) => item.agentId === "probe")?.executable.status,
      "ok",
    );
    assert.equal(
      report.agents.find((item) => item.agentId === "bad-cwd")?.directory
        .status,
      "error",
    );
    assert.ok(codes.has("agent-outside-team"));
    assert.ok(codes.has("agent-directory"));
    assert.ok(codes.has("unreachable-step"));
    assert.ok(codes.has("missing-transition"));
    assert.ok(codes.has("orphan-transition"));
    assert.ok(report.workflow?.unreachableStepIds.includes("unreachable"));
    assert.equal(
      await stat(marker)
        .then(() => true)
        .catch(() => false),
      false,
      "diagnostic executable probe was started",
    );
  });

  it("flags unreachable and outside-team steps while accepting a bounded cycle", () => {
    const workflow: Workflow = {
      id: "graph",
      name: "Graph",
      start: "a",
      maxSteps: 4,
      steps: [
        {
          id: "a",
          agentId: "developer",
          instruction: "a",
          transitions: { DONE: "b", ERROR: "error" },
        },
        {
          id: "b",
          agentId: "developer",
          instruction: "b",
          transitions: { PASS: "a", ERROR: "error" },
        },
        {
          id: "isolated",
          agentId: "reviewer",
          instruction: "isolated",
          transitions: { DONE: "done", ERROR: "error" },
        },
      ],
    };
    const report = analyzeWorkflow(
      workflow,
      ["developer"],
      ["developer", "reviewer"],
    );
    assert.deepEqual(report.reachableStepIds, ["a", "b"]);
    assert.deepEqual(report.unreachableStepIds, ["isolated"]);
    assert.ok(report.issues.some((item) => item.code === "agent-outside-team"));
    assert.ok(report.issues.some((item) => item.code === "unreachable-step"));
    assert.ok(report.issues.some((item) => item.code === "missing-transition"));
    assert.equal(
      report.issues.some((item) => item.code === "cycle"),
      false,
    );
  });

  it("recovers the last complete split configuration after a mid-save failure", async () => {
    const root = await tempRoot();
    const store = new Store(root);
    const original = defaults(root);
    await store.save(original);
    const draft = structuredClone(original);
    draft.agents[0].instructions =
      "new generation must not be mixed into the old one";

    class FailingStore extends Store {
      writes = 0;
      override async atomic(file: string, contents: string): Promise<void> {
        this.writes += 1;
        if (this.writes === 2) throw new Error("injected mid-save failure");
        await super.atomic(file, contents);
      }
    }
    const failing = new FailingStore(root);
    await assert.rejects(failing.save(draft), /injected mid-save failure/);
    assert.ok(failing.writes >= 2);

    const recovered = await new Store(root).load();
    assert.deepEqual(recovered, original);
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(root, ".agent-office", "config-manifest.json"),
          "utf8",
        ),
      ).configRevision,
      (await new Store(root).load()) &&
        (await import("../server/store.js")).configRevision(original),
    );
  });

  it("preserves malformed history bytes beside an empty recovered history", async () => {
    const root = await tempRoot();
    const store = new Store(root);
    await store.load();
    const file = path.join(root, ".agent-office", "history.json");
    const malformed = '{"version":2,"timeline": [';
    await writeFile(file, malformed);

    assert.equal(await store.history(), null);
    assert.equal(await readFile(file, "utf8"), malformed);
    assert.equal(await readFile(file + ".invalid", "utf8"), malformed);
  });

  it("checkpoints continuous output before Stop and responds with a stopped run", async () => {
    const root = await tempRoot();
    const fixture = path.join(root, "continuous.mjs");
    await writeFile(
      fixture,
      "setInterval(() => console.log('continuous tick'), 20);",
      { mode: 0o700 },
    );
    const flow: Workflow = {
      id: "continuous",
      name: "Continuous",
      start: "step",
      maxSteps: 2,
      steps: [
        {
          id: "step",
          agentId: "worker",
          instruction: "stream output",
          transitions: { DONE: "done", ERROR: "error" },
        },
      ],
    };
    const config = configFor(
      root,
      [agent(root, "worker", { args: [fixture] })],
      flow,
    );
    const store = new Store(root);
    await store.save(config);
    const engine = await OfficeEngine.create(store);
    engines.push(engine);
    const historyFile = path.join(root, ".agent-office", "history.json");

    await engine.runTask("project", flow.id, "stream task");
    await waitFor(engine, (snapshot) =>
      snapshot.agents.worker.output.includes("continuous tick"),
    );
    const checkpoint = await waitForHistory(
      historyFile,
      (value) =>
        value.run?.status === "Running" &&
        value.agents?.worker?.output.includes("continuous tick"),
      3500,
    );
    assert.equal(checkpoint.run.status, "Running");

    const started = Date.now();
    const stopped = await engine.stopRun();
    assert.ok(Date.now() - started < 2500, "Stop did not respond promptly");
    assert.equal(stopped.run?.status, "Stopped");
    const persisted = await waitForHistory(
      historyFile,
      (value) => value.run?.status === "Stopped",
      2500,
    );
    assert.equal(persisted.run.status, "Stopped");
    assert.ok(persisted.agents.worker.output.includes("continuous tick"));
  });
});
