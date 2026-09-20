import { spawn, type ChildProcess } from "node:child_process";

import type {
  Agent,
  AgentResult,
  AgentRunner,
  AgentStatus,
  ResultStatus,
  RunnerEvent,
  RunnerTask,
} from "../shared/types.js";

/**
 * The runner keeps the tail of a process log in memory. The process is still
 * streamed in full through RunnerEvent callbacks; only the retained snapshot
 * is bounded.
 */
export const MAX_OUTPUT_CHARS = 1_048_576;

/** A result must fit on one reasonably sized JSONL line. */
export const MAX_RESULT_LINE_CHARS = 64 * 1024;

/** How long a process gets to honour SIGTERM before its process group is killed. */
export const TERMINATE_GRACE_MS = 500;

/** A blocked stdin pipe must not hold the server's mutation queue forever. */
export const SEND_TIMEOUT_MS = 1_500;

const RESULT_STATUSES = new Set<ResultStatus>([
  "PASS",
  "FAIL",
  "DONE",
  "ERROR",
]);

type OutputSource = "stdout" | "stderr";
type TerminationReason = "stopped" | "timeout";

interface AgentRecord {
  agent: Agent;
  status: AgentStatus;
  output: string;
  lastTask?: RunnerTask;
  current?: RunState;
}

interface RunState {
  record: AgentRecord;
  task: RunnerTask;
  child: ChildProcess | null;
  output: string;
  outputChars: number;
  lineBuffers: Record<OutputSource, string>;
  result?: AgentResult;
  spawnError?: Error;
  stdinError?: Error;
  termination?: TerminationReason;
  timedOut: boolean;
  settled: boolean;
  timeoutTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  resolve: (result: AgentResult) => void;
  promise: Promise<AgentResult>;
}

type RunnerCallback = (event: RunnerEvent) => void;

function isResultStatus(value: unknown): value is ResultStatus {
  return (
    typeof value === "string" && RESULT_STATUSES.has(value as ResultStatus)
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * Parse the deliberately small line protocol used by agents. Extra JSON
 * fields are ignored so a CLI can include its own metadata, while malformed
 * required fields are treated as an ordinary log line.
 */
function parseResultLine(line: string): AgentResult | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (!isResultStatus(candidate.status)) return undefined;
  if (typeof candidate.summary !== "string") return undefined;
  if (!isStringArray(candidate.changed_files)) return undefined;
  if (!isStringArray(candidate.issues)) return undefined;
  if (!isStringArray(candidate.notes)) return undefined;

  return {
    status: candidate.status,
    summary: candidate.summary,
    changed_files: [...candidate.changed_files],
    issues: [...candidate.issues],
    notes: [...candidate.notes],
  };
}

function emptyResult(status: ResultStatus, summary: string): AgentResult {
  return {
    status,
    summary,
    changed_files: [],
    issues: [],
    notes: [],
  };
}

function cloneTask(task: RunnerTask): RunnerTask {
  return { prompt: task.prompt, cwd: task.cwd };
}

function roleStatus(role: string): AgentStatus {
  const normalized = role.toLocaleLowerCase();
  if (/\b(review|reviewer|critic|audit)\b/.test(normalized)) return "Reviewing";
  if (/\b(test|tester|testing|qa|quality)\b/.test(normalized)) return "Testing";
  return "Working";
}

function resultAgentStatus(result: AgentResult): AgentStatus {
  return result.status === "PASS" || result.status === "DONE"
    ? "Done"
    : "Error";
}

function substitute(
  value: string,
  task: RunnerTask,
  agent: Agent,
  cwd: string,
): string {
  const replacements: Record<"prompt" | "model" | "cwd", string> = {
    prompt: task.prompt,
    model: agent.model,
    cwd,
  };
  return value.replace(
    /\{(prompt|model|cwd)\}/g,
    (_match, key: "prompt" | "model" | "cwd") => replacements[key],
  );
}

function appendCapped(value: string, addition: string): string {
  if (addition.length >= MAX_OUTPUT_CHARS)
    return addition.slice(-MAX_OUTPUT_CHARS);
  const keepFromValue = MAX_OUTPUT_CHARS - addition.length;
  return value.length > keepFromValue
    ? value.slice(-keepFromValue) + addition
    : value + addition;
}

/**
 * Run configured local agent CLIs without involving a shell. Detached
 * children are process-group leaders on Linux, which lets stop/timeout clean
 * up descendants as well as the CLI itself.
 */
export class ProcessRunner implements AgentRunner {
  private readonly callback: RunnerCallback;
  private readonly records = new Map<string, AgentRecord>();
  private disposed = false;
  private disposePromise?: Promise<void>;

  constructor(callback: RunnerCallback = () => undefined) {
    this.callback = callback;
  }

  /** Register or replace an agent configuration. No child process is started. */
  async start(agent: Agent): Promise<void> {
    this.assertUsable();

    const existing = this.records.get(agent.id);
    if (existing?.current) await this.stop(agent.id);

    const record: AgentRecord = {
      agent,
      status: "Idle",
      output: "",
    };
    this.records.set(agent.id, record);
    this.emit({ agentId: agent.id, type: "status", status: "Idle" });
  }

  /** Execute one task and resolve when the child has fully closed. */
  async execute(agentId: string, task: RunnerTask): Promise<AgentResult> {
    this.assertUsable();
    const record = this.requireRecord(agentId);

    // Serialise accidental overlapping executions. This also makes a caller
    // that starts a new task while stopping an old one safe and deterministic.
    if (record.current) await this.stop(agentId);

    record.lastTask = cloneTask(task);
    record.output = "";

    const run = this.createRun(record, task);
    record.current = run;
    this.emitStatus(record, roleStatus(record.agent.role));
    this.launch(run);
    return run.promise;
  }

  /** Send one line to the live child stdin. */
  async send(agentId: string, message: string): Promise<void> {
    const record = this.requireRecord(agentId);
    const run = record.current;
    const stdin = run?.child?.stdin;

    if (
      !run ||
      run.settled ||
      run.spawnError ||
      run.stdinError ||
      !stdin ||
      stdin.destroyed ||
      stdin.writableEnded ||
      !stdin.writable ||
      run.child?.exitCode !== null ||
      run.child?.signalCode !== null
    ) {
      throw new Error(`Agent ${agentId} has no live stdin`);
    }

    const payload = message.endsWith("\n") ? message : `${message}\n`;
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(
        () => finish(new Error(`Timed out sending to agent ${agentId}`)),
        SEND_TIMEOUT_MS,
      );
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        stdin.off("error", onError);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error: Error) =>
        finish(
          new Error(`Unable to send to agent ${agentId}: ${error.message}`),
        );

      stdin.once("error", onError);
      try {
        stdin.write(payload, (error?: Error | null) => {
          if (error)
            finish(
              new Error(`Unable to send to agent ${agentId}: ${error.message}`),
            );
          else finish();
        });
      } catch (error) {
        finish(
          new Error(
            `Unable to send to agent ${agentId}: ${errorMessage(error)}`,
          ),
        );
      }
    });
  }

  /** Stop the current process group, if any, and wait for close. */
  async stop(agentId: string): Promise<void> {
    const record = this.requireRecord(agentId);
    const run = record.current;
    if (!run) return;

    if (!run.termination) run.termination = "stopped";
    this.emitStatus(record, "Idle");
    this.terminate(run);
    await run.promise;
  }

  /** Stop the current task and rerun the most recently requested task. */
  async restart(agentId: string): Promise<void> {
    this.assertUsable();
    const record = this.requireRecord(agentId);
    const task = record.lastTask && cloneTask(record.lastTask);
    if (!task)
      throw new Error(`Agent ${agentId} has no previous task to restart`);

    await this.stop(agentId);
    await this.execute(agentId, task);
  }

  async getStatus(agentId: string): Promise<AgentStatus> {
    return this.requireRecord(agentId).status;
  }

  async getOutput(agentId: string): Promise<string> {
    return this.requireRecord(agentId).output;
  }

  /** Stop all process groups and release runner state. */
  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;

    this.disposed = true;
    this.disposePromise = Promise.allSettled(
      [...this.records.keys()].map((agentId) => this.stop(agentId)),
    ).then(() => {
      this.records.clear();
    });
    return this.disposePromise;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("ProcessRunner has been disposed");
  }

  private requireRecord(agentId: string): AgentRecord {
    const record = this.records.get(agentId);
    if (!record) throw new Error(`Unknown agent ${agentId}`);
    return record;
  }

  private createRun(record: AgentRecord, task: RunnerTask): RunState {
    let resolve!: (result: AgentResult) => void;
    const promise = new Promise<AgentResult>((resolveResult) => {
      resolve = resolveResult;
    });
    return {
      record,
      task: cloneTask(task),
      child: null,
      output: "",
      outputChars: 0,
      lineBuffers: { stdout: "", stderr: "" },
      timedOut: false,
      settled: false,
      resolve,
      promise,
    };
  }

  private launch(run: RunState): void {
    const { record, task } = run;
    const cwd = task.cwd || record.agent.cwd || process.cwd();
    const command = substitute(record.agent.cli, task, record.agent, cwd);
    const args = record.agent.args.map((arg) =>
      substitute(arg, task, record.agent, cwd),
    );
    const env: NodeJS.ProcessEnv = { ...process.env };
    // The environment fallback is useful for CLIs that accept a prompt via
    // their own wrapper. Placeholder substitution remains the preferred path.
    env.AGENT_OFFICE_PROMPT = task.prompt;

    try {
      const child = spawn(command, args, {
        cwd,
        env,
        detached: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      run.child = child;

      // Keep Node's incremental decoder across stream chunks. Converting each
      // Buffer independently can split a UTF-8 character (and corrupt a JSON
      // result line containing non-ASCII text).
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: Buffer | string) =>
        this.handleOutput(run, "stdout", chunk),
      );
      child.stderr?.on("data", (chunk: Buffer | string) =>
        this.handleOutput(run, "stderr", chunk),
      );
      child.stdin?.on("error", (error) => {
        run.stdinError ??=
          error instanceof Error ? error : new Error(String(error));
      });
      child.once("error", (error) => {
        if (run.settled) return;
        run.spawnError =
          error instanceof Error ? error : new Error(String(error));
      });
      child.once("close", (code, signal) => this.finish(run, code, signal));

      const timeoutMs = Number(record.agent.timeoutMs);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        run.timeoutTimer = setTimeout(() => {
          if (run.settled) return;
          run.timedOut = true;
          run.termination = "timeout";
          this.emitStatus(record, "Error");
          this.terminate(run);
        }, timeoutMs);
      }
    } catch (error) {
      run.spawnError =
        error instanceof Error ? error : new Error(String(error));
      this.finish(run, null, null);
    }
  }

  private handleOutput(
    run: RunState,
    source: OutputSource,
    chunk: Buffer | string,
  ): void {
    if (run.settled || run.record.current !== run) return;
    const text = Buffer.isBuffer(chunk)
      ? chunk.toString("utf8")
      : String(chunk);
    if (!text) return;

    run.output = appendCapped(run.output, text);
    run.outputChars = run.output.length;
    run.record.output = run.output;
    this.emit({ agentId: run.record.agent.id, type: "output", text });

    run.lineBuffers[source] += text;
    let newline = run.lineBuffers[source].indexOf("\n");
    while (newline !== -1) {
      const line = run.lineBuffers[source].slice(0, newline);
      run.lineBuffers[source] = run.lineBuffers[source].slice(newline + 1);
      this.considerResult(run, line);
      newline = run.lineBuffers[source].indexOf("\n");
    }

    // A CLI that writes a never-ending line must not cause unbounded memory
    // use in the parser, even though its retained output is already capped.
    if (run.lineBuffers[source].length > MAX_RESULT_LINE_CHARS) {
      run.lineBuffers[source] = run.lineBuffers[source].slice(
        -MAX_RESULT_LINE_CHARS,
      );
    }
  }

  private considerResult(run: RunState, line: string): void {
    if (line.length > MAX_RESULT_LINE_CHARS) return;
    const result = parseResultLine(line);
    if (result) run.result = result;
  }

  private finish(
    run: RunState,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (run.settled) return;
    this.flushLineBuffers(run);

    // A CLI can daemonise a descendant with stdio ignored. `close` only
    // describes the direct child, so clean up the detached process group here
    // as well as in the stop/timeout path.
    if (run.child) this.signalProcessGroup(run.child, "SIGKILL");

    if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
    if (run.killTimer) clearTimeout(run.killTimer);

    const result = this.buildResult(run, code, signal);
    run.settled = true;

    const record = run.record;
    if (record.current === run) {
      record.current = undefined;
      record.output = run.output;
      this.emitStatus(
        record,
        run.termination === "stopped" ? "Idle" : resultAgentStatus(result),
      );
    }

    run.resolve(result);
  }

  private flushLineBuffers(run: RunState): void {
    this.considerResult(run, run.lineBuffers.stdout);
    this.considerResult(run, run.lineBuffers.stderr);
    run.lineBuffers.stdout = "";
    run.lineBuffers.stderr = "";
  }

  private buildResult(
    run: RunState,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): AgentResult {
    if (run.timedOut || run.termination === "timeout") {
      return emptyResult(
        "ERROR",
        `Agent timed out after ${run.record.agent.timeoutMs}ms`,
      );
    }

    if (run.termination === "stopped") {
      return emptyResult("ERROR", "Agent process stopped");
    }

    if (run.spawnError) {
      return emptyResult(
        "ERROR",
        `Unable to start agent ${run.record.agent.cli}: ${run.spawnError.message}`,
      );
    }

    if (code !== 0 || signal) {
      const reason = signal
        ? `terminated by ${signal}`
        : `exited with code ${String(code)}`;
      if (run.result) {
        return {
          ...run.result,
          status: "ERROR",
          summary: run.result.summary
            ? `${run.result.summary} (${reason})`
            : `Agent ${reason}`,
        };
      }
      return emptyResult("ERROR", `Agent ${reason}`);
    }

    return (
      run.result ??
      emptyResult("DONE", "Agent completed without a structured result")
    );
  }

  private terminate(run: RunState): void {
    const child = run.child;
    if (!child || run.settled) return;

    this.signalProcessGroup(child, "SIGTERM");
    if (!run.killTimer) {
      run.killTimer = setTimeout(() => {
        if (run.settled) return;
        this.signalProcessGroup(child, "SIGKILL");
      }, TERMINATE_GRACE_MS);
    }
  }

  private signalProcessGroup(
    child: ChildProcess,
    signal: NodeJS.Signals,
  ): void {
    const pid = child.pid;
    if (typeof pid === "number" && pid > 1) {
      try {
        // A detached child is a process-group leader on Linux. Negative PIDs
        // address that group, including descendants spawned by the CLI.
        process.kill(-pid, signal);
        return;
      } catch (error) {
        // ESRCH means the group already exited. For any other failure, the
        // direct-child fallback still gives the caller a chance to close it.
        if (!isNoSuchProcess(error)) {
          try {
            child.kill(signal);
          } catch {
            // The close/error event remains the source of truth for completion.
          }
        }
        return;
      }
    }

    try {
      child.kill(signal);
    } catch {
      // A process can exit between checking pid and sending the signal.
    }
  }

  private emitStatus(record: AgentRecord, status: AgentStatus): void {
    if (record.status === status) return;
    record.status = status;
    this.emit({ agentId: record.agent.id, type: "status", status });
  }

  private emit(event: RunnerEvent): void {
    try {
      this.callback(event);
    } catch {
      // Observers should not be able to break process cleanup or result
      // delivery. The server can choose to log callback errors itself.
    }
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ESRCH",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
