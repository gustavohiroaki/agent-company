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

/**
 * Versioned, local-only building blocks for an agent's vector avatar.
 *
 * Keep these values deliberately small and explicit: they are part of the
 * persisted configuration contract and are also used by the server to reject
 * arbitrary SVG/CSS values.
 */
export const AVATAR_APPEARANCE_VERSION = 1 as const;
export const AVATAR_FACES = ["soft", "round", "angular"] as const;
export type AvatarFace = (typeof AVATAR_FACES)[number];

export const AVATAR_EXPRESSIONS = ["neutral", "friendly", "focused"] as const;
export type AvatarExpression = (typeof AVATAR_EXPRESSIONS)[number];

export const AVATAR_HAIR_STYLES = [
  "short",
  "curly",
  "long",
  "shaved",
  "bun",
] as const;
export type AvatarHairStyle = (typeof AVATAR_HAIR_STYLES)[number];

export const AVATAR_OUTFITS = ["shirt", "hoodie", "jacket", "sweater"] as const;
export type AvatarOutfit = (typeof AVATAR_OUTFITS)[number];

export const AVATAR_ACCESSORIES = ["none", "glasses", "headset", "cap"] as const;
export type AvatarAccessory = (typeof AVATAR_ACCESSORIES)[number];

export const AVATAR_SKIN_TONES = [
  "#F6D0B1",
  "#E7AD82",
  "#C98762",
  "#A9664C",
  "#75452F",
  "#4A2A21",
] as const;
export type AvatarSkinTone = (typeof AVATAR_SKIN_TONES)[number];

export const AVATAR_HAIR_COLORS = [
  "#2E2523",
  "#5B392A",
  "#8C5A3C",
  "#C68A58",
  "#D8B56D",
  "#EFE7D7",
  "#6C4A7C",
] as const;
export type AvatarHairColor = (typeof AVATAR_HAIR_COLORS)[number];

export const AVATAR_OUTFIT_COLORS = [
  "#4F65C8",
  "#45A086",
  "#D98268",
  "#9278BE",
  "#293235",
  "#E0A92F",
  "#D5E3F2",
  "#F2D2C3",
] as const;
export type AvatarOutfitColor = (typeof AVATAR_OUTFIT_COLORS)[number];

export const AVATAR_BACKGROUND_COLORS = [
  "#F7F3E8",
  "#EAF0F6",
  "#E8F3EC",
  "#F0EAF5",
  "#FFF0E6",
  "#E7ECEB",
] as const;
export type AvatarBackgroundColor = (typeof AVATAR_BACKGROUND_COLORS)[number];

export interface AvatarAppearance {
  version: typeof AVATAR_APPEARANCE_VERSION;
  skinTone: AvatarSkinTone;
  face: AvatarFace;
  expression: AvatarExpression;
  hairStyle: AvatarHairStyle;
  hairColor: AvatarHairColor;
  outfit: AvatarOutfit;
  outfitColor: AvatarOutfitColor;
  accessory: AvatarAccessory;
  backgroundColor: AvatarBackgroundColor;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  avatar: string;
  /** Optional for backwards compatibility with pre-avatar-builder configs. */
  appearance?: AvatarAppearance;
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
