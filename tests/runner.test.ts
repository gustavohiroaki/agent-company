import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Agent, RunnerEvent } from "../shared/types.js";
import { ProcessRunner } from "../server/runner.js";

const cwd = process.cwd();

function makeAgent(script: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id: "test-agent",
    name: "Test agent",
    role: "Developer",
    avatar: "T",
    area: "Dev Lab",
    cli: process.execPath,
    args: ["-e", script],
    model: "test-model",
    cwd,
    instructions: "",
    timeoutMs: 2_000,
    ...overrides,
  };
}

async function waitForOutput(
  runner: ProcessRunner,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await runner.getOutput("test-agent")).includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for output ${JSON.stringify(expected)}`);
}

async function waitForPidFile(file: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  let lastContent = "";
  while (Date.now() < deadline) {
    try {
      lastContent = await readFile(file, "utf8");
      const pid = Number(lastContent.trim());
      if (Number.isSafeInteger(pid) && pid > 1) return pid;
    } catch {
      // The fixture can create the file before its synchronous write becomes
      // observable from this process. Keep polling until the complete PID is
      // available instead of treating an empty intermediate file as valid.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `Timed out waiting for a valid descendant PID in ${file}; last content was ${JSON.stringify(lastContent)}`,
  );
}

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("returns a structured PASS/FAIL result from the last valid JSON line", async (t) => {
  const events: RunnerEvent[] = [];
  const runner = new ProcessRunner((event) => events.push(event));
  t.after(() => runner.dispose());
  await runner.start(
    makeAgent(`
    console.log('ordinary log');
    console.log(JSON.stringify({status: 'PASS', summary: 'checks passed', changed_files: ['a.ts'], issues: [], notes: ['ok']}));
    console.log(JSON.stringify({status: 'FAIL', summary: 'last result', changed_files: [], issues: ['one'], notes: []}));
  `),
  );

  const result = await runner.execute("test-agent", { prompt: "hello", cwd });
  assert.deepEqual(result, {
    status: "FAIL",
    summary: "last result",
    changed_files: [],
    issues: ["one"],
    notes: [],
  });
  assert.equal(await runner.getStatus("test-agent"), "Error");
  assert.ok(
    events.some(
      (event) =>
        event.type === "output" && event.text?.includes("ordinary log"),
    ),
  );
});

test("reports a missing CLI as ERROR", async (t) => {
  const runner = new ProcessRunner();
  t.after(() => runner.dispose());
  await runner.start(makeAgent("", { cli: "/this/executable/does/not/exist" }));

  const result = await runner.execute("test-agent", { prompt: "hello", cwd });
  assert.equal(result.status, "ERROR");
  assert.match(result.summary, /Unable to start agent/);
  assert.equal(await runner.getStatus("test-agent"), "Error");
});

test("stop terminates a live child and leaves the agent idle", async (t) => {
  const runner = new ProcessRunner();
  t.after(() => runner.dispose());
  await runner.start(
    makeAgent(`
    console.log('started');
    setTimeout(() => {}, 60_000);
  `),
  );

  const resultPromise = runner.execute("test-agent", { prompt: "hello", cwd });
  await waitForOutput(runner, "started");
  await runner.stop("test-agent");
  const result = await resultPromise;

  assert.equal(result.status, "ERROR");
  assert.match(result.summary, /stopped/i);
  assert.equal(await runner.getStatus("test-agent"), "Idle");
});

test("stop kills descendants that ignore SIGTERM", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "agent-office-runner-"));
  const descendantPidFile = join(tempDir, "descendant.pid");
  const script = `
    const fs = require('node:fs');
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000);"], {stdio: 'ignore'});
    fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid));
    setInterval(() => {}, 60000);
  `;
  const runner = new ProcessRunner();
  t.after(async () => {
    await runner.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });
  await runner.start(makeAgent(script));

  const resultPromise = runner.execute("test-agent", { prompt: "hello", cwd });
  const descendantPid = await waitForPidFile(descendantPidFile);
  assert.ok(descendantPid > 1);
  await runner.stop("test-agent");
  await resultPromise;

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && (await processExists(descendantPid))) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await processExists(descendantPid), false);
});

test("restart safely reruns the last task", async (t) => {
  const statuses: string[] = [];
  const runner = new ProcessRunner((event) => {
    if (event.type === "status" && event.status) statuses.push(event.status);
  });
  t.after(() => runner.dispose());
  await runner.start(
    makeAgent(`
    console.log(JSON.stringify({status: 'DONE', summary: 'ran', changed_files: [], issues: [], notes: []}));
  `),
  );

  const first = await runner.execute("test-agent", {
    prompt: "same task",
    cwd,
  });
  await runner.restart("test-agent");
  assert.equal(first.status, "DONE");
  assert.equal(await runner.getStatus("test-agent"), "Done");
  assert.ok(statuses.filter((status) => status === "Working").length >= 2);
});

test("send writes to a live stdin and prompt fallback is available in the environment", async (t) => {
  const runner = new ProcessRunner();
  t.after(() => runner.dispose());
  await runner.start(
    makeAgent(`
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (value) => {
      if (value.includes('from stdin')) {
        console.log(JSON.stringify({status: 'PASS', summary: process.env.AGENT_OFFICE_PROMPT, changed_files: [], issues: [], notes: []}));
        process.exit(0);
      }
    });
  `),
  );

  const resultPromise = runner.execute("test-agent", {
    prompt: "prompt from environment",
    cwd,
  });
  await runner.send("test-agent", "from stdin");
  const result = await resultPromise;
  assert.equal(result.status, "PASS");
  assert.equal(result.summary, "prompt from environment");
});

test("times out and kills a child that does not exit", async (t) => {
  const runner = new ProcessRunner();
  t.after(() => runner.dispose());
  await runner.start(
    makeAgent("setTimeout(() => {}, 60_000);", { timeoutMs: 40 }),
  );

  const result = await runner.execute("test-agent", { prompt: "hello", cwd });
  assert.equal(result.status, "ERROR");
  assert.match(result.summary, /timed out/i);
  assert.equal(await runner.getStatus("test-agent"), "Error");
});
