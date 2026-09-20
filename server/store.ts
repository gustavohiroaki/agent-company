import {
  access,
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  readdir,
  rm,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import YAML from "yaml";
import { defaults } from "./defaults.js";
import type {
  AgentResult,
  AgentMessage,
  AgentRuntime,
  AvatarAppearance,
  BrandTheme,
  Config,
  Run,
  RunHistoryEntry,
  Snapshot,
  StepAttempt,
  TimelineEvent,
} from "../shared/types.js";
import {
  AVATAR_ACCESSORIES,
  AVATAR_APPEARANCE_VERSION,
  AVATAR_BACKGROUND_COLORS,
  AVATAR_EXPRESSIONS,
  AVATAR_FACES,
  AVATAR_HAIR_COLORS,
  AVATAR_HAIR_STYLES,
  AVATAR_OUTFIT_COLORS,
  AVATAR_OUTFITS,
  AVATAR_SKIN_TONES,
} from "../shared/types.js";

export const HISTORY_VERSION = 2;
export const MAX_RUN_HISTORY = 50;
export const MAX_ATTEMPTS = 200;
export const MAX_TIMELINE_EVENTS = 1000;
export const MAX_AGENT_MESSAGES = 100;
export const MAX_OUTPUT_CHARS = 100000;
export const CONFIG_MANIFEST_VERSION = 1;
export const MAX_CONFIG_BACKUPS = 3;

export interface PersistedHistory {
  version: typeof HISTORY_VERSION;
  agents: Record<string, AgentRuntime>;
  timeline: TimelineEvent[];
  run: Run | null;
  runHistory: RunHistoryEntry[];
}

interface ConfigManifest {
  version: typeof CONFIG_MANIFEST_VERSION;
  generation: string;
  createdAt: string;
  configRevision: string;
  files: Record<string, string>;
}
const areas = [
  "Executive",
  "Research Hub",
  "Dev Lab",
  "Review Zone",
  "Approval",
  "Content Studio",
];
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function str(value: unknown, name: string, max = 20000) {
  assert(
    typeof value === "string" && value.length <= max,
    `${name}: texto inválido (máximo ${max} caracteres).`,
  );
}
function id(value: unknown) {
  assert(
    typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value),
    "ID inválido. Use letras, números, _ ou -.",
  );
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  options: T,
): value is T[number] {
  return typeof value === "string" && options.includes(value);
}

const AVATAR_APPEARANCE_FIELDS = [
  "version",
  "skinTone",
  "face",
  "expression",
  "hairStyle",
  "hairColor",
  "outfit",
  "outfitColor",
  "accessory",
  "backgroundColor",
] as const;

const BRAND_THEME_FIELDS = ["primaryColor", "secondaryColor", "logoAsset", "logoDataUrl"] as const;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const BRAND_LOGO_DATA_URL = /^data:image\/(png|jpeg|webp|svg\+xml);base64,([a-zA-Z0-9+/]+={0,2})$/;
const MAX_BRAND_LOGO_DATA_URL_LENGTH = 700_000;
const MAX_BRAND_LOGO_BYTES = 512 * 1024;
const UNSAFE_EMBEDDED_SVG = /<(?:script|foreignObject|iframe|object|embed)\b|on[a-z]+\s*=|(?:href|src)\s*=\s*["']?\s*(?:https?:|\/\/|javascript:)|url\s*\(/i;

export function validateBrandTheme(
  value: unknown,
  field = "Identidade visual",
): asserts value is BrandTheme {
  assert(isRecord(value), `${field}: objeto inválido.`);
  const keys = Object.keys(value);
  assert(
    keys.every((key) => (BRAND_THEME_FIELDS as readonly string[]).includes(key)) &&
      Object.prototype.hasOwnProperty.call(value, "primaryColor") &&
      Object.prototype.hasOwnProperty.call(value, "secondaryColor"),
    `${field}: campos inválidos.`,
  );
  assert(
    typeof value.primaryColor === "string" && HEX_COLOR.test(value.primaryColor),
    `${field}.primaryColor: use uma cor hexadecimal como #4F5DFF.`,
  );
  assert(
    typeof value.secondaryColor === "string" && HEX_COLOR.test(value.secondaryColor),
    `${field}.secondaryColor: use uma cor hexadecimal como #17223B.`,
  );
  if (value.logoAsset !== undefined) {
    assert(value.logoAsset === "flash", `${field}.logoAsset: alternativa desconhecida.`);
  }
  assert(
    value.logoAsset === undefined || value.logoDataUrl === undefined,
    `${field}: escolha uma logo incluída ou personalizada, não ambas.`,
  );
  if (value.logoDataUrl !== undefined) {
    const match = typeof value.logoDataUrl === "string"
      ? BRAND_LOGO_DATA_URL.exec(value.logoDataUrl)
      : null;
    assert(
      typeof value.logoDataUrl === "string" &&
        value.logoDataUrl.length <= MAX_BRAND_LOGO_DATA_URL_LENGTH &&
        match,
      `${field}.logoDataUrl: envie PNG, JPEG, WebP ou SVG válido de até 512 KB.`,
    );
    const bytes = Buffer.from(match[2], "base64");
    assert(bytes.length <= MAX_BRAND_LOGO_BYTES, `${field}.logoDataUrl: a imagem excede 512 KB.`);
    if (match[1] === "svg+xml") {
      const svg = bytes.toString("utf8");
      assert(
        svg.includes("<svg") && !UNSAFE_EMBEDDED_SVG.test(svg),
        `${field}.logoDataUrl: o SVG contém conteúdo externo ou executável.`,
      );
    }
  }
}

/**
 * Validate the serializable avatar contract at the persistence boundary.
 *
 * This intentionally rejects extra keys as well as unknown option/color
 * values. In particular, no SVG, CSS declaration, URL, or arbitrary markup
 * can enter the configuration through an Agent object.
 */
export function validateAvatarAppearance(
  value: unknown,
  field = "Aparência",
): asserts value is AvatarAppearance {
  assert(isRecord(value), `${field}: objeto inválido.`);
  const keys = Object.keys(value);
  assert(
    keys.length === AVATAR_APPEARANCE_FIELDS.length &&
      AVATAR_APPEARANCE_FIELDS.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
      keys.every((key) => (AVATAR_APPEARANCE_FIELDS as readonly string[]).includes(key)),
    `${field}: campos inválidos.`,
  );
  assert(
    value.version === AVATAR_APPEARANCE_VERSION,
    `${field}.version inválida.`,
  );
  assert(
    oneOf(value.skinTone, AVATAR_SKIN_TONES),
    `${field}.skinTone inválido.`,
  );
  assert(oneOf(value.face, AVATAR_FACES), `${field}.face inválido.`);
  assert(
    oneOf(value.expression, AVATAR_EXPRESSIONS),
    `${field}.expression inválida.`,
  );
  assert(
    oneOf(value.hairStyle, AVATAR_HAIR_STYLES),
    `${field}.hairStyle inválido.`,
  );
  assert(
    oneOf(value.hairColor, AVATAR_HAIR_COLORS),
    `${field}.hairColor inválido.`,
  );
  assert(oneOf(value.outfit, AVATAR_OUTFITS), `${field}.outfit inválido.`);
  assert(
    oneOf(value.outfitColor, AVATAR_OUTFIT_COLORS),
    `${field}.outfitColor inválido.`,
  );
  assert(
    oneOf(value.accessory, AVATAR_ACCESSORIES),
    `${field}.accessory inválido.`,
  );
  assert(
    oneOf(value.backgroundColor, AVATAR_BACKGROUND_COLORS),
    `${field}.backgroundColor inválido.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return "null";
}

/** A content revision remains stable across YAML round-trips and restarts. */
export function configRevision(config: Config): string {
  return createHash("sha256").update(stableJson(config)).digest("hex");
}

function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function relativeConfigFile(value: string): boolean {
  return (
    value === "team.yaml" ||
    (/^(agents|workflows)\/[a-zA-Z0-9_-]{1,64}\.(md|yaml)$/.test(value) &&
      !value.includes(".."))
  );
}

function parseManifest(value: unknown): ConfigManifest {
  assert(isRecord(value), "config-manifest.json: objeto raiz inválido.");
  assert(value.version === CONFIG_MANIFEST_VERSION, "config-manifest.json: versão inválida.");
  assert(typeof value.generation === "string" && value.generation.length > 0, "config-manifest.json: generation inválida.");
  assert(typeof value.createdAt === "string", "config-manifest.json: createdAt inválido.");
  assert(typeof value.configRevision === "string", "config-manifest.json: configRevision inválido.");
  assert(isRecord(value.files), "config-manifest.json: files inválido.");
  const files: Record<string, string> = {};
  for (const [file, hash] of Object.entries(value.files)) {
    assert(relativeConfigFile(file), `config-manifest.json: arquivo inválido ${file}.`);
    assert(typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash), `config-manifest.json: hash inválido para ${file}.`);
    files[file] = hash;
  }
  assert(typeof files["team.yaml"] === "string", "config-manifest.json: team.yaml ausente.");
  return {
    version: CONFIG_MANIFEST_VERSION,
    generation: value.generation,
    createdAt: value.createdAt,
    configRevision: value.configRevision,
    files,
  };
}

const AGENT_STATUSES = new Set([
  "Idle",
  "Working",
  "Waiting",
  "Testing",
  "Reviewing",
  "Blocked",
  "Done",
  "Error",
]);
const RUN_STATUSES = new Set(["Running", "Done", "Error", "Stopped"]);
const RESULT_STATUSES = new Set(["PASS", "FAIL", "DONE", "ERROR"]);

function stringField(value: unknown, field: string): string {
  assert(typeof value === "string", `history.json: ${field} inválido.`);
  return value;
}

function parseMessage(value: unknown, field: string): AgentMessage {
  assert(isRecord(value), `history.json: ${field} inválida.`);
  const direction = value.direction;
  assert(direction === "user" || direction === "agent", `history.json: ${field}.direction inválido.`);
  return {
    at: stringField(value.at, `${field}.at`),
    text: stringField(value.text, `${field}.text`),
    direction,
  };
}

function parseResult(value: unknown, field: string): AgentResult {
  assert(isRecord(value), `history.json: ${field} inválido.`);
  assert(
    typeof value.status === "string" && RESULT_STATUSES.has(value.status),
    `history.json: ${field}.status inválido.`,
  );
  assert(typeof value.summary === "string", `history.json: ${field}.summary inválido.`);
  const arrays: Record<"changed_files" | "issues" | "notes", string[]> = {
    changed_files: [],
    issues: [],
    notes: [],
  };
  for (const key of ["changed_files", "issues", "notes"] as const) {
    assert(Array.isArray(value[key]), `history.json: ${field}.${key} inválido.`);
    assert(
      value[key].every((item) => typeof item === "string"),
      `history.json: ${field}.${key} contém item inválido.`,
    );
    arrays[key] = value[key].slice() as string[];
  }
  return {
    status: value.status as AgentResult["status"],
    summary: value.summary,
    ...arrays,
  };
}

function parseRuntime(value: unknown, agentId: string): AgentRuntime {
  assert(isRecord(value), `history.json: agente ${agentId} inválido.`);
  assert(typeof value.status === "string" && AGENT_STATUSES.has(value.status), `history.json: status do agente ${agentId} inválido.`);
  assert(Array.isArray(value.messages), `history.json: mensagens do agente ${agentId} inválidas.`);
  const result = value.result === undefined
    ? undefined
    : parseResult(value.result, `agentes.${agentId}.result`);
  if (value.lastActivityAt !== undefined)
    assert(typeof value.lastActivityAt === "string", `history.json: agentes.${agentId}.lastActivityAt inválido.`);
  return {
    status: value.status as AgentRuntime["status"],
    task: stringField(value.task, `agentes.${agentId}.task`),
    lastActivity: typeof value.lastActivity === "string" ? value.lastActivity : "",
    // The field was introduced after the first history format. Migration
    // derives it from messages/timeline when it is absent.
    lastActivityAt: value.lastActivityAt === undefined ? "" : value.lastActivityAt,
    output: stringField(value.output, `agentes.${agentId}.output`),
    messages: value.messages.slice(-MAX_AGENT_MESSAGES).map((message, index) => parseMessage(message, `agentes.${agentId}.messages[${index}]`)),
    ...(result === undefined ? {} : { result }),
  };
}

function parseAgents(value: unknown): Record<string, AgentRuntime> {
  assert(isRecord(value), "history.json: agents inválido.");
  const agents: Record<string, AgentRuntime> = {};
  for (const [agentId, runtime] of Object.entries(value)) agents[agentId] = parseRuntime(runtime, agentId);
  return agents;
}

function parseTimeline(value: unknown): TimelineEvent[] {
  assert(Array.isArray(value), "history.json: timeline inválida.");
  return value.slice(-MAX_TIMELINE_EVENTS).map((item, index) => {
    assert(isRecord(item), `history.json: timeline[${index}] inválida.`);
    const event: TimelineEvent = {
      id: stringField(item.id, `timeline[${index}].id`),
      at: stringField(item.at, `timeline[${index}].at`),
      kind: stringField(item.kind, `timeline[${index}].kind`),
      text: stringField(item.text, `timeline[${index}].text`),
    };
    for (const key of ["agentId", "runId", "attemptId"] as const)
      if (item[key] !== undefined) event[key] = stringField(item[key], `timeline[${index}].${key}`);
    return event;
  });
}

function parseRun(value: unknown, field: string): Run | null {
  if (value === null) return null;
  assert(isRecord(value), `history.json: ${field} inválido.`);
  assert(typeof value.status === "string" && RUN_STATUSES.has(value.status), `history.json: ${field}.status inválido.`);
  return {
    id: stringField(value.id, `${field}.id`),
    projectId: stringField(value.projectId, `${field}.projectId`),
    workflowId: stringField(value.workflowId, `${field}.workflowId`),
    task: stringField(value.task, `${field}.task`),
    status: value.status as Run["status"],
    stepId: stringField(value.stepId, `${field}.stepId`),
    startedAt: stringField(value.startedAt, `${field}.startedAt`),
    ...(value.endedAt === undefined ? {} : { endedAt: stringField(value.endedAt, `${field}.endedAt`) }),
  };
}

function parseAttempt(value: unknown, index: number, runId: string): StepAttempt {
  assert(isRecord(value), `history.json: attempts[${index}] inválida.`);
  assert(typeof value.status === "string" && RUN_STATUSES.has(value.status), `history.json: attempts[${index}].status inválido.`);
  assert(Array.isArray(value.messages), `history.json: attempts[${index}].messages inválidas.`);
  if (value.runId !== undefined)
    assert(typeof value.runId === "string", `history.json: attempts[${index}].runId inválido.`);
  if (value.output !== undefined)
    assert(typeof value.output === "string", `history.json: attempts[${index}].output inválido.`);
  const result = value.result === undefined
    ? undefined
    : parseResult(value.result, `attempts[${index}].result`);
  return {
    id: stringField(value.id, `attempts[${index}].id`),
    runId: value.runId === undefined ? runId : value.runId,
    stepId: stringField(value.stepId, `attempts[${index}].stepId`),
    agentId: stringField(value.agentId, `attempts[${index}].agentId`),
    status: value.status as StepAttempt["status"],
    startedAt: stringField(value.startedAt, `attempts[${index}].startedAt`),
    ...(value.endedAt === undefined ? {} : { endedAt: stringField(value.endedAt, `attempts[${index}].endedAt`) }),
    output: value.output === undefined ? "" : value.output.slice(-MAX_OUTPUT_CHARS),
    messages: value.messages.slice(-MAX_AGENT_MESSAGES).map((message, messageIndex) => parseMessage(message, `attempts[${index}].messages[${messageIndex}]`)),
    ...(result === undefined ? {} : { result }),
  };
}

function looksLikeConfig(value: unknown): value is Config {
  return isRecord(value) && Array.isArray(value.agents) && Array.isArray(value.workflows) && Array.isArray(value.projects) && typeof value.activeProjectId === "string";
}

function parseRunHistory(value: unknown, index: number): RunHistoryEntry {
  assert(isRecord(value), `history.json: runHistory[${index}] inválido.`);
  const run = parseRun(value, `runHistory[${index}]`);
  assert(run, `history.json: runHistory[${index}] inválido.`);
  assert(Array.isArray(value.attempts), `history.json: runHistory[${index}].attempts inválidas.`);
  if (value.configRevision !== undefined)
    assert(typeof value.configRevision === "string", `history.json: runHistory[${index}].configRevision inválido.`);
  if (value.config !== undefined) assert(looksLikeConfig(value.config), `history.json: runHistory[${index}].config inválida.`);
  return {
    ...run,
    configRevision: typeof value.configRevision === "string" ? value.configRevision : "",
    ...(value.config === undefined ? {} : { config: value.config }),
    attempts: value.attempts.slice(-MAX_ATTEMPTS).map((attempt, attemptIndex) => parseAttempt(attempt, attemptIndex, run.id)),
  };
}

function capRunHistory(runs: RunHistoryEntry[]): RunHistoryEntry[] {
  const kept = runs.slice(-MAX_RUN_HISTORY).map((run) => ({
    ...run,
    attempts: run.attempts.slice(),
  }));
  let attempts = kept.reduce((total, run) => total + run.attempts.length, 0);
  for (const run of kept) {
    if (attempts <= MAX_ATTEMPTS) break;
    const remove = Math.min(run.attempts.length, attempts - MAX_ATTEMPTS);
    if (remove > 0) {
      run.attempts.splice(0, remove);
      attempts -= remove;
    }
  }
  return kept;
}

function deriveActivityTimestamps(
  agents: Record<string, AgentRuntime>,
  timeline: TimelineEvent[],
  run: Run | null,
): void {
  for (const [agentId, runtime] of Object.entries(agents)) {
    if (runtime.lastActivityAt) continue;
    // A few early development snapshots used lastActivity for the timestamp
    // itself. Preserve the text while recovering that timestamp when it is
    // recognisably ISO formatted.
    if (/^\d{4}-\d{2}-\d{2}T/.test(runtime.lastActivity)) {
      runtime.lastActivityAt = runtime.lastActivity;
      continue;
    }
    const candidates = [
      ...runtime.messages.map((message) => message.at),
      ...timeline.filter((event) => event.agentId === agentId).map((event) => event.at),
    ].filter((at) => typeof at === "string" && at.length > 0);
    runtime.lastActivityAt = candidates.at(-1) || run?.endedAt || run?.startedAt || "";
  }
}

function migrateHistory(value: Record<string, unknown>): PersistedHistory {
  assert("agents" in value && "timeline" in value && "run" in value, "history.json: campos legados ausentes.");
  const run = parseRun(value.run, "run");
  const timeline = parseTimeline(value.timeline);
  const agents = parseAgents(value.agents);
  deriveActivityTimestamps(agents, timeline, run);
  if (value.runHistory !== undefined)
    assert(Array.isArray(value.runHistory), "history.json: runHistory inválido.");
  const runHistory = value.runHistory
    ? value.runHistory.map((item, index) => parseRunHistory(item, index))
    : [];
  if (run && !runHistory.some((item) => item.id === run.id))
    runHistory.push({ ...run, configRevision: "", attempts: [] });
  for (const event of timeline) if (!event.runId && run) event.runId = run.id;
  return {
    version: HISTORY_VERSION,
    agents,
    timeline,
    run,
    runHistory: capRunHistory(runHistory),
  };
}

function parseHistory(value: unknown): PersistedHistory {
  assert(isRecord(value), "history.json: objeto raiz inválido.");
  if (value.version === undefined) return migrateHistory(value);
  assert(value.version === HISTORY_VERSION, `history.json: versão ${String(value.version)} não suportada.`);
  const agents = parseAgents(value.agents);
  const timeline = parseTimeline(value.timeline);
  const run = parseRun(value.run, "run");
  assert(Array.isArray(value.runHistory), "history.json: runHistory inválido.");
  deriveActivityTimestamps(agents, timeline, run);
  return {
    version: HISTORY_VERSION,
    agents,
    timeline,
    run,
    runHistory: capRunHistory(value.runHistory.map((item, index) => parseRunHistory(item, index))),
  };
}
function unique(items: { id: string }[], label: string) {
  const ids = new Set<string>();
  for (const item of items) {
    assert(item && typeof item === "object", `${label}: item inválido.`);
    id(item.id);
    assert(!ids.has(item.id), `${label}: ID duplicado ${item.id}.`);
    ids.add(item.id);
  }
}
export function validateConfig(value: unknown): asserts value is Config {
  assert(value && typeof value === "object", "Configuração inválida.");
  const c = value as Config;
  if (c.branding !== undefined) validateBrandTheme(c.branding);
  for (const key of ["agents", "projects", "workflows"] as const)
    assert(
      Array.isArray(c[key]) && c[key].length <= 100,
      `${key}: lista inválida ou muito grande.`,
    );
  unique(c.agents, "Agentes");
  unique(c.projects, "Projetos");
  unique(c.workflows, "Workflows");
  assert(c.projects.length > 0, "Mantenha pelo menos um projeto.");
  assert(c.workflows.length > 0, "Mantenha pelo menos um workflow.");
  for (const a of c.agents) {
    str(a.name, "Nome", 100);
    assert(a.name.trim(), "Informe o nome do agente.");
    str(a.role, "Papel", 200);
    str(a.avatar, "Avatar", 40);
    if (a.appearance !== undefined)
      validateAvatarAppearance(a.appearance, `Aparência do agente ${a.id}`);
    assert(areas.includes(a.area), "Área inválida.");
    str(a.cli, "CLI", 4096);
    assert(a.cli.trim(), "Informe um executável de CLI.");
    assert(
      Array.isArray(a.args) && a.args.length <= 100,
      "Argumentos inválidos.",
    );
    a.args.forEach((s) => str(s, "Argumento"));
    str(a.cwd, "Diretório", 4096);
    assert(
      !a.cwd || path.isAbsolute(a.cwd),
      "O diretório do agente precisa ser absoluto.",
    );
    str(a.model, "Modelo", 200);
    str(a.instructions, "Instruções");
    assert(
      Number.isInteger(a.timeoutMs) &&
        a.timeoutMs >= 1000 &&
        a.timeoutMs <= 86400000,
      "Timeout deve ficar entre 1 segundo e 24 horas.",
    );
  }
  for (const w of c.workflows) {
    str(w.name, "Nome do workflow", 100);
    assert(
      Array.isArray(w.steps) && w.steps.length > 0 && w.steps.length <= 100,
      "Workflow precisa de 1 a 100 etapas.",
    );
    unique(w.steps, "Etapas");
    assert(
      Number.isInteger(w.maxSteps) && w.maxSteps > 0 && w.maxSteps <= 1000,
      "Limite de etapas deve ficar entre 1 e 1000.",
    );
    assert(
      w.steps.some((s) => s.id === w.start),
      "Etapa inicial não existe.",
    );
    for (const s of w.steps) {
      assert(
        s.id !== "done" && s.id !== "error",
        "IDs done e error são reservados.",
      );
      assert(
        c.agents.some((a) => a.id === s.agentId),
        `Agente da etapa ${s.id} não existe.`,
      );
      str(s.instruction, "Instrução da etapa");
      if (s.position !== undefined) {
        assert(
          isRecord(s.position) &&
            typeof s.position.x === "number" &&
            Number.isFinite(s.position.x) &&
            s.position.x >= 0 &&
            s.position.x <= 100000 &&
            typeof s.position.y === "number" &&
            Number.isFinite(s.position.y) &&
            s.position.y >= 0 &&
            s.position.y <= 100000,
          `Posição inválida na etapa ${s.id}.`,
        );
      }
      assert(
        s.transitions &&
          typeof s.transitions === "object" &&
          !Array.isArray(s.transitions),
        "Transições inválidas.",
      );
      for (const [status, target] of Object.entries(s.transitions)) {
        assert(
          ["PASS", "FAIL", "DONE", "ERROR"].includes(status),
          "Status de transição inválido.",
        );
        assert(
          typeof target === "string" &&
            (target === "done" ||
              target === "error" ||
              w.steps.some((t) => t.id === target)),
          `Destino inválido na etapa ${s.id}.`,
        );
      }
    }
  }
  for (const p of c.projects) {
    str(p.name, "Nome do projeto", 100);
    str(p.cwd, "Diretório", 4096);
    assert(
      path.isAbsolute(p.cwd),
      "O diretório do projeto precisa ser absoluto.",
    );
    str(p.rules, "Regras");
    assert(
      c.workflows.some((w) => w.id === p.workflowId),
      "Workflow padrão não existe.",
    );
    assert(
      Array.isArray(p.agentIds) &&
        p.agentIds.every((i) => c.agents.some((a) => a.id === i)),
      "Equipe do projeto inválida.",
    );
  }
  assert(
    c.projects.some((p) => p.id === c.activeProjectId),
    "Projeto ativo inválido.",
  );
}
export class Store {
  readonly dir: string;
  constructor(root: string) {
    this.dir = path.join(root, ".agent-office");
  }
  private manifestFile() {
    return path.join(this.dir, "config-manifest.json");
  }
  private backupsDir() {
    return path.join(this.dir, "backups");
  }
  private backupDir(generation: string) {
    return path.join(this.backupsDir(), generation);
  }
  private async readManifest(file = this.manifestFile()): Promise<ConfigManifest | null> {
    try {
      return parseManifest(JSON.parse(await readFile(file, "utf8")));
    } catch {
      return null;
    }
  }
  private async readConfigDirectory(base: string): Promise<Config> {
    const raw = await readFile(path.join(base, "team.yaml"), "utf8");
    const data = YAML.parse(raw) as (Config & { workflowIds?: string[] }) | null;
    assert(
      data && Array.isArray(data.agents) && Array.isArray(data.workflowIds),
      "team.yaml inválido.",
    );
    for (const a of data.agents) {
      id(a.id);
      a.instructions = await readFile(
        path.join(base, "agents", a.id + ".md"),
        "utf8",
      );
    }
    data.workflows = await Promise.all(
      data.workflowIds.map(async (key) => {
        id(key);
        return YAML.parse(
          await readFile(path.join(base, "workflows", key + ".yaml"), "utf8"),
        );
      }),
    );
    delete data.workflowIds;
    validateConfig(data);
    return data;
  }
  private async readConfigFiles(base: string): Promise<Record<string, string>> {
    const team = await readFile(path.join(base, "team.yaml"), "utf8");
    const data = YAML.parse(team) as { agents?: { id?: unknown }[]; workflowIds?: unknown[] } | null;
    assert(
      data && Array.isArray(data.agents) && Array.isArray(data.workflowIds),
      "team.yaml inválido.",
    );
    const files: Record<string, string> = { "team.yaml": team };
    for (const agent of data.agents) {
      id(agent.id);
      const key = String(agent.id);
      files[`agents/${key}.md`] = await readFile(
        path.join(base, "agents", key + ".md"),
        "utf8",
      );
    }
    for (const workflow of data.workflowIds) {
      id(workflow);
      const key = String(workflow);
      files[`workflows/${key}.yaml`] = await readFile(
        path.join(base, "workflows", key + ".yaml"),
        "utf8",
      );
    }
    return files;
  }
  private async verifyManifest(base: string, manifest: ConfigManifest): Promise<boolean> {
    try {
      for (const [relative, expected] of Object.entries(manifest.files)) {
        const actual = await readFile(path.join(base, relative), "utf8");
        if (contentHash(actual) !== expected) return false;
      }
      return true;
    } catch {
      return false;
    }
  }
  private async verifySnapshot(base: string, manifest: ConfigManifest): Promise<boolean> {
    if (!(await this.verifyManifest(base, manifest))) return false;
    try {
      return configRevision(await this.readConfigDirectory(base)) === manifest.configRevision;
    } catch {
      return false;
    }
  }
  private async createBackup(generation: string): Promise<ConfigManifest | null> {
    let config: Config;
    let files: Record<string, string>;
    try {
      config = await this.readConfigDirectory(this.dir);
      files = await this.readConfigFiles(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      // An invalid current config has no safe snapshot to copy. Existing
      // backups remain available for recovery, so continue the save path.
      if (error instanceof Error && /team\.yaml inválido|Configuração inválida/.test(error.message)) return null;
      return null;
    }
    const manifest: ConfigManifest = {
      version: CONFIG_MANIFEST_VERSION,
      generation,
      createdAt: new Date().toISOString(),
      configRevision: configRevision(config),
      files: Object.fromEntries(
        Object.entries(files).map(([relative, contents]) => [relative, contentHash(contents)]),
      ),
    };
    const destination = this.backupDir(generation);
    for (const [relative, contents] of Object.entries(files)) {
      const file = path.join(destination, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents, { mode: 0o600 });
    }
    await writeFile(
      path.join(destination, "manifest.json"),
      JSON.stringify(manifest),
      { mode: 0o600 },
    );
    return manifest;
  }
  private async findBackup(expectedGeneration?: string): Promise<string | null> {
    const candidates: { dir: string; manifest: ConfigManifest }[] = [];
    let names: string[];
    try {
      names = await readdir(this.backupsDir());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
    for (const name of names) {
      const dir = this.backupDir(name);
      const manifest = await this.readManifest(path.join(dir, "manifest.json"));
      if (!manifest || (expectedGeneration && manifest.generation !== expectedGeneration)) continue;
      if (await this.verifySnapshot(dir, manifest)) candidates.push({ dir, manifest });
    }
    if (candidates.length === 0 && expectedGeneration) {
      // A failed save can have created a fresh backup before publishing the
      // new pointer. In that case the newest valid backup is still safe.
      return this.findBackup();
    }
    candidates.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
    return candidates[0]?.dir || null;
  }
  private async restoreBackup(dir: string): Promise<void> {
    const manifest = await this.readManifest(path.join(dir, "manifest.json"));
    if (!manifest || !(await this.verifySnapshot(dir, manifest)))
      throw new Error("Nenhum backup íntegro da configuração foi encontrado.");
    for (const relative of Object.keys(manifest.files)) {
      await this.atomic(
        path.join(this.dir, relative),
        await readFile(path.join(dir, relative), "utf8"),
      );
    }
    await this.atomic(this.manifestFile(), JSON.stringify(manifest));
  }
  private async recoverConfig(): Promise<Config | null> {
    const manifest = await this.readManifest();
    if (manifest && (await this.verifySnapshot(this.dir, manifest))) return null;
    const backup = await this.findBackup(manifest?.generation);
    if (!backup) return null;
    await this.restoreBackup(backup);
    return this.readConfigDirectory(this.dir);
  }
  private async pruneBackups(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.backupsDir());
    } catch {
      return;
    }
    const entries: { name: string; createdAt: string }[] = [];
    for (const name of names) {
      const manifest = await this.readManifest(path.join(this.backupDir(name), "manifest.json"));
      if (manifest) entries.push({ name, createdAt: manifest.createdAt });
    }
    entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    await Promise.all(
      entries.slice(MAX_CONFIG_BACKUPS).map(({ name }) =>
        rm(this.backupDir(name), { recursive: true, force: true }).catch(() => undefined),
      ),
    );
  }
  async atomic(file: string, contents: string) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    await writeFile(tmp, contents, { mode: 0o600 });
    await rename(tmp, file);
  }
  async load(): Promise<Config> {
    try {
      const recovered = await this.recoverConfig();
      if (recovered) return recovered;
      return await this.readConfigDirectory(this.dir);
    } catch (e) {
      const backup = await this.findBackup();
      if (backup) {
        await this.restoreBackup(backup);
        return this.readConfigDirectory(this.dir);
      }
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const c = defaults(path.dirname(this.dir));
      await this.save(c);
      return c;
    }
  }
  async save(config: Config) {
    validateConfig(config);
    const generation = randomUUID();
    // Capture the last complete configuration before touching any split file.
    // If a later write fails, load() can verify the manifest and restore this
    // generation instead of accepting a mixed team/workflow/agent set.
    // Keep the pre-save backup generation separate from the manifest pointer.
    // A backup made before publishing must never be mistaken for the
    // configuration published by that pointer during a later recovery.
    await this.createBackup(randomUUID());
    // Write referenced files first and publish the index last. Runtime serializes all writes.
    for (const a of config.agents)
      await this.atomic(
        path.join(this.dir, "agents", a.id + ".md"),
        a.instructions,
      );
    for (const w of config.workflows)
      await this.atomic(
        path.join(this.dir, "workflows", w.id + ".yaml"),
        YAML.stringify(w),
      );
    const { workflows, agents, ...rest } = config;
    await this.atomic(
      path.join(this.dir, "team.yaml"),
      YAML.stringify({
        ...rest,
        agents: agents.map(({ instructions, ...a }) => a),
        workflowIds: workflows.map((w) => w.id),
      }),
    );
    for (const [folder, ext, keep] of [
      ["agents", ".md", agents.map((a) => a.id)],
      ["workflows", ".yaml", workflows.map((w) => w.id)],
    ] as const) {
      const dir = path.join(this.dir, folder);
      await mkdir(dir, { recursive: true });
      for (const file of await readdir(dir))
        if (file.endsWith(ext) && !keep.includes(file.slice(0, -ext.length)))
          await unlink(path.join(dir, file));
    }
    const files = await this.readConfigFiles(this.dir);
    const manifest: ConfigManifest = {
      version: CONFIG_MANIFEST_VERSION,
      generation,
      createdAt: new Date().toISOString(),
      configRevision: configRevision(config),
      files: Object.fromEntries(
        Object.entries(files).map(([relative, contents]) => [relative, contentHash(contents)]),
      ),
    };
    await this.atomic(this.manifestFile(), JSON.stringify(manifest));
    // Keep a published snapshot too. The pre-save generation protects a
    // failed write; this one protects the latest successful configuration.
    await this.createBackup(randomUUID()).catch((error) =>
      console.error("Falha ao criar backup da configuração:", error),
    );
    await this.pruneBackups();
  }
  async history(): Promise<PersistedHistory | null> {
    const file = path.join(this.dir, "history.json");
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    try {
      return parseHistory(JSON.parse(raw));
    } catch (e) {
      // Keep the original bytes available for diagnosis. A fresh history is
      // allowed to start so a malformed diagnostic file cannot brick startup.
      const backup = file + ".invalid";
      try {
        await access(backup);
      } catch {
        await writeFile(backup, raw, { mode: 0o600 });
      }
      console.error(
        `history.json inválido; histórico iniciado vazio. ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }
  async saveHistory(s: Snapshot) {
    await this.atomic(
      path.join(this.dir, "history.json"),
      JSON.stringify({
        version: HISTORY_VERSION,
        agents: s.agents,
        timeline: s.timeline,
        run: s.run,
        runHistory: capRunHistory(s.runHistory),
      }),
    );
  }
}
