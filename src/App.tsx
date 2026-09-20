import {
  AlertCircle,
  Archive,
  ArrowDownToLine,
  ArrowUpRight,
  Bot,
  Braces,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Clock3,
  Copy,
  DoorOpen,
  FileCode2,
  FileText,
  Filter,
  FlaskConical,
  FolderKanban,
  GitBranch,
  Hammer,
  HeartPulse,
  Layers3,
  LayoutGrid,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  MessageSquareText,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  UserRound,
  UsersRound,
  WandSparkles,
  X,
  XCircle,
  Zap,
  Eye,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Agent,
  AgentResult,
  AgentRuntime,
  AgentStatus,
  Area,
  Config,
  DiagnosticsReport,
  DiagnosticIssue,
  Project,
  ResultStatus,
  Run,
  RunHistoryEntry,
  Snapshot,
  Step,
  TimelineEvent,
  Workflow,
} from '../shared/types';

type Screen = 'run' | 'projects' | 'team' | 'workflow';
type ConnectionState = 'connecting' | 'connected' | 'offline';
type ArgsMode = 'json' | 'lines';
type PendingRun = 'run' | 'restart-run';

/**
 * The server contract is being extended while the UI is kept usable during
 * the transition. These narrow compatibility views disappear naturally once
 * older persisted snapshots have been migrated by the server.
 */
type RuntimeCompat = AgentRuntime & { lastActivityDescription?: string; description?: string };

const AREAS: Area[] = ['Executive', 'Research Hub', 'Dev Lab', 'Review Zone', 'Approval', 'Content Studio'];
const RESULT_STATUSES: ResultStatus[] = ['PASS', 'FAIL', 'DONE', 'ERROR'];
// The server retains the tail of an agent's output at this size. Keep the
// limit visible in the UI so a reviewer can tell when the beginning may be
// unavailable instead of mistaking a partial log for a complete one.
const MAX_RETAINED_OUTPUT_CHARS = 100_000;

const areaMeta: Record<Area, { label: string; className: string; icon: typeof Building2; detail: string }> = {
  Executive: { label: 'Executive', className: 'area-executive', icon: DoorOpen, detail: 'Direção e prioridades' },
  'Research Hub': { label: 'Research Hub', className: 'area-research', icon: FlaskConical, detail: 'Perguntas e evidências' },
  'Dev Lab': { label: 'Dev Lab', className: 'area-dev', icon: Hammer, detail: 'Código em construção' },
  'Review Zone': { label: 'Review Zone', className: 'area-review', icon: Search, detail: 'Revisão e qualidade' },
  Approval: { label: 'Approval', className: 'area-approval', icon: ShieldCheck, detail: 'Decisões finais' },
  'Content Studio': { label: 'Content Studio', className: 'area-content', icon: Sparkles, detail: 'Clareza e acabamento' },
};

const statusMeta: Record<AgentStatus, { label: string; className: string }> = {
  Idle: { label: 'Livre', className: 'status-idle' },
  Working: { label: 'Trabalhando', className: 'status-working' },
  Waiting: { label: 'Aguardando', className: 'status-waiting' },
  Testing: { label: 'Testando', className: 'status-testing' },
  Reviewing: { label: 'Revisando', className: 'status-reviewing' },
  Blocked: { label: 'Bloqueado', className: 'status-blocked' },
  Done: { label: 'Concluído', className: 'status-done' },
  Error: { label: 'Erro', className: 'status-error' },
};

const defaultAgentTemplates: Agent[] = [
  {
    id: 'planner-template',
    name: 'Planner',
    role: 'Planner',
    avatar: 'PL',
    area: 'Executive',
    cli: 'codex',
    args: ['exec', '--model', '{model}', '{prompt}'],
    model: 'gpt-5.6-luna',
    cwd: '',
    instructions: 'Quebre o objetivo em etapas pequenas, identifique riscos e deixe o caminho claro para a equipe.',
    timeoutMs: 120000,
  },
  {
    id: 'developer-template',
    name: 'Builder',
    role: 'Developer',
    avatar: 'BU',
    area: 'Dev Lab',
    cli: 'codex',
    args: ['exec', '--model', '{model}', '{prompt}'],
    model: 'gpt-5.6-luna',
    cwd: '',
    instructions: 'Implemente a mudança com passos pequenos, rode as verificações e registre o que mudou.',
    timeoutMs: 180000,
  },
  {
    id: 'tester-template',
    name: 'Tester',
    role: 'Tester',
    avatar: 'TS',
    area: 'Review Zone',
    cli: 'codex',
    args: ['exec', '--model', '{model}', '{prompt}'],
    model: 'gpt-5.6-luna',
    cwd: '',
    instructions: 'Teste os caminhos importantes, reproduza falhas e registre evidências objetivas.',
    timeoutMs: 120000,
  },
  {
    id: 'reviewer-template',
    name: 'Reviewer',
    role: 'Reviewer',
    avatar: 'RV',
    area: 'Review Zone',
    cli: 'codex',
    args: ['exec', '--model', '{model}', '{prompt}'],
    model: 'gpt-5.6-luna',
    cwd: '',
    instructions: 'Revise a entrega com atenção a regressões, acessibilidade e clareza. Aponte riscos concretos.',
    timeoutMs: 120000,
  },
  {
    id: 'researcher-template',
    name: 'Researcher',
    role: 'Researcher',
    avatar: 'RS',
    area: 'Research Hub',
    cli: 'codex',
    args: ['exec', '--model', '{model}', '{prompt}'],
    model: 'gpt-5.6-luna',
    cwd: '',
    instructions: 'Investigue o contexto, reúna evidências e deixe as fontes claras para a próxima pessoa.',
    timeoutMs: 120000,
  },
];

const nowLabel = () => new Date().toISOString();

function uid(prefix: string): string {
  try {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  } catch {
    return `${prefix}-${Date.now().toString(36)}`;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function initials(agent?: Agent): string {
  if (!agent) return '?';
  const source = agent.avatar?.trim() || agent.name;
  const letters = source.replace(/[^\p{L}\p{N}]/gu, '');
  if (letters.length <= 3) return letters.toUpperCase();
  return letters.slice(0, 2).toUpperCase();
}

function shortTime(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function relativeActivity(value?: string): string {
  if (!value) return 'sem atividade';
  const stamp = new Date(value).getTime();
  if (Number.isNaN(stamp)) return value;
  const diff = Math.max(0, Date.now() - stamp);
  if (diff < 60_000) return 'agora';
  if (diff < 3_600_000) return `há ${Math.max(1, Math.floor(diff / 60_000))} min`;
  return shortTime(value);
}

function validDateValue(value?: string): value is string {
  return Boolean(value && !Number.isNaN(new Date(value).getTime()));
}

function activityAt(runtime?: AgentRuntime): string | undefined {
  const compat = runtime as RuntimeCompat | undefined;
  if (validDateValue(runtime?.lastActivityAt)) return runtime.lastActivityAt;
  // Older history used lastActivity for prose, but a few early snapshots
  // stored the timestamp there. Only treat it as a timestamp when it parses.
  return validDateValue(runtime?.lastActivity) ? runtime.lastActivity : undefined;
}

function activityDescription(runtime?: AgentRuntime): string {
  const compat = runtime as RuntimeCompat | undefined;
  const description = compat?.lastActivityDescription || compat?.description;
  if (description) return description;
  if (runtime?.lastActivity && !validDateValue(runtime.lastActivity)) return runtime.lastActivity;
  return '';
}

function historyItems(snapshot: Snapshot): RunHistoryEntry[] {
  return snapshot.runHistory;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function historyRun(value: unknown): Record<string, unknown> {
  const record = recordOf(value);
  const nested = recordOf(record.run);
  return Object.keys(nested).length > 0 ? { ...record, ...nested } : record;
}

function textValue(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function historyStatusLabel(status: string): string {
  return status === 'Running' ? 'Em execução' : status === 'Done' ? 'Concluído' : status === 'Stopped' ? 'Parado' : status === 'Error' ? 'Erro' : status || 'Sem status';
}

function historySearchText(value: RunHistoryEntry, snapshot: Snapshot): string {
  const record = historyRun(value);
  const project = snapshot.config.projects.find((item) => item.id === textValue(record, 'projectId'));
  const workflow = snapshot.config.workflows.find((item) => item.id === textValue(record, 'workflowId'));
  return [
    textValue(record, 'id', 'runId'),
    textValue(record, 'status', 'state'),
    historyStatusLabel(textValue(record, 'status', 'state')),
    textValue(record, 'task', 'objective', 'title'),
    project?.name,
    workflow?.name,
  ].filter(Boolean).join(' ').toLocaleLowerCase();
}

function statusLabel(status?: AgentStatus): string {
  return status ? statusMeta[status].label : 'Sem estado';
}

function defaultStep(agentId: string): Step {
  return {
    id: uid('step'),
    agentId,
    instruction: 'Descreva o trabalho que este agente deve executar.',
    transitions: { DONE: 'done', ERROR: 'error' },
  };
}

function stepDisplayName(step: Step, index: number, config: Config): string {
  const instruction = step.instruction.trim().replace(/\s+/g, ' ');
  const firstSentence = instruction.split(/(?<=[.!?])\s+/)[0]?.trim() || instruction;
  if (firstSentence) {
    return firstSentence.length > 56 ? `${firstSentence.slice(0, 53)}…` : firstSentence;
  }
  const agent = config.agents.find((item) => item.id === step.agentId);
  return agent?.name || `Etapa ${index + 1}`;
}

function resultExplanation(status: ResultStatus): string {
  if (status === 'PASS') return 'PASS: o agente declarou que a etapa passou.';
  if (status === 'FAIL') return 'FAIL: o agente declarou que a etapa precisa de correção.';
  if (status === 'DONE') return 'DONE: a etapa terminou sem declarar PASS ou FAIL.';
  return 'ERROR: a etapa terminou com erro técnico ou de execução.';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function outputWithHighlights(output: string, query: string): React.ReactNode {
  const normalized = query.trim();
  if (!normalized) return output;
  const pattern = new RegExp(`(${escapeRegExp(normalized)})`, 'ig');
  return output.split(pattern).map((part, index) =>
    part.toLocaleLowerCase() === normalized.toLocaleLowerCase()
      ? <mark key={`${part}-${index}`}>{part}</mark>
      : part,
  );
}

function blankAgent(index = 1): Agent {
  return {
    id: uid(`agent${index}`),
    name: `New agent ${index}`,
    role: 'Generalist',
    avatar: 'NA',
    area: 'Executive',
    cli: 'codex',
    args: ['exec', '--model', '{model}', '{prompt}'],
    model: 'gpt-5.6-luna',
    cwd: '',
    instructions: '',
    timeoutMs: 120000,
  };
}

function blankProject(index: number, config: Config): Project {
  const firstWorkflow = config.workflows[0];
  return {
    id: uid(`project${index}`),
    name: `New project ${index}`,
    cwd: '',
    rules: '',
    workflowId: firstWorkflow?.id ?? '',
    agentIds: config.agents.slice(0, 3).map((agent) => agent.id),
  };
}

function blankWorkflow(index: number, config: Config): Workflow {
  const firstAgent = config.agents[0]?.id ?? '';
  const firstStep = defaultStep(firstAgent);
  return {
    id: uid(`workflow${index}`),
    name: `New workflow ${index}`,
    start: firstStep.id,
    steps: [firstStep],
    maxSteps: 8,
  };
}

function parseArgsValue(value: string, mode: ArgsMode): string[] | null {
  if (mode === 'lines') return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const payload = (await response.json().catch(() => null)) as T | { error?: string } | null;
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload && payload.error
      ? payload.error
      : `A solicitação falhou (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

function agentFromSnapshot(snapshot: Snapshot | null, id: string): Agent | undefined {
  return snapshot?.config.agents.find((agent) => agent.id === id);
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [screen, setScreen] = useState<Screen>('run');
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [connectionNote, setConnectionNote] = useState('Conectando ao escritório…');
  const [connectionError, setConnectionError] = useState('');
  const [configError, setConfigError] = useState('');
  const [error, setError] = useState('');
  const [configDraft, setConfigDraft] = useState<Config | null>(null);
  const [configDirty, setConfigDirty] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [pendingRun, setPendingRun] = useState<PendingRun | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [timelineFilter, setTimelineFilter] = useState('all');
  const [runTask, setRunTask] = useState('');
  const [runProjectId, setRunProjectId] = useState('');
  const [runWorkflowId, setRunWorkflowId] = useState('');
  const [messageDraft, setMessageDraft] = useState('');
  const [projectEditorId, setProjectEditorId] = useState('');
  const [workflowEditorId, setWorkflowEditorId] = useState('');
  const [agentEditorId, setAgentEditorId] = useState('');
  const [argsModes, setArgsModes] = useState<Record<string, ArgsMode>>({});
  const [argsErrors, setArgsErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const reconnectDelay = useRef(1000);
  const configDirtyRef = useRef(false);
  const savingRef = useRef(false);
  const draftRevisionRef = useRef<string | undefined>(undefined);
  const runProjectRef = useRef('');
  const selectedAgentRef = useRef('');
  const selectedAgentTouchedRef = useRef(false);

  useEffect(() => { configDirtyRef.current = configDirty; }, [configDirty]);
  useEffect(() => { savingRef.current = saving; }, [saving]);
  useEffect(() => { runProjectRef.current = runProjectId; }, [runProjectId]);
  useEffect(() => { selectedAgentRef.current = selectedAgentId; }, [selectedAgentId]);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!configDirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);

  const receiveSnapshot = useCallback((next: Snapshot) => {
    const incomingRevision = next.configRevision;
    setSnapshot(next);
    if (!configDirtyRef.current) setConfigDraft(clone(next.config));
    setConnectionError('');
    if (
      configDirtyRef.current &&
      !savingRef.current &&
      draftRevisionRef.current &&
      incomingRevision &&
      incomingRevision !== draftRevisionRef.current
    ) {
      setConfigError('A configuração mudou em outra aba. Suas alterações locais foram preservadas; salve novamente ou descarte o rascunho.');
    }
    if (!runProjectRef.current) setRunProjectId(next.config.activeProjectId || next.config.projects[0]?.id || '');
    const selectedStillExists = next.config.agents.some((agent) => agent.id === selectedAgentRef.current);
    if (!selectedStillExists) setSelectedAgentId(next.config.agents[0]?.id ?? '');
  }, []);

  const loadInitial = useCallback(async () => {
    try {
      const next = await api<Snapshot>('/api/state');
      receiveSnapshot(next);
      setConnection('connected');
      setConnectionNote('Ligado ao escritório');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Não foi possível carregar o estado.';
      setConnectionError(message);
      setConnection('offline');
      setConnectionNote('Servidor indisponível');
    }
  }, [receiveSnapshot]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      setConnection('connecting');
      setConnectionNote('Reconectando ao escritório…');
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      try {
        socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      } catch {
        setConnection('offline');
        setConnectionNote('Servidor indisponível');
        setConnectionError('Não foi possível conectar ao servidor local.');
        reconnectTimer.current = window.setTimeout(connect, reconnectDelay.current);
        reconnectDelay.current = Math.min(10_000, reconnectDelay.current * 2);
        return;
      }
      socket.onopen = () => {
        reconnectDelay.current = 1000;
        setConnection('connected');
        setConnectionNote('Ligado ao escritório');
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as { type?: string; data?: Snapshot; error?: string };
          if (message.type === 'snapshot' && message.data) receiveSnapshot(message.data);
          if (message.type === 'error' && message.error) setConfigError(message.error);
        } catch {
          // A malformed websocket frame cannot replace a good local snapshot.
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (disposed) return;
        setConnection('offline');
        setConnectionNote('Servidor indisponível · tentando de novo');
        setConnectionError('A conexão com o servidor foi interrompida. Tentando novamente…');
        reconnectTimer.current = window.setTimeout(connect, reconnectDelay.current);
        reconnectDelay.current = Math.min(10_000, reconnectDelay.current * 2);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
      socket?.close();
    };
  }, [receiveSnapshot]);

  useEffect(() => {
    if (!snapshot) return;
    const config = snapshot.config;
    if (!runProjectId || !config.projects.some((project) => project.id === runProjectId)) {
      setRunProjectId(config.activeProjectId || config.projects[0]?.id || '');
    }
    const project = config.projects.find((item) => item.id === (runProjectId || config.activeProjectId));
    if (!runWorkflowId || !config.workflows.some((workflow) => workflow.id === runWorkflowId)) {
      setRunWorkflowId(project?.workflowId || config.workflows[0]?.id || '');
    }
  }, [snapshot, runProjectId, runWorkflowId]);

  const config = configDraft ?? snapshot?.config ?? null;
  const selectedAgent = snapshot ? agentFromSnapshot(snapshot, selectedAgentId) : undefined;
  const selectedRuntime = selectedAgentId && snapshot ? snapshot.agents[selectedAgentId] : undefined;
  const activeProject = snapshot?.config.projects.find((project) => project.id === runProjectId) ?? snapshot?.config.projects[0];
  const activeWorkflow = snapshot?.config.workflows.find((workflow) => workflow.id === runWorkflowId) ?? snapshot?.config.workflows[0];
  const activeAgentId = useMemo(() => {
    if (snapshot?.run?.status !== 'Running') return '';
    const workflow = snapshot.config.workflows.find((item) => item.id === snapshot.run?.workflowId);
    return workflow?.steps.find((step) => step.id === snapshot.run?.stepId)?.agentId ?? '';
  }, [snapshot]);
  const isRunRunning = snapshot?.run?.status === 'Running';

  useEffect(() => {
    if (isRunRunning && activeAgentId && !selectedAgentTouchedRef.current) {
      setSelectedAgentId(activeAgentId);
    }
  }, [activeAgentId, isRunRunning]);

  useEffect(() => {
    if (!activeProject || !selectedAgentId || activeProject.agentIds.includes(selectedAgentId)) return;
    selectedAgentTouchedRef.current = false;
    setSelectedAgentId(activeProject.agentIds[0] ?? '');
  }, [activeProject, selectedAgentId]);

  const commitDraft = useCallback((updater: (current: Config) => Config) => {
    setConfigDraft((current) => {
      if (!current) return current;
      if (!configDirtyRef.current) {
        draftRevisionRef.current = snapshot?.configRevision;
        configDirtyRef.current = true;
      }
      setConfigDirty(true);
      return updater(clone(current));
    });
  }, [snapshot]);

  const perform = useCallback(async (key: string, operation: () => Promise<Snapshot>): Promise<boolean> => {
    setBusyAction(key);
    setError('');
    try {
      const next = await operation();
      receiveSnapshot(next);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'A ação não foi concluída.');
      return false;
    } finally {
      setBusyAction('');
    }
  }, [receiveSnapshot]);

  const saveConfig = async (): Promise<boolean> => {
    if (!configDraft) return false;
    if (snapshot?.run?.status === 'Running') {
      setConfigError('Pare a execução antes de salvar a configuração.');
      return false;
    }
    if (Object.values(argsErrors).some(Boolean)) {
      setConfigError('Corrija os argumentos dos agentes antes de salvar a configuração.');
      return false;
    }
    setSaving(true);
    savingRef.current = true;
    setConfigError('');
    try {
      const next = await api<Snapshot>('/api/config', {
        method: 'PUT',
        body: JSON.stringify({
          config: configDraft,
          // Compare against the revision the draft started from. If another
          // tab changed the config while this draft was open, using the newer
          // snapshot revision here would silently overwrite that tab.
          expectedRevision: draftRevisionRef.current || snapshot?.configRevision,
        }),
      });
      setSnapshot(next);
      setConfigDraft(clone(next.config));
      setConfigDirty(false);
      configDirtyRef.current = false;
      draftRevisionRef.current = undefined;
      return true;
    } catch (cause) {
      setConfigError(cause instanceof Error ? cause.message : 'As mudanças não foram salvas.');
      // Keep configDraft and its dirty marker intact so a transient or
      // revision-conflict failure cannot silently discard the user's work.
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const executeRun = async (kind: PendingRun): Promise<boolean> => {
    if (kind === 'restart-run') {
      return perform('restart-run', () => api<Snapshot>('/api/run/restart', { method: 'POST' }));
    }
    return perform('run', () => api<Snapshot>('/api/run', {
      method: 'POST',
      body: JSON.stringify({ projectId: runProjectId, workflowId: runWorkflowId, task: runTask.trim() }),
    }));
  };

  const startRun = async () => {
    if (!runProjectId || !runWorkflowId || !runTask.trim()) {
      setError('Escolha um projeto, um workflow e descreva a tarefa para começar.');
      return;
    }
    if (saving) {
      setError('Aguarde o salvamento da configuração terminar antes de iniciar.');
      return;
    }
    if (configDirty) {
      setPendingRun('run');
      return;
    }
    await executeRun('run');
  };

  const stopRun = async () => {
    await perform('stop-run', () => api<Snapshot>('/api/run/stop', { method: 'POST' }));
  };

  const restartRun = async () => {
    if (saving) {
      setError('Aguarde o salvamento da configuração terminar antes de reiniciar.');
      return;
    }
    if (configDirty) {
      setPendingRun('restart-run');
      return;
    }
    await executeRun('restart-run');
  };

  const discardDraft = useCallback(() => {
    if (!snapshot) return;
    setConfigDraft(clone(snapshot.config));
    setConfigDirty(false);
    configDirtyRef.current = false;
    draftRevisionRef.current = undefined;
    setConfigError('');
  }, [snapshot]);

  const saveAndRun = async () => {
    if (!pendingRun) return;
    const kind = pendingRun;
    const saved = await saveConfig();
    if (!saved) return;
    setPendingRun(null);
    await executeRun(kind);
  };

  const discardAndRun = async () => {
    if (!pendingRun) return;
    const kind = pendingRun;
    discardDraft();
    setPendingRun(null);
    await executeRun(kind);
  };

  const sendMessage = async () => {
    if (!selectedAgentId || selectedAgentId !== activeAgentId || !messageDraft.trim()) return;
    const text = messageDraft.trim();
    const sent = await perform(`send-${selectedAgentId}`, () => api<Snapshot>(`/api/agents/${encodeURIComponent(selectedAgentId)}/send`, {
      method: 'POST', body: JSON.stringify({ message: text }),
    }));
    if (sent) setMessageDraft('');
  };

  const controlAgent = async (action: 'stop' | 'restart') => {
    if (!selectedAgentId || selectedAgentId !== activeAgentId) return;
    await perform(`${action}-${selectedAgentId}`, () => api<Snapshot>(`/api/agents/${encodeURIComponent(selectedAgentId)}/${action}`, { method: 'POST' }));
  };

  const switchProject = (projectId: string) => {
    setRunProjectId(projectId);
    const nextProject = snapshot?.config.projects.find((project) => project.id === projectId);
    setRunWorkflowId(nextProject?.workflowId || snapshot?.config.workflows[0]?.id || '');
  };

  const projectRuntimeIds = useMemo(() => new Set(activeProject?.agentIds ?? []), [activeProject]);

  const selectAgent = useCallback((id: string) => {
    selectedAgentTouchedRef.current = true;
    setSelectedAgentId(id);
  }, []);

  const renderContent = () => {
    if (!snapshot || !config) return <LoadingOffice connection={connection} />;
    if (screen === 'projects') {
      return (
        <ProjectsScreen
          config={config}
          selectedId={projectEditorId || config.projects[0]?.id || ''}
          onSelect={setProjectEditorId}
          onChange={commitDraft}
          onAdd={() => {
            const next = blankProject(config.projects.length + 1, config);
            commitDraft((draft) => ({ ...draft, projects: [...draft.projects, next], activeProjectId: next.id }));
            setProjectEditorId(next.id);
          }}
          onRemove={(id) => {
            if (config.projects.length <= 1) {
              setError('Mantenha pelo menos um projeto configurado.');
              return;
            }
            commitDraft((draft) => {
              const projects = draft.projects.filter((project) => project.id !== id);
              return { ...draft, projects, activeProjectId: draft.activeProjectId === id ? projects[0]?.id ?? '' : draft.activeProjectId };
            });
            setProjectEditorId('');
          }}
        />
      );
    }
    if (screen === 'team') {
      return (
        <TeamScreen
          config={config}
          snapshot={snapshot}
          selectedId={agentEditorId || selectedAgentId || config.agents[0]?.id || ''}
          argsModes={argsModes}
          argsErrors={argsErrors}
          onSelect={(id) => { setAgentEditorId(id); selectAgent(id); }}
          onChange={commitDraft}
          onArgsMode={(id, mode) => setArgsModes((current) => ({ ...current, [id]: mode }))}
          onArgsError={(id, message) => setArgsErrors((current) => ({ ...current, [id]: message }))}
          onAddBlank={() => {
            const next = blankAgent(config.agents.length + 1);
            commitDraft((draft) => ({ ...draft, agents: [...draft.agents, next] }));
            setAgentEditorId(next.id);
            selectAgent(next.id);
          }}
          onClone={(template) => {
            const next = { ...clone(template), id: uid(template.id), name: `${template.name} copy` };
            commitDraft((draft) => ({ ...draft, agents: [...draft.agents, next] }));
            setAgentEditorId(next.id);
            selectAgent(next.id);
          }}
          onRemove={(id) => {
            if (!window.confirm('Remover este agente e suas referências da configuração?')) return;
            const projectReference = config.projects.some((project) => project.agentIds.includes(id));
            const workflowReference = config.workflows.some((workflow) => workflow.steps.some((step) => step.agentId === id));
            if (projectReference || workflowReference) {
              setError('Reassocie este agente nos projetos e workflows antes de removê-lo.');
              return;
            }
            commitDraft((draft) => ({ ...draft, agents: draft.agents.filter((agent) => agent.id !== id) }));
            setArgsErrors((current) => {
              const { [id]: _removed, ...rest } = current;
              return rest;
            });
            setArgsModes((current) => {
              const { [id]: _removed, ...rest } = current;
              return rest;
            });
            setAgentEditorId('');
            setSelectedAgentId('');
          }}
        />
      );
    }
    if (screen === 'workflow') {
      return (
        <WorkflowScreen
          config={config}
          selectedId={workflowEditorId || config.workflows[0]?.id || ''}
          onSelect={setWorkflowEditorId}
          onChange={commitDraft}
          onAdd={() => {
            const next = blankWorkflow(config.workflows.length + 1, config);
            commitDraft((draft) => ({ ...draft, workflows: [...draft.workflows, next] }));
            setWorkflowEditorId(next.id);
          }}
          onRemove={(id) => {
            if (config.workflows.length <= 1) {
              setError('Mantenha pelo menos um workflow configurado.');
              return;
            }
            commitDraft((draft) => ({
              ...draft,
              workflows: draft.workflows.filter((workflow) => workflow.id !== id),
              projects: draft.projects.map((project) => project.workflowId === id ? { ...project, workflowId: draft.workflows.find((workflow) => workflow.id !== id)?.id ?? '' } : project),
            }));
            setWorkflowEditorId('');
          }}
        />
      );
    }
    return (
      <RunScreen
        snapshot={snapshot}
        activeProject={activeProject}
        activeWorkflow={activeWorkflow}
        activeAgentId={activeAgentId}
        runProjectId={runProjectId}
        runWorkflowId={runWorkflowId}
        runTask={runTask}
        busyAction={busyAction}
        saving={saving}
        configDirty={configDirty}
        pendingRun={pendingRun}
        selectedAgentId={selectedAgentId}
        selectedAgent={selectedAgent}
        selectedRuntime={selectedRuntime}
        timelineFilter={timelineFilter}
        messageDraft={messageDraft}
        projectRuntimeIds={projectRuntimeIds}
        onProjectChange={switchProject}
        onWorkflowChange={setRunWorkflowId}
        onTaskChange={setRunTask}
        onStartRun={startRun}
        onStopRun={stopRun}
        onRestartRun={restartRun}
        onSaveAndRun={() => void saveAndRun()}
        onDiscardAndRun={() => void discardAndRun()}
        onCancelPendingRun={() => setPendingRun(null)}
        onSelectAgent={selectAgent}
        onTimelineFilter={setTimelineFilter}
        onMessageChange={setMessageDraft}
        onSendMessage={sendMessage}
        onControlAgent={controlAgent}
        onOpenScreen={(nextScreen) => {
          if (isRunRunning) {
            setError('Pare a execução antes de editar a configuração.');
            return;
          }
          setScreen(nextScreen);
        }}
      />
    );
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><Building2 size={21} strokeWidth={2.3} /></div>
          <div>
            <div className="brand-name">Agent Office</div>
            <div className="brand-caption">sala de operações</div>
          </div>
        </div>
        <nav className="primary-nav" aria-label="Seções">
          {([
            ['run', 'Run', 'Execução', Play],
            ['projects', 'Projects', 'Projetos', FolderKanban],
            ['team', 'Team', 'Equipe', UsersRound],
            ['workflow', 'Workflow', 'Workflows', GitBranch],
          ] as const).map(([id, ariaLabel, label, Icon]) => (
            <button key={id} type="button" className={`nav-item ${screen === id ? 'is-active' : ''}`} aria-label={ariaLabel} onClick={() => setScreen(id)} disabled={isRunRunning && id !== 'run'} title={isRunRunning && id !== 'run' ? 'Pare a execução antes de editar a configuração.' : undefined}>
              <Icon size={16} strokeWidth={2.1} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="topbar-actions">
          {snapshot?.run && <RunPill run={snapshot.run} />}
          <div className={`connection-pill connection-${connection}`} title={connectionNote}>
            <span className="connection-dot" />
            <span>{connection === 'connected' ? 'Ao vivo' : connection === 'connecting' ? 'Conectando' : 'Offline'}</span>
          </div>
          <button type="button" className={`save-button ${configDirty ? 'is-dirty' : ''}`} onClick={() => void saveConfig()} disabled={!configDirty || saving || isRunRunning} title={isRunRunning ? 'Pare a execução antes de salvar a configuração.' : undefined}>
            {saving ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}
            <span>{saving ? 'Salvando…' : configDirty ? 'Salvar mudanças' : 'Tudo salvo'}</span>
          </button>
        </div>
      </header>

      <main className="main-content">
        {connectionError && <ErrorBanner label="Conexão" message={connectionError} onDismiss={() => setConnectionError('')} />}
        {configError && <ErrorBanner label="Configuração" message={configError} onDismiss={() => setConfigError('')} />}
        {error && <ErrorBanner label="Ação" message={error} onDismiss={() => setError('')} />}
        {renderContent()}
      </main>
      {snapshot && configDirty && (
        <div className="unsaved-note"><Pencil size={13} /><span>Rascunho local não salvo.</span><button type="button" onClick={discardDraft}>Descartar rascunho</button></div>
      )}
    </div>
  );
}

function ErrorBanner({ label, message, onDismiss }: { label: string; message: string; onDismiss: () => void }) {
  return <div className="error-banner" role="alert"><AlertCircle size={18} /><strong>{label}</strong><span>{message}</span><button type="button" aria-label={`Fechar aviso de ${label.toLowerCase()}`} onClick={onDismiss}><X size={16} /></button></div>;
}

function LoadingOffice({ connection }: { connection: ConnectionState }) {
  return (
    <section className="loading-state">
      <div className="loading-illustration"><Building2 size={54} strokeWidth={1.4} /></div>
      <h1>Abrindo o escritório</h1>
      <p>{connection === 'offline' ? 'O servidor ainda não respondeu. A próxima tentativa será automática.' : 'Estamos buscando a configuração e o estado dos agentes.'}</p>
      <LoaderCircle size={22} className="spin" />
    </section>
  );
}

function RunPill({ run }: { run: Run }) {
  const isRunning = run.status === 'Running';
  const label = run.status === 'Running' ? 'Em execução' : run.status === 'Done' ? 'Concluído' : run.status === 'Stopped' ? 'Parado' : 'Erro';
  return (
    <div className={`run-pill ${isRunning ? 'is-running' : ''}`}>
      {isRunning ? <LoaderCircle size={14} className="spin" /> : run.status === 'Done' ? <CheckCircle2 size={14} /> : <Clock3 size={14} />}
      <span>{label}</span>
    </div>
  );
}

function RunScreen({
  snapshot,
  activeProject,
  activeWorkflow,
  activeAgentId,
  runProjectId,
  runWorkflowId,
  runTask,
  busyAction,
  saving,
  configDirty,
  pendingRun,
  selectedAgentId,
  selectedAgent,
  selectedRuntime,
  timelineFilter,
  messageDraft,
  projectRuntimeIds,
  onProjectChange,
  onWorkflowChange,
  onTaskChange,
  onStartRun,
  onStopRun,
  onRestartRun,
  onSaveAndRun,
  onDiscardAndRun,
  onCancelPendingRun,
  onSelectAgent,
  onTimelineFilter,
  onMessageChange,
  onSendMessage,
  onControlAgent,
  onOpenScreen,
}: {
  snapshot: Snapshot;
  activeProject?: Project;
  activeWorkflow?: Workflow;
  activeAgentId: string;
  runProjectId: string;
  runWorkflowId: string;
  runTask: string;
  busyAction: string;
  saving: boolean;
  configDirty: boolean;
  pendingRun: PendingRun | null;
  selectedAgentId: string;
  selectedAgent?: Agent;
  selectedRuntime?: AgentRuntime;
  timelineFilter: string;
  messageDraft: string;
  projectRuntimeIds: Set<string>;
  onProjectChange: (id: string) => void;
  onWorkflowChange: (id: string) => void;
  onTaskChange: (value: string) => void;
  onStartRun: () => void;
  onStopRun: () => void;
  onRestartRun: () => void;
  onSaveAndRun: () => void;
  onDiscardAndRun: () => void;
  onCancelPendingRun: () => void;
  onSelectAgent: (id: string) => void;
  onTimelineFilter: (value: string) => void;
  onMessageChange: (value: string) => void;
  onSendMessage: () => void;
  onControlAgent: (action: 'stop' | 'restart') => void;
  onOpenScreen: (screen: Screen) => void;
}) {
  const run = snapshot.run;
  const isRunning = run?.status === 'Running';
  const [officeExpanded, setOfficeExpanded] = useState(true);
  const [configPeekOpen, setConfigPeekOpen] = useState(false);
  const [timelineVisibleCount, setTimelineVisibleCount] = useState(24);
  const officeAgents = snapshot.config.agents.filter((agent) => projectRuntimeIds.has(agent.id));
  const runWorkflow = snapshot.config.workflows.find((workflow) => workflow.id === run?.workflowId) ?? activeWorkflow;
  const currentStep = runWorkflow?.steps.find((step) => step.id === run?.stepId);
  const currentAgent = currentStep ? snapshot.config.agents.find((agent) => agent.id === currentStep.agentId) : undefined;
  const currentRuntime = currentAgent ? snapshot.agents[currentAgent.id] : undefined;
  const terminationEvent = run && run.status !== 'Running'
    ? snapshot.timeline.slice().reverse().find((event) => {
      if (run.id && event.runId && event.runId !== run.id) return false;
      const kind = event.kind.toLowerCase();
      return kind.includes('error') || kind.includes('stop') || kind.includes('done') || kind.includes('finish') || kind.includes('complete');
    })
    : undefined;
  const visibleTimeline = snapshot.timeline.filter((event) => {
    const belongsToCurrentRun = !run?.id || event.runId === run.id || (!event.runId && (!run.startedAt || event.at >= run.startedAt));
    return belongsToCurrentRun && (!event.agentId || projectRuntimeIds.has(event.agentId)) && (timelineFilter === 'all' || event.agentId === timelineFilter);
  });
  const pagedTimeline = visibleTimeline.slice(-timelineVisibleCount);

  useEffect(() => {
    setTimelineVisibleCount(24);
  }, [run?.id, timelineFilter]);

  return (
    <div className="run-layout">
      <section className="run-main-column">
        <div className="page-intro intro-run">
          <div>
            <p className="eyebrow"><span className="eyebrow-dot" /> sala aberta</p>
            <h1>O trabalho acontece aqui.</h1>
            <p className="intro-copy">Acompanhe cada agente no seu espaço, inicie uma tarefa e veja as decisões ganharem forma.</p>
          </div>
          <div className="intro-stats">
            <div><strong>{officeAgents.length}</strong><span>agentes do projeto</span></div>
            <div><strong>{snapshot.config.workflows.length}</strong><span>workflows</span></div>
            <div><strong>{snapshot.timeline.length}</strong><span>eventos</span></div>
          </div>
        </div>

        <OnboardingPanel snapshot={snapshot} activeProject={activeProject} activeWorkflow={activeWorkflow} projectRuntimeIds={projectRuntimeIds} onOpenScreen={onOpenScreen} />

        <section className="run-launcher paper-panel">
          <div className="panel-heading">
            <div className="heading-icon heading-icon-cobalt"><Zap size={17} /></div>
            <div><h2>Começar uma tarefa</h2><p>Envie um objetivo para o workflow selecionado.</p></div>
            {isRunning && <span className="live-tag"><span /> workflow rodando</span>}
          </div>
          <div className="run-form-grid">
            <label className="field-label">Projeto
              <select value={runProjectId} onChange={(event) => onProjectChange(event.target.value)} disabled={isRunning}>
                <option value="">Escolha um projeto</option>
                {snapshot.config.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            <label className="field-label">Workflow
              <select value={runWorkflowId} onChange={(event) => onWorkflowChange(event.target.value)} disabled={isRunning}>
                <option value="">Escolha um workflow</option>
                {snapshot.config.workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}
              </select>
            </label>
          </div>
          <label className="field-label task-field">Tarefa
            <textarea value={runTask} onChange={(event) => onTaskChange(event.target.value)} disabled={isRunning} placeholder="Ex.: Revise o fluxo de login e prepare um plano de correção…" rows={3} />
          </label>
          <div className="launcher-footer">
            <span className="muted-detail"><FolderKanban size={14} /> {activeProject?.cwd || 'sem diretório definido'} <span className="detail-separator">·</span> {activeWorkflow?.steps.length ?? 0} passos</span>
            <div className="launcher-actions">
              <button type="button" className="button button-quiet" onClick={() => setConfigPeekOpen(true)}><Eye size={14} /> Consultar configuração</button>
              {isRunning ? (
                <button type="button" className="button button-stop" onClick={onStopRun} disabled={busyAction === 'stop-run'}>{busyAction === 'stop-run' ? <LoaderCircle className="spin" size={16} /> : <Square size={14} fill="currentColor" />} Parar execução</button>
              ) : (
                <>
                  {run && <button type="button" className="button button-quiet" onClick={onRestartRun} disabled={saving || busyAction === 'restart-run'}>{busyAction === 'restart-run' ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={15} />} Reiniciar workflow</button>}
                  <button type="button" className="button button-primary" onClick={onStartRun} disabled={saving || busyAction === 'run'}>{busyAction === 'run' ? <LoaderCircle className="spin" size={16} /> : <Play size={15} fill="currentColor" />} Iniciar workflow</button>
                </>
              )}
            </div>
          </div>
          {pendingRun && <RunDecisionPanel pendingRun={pendingRun} saving={saving} configDirty={configDirty} onSaveAndRun={onSaveAndRun} onDiscardAndRun={onDiscardAndRun} onCancel={onCancelPendingRun} />}
        </section>

        <RunStatusCard run={run} currentStep={currentStep} currentStepName={currentStep ? stepDisplayName(currentStep, runWorkflow?.steps.findIndex((step) => step.id === run?.stepId) ?? 0, snapshot.config) : undefined} currentAgent={currentAgent} currentRuntime={currentRuntime} stepNumber={runWorkflow?.steps.findIndex((step) => step.id === run?.stepId) ?? -1} stepTotal={runWorkflow?.steps.length ?? 0} terminationReason={terminationEvent?.text} />

        <section className="office-section">
          <div className="section-heading"><div><p className="eyebrow">planta do escritório</p><h2>O escritório agora</h2></div><div className="section-heading-actions"><span className="section-note"><span className="legend-dot legend-working" /> atividade ao vivo</span><button type="button" className="icon-button" aria-expanded={officeExpanded} aria-controls="office-floor" aria-label={officeExpanded ? 'Recolher escritório' : 'Expandir escritório'} onClick={() => setOfficeExpanded((expanded) => !expanded)}>{officeExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button></div></div>
          {officeExpanded && <div className="office-floor" id="office-floor">
            <div className="floor-label"><Building2 size={14} /> escritório de agentes · piso 01</div>
            {AREAS.map((area) => (
              <RoomCard key={area} area={area} agents={officeAgents.filter((agent) => agent.area === area)} runtimes={snapshot.agents} selectedAgentId={selectedAgentId} activeAgentId={activeAgentId} projectRuntimeIds={projectRuntimeIds} onSelectAgent={onSelectAgent} />
            ))}
            {officeAgents.length === 0 && <div className="office-empty"><UsersRound size={27} /><strong>O escritório está vazio</strong><span>Adicione agentes em Equipe para começar a montar sua equipe.</span></div>}
          </div>}
        </section>

        <TeamDock agents={officeAgents} runtimes={snapshot.agents} selectedAgentId={selectedAgentId} activeAgentId={activeAgentId} onSelectAgent={onSelectAgent} />
      </section>

      <AgentInspector agent={selectedAgent} runtime={selectedRuntime} activeAgentId={activeAgentId} busyAction={busyAction} messageDraft={messageDraft} onMessageChange={onMessageChange} onSendMessage={onSendMessage} onControlAgent={onControlAgent} />

      <section className="timeline-section paper-panel">
        <div className="panel-heading timeline-heading">
          <div className="heading-icon heading-icon-warm"><Clock3 size={17} /></div>
          <div><h2>Linha do tempo</h2><p>O que mudou no escritório, em ordem.</p></div>
          <label className="timeline-filter"><Filter size={14} /><span>Filtrar por agente</span><select aria-label="Filtrar linha do tempo por agente" value={timelineFilter} onChange={(event) => onTimelineFilter(event.target.value)}><option value="all">Todos os agentes</option>{officeAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select><ChevronDown size={14} /></label>
        </div>
        <Timeline events={pagedTimeline} agents={officeAgents} hasMore={pagedTimeline.length < visibleTimeline.length} onLoadMore={() => setTimelineVisibleCount((count) => count + 24)} />
      </section>
      <RunHistoryPanel snapshot={snapshot} />

      {configPeekOpen && <ReadOnlyConfigDialog project={activeProject} workflow={activeWorkflow} agents={officeAgents} configRevision={snapshot.configRevision} onClose={() => setConfigPeekOpen(false)} />}
    </div>
  );
}

type DiagnosticView = { state: 'idle' | 'loading' | 'success' | 'unavailable' | 'error'; message?: string };

function OnboardingPanel({ snapshot, activeProject, activeWorkflow, projectRuntimeIds, onOpenScreen }: { snapshot: Snapshot; activeProject?: Project; activeWorkflow?: Workflow; projectRuntimeIds: Set<string>; onOpenScreen: (screen: Screen) => void }) {
  const [diagnostic, setDiagnostic] = useState<DiagnosticView>({ state: 'idle' });
  const [diagnosticReport, setDiagnosticReport] = useState<DiagnosticsReport | null>(null);
  const projectAgents = snapshot.config.agents.filter((agent) => projectRuntimeIds.has(agent.id));
  const workflowAgents = new Set(activeWorkflow?.steps.map((step) => step.agentId) ?? []);
  const checks = [
    { key: 'project', label: 'Projeto tem diretório', detail: activeProject?.cwd || 'Defina um caminho absoluto para o projeto.', ok: Boolean(activeProject?.cwd.trim()), screen: 'projects' as Screen },
    { key: 'team', label: 'Equipe do projeto', detail: projectAgents.length > 0 ? `${projectAgents.length} agente${projectAgents.length === 1 ? '' : 's'} selecionado${projectAgents.length === 1 ? '' : 's'}.` : 'Inclua pelo menos um agente no projeto.', ok: projectAgents.length > 0, screen: 'projects' as Screen },
    { key: 'workflow', label: 'Workflow com etapas', detail: activeWorkflow?.steps.length ? `${activeWorkflow.steps.length} etapa${activeWorkflow.steps.length === 1 ? '' : 's'} configurada${activeWorkflow.steps.length === 1 ? '' : 's'}.` : 'Crie uma etapa e escolha o agente responsável.', ok: Boolean(activeWorkflow?.steps.length), screen: 'workflow' as Screen },
    { key: 'compatibility', label: 'Etapas pertencem à equipe', detail: workflowAgents.size > 0 && [...workflowAgents].every((id) => projectRuntimeIds.has(id)) ? 'Todos os agentes do workflow estão no projeto.' : 'Há uma etapa apontando para alguém fora da equipe.', ok: workflowAgents.size > 0 && [...workflowAgents].every((id) => projectRuntimeIds.has(id)), screen: 'workflow' as Screen },
    { key: 'cli', label: 'Executável informado', detail: projectAgents.every((agent) => agent.cli.trim()) ? 'Cada agente tem um CLI configurado.' : 'Revise os agentes sem executável.', ok: projectAgents.length > 0 && projectAgents.every((agent) => agent.cli.trim()), screen: 'team' as Screen },
  ];
  const ready = checks.every((check) => check.ok);

  const runDiagnostics = async () => {
    setDiagnostic({ state: 'loading', message: 'Consultando apenas o servidor local…' });
    setDiagnosticReport(null);
    try {
      const result = await api<DiagnosticsReport>('/api/diagnostics', {
        method: 'POST',
        body: JSON.stringify({
          ...(activeProject?.id ? { projectId: activeProject.id } : {}),
          ...(activeWorkflow?.id ? { workflowId: activeWorkflow.id } : {}),
        }),
      });
      setDiagnosticReport(result);
      setDiagnostic({
        state: result.ok ? 'success' : 'error',
        message: result.ok
          ? `Diagnóstico concluído sem erros${result.issues.length ? `; ${result.issues.length} aviso${result.issues.length === 1 ? '' : 's'} para revisar` : ''}. Nenhuma chamada de IA foi iniciada.`
          : `Diagnóstico encontrou ${result.issues.length} problema${result.issues.length === 1 ? '' : 's'}. Corrija os itens abaixo antes de iniciar.`,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Não foi possível consultar o diagnóstico local.';
      setDiagnostic({
        state: message.includes('404') ? 'unavailable' : 'error',
        message: message.includes('404')
          ? 'O endpoint de diagnóstico ainda não está disponível neste servidor. O checklist local continua sendo a fonte de orientação.'
          : message,
      });
    }
  };

  return (
    <section className="onboarding-panel paper-panel" aria-labelledby="onboarding-title">
      <div className="panel-heading onboarding-heading">
        <div className="heading-icon heading-icon-warm"><ListChecks size={17} /></div>
        <div><h2 id="onboarding-title">Primeira execução</h2><p>Revise o caminho e a equipe antes de iniciar qualquer processo.</p></div>
        <span className={`onboarding-state ${ready ? 'is-ready' : ''}`} aria-live="polite">{ready ? 'pronto para revisar' : `${checks.filter((check) => !check.ok).length} pendência${checks.filter((check) => !check.ok).length === 1 ? '' : 's'}`}</span>
      </div>
      <div className="onboarding-checklist">
        {checks.map((check) => <div className={`onboarding-check ${check.ok ? 'is-complete' : 'is-pending'}`} key={check.key}>
          <span className="onboarding-check-icon" aria-hidden="true">{check.ok ? <CheckCircle2 size={16} /> : <CircleHelp size={16} />}</span>
          <div><strong>{check.label}</strong><p>{check.detail}</p></div>
          {!check.ok && <button type="button" className="button button-text" onClick={() => onOpenScreen(check.screen)}>Configurar</button>}
        </div>)}
      </div>
      <div className="onboarding-notes">
        <p><strong>CLI e modelo: não verificados.</strong> O diagnóstico local verifica diretório, executável e compatibilidade; autenticação e disponibilidade do modelo dependem do CLI instalado.</p>
        <p><strong>Diretórios e placeholders.</strong> O diretório do agente tem precedência sobre o diretório do projeto; se ambos estiverem vazios, o processo usa o diretório do servidor. Use <code>{'{prompt}'}</code>, <code>{'{model}'}</code> e <code>{'{cwd}'}</code> nos argumentos quando precisar deles.</p>
      </div>
      <div className="onboarding-actions">
        <button type="button" className="button button-quiet" onClick={() => void runDiagnostics()} disabled={diagnostic.state === 'loading'}>{diagnostic.state === 'loading' ? <LoaderCircle size={14} className="spin" /> : <HeartPulse size={14} />} Diagnóstico local</button>
        <span className="onboarding-diagnostic" aria-live="polite">{diagnostic.message || 'Não inicia IA nem altera a configuração.'}</span>
      </div>
      {diagnostic.state !== 'idle' && <div className={`diagnostic-result diagnostic-${diagnostic.state}`} role={diagnostic.state === 'error' ? 'alert' : 'status'}><span>{diagnostic.state === 'unavailable' ? 'aguardando endpoint' : diagnostic.state === 'loading' ? 'consultando' : diagnostic.state === 'success' ? 'resposta local' : 'falha local'}</span><p>{diagnostic.message}</p></div>}
      {diagnosticReport && <DiagnosticReportView report={diagnosticReport} workflow={activeWorkflow} config={snapshot.config} />}
      <details className="demo-guide">
        <summary><WandSparkles size={15} /> Demonstração local determinística <ChevronDown size={14} /></summary>
        <div className="demo-guide-content">
          <p>Para provar o fluxo sem custo de IA, configure um agente com CLI <code>node</code>, modelo vazio e argumentos <code>[&quot;/caminho/agent-company/scripts/example-agent.mjs&quot;, &quot;{'{prompt}'}&quot;]</code>. Escolha uma pasta de teste absoluta, inclua o agente na equipe e use um workflow de uma etapa.</p>
          <p>Essa demonstração usa arquivos locais e não exige editar YAML. O agente escreve <code>agent-office-example.txt</code>; a autenticação e o modelo continuam <strong>não verificados</strong>.</p>
          <div className="demo-guide-actions"><button type="button" className="button button-text" onClick={() => onOpenScreen('team')}>Abrir Equipe</button><button type="button" className="button button-text" onClick={() => onOpenScreen('projects')}>Abrir Projetos</button><button type="button" className="button button-text" onClick={() => onOpenScreen('workflow')}>Abrir Workflows</button></div>
        </div>
      </details>
    </section>
  );
}

function diagnosticCorrection(issue: DiagnosticIssue): string {
  if (issue.code.includes('directory')) return 'Abra Projetos e informe um diretório absoluto existente; o diretório do agente substitui o do projeto quando preenchido.';
  if (issue.code.includes('executable')) return 'Abra Equipe e informe um executável disponível no PATH ou um caminho executável.';
  if (issue.code === 'agent-outside-team') return 'Abra Projetos e inclua o agente indicado na equipe deste projeto, ou ajuste a etapa no Workflow.';
  if (issue.code.includes('transition') || issue.code.includes('step') || issue.code.includes('workflow')) return 'Abra Workflows e ajuste a etapa ou a transição indicada no caminho.';
  if (issue.code.includes('project')) return 'Abra Projetos e selecione uma configuração existente.';
  return 'Revise o campo indicado antes de iniciar a execução.';
}

function diagnosticCheckLabel(status: 'ok' | 'error' | 'not-verified'): string {
  return status === 'ok' ? 'ok' : status === 'error' ? 'erro' : 'não verificado';
}

function DiagnosticReportView({ report, workflow, config }: { report: DiagnosticsReport; workflow?: Workflow; config: Config }) {
  const checkRows = report.agents.flatMap((agent) => [
    { key: `${agent.agentId}-directory`, agentId: agent.agentId, label: 'Diretório', check: agent.directory },
    { key: `${agent.agentId}-executable`, agentId: agent.agentId, label: 'Executável', check: agent.executable },
    { key: `${agent.agentId}-authentication`, agentId: agent.agentId, label: 'Autenticação', check: agent.authentication },
    { key: `${agent.agentId}-model`, agentId: agent.agentId, label: 'Modelo', check: agent.model },
  ]);
  const labelForStep = (id: string) => {
    const index = workflow?.steps.findIndex((step) => step.id === id) ?? -1;
    return index >= 0 && workflow ? stepDisplayName(workflow.steps[index], index, config) : id;
  };
  return <div className="diagnostic-report"><div className="diagnostic-report-heading"><strong>Detalhes verificados pelo servidor local</strong><time>{shortTime(report.checkedAt)}</time></div><p className="diagnostic-report-summary">{report.ok ? 'Sem erros de configuração encontrados.' : `${report.issues.filter((issue) => issue.severity === 'error').length} erro${report.issues.filter((issue) => issue.severity === 'error').length === 1 ? '' : 's'} encontrado${report.issues.filter((issue) => issue.severity === 'error').length === 1 ? '' : 's'}.`} Avisos e estados não verificados permanecem listados para revisão.</p><div className="diagnostic-checks">{checkRows.map((row) => <div className={`diagnostic-check diagnostic-check-${row.check.status}`} key={row.key}><span>{row.label}</span><strong>{diagnosticCheckLabel(row.check.status)}</strong><p>{row.check.message}</p>{row.check.path && <code>{row.check.path}</code>}</div>)}</div>{report.issues.length > 0 && <div className="diagnostic-issues"><span className="small-label"><CircleHelp size={13} /> Problemas e correções</span>{report.issues.map((issue, index) => <article key={`${issue.code}-${issue.path || index}`}><div><code>{issue.code}</code><span className={`diagnostic-severity diagnostic-severity-${issue.severity}`}>{issue.severity}</span></div><p>{issue.message}</p><small><strong>Próximo passo:</strong> {diagnosticCorrection(issue)}{issue.path ? ` Campo: ${issue.path}.` : ''}</small></article>)}</div>}{report.workflow?.unreachableStepIds.length ? <p className="diagnostic-warning"><strong>Etapas inalcançáveis:</strong> {report.workflow.unreachableStepIds.map(labelForStep).join(', ')}.</p> : null}</div>;
}

function RunStatusCard({ run, currentStep, currentStepName, currentAgent, currentRuntime, stepNumber, stepTotal, terminationReason }: { run: Run | null; currentStep?: Step; currentStepName?: string; currentAgent?: Agent; currentRuntime?: AgentRuntime; stepNumber: number; stepTotal: number; terminationReason?: string }) {
  const status = run?.status ?? 'Waiting';
  const statusLabel = status === 'Running' ? 'Em execução' : status === 'Done' ? 'Concluído' : status === 'Stopped' ? 'Parado' : status === 'Error' ? 'Erro' : 'Aguardando execução';
  const at = activityAt(currentRuntime) || (run?.endedAt ?? run?.startedAt);
  return <section className={`run-status-card paper-panel run-status-${status.toLowerCase()}`} aria-live="polite" aria-labelledby="run-status-title">
    <div className="run-status-heading"><div><p className="eyebrow">estado da execução</p><h2 id="run-status-title">{statusLabel}</h2></div><StatusBadge status={currentRuntime?.status ?? 'Idle'} /></div>
    <div className="run-status-grid">
      <div><span className="small-label">Etapa atual</span><strong>{currentStep ? `${stepNumber + 1} de ${stepTotal} · ${currentStepName || 'sem nome'}` : '—'}</strong><p>{currentStep?.instruction || 'O servidor ainda não informou uma etapa ativa.'}</p></div>
      <div><span className="small-label">Agente atual</span><strong>{currentAgent?.name || '—'}</strong><p>{currentAgent?.role || 'Nenhum agente ativo informado.'}</p></div>
      <div><span className="small-label">Tempo decorrido</span><strong>{run?.startedAt ? <ElapsedTime startedAt={run.startedAt} endedAt={run.endedAt} /> : '—'}</strong><p>{run?.startedAt ? `início às ${shortTime(run.startedAt)}` : 'Ainda sem execução registrada.'}</p></div>
      <div><span className="small-label">Última atividade</span><strong><ActivityTime at={at} /></strong><p>{activityDescription(currentRuntime) || 'Descrição não informada pelo servidor.'}</p></div>
    </div>
    {run && run.status !== 'Running' && <div className="termination-reason"><span className="small-label">Motivo de término</span><p>{terminationReason || 'Motivo não informado pelo servidor.'}</p></div>}
  </section>;
}

function ElapsedTime({ startedAt, endedAt }: { startedAt: string; endedAt?: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (endedAt) return;
    const timer = window.setInterval(() => setTick((current) => current + 1), 1000);
    return () => window.clearInterval(timer);
  }, [endedAt]);
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return 'tempo não informado';
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}min ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}min`;
}

function ReadOnlyConfigDialog({ project, workflow, agents, configRevision, onClose }: { project?: Project; workflow?: Workflow; agents: Agent[]; configRevision: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  return <div className="readonly-config-overlay" role="presentation"><section className="readonly-config paper-panel" role="dialog" aria-modal="true" aria-labelledby="readonly-config-title"><div className="readonly-config-heading"><div><p className="eyebrow">consulta durante execução</p><h2 id="readonly-config-title">Configuração usada</h2></div><button ref={closeRef} type="button" className="icon-button" aria-label="Fechar consulta de configuração" onClick={onClose}><X size={17} /></button></div><p className="readonly-config-note"><LockKeyhole size={14} /> Somente leitura enquanto o run está ativo. Revisão <code>{configRevision || 'não informada'}</code>.</p><div className="readonly-config-grid"><div><span className="small-label">Projeto</span><strong>{project?.name || 'Projeto não informado'}</strong><p>{project?.cwd || 'diretório não informado'}</p></div><div><span className="small-label">Workflow</span><strong>{workflow?.name || 'Workflow não informado'}</strong><p>{workflow?.steps.length ?? 0} etapas</p></div></div><div className="readonly-team"><span className="small-label">Equipe do projeto</span>{agents.length === 0 ? <p>Nenhum agente selecionado.</p> : <ul>{agents.map((agent) => <li key={agent.id}><Avatar agent={agent} size="small" /><span><strong>{agent.name}</strong><small>{agent.cli || 'CLI não definido'} · modelo não verificado</small></span></li>)}</ul>}</div><div className="readonly-help"><strong>Como o processo resolve o contexto</strong><p>O diretório do agente tem precedência sobre o diretório do projeto; com ambos vazios, o servidor usa seu diretório de trabalho. Placeholders disponíveis: <code>{'{prompt}'}</code>, <code>{'{model}'}</code> e <code>{'{cwd}'}</code>.</p></div></section></div>;
}

function RunDecisionPanel({ pendingRun, saving, configDirty, onSaveAndRun, onDiscardAndRun, onCancel }: { pendingRun: PendingRun; saving: boolean; configDirty: boolean; onSaveAndRun: () => void; onDiscardAndRun: () => void; onCancel: () => void }) {
  const verb = pendingRun === 'run' ? 'iniciar' : 'reiniciar';
  return <div className="run-decision" role="status"><div><strong>Há mudanças locais antes de {verb}.</strong><p>Escolha o que deve acontecer com o rascunho para evitar executar a configuração salva por engano.</p></div><div className="run-decision-actions"><button type="button" className="button button-primary" onClick={onSaveAndRun} disabled={saving || !configDirty}>{saving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />} Salvar e {verb}</button><button type="button" className="button button-quiet" onClick={onDiscardAndRun} disabled={saving}>{<Trash2 size={14} />} Descartar alterações e {verb}</button><button type="button" className="button button-text" onClick={onCancel} disabled={saving}>Cancelar</button></div></div>;
}

function RunHistoryPanel({ snapshot }: { snapshot: Snapshot }) {
  const [query, setQuery] = useState('');
  const items = historyItems(snapshot);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = items.filter((item) => !normalizedQuery || historySearchText(item, snapshot).includes(normalizedQuery));
  const rawHistory = snapshot.runHistory;

  const exportHistory = () => {
    if (!rawHistory) return;
    const blob = new Blob([JSON.stringify(rawHistory, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `agent-office-run-history-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const visibleItems = filtered.slice(-12).reverse();
  return <section className="history-section paper-panel"><div className="panel-heading history-heading"><div className="heading-icon heading-icon-warm"><Archive size={17} /></div><div><h2>Histórico de runs</h2><p>Consulte execuções registradas sem misturá-las com a atual.</p></div><button type="button" className="button button-quiet history-export" onClick={exportHistory} disabled={!rawHistory}><ArrowDownToLine size={14} /> Exportar JSON</button></div><div className="history-tools"><label className="history-search"><Search size={14} /><span className="sr-only">Buscar no histórico</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por tarefa, projeto ou status" /></label><span className="history-count">{filtered.length} de {items.length}</span></div>{filtered.length === 0 ? <div className="history-empty"><Archive size={17} /><span>{items.length === 0 ? 'Nenhum run registrado ainda.' : 'Nenhum run corresponde à busca.'}</span></div> : <div className="history-list">{visibleItems.map((item, index) => <HistoryRow key={`${textValue(historyRun(item), 'id', 'runId') || 'run'}-${index}`} value={item} index={index} snapshot={snapshot} />)}</div>}{filtered.length > 12 && <p className="history-limit">Mostrando os 12 resultados mais recentes. Use a busca para refinar.</p>}</section>;
}

function HistoryRow({ value, index, snapshot }: { value: RunHistoryEntry; index: number; snapshot: Snapshot }) {
  const record = historyRun(value);
  const runId = textValue(record, 'id', 'runId') || `run-${index + 1}`;
  const status = textValue(record, 'status', 'state');
  const projectId = textValue(record, 'projectId');
  const project = snapshot.config.projects.find((item) => item.id === projectId);
  const projectLabel = project?.name || textValue(record, 'projectName', 'project') || 'Projeto não identificado';
  const task = textValue(record, 'task', 'objective', 'title') || 'Tarefa sem descrição';
  const startedAt = textValue(record, 'startedAt', 'createdAt', 'at');
  const attempts = Array.isArray(record.attempts) ? record.attempts.length : Array.isArray(record.steps) ? record.steps.length : 0;
  const current = snapshot.run?.id === runId;
  return <article className={`history-row ${current ? 'is-current' : ''}`}><div className="history-row-main"><div className="history-row-title"><strong>{task}</strong>{current && <span className="history-current">Atual</span>}</div><p>{projectLabel} <span>·</span> {startedAt ? shortTime(startedAt) : 'horário não informado'} {attempts > 0 && <><span>·</span> {attempts} {attempts === 1 ? 'registro' : 'registros'}</>}</p></div><div className={`history-status history-status-${status.toLowerCase() || 'unknown'}`}>{historyStatusLabel(status)}</div><code title={runId}>{runId.slice(0, 12)}</code></article>;
}

function RoomCard({ area, agents, runtimes, selectedAgentId, activeAgentId, projectRuntimeIds, onSelectAgent }: { area: Area; agents: Agent[]; runtimes: Record<string, AgentRuntime>; selectedAgentId: string; activeAgentId: string; projectRuntimeIds: Set<string>; onSelectAgent: (id: string) => void }) {
  const meta = areaMeta[area];
  const Icon = meta.icon;
  return (
    <article className={`room-card ${meta.className}`}>
      <div className="room-topline"><div className="room-name"><Icon size={16} strokeWidth={2.2} /><h3>{meta.label}</h3></div><span className="room-count">{agents.length || '—'}</span></div>
      <p className="room-detail">{meta.detail}</p>
      <RoomFurniture area={area} />
      <div className="room-agents">
        {agents.length === 0 ? <span className="room-vacancy">sem agentes</span> : agents.map((agent) => {
          const runtime = runtimes[agent.id];
          const isSelected = selectedAgentId === agent.id;
          const isActive = activeAgentId === agent.id;
          const inProject = projectRuntimeIds.has(agent.id);
          return <button type="button" key={agent.id} className={`room-avatar-button ${isSelected ? 'is-selected' : ''} ${isActive ? 'is-active' : ''} ${!inProject ? 'is-muted' : ''}`} aria-current={isActive ? 'step' : undefined} onClick={() => onSelectAgent(agent.id)} title={`${agent.name} · ${isActive ? 'etapa atual · ' : ''}${statusLabel(runtime?.status)}`}><Avatar agent={agent} runtime={runtime} size="small" /><span className="room-agent-meta"><strong>{agent.name}</strong>{isActive && <em>atual</em>}<small>{statusLabel(runtime?.status ?? 'Idle')}</small></span></button>;
        })}
      </div>
    </article>
  );
}

function RoomFurniture({ area }: { area: Area }) {
  return <div className={`room-furniture furniture-${area.toLowerCase().replace(/\s+/g, '-')}`} aria-hidden="true"><span className="furniture-shape furniture-main" /><span className="furniture-shape furniture-secondary" /><span className="furniture-plant"><i /><b /><em /></span></div>;
}

function TeamDock({ agents, runtimes, selectedAgentId, activeAgentId, onSelectAgent }: { agents: Agent[]; runtimes: Record<string, AgentRuntime>; selectedAgentId: string; activeAgentId: string; onSelectAgent: (id: string) => void }) {
  const working = agents.filter((agent) => ['Working', 'Testing', 'Reviewing'].includes(runtimes[agent.id]?.status ?? '')).length;
  return (
    <section className="team-dock">
      <div className="dock-copy"><div className="dock-icon"><UsersRound size={17} /></div><div><h2>Equipe do projeto</h2><p>{working ? `${working} em movimento agora` : 'Nenhuma execução ativa'}</p></div></div>
      <div className="dock-members">{agents.length === 0 ? <span className="dock-empty">A equipe aparece aqui quando você adicionar agentes.</span> : agents.map((agent) => { const isActive = activeAgentId === agent.id; return <button type="button" className={`dock-member ${selectedAgentId === agent.id ? 'is-selected' : ''} ${isActive ? 'is-active' : ''}`} aria-current={isActive ? 'step' : undefined} key={agent.id} onClick={() => onSelectAgent(agent.id)}><Avatar agent={agent} runtime={runtimes[agent.id]} size="medium" /><span><strong>{agent.name}</strong>{isActive && <em>etapa atual</em>}<small>{agent.role}</small></span><StatusBadge status={runtimes[agent.id]?.status ?? 'Idle'} compact /></button>; })}</div>
    </section>
  );
}

function Avatar({ agent, runtime, size = 'medium' }: { agent: Agent; runtime?: AgentRuntime; size?: 'small' | 'medium' | 'large' }) {
  const hue = colorForAgent(agent.id);
  return <span className={`avatar avatar-${size}`} style={{ '--avatar-hue': hue } as React.CSSProperties}><span>{initials(agent)}</span>{runtime && runtime.status !== 'Idle' && <i className={`avatar-presence ${statusMeta[runtime.status].className}`} />}</span>;
}

function colorForAgent(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = id.charCodeAt(index) + ((hash << 5) - hash);
  const palette = ['#4f65c8', '#d77d64', '#45a086', '#9b7ac7', '#d6a84f', '#3f8caf'];
  return palette[Math.abs(hash) % palette.length];
}

function StatusBadge({ status, compact = false }: { status: AgentStatus; compact?: boolean }) {
  const meta = statusMeta[status];
  return <span className={`status-badge ${meta.className} ${compact ? 'is-compact' : ''}`}><span className="status-dot" />{meta.label}</span>;
}

function AgentInspector({ agent, runtime, activeAgentId, busyAction, messageDraft, onMessageChange, onSendMessage, onControlAgent }: { agent?: Agent; runtime?: AgentRuntime; activeAgentId: string; busyAction: string; messageDraft: string; onMessageChange: (value: string) => void; onSendMessage: () => void; onControlAgent: (action: 'stop' | 'restart') => void }) {
  if (!agent) {
    return <aside className="agent-inspector paper-panel inspector-empty"><div className="empty-icon"><Bot size={25} /></div><h2>Escolha um agente</h2><p>Selecione alguém no floor plan ou no Team dock para acompanhar sua atividade.</p></aside>;
  }
  const runtimeStatus = runtime?.status ?? 'Idle';
  const isCurrentAgent = activeAgentId === agent.id;
  const hasActiveProcess = ['Working', 'Testing', 'Reviewing'].includes(runtimeStatus);
  const canStop = isCurrentAgent && hasActiveProcess;
  const canRestart = isCurrentAgent && Boolean(runtime?.task?.trim()) && hasActiveProcess;
  const canSend = isCurrentAgent && hasActiveProcess;
  return (
    <aside className="agent-inspector paper-panel">
      <div className="inspector-header"><div className="inspector-person"><Avatar agent={agent} runtime={runtime} size="large" /><div><h2>{agent.name}</h2><p>{agent.role} · {agent.area}</p></div></div></div>
      <div className="inspector-status-row"><StatusBadge status={runtimeStatus} /><ActivityTime at={activityAt(runtime)} /></div>
      <div className="activity-description"><HeartPulse size={13} /><span>{activityDescription(runtime) || 'Sem descrição de atividade.'}</span></div>
      <div className="inspector-facts"><span><Terminal size={12} /> {agent.cli || 'CLI não definido'}</span><span><Bot size={12} /> {agent.model || 'modelo não definido'}</span></div>
      <div className="inspector-task"><span className="small-label">Tarefa atual</span><p>{runtime?.task || 'Nenhuma tarefa atribuída.'}</p></div>
      <div className="inspector-actions"><button type="button" className="button button-quiet" onClick={() => onControlAgent('restart')} disabled={!canRestart || busyAction === `restart-${agent.id}`}><RefreshCw size={14} className={busyAction === `restart-${agent.id}` ? 'spin' : ''} /> Reiniciar</button><button type="button" className="button button-quiet button-quiet-danger" onClick={() => onControlAgent('stop')} disabled={!canStop || busyAction === `stop-${agent.id}`}><Square size={13} fill="currentColor" /> Parar</button></div>
      <div className="inspector-divider" />
      <OutputEvidence output={runtime?.output || ''} agentName={agent.name} />
      <MessageComposer value={messageDraft} onChange={onMessageChange} onSend={onSendMessage} disabled={!canSend || busyAction === `send-${agent.id}`} placeholder={canSend ? 'Escreva uma instrução…' : 'Disponível durante a execução'} />
      <MessageHistory messages={runtime?.messages ?? []} />
      <AgentResultView result={runtime?.result} />
    </aside>
  );
}

function MessageHistory({ messages }: { messages: AgentRuntime['messages'] }) {
  const recent = messages.slice(-8);
  return <div className="message-history"><div className="small-label"><MessageSquareText size={13} /> Mensagens recentes</div>{recent.length === 0 ? <p className="messages-empty">Nenhuma mensagem nesta tarefa.</p> : <div className="message-list">{recent.map((message, index) => <div className={`message-item message-${message.direction}`} key={`${message.at}-${index}`}><div><strong>{message.direction === 'user' ? 'Você' : 'Agente'}</strong><time>{shortTime(message.at)}</time></div><p>{message.text}</p></div>)}</div>}</div>;
}

function ActivityTime({ at }: { at?: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((current) => current + 1), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="activity-time"><HeartPulse size={13} /> {relativeActivity(at)}</span>;
}

function MessageComposer({ value, onChange, onSend, disabled, placeholder }: { value: string; onChange: (value: string) => void; onSend: () => void; disabled: boolean; placeholder: string }) {
  return <div className="message-composer"><div className="small-label"><MessageCircle size={13} /> Falar com o agente</div><p className="composer-help">Enviado para stdin; o CLI pode não confirmar que leu a mensagem.</p><div className="composer-row"><input value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSend(); } }} placeholder={placeholder} disabled={disabled} /><button type="button" aria-label="Enviar mensagem" onClick={onSend} disabled={disabled || !value.trim()}><Send size={15} /></button></div></div>;
}

function OutputEvidence({ output, agentName }: { output: string; agentName: string }) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const preRef = useRef<HTMLPreElement>(null);
  const normalizedQuery = query.trim();
  const matchCount = normalizedQuery
    ? output.match(new RegExp(escapeRegExp(normalizedQuery), 'gi'))?.length ?? 0
    : 0;
  const isRetainedLimit = output.length >= MAX_RETAINED_OUTPUT_CHARS;

  useEffect(() => {
    if (!autoFollow || !preRef.current) return;
    preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [output, autoFollow, expanded]);

  const copyOutput = async () => {
    if (!output) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(output);
      } else {
        const helper = document.createElement('textarea');
        helper.value = output;
        helper.setAttribute('readonly', '');
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        const copied = document.execCommand('copy');
        helper.remove();
        if (!copied) throw new Error('copy command failed');
      }
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    window.setTimeout(() => setCopyState('idle'), 1800);
  };

  const downloadOutput = () => {
    const blob = new Blob([output], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `agent-office-${agentName || 'agent'}-output.txt`.replace(/[^\w.-]+/g, '-');
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return <div className="output-block">
    <div className="output-heading"><span className="small-label"><Terminal size={13} /> Última saída</span><span>{output ? `${output.length.toLocaleString('pt-BR')} caracteres` : 'vazia'}</span></div>
    <div className="output-toolbar">
      <label className="output-search"><Search size={13} /><span className="sr-only">Buscar na saída do agente</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar no log" /></label>
      <div className="output-actions">
        <button type="button" className="output-action" onClick={() => void copyOutput()} disabled={!output} title="Copiar a saída"><Copy size={13} /><span>{copyState === 'copied' ? 'Copiado' : copyState === 'failed' ? 'Falhou' : 'Copiar'}</span></button>
        <button type="button" className="output-action" onClick={downloadOutput} disabled={!output} title="Baixar a saída"><ArrowDownToLine size={13} /><span>Baixar</span></button>
        <button type="button" className={`output-action ${autoFollow ? 'is-pressed' : ''}`} aria-pressed={autoFollow} onClick={() => setAutoFollow((current) => !current)} title="Acompanhar o final da saída"><ArrowDownToLine size={13} /><span>{autoFollow ? 'Acompanhando' : 'Acompanhar'}</span></button>
        <button type="button" className="output-action" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded} title={expanded ? 'Recolher saída' : 'Expandir saída'}><ArrowUpRight size={13} /><span>{expanded ? 'Recolher' : 'Expandir'}</span></button>
      </div>
    </div>
    <p className="output-meta" aria-live="polite">{normalizedQuery ? `${matchCount} ${matchCount === 1 ? 'ocorrência' : 'ocorrências'} encontrada${matchCount === 1 ? '' : 's'}.` : 'A busca considera a saída retida neste run.'}{isRetainedLimit && <> Limite de retenção: os últimos {MAX_RETAINED_OUTPUT_CHARS.toLocaleString('pt-BR')} caracteres; o início pode ter sido truncado pelo servidor.</>}</p>
    <pre ref={preRef} className={expanded ? 'is-expanded' : ''} tabIndex={0} onScroll={(event) => { const element = event.currentTarget; const nearEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 24; if (!nearEnd && autoFollow) setAutoFollow(false); }}>{output ? outputWithHighlights(output, normalizedQuery) : 'A saída do agente aparecerá aqui quando ele trabalhar.'}</pre>
  </div>;
}

function AgentResultView({ result }: { result?: AgentResult }) {
  if (!result) return null;
  return <div className="result-view">
    <div className="small-label">Resultado final declarado pelo agente</div>
    <div className={`result-status result-${result.status.toLowerCase()}`}><span>{result.status}</span><strong>{result.summary || 'Sem resumo.'}</strong></div>
    <p className="result-explanation">{resultExplanation(result.status)}</p>
    <div className="result-list"><span><FileCode2 size={13} /> Arquivos declarados pelo agente</span>{result.changed_files.length > 0 ? result.changed_files.map((file) => <code key={file}>{file}</code>) : <span className="result-empty-line">Nenhum arquivo declarado.</span>}<small>Declarações do agente; o aplicativo não verificou autoria nem alterações no git.</small></div>
    <div className="result-list result-issues"><span><AlertCircle size={13} /> Problemas declarados</span>{result.issues.length > 0 ? result.issues.map((issue, index) => <span key={`${issue}-${index}`}>{issue}</span>) : <span className="result-empty-line">Nenhum problema declarado.</span>}</div>
    <div className="result-list result-notes"><span><FileText size={13} /> Verificações e notas declaradas pelo agente</span>{result.notes.length > 0 ? result.notes.map((note, index) => <span key={`${note}-${index}`}>{note}</span>) : <span className="result-empty-line">Nenhuma verificação ou nota declarada.</span>}<small>O aplicativo exibe as declarações recebidas; elas não equivalem a verificações executadas pelo aplicativo.</small></div>
  </div>;
}

function Timeline({ events, agents, hasMore, onLoadMore }: { events: TimelineEvent[]; agents: Agent[]; hasMore: boolean; onLoadMore: () => void }) {
  if (events.length === 0) return <div className="timeline-empty"><Clock3 size={18} /><span>A linha do tempo começa quando uma execução ou mensagem acontecer.</span></div>;
  return <><div className="timeline-list">{events.slice().reverse().map((event) => { const agent = agents.find((item) => item.id === event.agentId); return <div className="timeline-event" key={event.id}><div className="timeline-marker" /> <div className="timeline-event-body"><div><strong>{agent?.name || 'Sistema do escritório'}</strong><span className="timeline-kind">{event.kind}</span></div><p>{event.text}</p></div><time>{shortTime(event.at)}</time></div>; })}</div>{hasMore && <button type="button" className="button button-quiet timeline-load-more" onClick={onLoadMore}><ArrowDownToLine size={14} /> Carregar eventos anteriores</button>}</>;
}

function PageHeader({ eyebrow, title, description, icon: Icon, action }: { eyebrow: string; title: string; description: string; icon: typeof Settings2; action?: React.ReactNode }) {
  return <div className="page-header"><div className="page-header-icon"><Icon size={21} /></div><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{action && <div className="page-header-action">{action}</div>}</div>;
}

function ProjectsScreen({ config, selectedId, onSelect, onChange, onAdd, onRemove }: { config: Config; selectedId: string; onSelect: (id: string) => void; onChange: (updater: (config: Config) => Config) => void; onAdd: () => void; onRemove: (id: string) => void }) {
  const selected = config.projects.find((project) => project.id === selectedId) ?? config.projects[0];
  return <div className="settings-page"><PageHeader eyebrow="projetos" title="Projetos" description="Defina onde o trabalho acontece e qual equipe o conduz." icon={FolderKanban} action={<button type="button" className="button button-primary" onClick={onAdd}><Plus size={15} /> Novo projeto</button>} /><div className="settings-split"><div className="resource-list">{config.projects.length === 0 ? <EmptyResource icon={FolderKanban} text="Nenhum projeto ainda." /> : config.projects.map((project) => <button type="button" className={`resource-row ${selected?.id === project.id ? 'is-selected' : ''}`} key={project.id} onClick={() => onSelect(project.id)}><span className="resource-glyph"><FolderKanban size={16} /></span><span><strong>{project.name || 'Projeto sem nome'}</strong><small>{project.cwd || 'sem diretório'}</small></span><ChevronDown size={15} className="resource-chevron" /></button>)}</div>{selected ? <ProjectEditor project={selected} config={config} onChange={onChange} onRemove={() => onRemove(selected.id)} /> : <EditorEmpty title="Selecione um projeto" detail="Crie um projeto para configurar a equipe e o diretório." />}</div></div>;
}

function ProjectEditor({ project, config, onChange, onRemove }: { project: Project; config: Config; onChange: (updater: (config: Config) => Config) => void; onRemove: () => void }) {
  const update = (patch: Partial<Project>) => onChange((draft) => ({ ...draft, projects: draft.projects.map((item) => item.id === project.id ? { ...item, ...patch } : item) }));
  return <div className="editor-panel paper-panel"><div className="editor-title"><div><p className="eyebrow">configuração do projeto</p><h2>{project.name || 'Projeto sem nome'}</h2></div><button type="button" className="icon-button icon-danger" title="Remover projeto" onClick={onRemove}><Trash2 size={17} /></button></div><div className="form-stack"><label className="field-label">Nome<input value={project.name} onChange={(event) => update({ name: event.target.value })} /></label><label className="field-label">Diretório de trabalho<input value={project.cwd} onChange={(event) => update({ cwd: event.target.value })} placeholder="/home/voce/projeto" /></label><label className="field-label">Workflow padrão<select value={project.workflowId} onChange={(event) => update({ workflowId: event.target.value })}><option value="">Nenhum workflow</option>{config.workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select></label><label className="field-label">Regras do projeto<textarea value={project.rules} onChange={(event) => update({ rules: event.target.value })} rows={5} placeholder="Contexto, limites ou comandos que todos devem seguir…" /></label><div className="field-label">Equipe do projeto<div className="check-grid">{config.agents.length === 0 ? <span className="field-help">Adicione agentes em Equipe.</span> : config.agents.map((agent) => <label className="check-option" key={agent.id}><input type="checkbox" checked={project.agentIds.includes(agent.id)} onChange={(event) => update({ agentIds: event.target.checked ? [...project.agentIds, agent.id] : project.agentIds.filter((id) => id !== agent.id) })} /><span><span className="check-avatar" style={{ background: colorForAgent(agent.id) }}>{initials(agent)}</span>{agent.name}</span></label>)}</div></div></div></div>;
}

function TeamScreen({ config, snapshot, selectedId, argsModes, argsErrors, onSelect, onChange, onArgsMode, onArgsError, onAddBlank, onClone, onRemove }: { config: Config; snapshot: Snapshot; selectedId: string; argsModes: Record<string, ArgsMode>; argsErrors: Record<string, string>; onSelect: (id: string) => void; onChange: (updater: (config: Config) => Config) => void; onArgsMode: (id: string, mode: ArgsMode) => void; onArgsError: (id: string, message: string) => void; onAddBlank: () => void; onClone: (agent: Agent) => void; onRemove: (id: string) => void }) {
  const selected = config.agents.find((agent) => agent.id === selectedId) ?? config.agents[0];
  return <div className="settings-page"><PageHeader eyebrow="equipe" title="Equipe" description="Ajuste os agentes, suas salas e a ferramenta que executa cada tarefa." icon={UsersRound} action={<div className="button-group"><button type="button" className="button button-quiet" onClick={onAddBlank}><Plus size={15} /> Agente em branco</button><details className="clone-menu"><summary><Copy size={14} /> Clonar padrão <ChevronDown size={14} /></summary><div className="clone-options">{defaultAgentTemplates.map((template) => <button key={template.id} type="button" className="clone-option" onClick={() => onClone(template)}>{template.name}<small>{template.role}</small></button>)}</div></details></div>} /><div className="settings-split team-split"><div className="resource-list team-list">{config.agents.length === 0 ? <EmptyResource icon={UsersRound} text="Nenhum agente ainda." /> : config.agents.map((agent) => <button type="button" className={`resource-row team-resource-row ${selected?.id === agent.id ? 'is-selected' : ''}`} key={agent.id} onClick={() => onSelect(agent.id)}><Avatar agent={agent} runtime={snapshot.agents[agent.id]} size="small" /><span><strong>{agent.name || 'Agente sem nome'}</strong><small>{agent.role} · {agent.area}</small></span><StatusBadge status={snapshot.agents[agent.id]?.status ?? 'Idle'} compact /></button>)}</div>{selected ? <AgentEditor agent={selected} onChange={onChange} mode={argsModes[selected.id] ?? 'lines'} argsError={argsErrors[selected.id]} onMode={(mode) => { onArgsMode(selected.id, mode); onArgsError(selected.id, ''); }} onArgsError={(message) => onArgsError(selected.id, message)} onRemove={() => onRemove(selected.id)} /> : <EditorEmpty title="Monte sua equipe" detail="Adicione um agente em branco ou clone um padrão para começar." />}</div></div>;
}

function AgentEditor({ agent, onChange, mode, argsError, onMode, onArgsError, onRemove }: { agent: Agent; onChange: (updater: (config: Config) => Config) => void; mode: ArgsMode; argsError?: string; onMode: (mode: ArgsMode) => void; onArgsError: (message: string) => void; onRemove: () => void }) {
  const update = (patch: Partial<Agent>) => onChange((draft) => ({ ...draft, agents: draft.agents.map((item) => item.id === agent.id ? { ...item, ...patch } : item) }));
  const argsText = (args: string[]) => mode === 'json' ? JSON.stringify(args, null, 2) : args.join('\n');
  const [rawArgs, setRawArgs] = useState(() => argsText(agent.args));
  useEffect(() => { setRawArgs(argsText(agent.args)); }, [agent.id, mode]);
  const onArgsChange = (value: string) => {
    setRawArgs(value);
    const parsed = parseArgsValue(value, mode);
    if (!parsed) {
      onArgsError(mode === 'json' ? 'Use um array JSON de strings, por exemplo ["--flag"].' : 'Cada linha deve conter um argumento.');
      return;
    }
    onArgsError('');
    update({ args: parsed });
  };
  return <div className="editor-panel paper-panel"><div className="editor-title"><div className="editor-person-title"><Avatar agent={agent} size="medium" /><div><p className="eyebrow">perfil do agente</p><h2>{agent.name || 'Agente sem nome'}</h2></div></div><button type="button" className="icon-button icon-danger" title="Remover agente" onClick={onRemove}><Trash2 size={17} /></button></div><div className="form-stack"><div className="form-two-col"><label className="field-label">Nome<input value={agent.name} onChange={(event) => update({ name: event.target.value })} /></label><label className="field-label">Função<input value={agent.role} onChange={(event) => update({ role: event.target.value })} /></label></div><div className="form-two-col"><label className="field-label">Sala<select value={agent.area} onChange={(event) => update({ area: event.target.value as Area })}>{AREAS.map((area) => <option key={area} value={area}>{area}</option>)}</select></label><label className="field-label">Avatar<input value={agent.avatar} onChange={(event) => update({ avatar: event.target.value })} maxLength={4} placeholder="AB" /></label></div><div className="form-two-col"><label className="field-label">CLI<input value={agent.cli} onChange={(event) => update({ cli: event.target.value })} /></label><label className="field-label">Modelo<input value={agent.model} onChange={(event) => update({ model: event.target.value })} /></label></div><label className="field-label">Diretório padrão<input value={agent.cwd} onChange={(event) => update({ cwd: event.target.value })} /></label><label className="field-label">Instruções<textarea value={agent.instructions} onChange={(event) => update({ instructions: event.target.value })} rows={6} placeholder="Como este agente deve trabalhar…" /></label><details className="advanced-details"><summary>Avançado <ChevronDown size={14} /></summary><div className="advanced-content"><label className="field-label">Timeout (ms)<input type="number" min={1000} value={agent.timeoutMs} onChange={(event) => update({ timeoutMs: Number(event.target.value) || 1000 })} /></label><div className="field-label args-field"><div className="field-label-row"><span>Argumentos</span><div className="segmented-control"><button type="button" className={mode === 'lines' ? 'is-active' : ''} onClick={() => onMode('lines')}><FileText size={13} /> Linhas</button><button type="button" className={mode === 'json' ? 'is-active' : ''} onClick={() => onMode('json')}><Braces size={13} /> JSON</button></div></div><textarea value={rawArgs} onChange={(event) => onArgsChange(event.target.value)} rows={4} className={argsError ? 'has-error' : ''} />{argsError && <span className="field-error">{argsError}</span>}</div></div></details></div></div>;
}

function WorkflowScreen({ config, selectedId, onSelect, onChange, onAdd, onRemove }: { config: Config; selectedId: string; onSelect: (id: string) => void; onChange: (updater: (config: Config) => Config) => void; onAdd: () => void; onRemove: (id: string) => void }) {
  const selected = config.workflows.find((workflow) => workflow.id === selectedId) ?? config.workflows[0];
  return <div className="settings-page"><PageHeader eyebrow="workflow" title="Workflows" description="Desenhe a sequência de trabalho e as transições que movem a tarefa." icon={GitBranch} action={<button type="button" className="button button-primary" onClick={onAdd}><Plus size={15} /> Novo workflow</button>} /><div className="settings-split workflow-split"><div className="resource-list">{config.workflows.length === 0 ? <EmptyResource icon={GitBranch} text="Nenhum workflow ainda." /> : config.workflows.map((workflow) => <button type="button" className={`resource-row ${selected?.id === workflow.id ? 'is-selected' : ''}`} key={workflow.id} onClick={() => onSelect(workflow.id)}><span className="resource-glyph workflow-glyph"><GitBranch size={16} /></span><span><strong>{workflow.name || 'Workflow sem nome'}</strong><small>{workflow.steps.length} {workflow.steps.length === 1 ? 'passo' : 'passos'} · máx. {workflow.maxSteps}</small></span><ChevronDown size={15} className="resource-chevron" /></button>)}</div>{selected ? <WorkflowEditor workflow={selected} config={config} onChange={onChange} onRemove={() => onRemove(selected.id)} /> : <EditorEmpty title="Desenhe o fluxo" detail="Crie um workflow para conectar o trabalho dos agentes." />}</div></div>;
}

function WorkflowEditor({ workflow, config, onChange, onRemove }: { workflow: Workflow; config: Config; onChange: (updater: (config: Config) => Config) => void; onRemove: () => void }) {
  const [removalImpact, setRemovalImpact] = useState('');
  const updateWorkflow = (patch: Partial<Workflow>) => onChange((draft) => ({ ...draft, workflows: draft.workflows.map((item) => item.id === workflow.id ? { ...item, ...patch } : item) }));
  const updateStep = (stepId: string, patch: Partial<Step>) => updateWorkflow({ steps: workflow.steps.map((step) => step.id === stepId ? { ...step, ...patch } : step) });
  const removeStep = (stepId: string) => {
    if (workflow.steps.length <= 1) return;
    const remainingIds = new Set(workflow.steps.filter((step) => step.id !== stepId).map((step) => step.id));
    const steps = workflow.steps
      .filter((step) => step.id !== stepId)
      .map((step) => ({ ...step, transitions: Object.fromEntries(Object.entries(step.transitions).filter(([, target]) => target === 'done' || target === 'error' || remainingIds.has(target))) as Step['transitions'] }));
    updateWorkflow({ steps, start: workflow.start === stepId ? steps[0]?.id ?? '' : workflow.start });
  };
  const addStep = () => { const next = defaultStep(config.agents[0]?.id ?? ''); updateWorkflow({ steps: [...workflow.steps, next] }); };
  const removeStepWithImpact = (stepId: string) => {
    const target = workflow.steps.find((step) => step.id === stepId);
    if (!target || workflow.steps.length <= 1) return;
    const incoming = workflow.steps.flatMap((step, index) => RESULT_STATUSES.filter((status) => step.transitions[status] === stepId).map((status) => `${stepDisplayName(step, index, config)} · ${status}`));
    const startChanged = workflow.start === stepId;
    removeStep(stepId);
    setRemovalImpact(`${incoming.length > 0 ? `Ligações afetadas: ${incoming.join(', ')}. ` : 'Nenhuma outra etapa apontava diretamente para ela. '}${startChanged ? 'A primeira etapa restante assumiu o início.' : 'As demais etapas permanecem na mesma ordem.'}`);
  };
  const reachable = new Set<string>();
  const stepById = new Map(workflow.steps.map((step) => [step.id, step]));
  const queue = workflow.start && stepById.has(workflow.start) ? [workflow.start] : [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const step = stepById.get(id);
    if (!step) continue;
    for (const target of Object.values(step.transitions)) {
      if (target && stepById.has(target) && !reachable.has(target)) queue.push(target);
    }
  }
  const unreachableSteps = workflow.steps.filter((step) => !reachable.has(step.id));
  const missingOutputs = workflow.steps.flatMap((step, index) => RESULT_STATUSES.filter((status) => !step.transitions[status]).map((status) => `${stepDisplayName(step, index, config)} · ${status}`));
  const teamMismatches = config.projects
    .filter((project) => project.workflowId === workflow.id)
    .flatMap((project) => workflow.steps.flatMap((step, index) => !project.agentIds.includes(step.agentId) ? `${stepDisplayName(step, index, config)} · ${project.name || 'projeto sem nome'}` : []));
  return <div className="editor-panel paper-panel workflow-editor"><div className="editor-title"><div><p className="eyebrow">mapa do workflow</p><h2>{workflow.name || 'Workflow sem nome'}</h2></div><button type="button" className="icon-button icon-danger" title="Remover workflow" onClick={onRemove}><Trash2 size={17} /></button></div><div className="form-stack"><div className="form-two-col"><label className="field-label">Nome<input value={workflow.name} onChange={(event) => updateWorkflow({ name: event.target.value })} /></label><label className="field-label">Máximo de passos<input type="number" min={1} value={workflow.maxSteps} onChange={(event) => updateWorkflow({ maxSteps: Number(event.target.value) || 1 })} /></label></div><label className="field-label">Começa em<select value={workflow.start} onChange={(event) => updateWorkflow({ start: event.target.value })}>{workflow.steps.map((step, index) => <option key={step.id} value={step.id}>Etapa {index + 1} · {stepDisplayName(step, index, config)}</option>)}</select></label><WorkflowSummary workflow={workflow} config={config} /><div className="workflow-status-help"><strong>Como ler as saídas:</strong> <span>PASS passou · FAIL pede correção · DONE concluiu sem PASS/FAIL · ERROR encerrou com erro.</span><small>Ciclos de correção são permitidos e permanecem limitados pelo máximo de etapas.</small></div><WorkflowDiagnostics workflow={workflow} config={config} unreachableSteps={unreachableSteps} missingOutputs={missingOutputs} teamMismatches={teamMismatches} /><div className="steps-heading"><div><h3>Etapas do workflow</h3><p>Os nomes abaixo são derivados da primeira frase da instrução; o contrato compartilhado continua sem um campo de nome.</p></div><button type="button" className="button button-quiet" onClick={addStep}><Plus size={14} /> Adicionar passo</button></div>{removalImpact && <div className="workflow-removal-impact" role="status"><div><strong>Etapa removida; impacto registrado.</strong><p>{removalImpact} Revise o resumo das ligações antes de salvar.</p></div><div className="workflow-removal-actions"><button type="button" className="button button-text" onClick={() => setRemovalImpact('')}>Fechar aviso</button></div></div>}<div className="steps-list">{workflow.steps.length === 0 ? <div className="steps-empty"><GitBranch size={18} /> Adicione a primeira etapa.</div> : workflow.steps.map((step, index) => <WorkflowStepCard key={step.id} step={step} index={index} steps={workflow.steps} config={config} start={workflow.start === step.id} onChange={(patch) => updateStep(step.id, patch)} onRemove={() => removeStepWithImpact(step.id)} />)}</div></div></div>;
}

function WorkflowSummary({ workflow, config }: { workflow: Workflow; config: Config }) {
  const targetLabel = (target: string | undefined) => {
    if (target === 'done') return 'concluir';
    if (target === 'error') return 'erro';
    const index = workflow.steps.findIndex((step) => step.id === target);
    return index >= 0 ? stepDisplayName(workflow.steps[index], index, config) : 'sem destino';
  };
  return <section className="workflow-summary" aria-labelledby="workflow-summary-title"><div className="workflow-summary-heading"><div><span className="small-label" id="workflow-summary-title"><GitBranch size={13} /> Resumo das ligações</span><p>O caminho parte da etapa inicial e segue pelo resultado declarado.</p></div><span>{workflow.steps.length} {workflow.steps.length === 1 ? 'etapa' : 'etapas'}</span></div><div className="workflow-summary-list">{workflow.steps.map((step, index) => <div className={`workflow-summary-row ${workflow.start === step.id ? 'is-start' : ''}`} key={step.id}><div className="workflow-summary-node"><span>{index + 1}</span><strong>{stepDisplayName(step, index, config)}</strong>{workflow.start === step.id && <em>início</em>}</div><div className="workflow-summary-edges">{RESULT_STATUSES.map((status) => <span className={`workflow-summary-edge ${step.transitions[status] ? '' : 'is-missing'}`} key={status}><b>{status}</b><ArrowUpRight size={12} />{targetLabel(step.transitions[status])}</span>)}</div></div>)}</div></section>;
}

function WorkflowDiagnostics({ workflow, config, unreachableSteps, missingOutputs, teamMismatches }: { workflow: Workflow; config: Config; unreachableSteps: Step[]; missingOutputs: string[]; teamMismatches: string[] }) {
  const missingAgents = workflow.steps.filter((step) => step.agentId && !config.agents.some((agent) => agent.id === step.agentId));
  const hasProblems = unreachableSteps.length > 0 || missingOutputs.length > 0 || teamMismatches.length > 0 || missingAgents.length > 0 || !workflow.start;
  return <section className={`workflow-diagnostics ${hasProblems ? 'has-problems' : 'is-clear'}`} aria-live="polite"><div className="workflow-diagnostics-heading"><span className="small-label"><HeartPulse size={13} /> Diagnóstico do rascunho</span><strong>{hasProblems ? 'revisar antes de executar' : 'estrutura legível'}</strong></div>{!hasProblems ? <p>Nenhuma etapa inalcançável, equipe incompatível ou saída sem destino foi encontrada neste rascunho.</p> : <div className="workflow-diagnostics-list">{!workflow.start && <p><strong>Início ausente:</strong> escolha a etapa inicial.</p>}{unreachableSteps.length > 0 && <p><strong>Etapas inalcançáveis:</strong> {unreachableSteps.map((step, index) => stepDisplayName(step, workflow.steps.indexOf(step), config)).join(', ')}.</p>}{teamMismatches.length > 0 && <p><strong>Fora da equipe:</strong> {teamMismatches.join(', ')}.</p>}{missingAgents.length > 0 && <p><strong>Agente inexistente:</strong> {missingAgents.map((step) => stepDisplayName(step, workflow.steps.indexOf(step), config)).join(', ')}.</p>}{missingOutputs.length > 0 && <p><strong>Saídas sem destino:</strong> {missingOutputs.join(', ')}.</p>}</div>}</section>;
}

function WorkflowStepCard({ step, index, steps, config, start, onChange, onRemove }: { step: Step; index: number; steps: Step[]; config: Config; start: boolean; onChange: (patch: Partial<Step>) => void; onRemove: () => void }) {
  const transitions = RESULT_STATUSES.map((result) => [result, step.transitions[result] ?? ''] as const);
  const label = stepDisplayName(step, index, config);
  return <article className={`workflow-step-card ${start ? 'is-start' : ''}`}><div className="step-card-top"><div className="step-number">{index + 1}</div><div><span className="step-kicker">{start ? 'Ponto de partida' : `Etapa ${index + 1}`}</span><h3>{label}</h3></div><button type="button" className="icon-button" title={steps.length <= 1 ? 'Um workflow precisa de pelo menos uma etapa' : 'Remover passo'} aria-label={steps.length <= 1 ? 'Um workflow precisa de pelo menos uma etapa' : `Remover etapa ${index + 1}`} onClick={onRemove} disabled={steps.length <= 1}><Trash2 size={15} /></button></div><label className="field-label">Agente<select value={step.agentId} onChange={(event) => onChange({ agentId: event.target.value })}><option value="">Escolha um agente</option>{config.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.role}</option>)}</select></label><label className="field-label">Instrução<textarea value={step.instruction} onChange={(event) => onChange({ instruction: event.target.value })} rows={3} placeholder="O que este agente deve fazer?" /></label><div className="transition-grid"><span className="transition-label"><GitBranch size={13} /> Saídas</span>{transitions.map(([result, target]) => <label key={result} className="transition-field"><span className={`transition-chip transition-${result.toLowerCase()}`}>{result}</span><TransitionTargetSelect value={target} steps={steps} config={config} onChange={(next) => onChange({ transitions: { ...step.transitions, [result]: next || undefined } })} /></label>)}</div></article>;
}

function TransitionTargetSelect({ value, steps, config, onChange }: { value: string; steps: Step[]; config: Config; onChange: (value: string) => void }) {
  return <select className="transition-select" value={value} onChange={(event) => onChange(event.target.value)}><option value="">Sem destino</option><option value="done">Concluir workflow</option><option value="error">Encerrar com erro</option>{steps.map((step, index) => <option key={step.id} value={step.id}>Etapa {index + 1} · {stepDisplayName(step, index, config)}</option>)}</select>;
}

function EmptyResource({ icon: Icon, text }: { icon: typeof UsersRound; text: string }) {
  return <div className="resource-empty"><Icon size={19} /><span>{text}</span></div>;
}

function EditorEmpty({ title, detail }: { title: string; detail: string }) {
  return <div className="editor-empty paper-panel"><div className="empty-icon"><Pencil size={21} /></div><h2>{title}</h2><p>{detail}</p></div>;
}

export default App;
