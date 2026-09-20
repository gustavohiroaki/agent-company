import {
  Maximize2,
  Minus,
  MousePointer2,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Config, ResultStatus, Step, Workflow } from '../shared/types';
import './workflow-canvas.css';

type WorkflowPosition = { x: number; y: number };
type PositionedStep = Step & { position?: WorkflowPosition };

export interface WorkflowCanvasProps {
  workflow: Workflow;
  config: Config;
  selectedStepId?: string;
  onSelectStep: (stepId: string) => void;
  onChangeSteps: (steps: Step[]) => void;
  onAddStep?: () => void;
  canAddStep?: boolean;
  disabled?: boolean;
}

const RESULT_STATUSES: ResultStatus[] = ['PASS', 'FAIL', 'DONE', 'ERROR'];
const CANVAS_WIDTH = 1120;
const CANVAS_HEIGHT = 650;
const NODE_WIDTH = 226;
const NODE_HEIGHT = 174;
const TERMINAL_WIDTH = 142;
const TERMINAL_HEIGHT = 66;
const MIN_ZOOM = 0.55;
const MAX_ZOOM = 1.35;
const MAX_COORDINATE = 100000;

const statusMeta: Record<ResultStatus, { className: string; label: string }> = {
  PASS: { className: 'workflow-edge-pass', label: 'PASS' },
  FAIL: { className: 'workflow-edge-fail', label: 'FAIL' },
  DONE: { className: 'workflow-edge-done', label: 'DONE' },
  ERROR: { className: 'workflow-edge-error', label: 'ERROR' },
};

function terminalLayout(width: number): Record<'done' | 'error', WorkflowPosition> {
  return {
    done: { x: width - TERMINAL_WIDTH - 35, y: 148 },
    error: { x: width - TERMINAL_WIDTH - 35, y: 360 },
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function fallbackPosition(index: number): WorkflowPosition {
  const column = index % 3;
  const row = Math.floor(index / 3);
  return {
    x: 48 + column * 282,
    y: 52 + row * 205,
  };
}

function stepPosition(step: PositionedStep, index: number): WorkflowPosition {
  const fallback = fallbackPosition(index);
  const raw = step.position;
  const x = finite(raw?.x) ? raw.x : fallback.x;
  const y = finite(raw?.y) ? raw.y : fallback.y;
  return {
    x: clamp(x, 0, MAX_COORDINATE),
    y: clamp(y, 0, MAX_COORDINATE),
  };
}

function agentFor(config: Config, step: Step): Agent | undefined {
  return config.agents.find((agent) => agent.id === step.agentId);
}

function initials(agent?: Agent): string {
  if (!agent) return '?';
  const letters = (agent.avatar?.trim() || agent.name).replace(/[^\p{L}\p{N}]/gu, '');
  return (letters.length <= 3 ? letters : letters.slice(0, 2)).toUpperCase() || '?';
}

function stepLabel(step: Step, config: Config, index: number): string {
  const instruction = step.instruction.trim().replace(/\s+/g, ' ');
  if (instruction) return instruction.length > 46 ? `${instruction.slice(0, 43)}…` : instruction;
  return agentFor(config, step)?.name || `Etapa ${index + 1}`;
}

function sourceAnchor(position: WorkflowPosition, status: ResultStatus): WorkflowPosition {
  return {
    x: position.x + NODE_WIDTH,
    y: position.y + 95 + RESULT_STATUSES.indexOf(status) * 18,
  };
}

function inputAnchor(position: WorkflowPosition): WorkflowPosition {
  return { x: position.x, y: position.y + 87 };
}

function terminalInputAnchor(target: 'done' | 'error', terminals: Record<'done' | 'error', WorkflowPosition>): WorkflowPosition {
  const position = terminals[target];
  return { x: position.x + 14, y: position.y + TERMINAL_HEIGHT / 2 };
}

function connectorPath(source: WorkflowPosition, target: WorkflowPosition, selfLoop = false): string {
  if (selfLoop) {
    const loopY = Math.max(18, Math.min(source.y, target.y) - 64);
    const loopX = Math.max(source.x, target.x) + 72;
    return `M ${source.x} ${source.y} C ${loopX} ${source.y}, ${loopX} ${loopY}, ${source.x} ${loopY} C ${source.x - 72} ${loopY}, ${target.x - 72} ${loopY}, ${target.x} ${target.y}`;
  }
  const distance = Math.max(54, Math.abs(target.x - source.x) * 0.42);
  const direction = target.x >= source.x ? 1 : -1;
  const first = source.x + distance * direction;
  const second = target.x - distance * direction;
  return `M ${source.x} ${source.y} C ${first} ${source.y}, ${second} ${target.y}, ${target.x} ${target.y}`;
}

function edgeLabelPoint(source: WorkflowPosition, target: WorkflowPosition, sourceNode: WorkflowPosition, targetNode?: WorkflowPosition): WorkflowPosition {
  const point = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
  const overlapsNode = (node?: WorkflowPosition) => Boolean(node && point.x >= node.x - 40 && point.x <= node.x + NODE_WIDTH + 40 && point.y >= node.y - 18 && point.y <= node.y + NODE_HEIGHT + 18);
  if (!overlapsNode(sourceNode) && !overlapsNode(targetNode)) return point;
  const upper = Math.min(sourceNode.y, targetNode?.y ?? sourceNode.y) - 28;
  const lower = Math.max(sourceNode.y, targetNode?.y ?? sourceNode.y) + NODE_HEIGHT + 28;
  return { x: point.x, y: upper >= 22 ? upper : lower };
}

function getEventPoint(event: { clientX: number; clientY: number }, viewport: HTMLElement | null, world: HTMLElement | null, zoom: number): WorkflowPosition {
  const rect = world?.getBoundingClientRect() ?? viewport?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return {
    x: (event.clientX - rect.left) / zoom,
    y: (event.clientY - rect.top) / zoom,
  };
}

function validTargetAt(point: WorkflowPosition, steps: PositionedStep[], positions: Map<string, WorkflowPosition>, terminalPositionsMap: Record<'done' | 'error', WorkflowPosition>): string | 'done' | 'error' | undefined {
  const terminalTarget = (Object.keys(terminalPositionsMap) as Array<'done' | 'error'>).find((target) => {
    const terminal = terminalPositionsMap[target];
    return point.x >= terminal.x - 18 && point.x <= terminal.x + TERMINAL_WIDTH + 18 && point.y >= terminal.y - 18 && point.y <= terminal.y + TERMINAL_HEIGHT + 18;
  });
  if (terminalTarget) return terminalTarget;
  const step = steps.find((candidate) => {
    const position = positions.get(candidate.id);
    return Boolean(position && point.x >= position.x - 18 && point.x <= position.x + NODE_WIDTH + 18 && point.y >= position.y - 18 && point.y <= position.y + NODE_HEIGHT + 18);
  });
  return step?.id;
}

type NodeGesture = {
  kind: 'node';
  stepId: string;
  pointerId: number;
  offsetX: number;
  offsetY: number;
  startPoint: WorkflowPosition;
  moved: boolean;
};

type ConnectionGesture = {
  kind: 'connection';
  stepId: string;
  status: ResultStatus;
  pointerId: number;
  point: WorkflowPosition;
  moved: boolean;
};

type Gesture = NodeGesture | ConnectionGesture;
type PendingConnection = { stepId: string; status: ResultStatus };
type SelectedEdge = { stepId: string; status: ResultStatus };

function WorkflowCanvas({ workflow, config, selectedStepId, onSelectStep, onChangeSteps, onAddStep, canAddStep = true, disabled = false }: WorkflowCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const pendingRef = useRef<PendingConnection | null>(null);
  const [zoom, setZoom] = useState(0.9);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [previewPositions, setPreviewPositions] = useState<Record<string, WorkflowPosition>>({});
  const [pendingConnection, setPendingConnection] = useState<PendingConnection | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<SelectedEdge | null>(null);
  const didFitInitial = useRef(false);
  const [hoveredTarget, setHoveredTarget] = useState<string | 'done' | 'error' | null>(null);

  const positionedSteps = useMemo(() => workflow.steps as PositionedStep[], [workflow.steps]);
  const positions = useMemo(() => {
    const map = new Map<string, WorkflowPosition>();
    positionedSteps.forEach((step, index) => {
      map.set(step.id, previewPositions[step.id] ?? stepPosition(step, index));
    });
    return map;
  }, [positionedSteps, previewPositions]);
  const canvasSize = useMemo(() => {
    let width = CANVAS_WIDTH;
    let height = CANVAS_HEIGHT;
    positions.forEach((position) => {
      width = Math.max(width, position.x + NODE_WIDTH + TERMINAL_WIDTH + 100);
      height = Math.max(height, position.y + NODE_HEIGHT + 42);
    });
    return { width, height };
  }, [positions]);
  const terminalPositions = useMemo(() => terminalLayout(canvasSize.width), [canvasSize.width]);

  const updateSteps = useCallback((stepId: string, patch: Partial<PositionedStep>) => {
    onChangeSteps(workflow.steps.map((step) => step.id === stepId ? ({ ...step, ...patch } as Step) : step));
  }, [onChangeSteps, workflow.steps]);

  const commitPosition = useCallback((stepId: string, position: WorkflowPosition) => {
    if (disabled) return;
    const next = {
      x: Math.round(clamp(position.x, 0, MAX_COORDINATE)),
      y: Math.round(clamp(position.y, 0, MAX_COORDINATE)),
    };
    updateSteps(stepId, { position: next });
    setPreviewPositions((current) => {
      const { [stepId]: _removed, ...rest } = current;
      return rest;
    });
  }, [disabled, updateSteps]);

  const connect = useCallback((sourceId: string, status: ResultStatus, target: string | 'done' | 'error') => {
    if (disabled) return;
    onChangeSteps(workflow.steps.map((step) => step.id === sourceId ? ({ ...step, transitions: { ...step.transitions, [status]: target } } as Step) : step));
    pendingRef.current = null;
    setPendingConnection(null);
    setHoveredTarget(null);
  }, [disabled, onChangeSteps, workflow.steps]);

  const removeEdge = useCallback((edge: SelectedEdge) => {
    if (disabled) return;
    onChangeSteps(workflow.steps.map((step) => step.id === edge.stepId ? ({ ...step, transitions: { ...step.transitions, [edge.status]: undefined } } as Step) : step));
    setSelectedEdge(null);
  }, [disabled, onChangeSteps, workflow.steps]);

  const removeSelectedEdge = useCallback(() => {
    if (!selectedEdge) return;
    removeEdge(selectedEdge);
  }, [removeEdge, selectedEdge]);

  const cancelGesture = useCallback(() => {
    gestureRef.current = null;
    pendingRef.current = null;
    setGesture(null);
    setPendingConnection(null);
    setHoveredTarget(null);
    setPreviewPositions({});
  }, []);

  useEffect(() => {
    if (disabled) cancelGesture();
  }, [cancelGesture, disabled]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelGesture();
      setSelectedEdge(null);
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedEdge) {
      event.preventDefault();
      removeSelectedEdge();
    }
  }, [cancelGesture, removeSelectedEdge, selectedEdge]);

  useEffect(() => {
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelGesture();
    };
    window.addEventListener('keydown', cancelOnEscape);
    return () => window.removeEventListener('keydown', cancelOnEscape);
  }, [cancelGesture]);

  const finishNodeGesture = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (disabled) {
      cancelGesture();
      return;
    }
    const current = gestureRef.current;
    if (!current || current.kind !== 'node' || current.pointerId !== event.pointerId) return;
    const point = getEventPoint(event, viewportRef.current, worldRef.current, zoom);
    const next = { x: point.x - current.offsetX, y: point.y - current.offsetY };
    if (!current.moved && Math.hypot(point.x - current.startPoint.x, point.y - current.startPoint.y) < 3) {
      gestureRef.current = null;
      setGesture(null);
      setPreviewPositions({});
      try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
      return;
    }
    commitPosition(current.stepId, next);
    gestureRef.current = null;
    setGesture(null);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
  }, [cancelGesture, commitPosition, disabled, zoom]);

  const moveNodeGesture = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const current = gestureRef.current;
    if (!current || current.kind !== 'node' || current.pointerId !== event.pointerId) return;
    const point = getEventPoint(event, viewportRef.current, worldRef.current, zoom);
    const moved = current.moved || Math.hypot(point.x - current.startPoint.x, point.y - current.startPoint.y) >= 3;
    const next = {
      x: clamp(point.x - current.offsetX, 0, MAX_COORDINATE),
      y: clamp(point.y - current.offsetY, 0, MAX_COORDINATE),
    };
    gestureRef.current = { ...current, moved };
    setGesture({ ...current, moved });
    setPreviewPositions((positionsById) => ({ ...positionsById, [current.stepId]: next }));
  }, [zoom]);

  const beginNodeGesture = useCallback((event: React.PointerEvent<HTMLElement>, stepId: string) => {
    if (disabled) return;
    if (pendingRef.current) {
      connect(pendingRef.current.stepId, pendingRef.current.status, stepId);
      event.stopPropagation();
      return;
    }
    const point = getEventPoint(event, viewportRef.current, worldRef.current, zoom);
    const position = positions.get(stepId) ?? { x: 20, y: 20 };
    gestureRef.current = { kind: 'node', stepId, pointerId: event.pointerId, offsetX: point.x - position.x, offsetY: point.y - position.y, startPoint: point, moved: false };
    setGesture(gestureRef.current);
    onSelectStep(stepId);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [connect, disabled, onSelectStep, positions, zoom]);

  const beginConnection = useCallback((event: React.PointerEvent<HTMLButtonElement>, stepId: string, status: ResultStatus) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    const point = getEventPoint(event, viewportRef.current, worldRef.current, zoom);
    const next: ConnectionGesture = { kind: 'connection', stepId, status, pointerId: event.pointerId, point, moved: false };
    gestureRef.current = next;
    setGesture(next);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [disabled, zoom]);

  const moveConnection = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const current = gestureRef.current;
    if (!current || current.kind !== 'connection' || current.pointerId !== event.pointerId) return;
    const point = getEventPoint(event, viewportRef.current, worldRef.current, zoom);
    const moved = current.moved || Math.hypot(point.x - current.point.x, point.y - current.point.y) > 5;
    const target = validTargetAt(point, positionedSteps, positions, terminalPositions);
    const next: ConnectionGesture = { ...current, point, moved };
    gestureRef.current = next;
    setGesture(next);
    setHoveredTarget(target ?? null);
  }, [positionedSteps, positions, terminalPositions, zoom]);

  const finishConnection = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled) {
      cancelGesture();
      return;
    }
    const current = gestureRef.current;
    if (!current || current.kind !== 'connection' || current.pointerId !== event.pointerId) return;
    const point = getEventPoint(event, viewportRef.current, worldRef.current, zoom);
    const target = validTargetAt(point, positionedSteps, positions, terminalPositions);
    if (current.moved && target) connect(current.stepId, current.status, target);
    else if (!current.moved) {
      pendingRef.current = { stepId: current.stepId, status: current.status };
      setPendingConnection(pendingRef.current);
    }
    gestureRef.current = null;
    setGesture(null);
    setHoveredTarget(target ?? null);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
  }, [cancelGesture, connect, disabled, positionedSteps, positions, terminalPositions, zoom]);

  const selectInput = useCallback((event: React.MouseEvent<HTMLButtonElement>, stepId: string) => {
    event.stopPropagation();
    if (pendingRef.current) {
      connect(pendingRef.current.stepId, pendingRef.current.status, stepId);
      return;
    }
    onSelectStep(stepId);
  }, [connect, onSelectStep]);

  const selectTerminal = useCallback((event: React.MouseEvent<HTMLButtonElement>, target: 'done' | 'error') => {
    event.stopPropagation();
    if (pendingRef.current) connect(pendingRef.current.stepId, pendingRef.current.status, target);
  }, [connect]);

  const organize = useCallback(() => {
    if (disabled) return;
    const steps = workflow.steps.map((step, index) => ({
      ...step,
      position: fallbackPosition(index),
    } as Step));
    onChangeSteps(steps);
    setPreviewPositions({});
  }, [disabled, onChangeSteps, workflow.steps]);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      setZoom(0.9);
      return;
    }
    const availableWidth = Math.max(300, viewport.clientWidth - 24);
    const availableHeight = Math.max(260, viewport.clientHeight - 24);
    setZoom(clamp(Math.min(availableWidth / canvasSize.width, availableHeight / canvasSize.height), MIN_ZOOM, 1.1));
  }, [canvasSize.height, canvasSize.width]);

  useEffect(() => {
    if (didFitInitial.current) return;
    didFitInitial.current = true;
    fit();
  }, [fit]);

  const currentConnection = gesture?.kind === 'connection' ? gesture : null;

  return (
    <section className={`workflow-canvas-card ${disabled ? 'is-disabled' : ''}`} aria-label={`Mapa visual do workflow ${workflow.name || ''}`} data-testid="workflow-canvas">
      <div className="workflow-canvas-toolbar">
        <div className="workflow-canvas-toolbar-copy">
          <span className="workflow-canvas-kicker"><MousePointer2 size={13} /> mapa visual</span>
          <strong>{workflow.steps.length} {workflow.steps.length === 1 ? 'etapa' : 'etapas'} · arraste os blocos para organizar</strong>
        </div>
        <div className="workflow-canvas-actions" aria-label="Controles do mapa">
          {onAddStep && <button type="button" className="workflow-canvas-control workflow-canvas-control-wide" onClick={onAddStep} disabled={disabled || !canAddStep} aria-label="Adicionar etapa no mapa" title={canAddStep ? 'Adicionar etapa' : 'Limite de 100 etapas atingido'}><Plus size={14} /><span>Adicionar etapa</span></button>}
          <button type="button" className="workflow-canvas-control" onClick={() => setZoom((value) => clamp(value - 0.1, MIN_ZOOM, MAX_ZOOM))} disabled={disabled} aria-label="Afastar mapa" title="Afastar"><Minus size={15} /></button>
          <output className="workflow-zoom-value" aria-live="polite">{Math.round(zoom * 100)}%</output>
          <button type="button" className="workflow-canvas-control" onClick={() => setZoom((value) => clamp(value + 0.1, MIN_ZOOM, MAX_ZOOM))} disabled={disabled} aria-label="Aproximar mapa" title="Aproximar"><Plus size={15} /></button>
          <button type="button" className="workflow-canvas-control workflow-canvas-control-wide" onClick={fit} disabled={disabled} title="Ajustar mapa à área visível"><Maximize2 size={14} /><span>Ajustar</span></button>
          <button type="button" className="workflow-canvas-control workflow-canvas-control-wide" onClick={organize} disabled={disabled} title="Organizar etapas"><Sparkles size={14} /><span>Organizar</span></button>
          <button type="button" className="workflow-canvas-control workflow-canvas-control-wide workflow-canvas-remove-edge" onClick={removeSelectedEdge} disabled={disabled || !selectedEdge} aria-label="Remover conexão selecionada" title={selectedEdge ? 'Remover conexão selecionada' : 'Selecione uma conexão para remover'}><Trash2 size={14} /><span>Remover conexão</span></button>
          <button type="button" className="workflow-canvas-control" onClick={cancelGesture} disabled={disabled} aria-label="Cancelar gesto" title="Cancelar gesto"><RotateCcw size={14} /></button>
        </div>
      </div>
      <div className="workflow-canvas-hint" role="status" aria-live="polite">
        {disabled ? 'O workflow está bloqueado enquanto uma execução está ativa.' : pendingConnection ? `Saída ${pendingConnection.status} selecionada. Clique na entrada de uma etapa ou em um terminal.` : 'Conecte uma saída a uma etapa ou terminal. A lista mantém a edição por teclado.'}
      </div>
      <div className="workflow-canvas-viewport" ref={viewportRef} tabIndex={0} onKeyDown={handleKeyDown} onPointerDown={(event) => { if (pendingRef.current && event.target === event.currentTarget) cancelGesture(); }}>
        <div className="workflow-canvas-world" ref={worldRef} style={{ width: canvasSize.width, height: canvasSize.height, transform: `scale(${zoom})` }}>
          <svg className="workflow-canvas-edges" viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`} aria-hidden="true">
            <defs>
              {(RESULT_STATUSES.map((status) => <marker key={status} id={`workflow-arrow-${status.toLowerCase()}`} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L6,3 z" className={`workflow-marker ${statusMeta[status].className}`} /></marker>))}
            </defs>
            {positionedSteps.flatMap((step) => RESULT_STATUSES.flatMap((status) => {
      const target = step.transitions[status];
              if (!target) return [];
              const source = sourceAnchor(positions.get(step.id) ?? fallbackPosition(0), status);
              const destination = target === 'done' || target === 'error'
                ? terminalInputAnchor(target, terminalPositions)
                : inputAnchor(positions.get(target) ?? fallbackPosition(0));
              const isSelfLoop = target === step.id;
              const meta = statusMeta[status];
              const labelPoint = edgeLabelPoint(source, destination, positions.get(step.id) ?? fallbackPosition(0), target === 'done' || target === 'error' ? undefined : positions.get(target));
              const labelX = labelPoint.x;
              const labelY = labelPoint.y;
              const isSelected = selectedEdge?.stepId === step.id && selectedEdge.status === status;
              return [
                <g key={`${step.id}-${status}-visual`} className={`workflow-edge-visual ${meta.className} ${isSelected ? 'is-selected' : ''}`} aria-hidden="true">
                  <path className="workflow-edge-underlay" d={connectorPath(source, destination, isSelfLoop)} />
                  <path className="workflow-edge-path" d={connectorPath(source, destination, isSelfLoop)} markerEnd={`url(#workflow-arrow-${status.toLowerCase()})`} />
                </g>,
                <g key={`${step.id}-${status}`} className={`workflow-edge-group ${meta.className} ${isSelected ? 'is-selected' : ''}`} data-edge-from={step.id} data-edge-source={step.id} data-edge-status={status} data-edge-target={target} role="button" tabIndex={0} aria-selected={isSelected} aria-label={`Ligação ${status} para ${target === 'done' ? 'concluir workflow' : target === 'error' ? 'encerrar com erro' : 'etapa de destino'}`} onFocus={() => setSelectedEdge({ stepId: step.id, status })} onClick={(event) => { event.stopPropagation(); setSelectedEdge({ stepId: step.id, status }); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedEdge({ stepId: step.id, status }); } else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeEdge({ stepId: step.id, status }); } }}>
                  <rect className="workflow-edge-label-hitarea" x={labelX - 34} y={labelY - 15} width="68" height="30" rx="8" />
                  <g className="workflow-edge-label" transform={`translate(${labelX} ${labelY})`}>
                    <rect x="-25" y="-10" width="50" height="20" rx="6" />
                    <text x="0" y="1" textAnchor="middle">{meta.label}</text>
                  </g>
                </g>,
              ];
            }))}
            {currentConnection && <path className="workflow-preview-edge" d={connectorPath(sourceAnchor(positions.get(currentConnection.stepId) ?? fallbackPosition(0), currentConnection.status), currentConnection.point)} />}
          </svg>
          <div className="workflow-canvas-start-line" aria-hidden="true"><span>início</span></div>
          <button type="button" data-target="done" className={`workflow-terminal workflow-terminal-done ${hoveredTarget === 'done' ? 'is-hovered' : ''} ${pendingConnection ? 'is-connectable' : ''}`} style={{ left: terminalPositions.done.x, top: terminalPositions.done.y }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => selectTerminal(event, 'done')} disabled={disabled} aria-label="Destino done"> <span className="workflow-terminal-port" /> <span><strong>DONE</strong><small>concluir workflow</small></span></button>
          <button type="button" data-target="error" className={`workflow-terminal workflow-terminal-error ${hoveredTarget === 'error' ? 'is-hovered' : ''} ${pendingConnection ? 'is-connectable' : ''}`} style={{ left: terminalPositions.error.x, top: terminalPositions.error.y }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => selectTerminal(event, 'error')} disabled={disabled} aria-label="Destino error"> <span className="workflow-terminal-port" /> <span><strong>ERROR</strong><small>encerrar com erro</small></span></button>
          {positionedSteps.map((step, index) => {
            const position = positions.get(step.id) ?? fallbackPosition(index);
            const agent = agentFor(config, step);
            return <WorkflowCanvasNode
              key={step.id}
              step={step}
              index={index}
              agent={agent}
              label={stepLabel(step, config, index)}
              position={position}
              isStart={workflow.start === step.id}
              selected={selectedStepId === step.id}
              pendingConnection={pendingConnection}
              hoveredTarget={hoveredTarget}
              disabled={disabled}
              onSelect={onSelectStep}
              onNodePointerDown={beginNodeGesture}
              onNodePointerMove={moveNodeGesture}
              onNodePointerUp={finishNodeGesture}
              onNodePointerCancel={cancelGesture}
              onOutputPointerDown={beginConnection}
              onOutputPointerMove={moveConnection}
              onOutputPointerUp={finishConnection}
              onOutputPointerCancel={cancelGesture}
              onInputClick={selectInput}
            />;
          })}
        </div>
      </div>
    </section>
  );
}

interface WorkflowCanvasNodeProps {
  step: PositionedStep;
  index: number;
  agent?: Agent;
  label: string;
  position: WorkflowPosition;
  isStart: boolean;
  selected: boolean;
  pendingConnection: PendingConnection | null;
  hoveredTarget: string | 'done' | 'error' | null;
  disabled: boolean;
  onSelect: (stepId: string) => void;
  onNodePointerDown: (event: React.PointerEvent<HTMLElement>, stepId: string) => void;
  onNodePointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onNodePointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onNodePointerCancel: () => void;
  onOutputPointerDown: (event: React.PointerEvent<HTMLButtonElement>, stepId: string, status: ResultStatus) => void;
  onOutputPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onOutputPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onOutputPointerCancel: () => void;
  onInputClick: (event: React.MouseEvent<HTMLButtonElement>, stepId: string) => void;
}

const WorkflowCanvasNode = memo(function WorkflowCanvasNode({ step, index, agent, label, position, isStart, selected, pendingConnection, hoveredTarget, disabled, onSelect, onNodePointerDown, onNodePointerMove, onNodePointerUp, onNodePointerCancel, onOutputPointerDown, onOutputPointerMove, onOutputPointerUp, onOutputPointerCancel, onInputClick }: WorkflowCanvasNodeProps) {
  return (
    <article
      className={`workflow-canvas-node ${selected ? 'is-selected' : ''} ${isStart ? 'is-start' : ''} ${hoveredTarget === step.id ? 'is-connect-target' : ''}`}
      data-step-id={step.id}
      tabIndex={0}
      style={{ left: position.x, top: position.y }}
      aria-label={`Etapa ${index + 1}: ${label}`}
      aria-disabled={disabled}
      onPointerDown={(event) => onNodePointerDown(event, step.id)}
      onPointerMove={onNodePointerMove}
      onPointerUp={onNodePointerUp}
      onPointerCancel={onNodePointerCancel}
      onFocus={() => onSelect(step.id)}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(step.id); } }}
      onClick={() => onSelect(step.id)}
    >
      <button type="button" className="workflow-node-input" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => onInputClick(event, step.id)} disabled={disabled} aria-label={`Entrada da etapa ${index + 1}`} title="Entrada da etapa" />
      <div className="workflow-node-header" data-drag-handle="true">
        <span className="workflow-node-index">{index + 1}</span>
        <span className="workflow-node-heading"><small>{isStart ? 'ponto de partida' : 'etapa do workflow'}</small><strong>{label}</strong></span>
        {isStart && <span className="workflow-node-start">início</span>}
      </div>
      <div className="workflow-node-agent"><span className="workflow-node-avatar">{initials(agent)}</span><span><strong>{agent?.name || 'Agente não selecionado'}</strong><small>{agent?.role || 'Escolha um agente na lista'}</small></span></div>
      <div className="workflow-node-ports" aria-label="Saídas da etapa">
        {RESULT_STATUSES.map((status) => {
          const target = step.transitions[status];
          const meta = statusMeta[status];
          return <button key={status} type="button" data-step-id={step.id} data-status={status} className={`workflow-output-port ${meta.className} ${pendingConnection?.stepId === step.id && pendingConnection.status === status ? 'is-pending' : ''} ${target ? 'has-target' : 'is-open'}`} onPointerDown={(event) => onOutputPointerDown(event, step.id, status)} onPointerMove={onOutputPointerMove} onPointerUp={onOutputPointerUp} onPointerCancel={onOutputPointerCancel} onClick={(event) => event.stopPropagation()} disabled={disabled} aria-label={`Saída ${status} da etapa ${index + 1}`} title={target ? `${status} → ${target}` : `Conectar saída ${status}`}><span className="workflow-port-dot" /><span>{status}</span></button>;
        })}
      </div>
    </article>
  );
});

export default memo(WorkflowCanvas);
