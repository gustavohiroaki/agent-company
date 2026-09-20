export type AgentStatus =
  | "Idle"
  | "Working"
  | "Waiting"
  | "Testing"
  | "Reviewing"
  | "Blocked"
  | "Done"
  | "Error";
export type ResultStatus = "PASS" | "FAIL" | "DONE" | "ERROR";
export type Area =
  | "Executive"
  | "Research Hub"
  | "Dev Lab"
  | "Review Zone"
  | "Approval"
  | "Content Studio";
export interface Agent {
  id: string;
  name: string;
  role: string;
  avatar: string;
  area: Area;
  cli: string;
  args: string[];
  model: string;
  cwd: string;
  instructions: string;
  timeoutMs: number;
}
export interface AgentResult {
  status: ResultStatus;
  summary: string;
  changed_files: string[];
  issues: string[];
  notes: string[];
}
export interface AgentMessage {
  at: string;
  text: string;
  direction: "user" | "agent";
}
export interface Step {
  id: string;
  agentId: string;
  instruction: string;
  transitions: Partial<Record<ResultStatus, string>>;
}
export interface Workflow {
  id: string;
  name: string;
  start: string;
  steps: Step[];
  maxSteps: number;
}
export interface Project {
  id: string;
  name: string;
  cwd: string;
  rules: string;
  workflowId: string;
  agentIds: string[];
}
export interface Config {
  agents: Agent[];
  workflows: Workflow[];
  projects: Project[];
  activeProjectId: string;
}
export type DiagnosticSeverity = "error" | "warning" | "info";
export type DiagnosticCheckStatus = "ok" | "error" | "not-verified";
export interface DiagnosticIssue {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  path?: string;
  projectId?: string;
  workflowId?: string;
  stepId?: string;
  agentId?: string;
}
export interface DiagnosticCheck {
  status: DiagnosticCheckStatus;
  message: string;
  path?: string;
}
export interface AgentDiagnostic {
  agentId: string;
  directory: DiagnosticCheck;
  executable: DiagnosticCheck;
  authentication: DiagnosticCheck;
  model: DiagnosticCheck;
  issues: DiagnosticIssue[];
}
export interface WorkflowDiagnostic {
  workflowId: string;
  reachableStepIds: string[];
  unreachableStepIds: string[];
  issues: DiagnosticIssue[];
}
export interface DiagnosticsReport {
  checkedAt: string;
  ok: boolean;
  projectId?: string;
  workflowId?: string;
  issues: DiagnosticIssue[];
  agents: AgentDiagnostic[];
  workflow?: WorkflowDiagnostic;
}
export interface AgentRuntime {
  status: AgentStatus;
  task: string;
  lastActivity: string;
  lastActivityAt: string;
  output: string;
  messages: AgentMessage[];
  result?: AgentResult;
}
export interface TimelineEvent {
  id: string;
  at: string;
  agentId?: string;
  runId?: string;
  attemptId?: string;
  kind: string;
  text: string;
}
export interface Run {
  id: string;
  projectId: string;
  workflowId: string;
  task: string;
  status: "Running" | "Done" | "Error" | "Stopped";
  stepId: string;
  startedAt: string;
  endedAt?: string;
}
export interface StepAttempt {
  id: string;
  runId: string;
  stepId: string;
  agentId: string;
  status: "Running" | "Done" | "Error" | "Stopped";
  startedAt: string;
  endedAt?: string;
  output: string;
  messages: AgentMessage[];
  result?: AgentResult;
}
export interface RunHistoryEntry extends Run {
  /** The configuration captured at run start. Legacy records may omit it. */
  config?: Config;
  configRevision: string;
  attempts: StepAttempt[];
}
export interface Snapshot {
  config: Config;
  configRevision: string;
  agents: Record<string, AgentRuntime>;
  timeline: TimelineEvent[];
  run: Run | null;
  runHistory: RunHistoryEntry[];
}
export interface RunnerTask {
  prompt: string;
  cwd: string;
}
export interface AgentRunner {
  start(agent: Agent): Promise<void>;
  execute(agentId: string, task: RunnerTask): Promise<AgentResult>;
  send(agentId: string, message: string): Promise<void>;
  stop(agentId: string): Promise<void>;
  restart(agentId: string): Promise<void>;
  getStatus(agentId: string): Promise<AgentStatus>;
  getOutput(agentId: string): Promise<string>;
}
export type RunnerEvent = {
  agentId: string;
  type: "output" | "status" | "message";
  text?: string;
  status?: AgentStatus;
};
