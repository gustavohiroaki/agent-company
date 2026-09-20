import { access, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import type {
  Agent,
  AgentDiagnostic,
  Config,
  DiagnosticCheck,
  DiagnosticIssue,
  DiagnosticsReport,
  Step,
  Workflow,
  WorkflowDiagnostic,
} from "../shared/types.js";

const RESULT_STATUSES = ["PASS", "FAIL", "DONE", "ERROR"] as const;

function issue(
  code: string,
  severity: DiagnosticIssue["severity"],
  message: string,
  fields: Partial<Pick<DiagnosticIssue, "path" | "projectId" | "workflowId" | "stepId" | "agentId">> = {},
): DiagnosticIssue {
  return { code, severity, message, ...fields };
}

function hasError(issues: DiagnosticIssue[]): boolean {
  return issues.some((item) => item.severity === "error");
}

/**
 * Analyze graph structure without imposing a DAG. A correction loop is a
 * valid workflow; traversal uses a visited set and execution still enforces
 * maxSteps at runtime.
 */
export function analyzeWorkflow(
  workflow: Workflow,
  projectAgentIds?: string[],
  availableAgentIds?: string[],
): WorkflowDiagnostic {
  const workflowId = workflow?.id || "unknown";
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  const issues: DiagnosticIssue[] = [];
  if (!Number.isInteger(workflow?.maxSteps) || workflow.maxSteps <= 0) {
    issues.push(
      issue(
        "invalid-max-steps",
        "error",
        `O limite de etapas do workflow ${workflowId} precisa ser um inteiro positivo.`,
        { path: `workflows.${workflowId}.maxSteps`, workflowId },
      ),
    );
  }
  const stepById = new Map<string, Step>();
  for (const [index, step] of steps.entries()) {
    const stepId = typeof step?.id === "string" ? step.id : `step-${index}`;
    if (stepById.has(stepId)) {
      issues.push(
        issue(
          "duplicate-step-id",
          "error",
          `A etapa ${stepId} está duplicada no workflow ${workflowId}.`,
          { path: `workflows.${workflowId}.steps[${index}].id`, workflowId, stepId },
        ),
      );
      continue;
    }
    stepById.set(stepId, step);
  }

  const edges = new Map<string, string[]>();
  for (const [index, step] of steps.entries()) {
    const stepId = typeof step?.id === "string" ? step.id : `step-${index}`;
    const transitions = step?.transitions && typeof step.transitions === "object" ? step.transitions : {};
    const targets: string[] = [];
    if (availableAgentIds && !availableAgentIds.includes(step.agentId)) {
      issues.push(
        issue(
          "missing-agent",
          "error",
          `A etapa ${stepId} referencia o agente inexistente ${String(step.agentId)}.`,
          { path: `workflows.${workflowId}.steps[${index}].agentId`, workflowId, stepId, agentId: step.agentId },
        ),
      );
    }
    if (projectAgentIds && !projectAgentIds.includes(step.agentId)) {
      issues.push(
        issue(
          "agent-outside-team",
          "error",
          `A etapa ${stepId} usa ${step.agentId}, que está fora da equipe do projeto.`,
          { path: `workflows.${workflowId}.steps[${index}].agentId`, workflowId, stepId, agentId: step.agentId },
        ),
      );
    }
    for (const status of RESULT_STATUSES) {
      const target = (transitions as Record<string, unknown>)[status];
      if (target === undefined) {
        issues.push(
          issue(
            "missing-transition",
            "warning",
            `A etapa ${stepId} não define destino para ${status}.`,
            { path: `workflows.${workflowId}.steps[${index}].transitions.${status}`, workflowId, stepId },
          ),
        );
        continue;
      }
      if (typeof target !== "string") {
        issues.push(
          issue(
            "invalid-transition-target",
            "error",
            `O destino de ${status} na etapa ${stepId} precisa ser texto.`,
            { path: `workflows.${workflowId}.steps[${index}].transitions.${status}`, workflowId, stepId },
          ),
        );
        continue;
      }
      if (target === "done" || target === "error") continue;
      if (!stepById.has(target)) {
        issues.push(
          issue(
            "orphan-transition",
            "error",
            `A transição ${status} da etapa ${stepId} aponta para a etapa inexistente ${target}.`,
            { path: `workflows.${workflowId}.steps[${index}].transitions.${status}`, workflowId, stepId },
          ),
        );
        continue;
      }
      targets.push(target);
    }
    for (const [status, target] of Object.entries(transitions as Record<string, unknown>)) {
      if (!(RESULT_STATUSES as readonly string[]).includes(status)) {
        issues.push(
          issue(
            "unknown-transition-status",
            "error",
            `A etapa ${stepId} usa o status de transição desconhecido ${status}.`,
            { path: `workflows.${workflowId}.steps[${index}].transitions.${status}`, workflowId, stepId },
          ),
        );
      }
    }
    edges.set(stepId, [...new Set(targets)]);
  }

  const reachableStepIds: string[] = [];
  const visited = new Set<string>();
  const start = workflow?.start;
  if (!stepById.has(start)) {
    issues.push(
      issue(
        "missing-start-step",
        "error",
        `A etapa inicial ${String(start)} não existe no workflow ${workflowId}.`,
        { path: `workflows.${workflowId}.start`, workflowId },
      ),
    );
  } else {
    const pending = [start];
    while (pending.length > 0) {
      const current = pending.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      reachableStepIds.push(current);
      for (const target of edges.get(current) || []) if (!visited.has(target)) pending.push(target);
    }
  }
  const unreachableStepIds = steps
    .map((step) => step.id)
    .filter((stepId) => typeof stepId === "string" && !visited.has(stepId));
  for (const stepId of unreachableStepIds) {
    issues.push(
      issue(
        "unreachable-step",
        "error",
        `A etapa ${stepId} não é alcançável a partir de ${String(start)}.`,
        { path: `workflows.${workflowId}.steps.${stepId}`, workflowId, stepId },
      ),
    );
  }
  return { workflowId, reachableStepIds, unreachableStepIds, issues };
}

async function checkDirectory(directory: string): Promise<DiagnosticCheck> {
  if (!directory || !path.isAbsolute(directory))
    return { status: "error", message: "O diretório precisa ser absoluto.", path: directory };
  const info = await stat(directory).catch(() => null);
  return info?.isDirectory()
    ? { status: "ok", message: "Diretório acessível.", path: directory }
    : { status: "error", message: "Diretório não encontrado ou não é uma pasta.", path: directory };
}

async function resolveExecutable(command: string, cwd: string): Promise<string | null> {
  if (!command.trim()) return null;
  const candidates = command.includes(path.sep) || path.isAbsolute(command)
    ? [path.isAbsolute(command) ? command : path.resolve(cwd, command)]
    : (process.env.PATH || "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null);
    if (!info?.isFile()) continue;
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep checking PATH entries; no process is started by this diagnostic.
    }
  }
  return null;
}

async function diagnoseAgent(
  agent: Agent,
  projectCwd: string,
  projectId: string | undefined,
): Promise<AgentDiagnostic> {
  const cwd = agent.cwd || projectCwd;
  const directory = await checkDirectory(cwd);
  const resolved = directory.status === "ok" ? await resolveExecutable(agent.cli, cwd) : null;
  const executable: DiagnosticCheck = resolved
    ? { status: "ok", message: "Executável resolvível sem iniciar o processo.", path: resolved }
    : { status: "error", message: `Executável não encontrado ou sem permissão: ${agent.cli || "(vazio)"}.` };
  const issues: DiagnosticIssue[] = [];
  if (directory.status === "error")
    issues.push(
      issue("agent-directory", "error", directory.message, {
        path: `agents.${agent.id}.cwd`, projectId, agentId: agent.id,
      }),
    );
  if (executable.status === "error")
    issues.push(
      issue("agent-executable", "error", executable.message, {
        path: `agents.${agent.id}.cli`, projectId, agentId: agent.id,
      }),
    );
  return {
    agentId: agent.id,
    directory,
    executable,
    authentication: { status: "not-verified", message: "Autenticação não verificada; nenhum CLI foi executado." },
    model: { status: "not-verified", message: "Modelo não verificado; o diagnóstico não faz chamadas de IA." },
    issues,
  };
}

export async function diagnoseConfig(
  config: Config,
  requestedProjectId?: string,
  requestedWorkflowId?: string,
): Promise<DiagnosticsReport> {
  const issues: DiagnosticIssue[] = [];
  const project = config.projects.find((item) => item.id === (requestedProjectId || config.activeProjectId));
  const projectId = requestedProjectId || project?.id;
  if (!project) {
    issues.push(issue("project-not-found", "error", `Projeto não encontrado: ${projectId || "(não informado)"}.`, { projectId }));
  }
  const workflowId = requestedWorkflowId || project?.workflowId;
  const workflow = config.workflows.find((item) => item.id === workflowId);
  if (!workflow) {
    issues.push(issue("workflow-not-found", "error", `Workflow não encontrado: ${workflowId || "(não informado)"}.`, { projectId, workflowId }));
  }
  if (project && !path.isAbsolute(project.cwd))
    issues.push(issue("project-directory", "error", "O diretório do projeto precisa ser absoluto.", { path: `projects.${project.id}.cwd`, projectId: project.id }));
  else if (project) {
    const projectDirectory = await checkDirectory(project.cwd);
    if (projectDirectory.status === "error")
      issues.push(issue("project-directory", "error", projectDirectory.message, { path: `projects.${project.id}.cwd`, projectId: project.id }));
  }

  const projectAgentIds = project?.agentIds || [];
  for (const agentId of projectAgentIds) {
    if (!config.agents.some((item) => item.id === agentId))
      issues.push(issue("project-agent-missing", "error", `A equipe referencia o agente inexistente ${agentId}.`, { path: `projects.${project?.id}.agentIds`, projectId, agentId }));
  }
  const workflowDiagnostic = workflow
    ? analyzeWorkflow(workflow, projectAgentIds, config.agents.map((item) => item.id))
    : undefined;
  if (workflowDiagnostic) issues.push(...workflowDiagnostic.issues.map((item) => ({ ...item, projectId })));

  const ids = new Set<string>([
    ...config.agents.map((item) => item.id),
    ...projectAgentIds,
    ...(workflow?.steps || []).map((step) => step.agentId),
  ]);
  const agents: AgentDiagnostic[] = [];
  for (const agentId of ids) {
    const agent = config.agents.find((item) => item.id === agentId);
    if (!agent) {
      agents.push({
        agentId,
        directory: { status: "error", message: "Agente não existe na configuração." },
        executable: { status: "error", message: "Agente não existe na configuração." },
        authentication: { status: "not-verified", message: "Autenticação não verificada." },
        model: { status: "not-verified", message: "Modelo não verificado." },
        issues: [],
      });
      continue;
    }
    agents.push(await diagnoseAgent(agent, project?.cwd || "", project?.id));
  }
  const allIssues = [...issues, ...agents.flatMap((agent) => agent.issues)];
  return {
    checkedAt: new Date().toISOString(),
    ok: !hasError(allIssues),
    ...(projectId ? { projectId } : {}),
    ...(workflowId ? { workflowId } : {}),
    issues: allIssues,
    agents,
    ...(workflowDiagnostic ? { workflow: workflowDiagnostic } : {}),
  };
}
