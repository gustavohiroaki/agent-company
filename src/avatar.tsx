import {
  AVATAR_ACCESSORIES,
  AVATAR_BACKGROUND_COLORS,
  AVATAR_EXPRESSIONS,
  AVATAR_FACES,
  AVATAR_HAIR_COLORS,
  AVATAR_HAIR_STYLES,
  AVATAR_OUTFIT_COLORS,
  AVATAR_OUTFITS,
  AVATAR_SKIN_TONES,
  type Agent,
  type AgentRuntime,
  type AvatarAccessory,
  type AvatarAppearance,
  type AvatarExpression,
  type AvatarFace,
  type AvatarHairStyle,
  type AvatarOutfit,
} from '../shared/types';
import { useEffect, useRef, useState } from 'react';

/**
 * The avatar is deliberately data-only. The server validates this shape, but
 * the renderer also normalises it so a partially migrated legacy snapshot can
 * never make the office UI fail to render.
 */
export type { AvatarAppearance };
export type AgentWithAppearance = Agent;

const SKIN_TONES = AVATAR_SKIN_TONES.map((value, index) => ({
  value,
  label: ['Pêssego claro', 'Damasco', 'Terracota', 'Canela', 'Cacau', 'Ébano'][index] ?? 'Tom de pele',
}));

const HAIR_COLORS = AVATAR_HAIR_COLORS.map((value, index) => ({
  value,
  label: ['Grafite', 'Castanho', 'Cobre', 'Mel', 'Areia', 'Creme', 'Violeta'][index] ?? 'Cor do cabelo',
}));

const OUTFIT_COLORS = AVATAR_OUTFIT_COLORS.map((value, index) => ({
  value,
  label: ['Cobalto', 'Verde escritório', 'Coral', 'Lilás', 'Grafite', 'Mostarda', 'Azul névoa', 'Pêssego'][index] ?? 'Cor da roupa',
}));

const BACKGROUND_COLORS = AVATAR_BACKGROUND_COLORS.map((value, index) => ({
  value,
  label: ['Papel creme', 'Azul planta', 'Verde vidro', 'Lilás suave', 'Pêssego', 'Cinza folha'][index] ?? 'Cor do fundo',
}));

const DEFAULT_AVATAR_APPEARANCE: AvatarAppearance = {
  version: 1,
  skinTone: AVATAR_SKIN_TONES[1],
  face: 'soft',
  expression: 'friendly',
  hairStyle: 'short',
  hairColor: AVATAR_HAIR_COLORS[0],
  outfit: 'shirt',
  outfitColor: AVATAR_OUTFIT_COLORS[0],
  accessory: 'none',
  backgroundColor: AVATAR_BACKGROUND_COLORS[0],
};

const AVATAR_PRESETS: Array<{ id: string; label: string; note: string; appearance: AvatarAppearance }> = [
  {
    id: 'desk-lead',
    label: 'Liderança',
    note: 'Cobalto e postura aberta',
    appearance: { ...DEFAULT_AVATAR_APPEARANCE, face: 'angular', expression: 'focused', hairStyle: 'bun', outfit: 'jacket', outfitColor: '#4F65C8', backgroundColor: '#EAF0F6' },
  },
  {
    id: 'field-research',
    label: 'Pesquisa',
    note: 'Verde, cachos e óculos',
    appearance: { ...DEFAULT_AVATAR_APPEARANCE, skinTone: '#C98762', face: 'round', expression: 'friendly', hairStyle: 'curly', hairColor: '#8C5A3C', outfit: 'sweater', outfitColor: '#45A086', accessory: 'glasses', backgroundColor: '#E8F3EC' },
  },
  {
    id: 'build-mode',
    label: 'Construção',
    note: 'Grafite, headset e foco',
    appearance: { ...DEFAULT_AVATAR_APPEARANCE, skinTone: '#A9664C', face: 'angular', expression: 'focused', hairStyle: 'shaved', hairColor: '#2E2523', outfit: 'hoodie', outfitColor: '#293235', accessory: 'headset', backgroundColor: '#E7ECEB' },
  },
  {
    id: 'review-desk',
    label: 'Revisão',
    note: 'Lilás e expressão calma',
    appearance: { ...DEFAULT_AVATAR_APPEARANCE, skinTone: '#E7AD82', face: 'soft', expression: 'neutral', hairStyle: 'long', hairColor: '#5B392A', outfit: 'sweater', outfitColor: '#9278BE', accessory: 'glasses', backgroundColor: '#F0EAF5' },
  },
] as const;

const FACE_VALUES: readonly AvatarFace[] = AVATAR_FACES;
const EXPRESSION_VALUES: readonly AvatarExpression[] = AVATAR_EXPRESSIONS;
const HAIR_VALUES: readonly AvatarHairStyle[] = AVATAR_HAIR_STYLES;
const OUTFIT_VALUES: readonly AvatarOutfit[] = AVATAR_OUTFITS;
const ACCESSORY_VALUES: readonly AvatarAccessory[] = AVATAR_ACCESSORIES;

function allowedColor<T extends string>(value: unknown, palette: readonly { value: T }[], fallback: T): T {
  return typeof value === 'string' && palette.some((item) => item.value === value) ? value as T : fallback;
}

function allowedValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? value as T : fallback;
}

export function normalizeAppearance(value?: Partial<AvatarAppearance> | null): AvatarAppearance {
  const source = value ?? {};
  return {
    version: 1,
    skinTone: allowedColor(source.skinTone, SKIN_TONES, DEFAULT_AVATAR_APPEARANCE.skinTone),
    face: allowedValue(source.face, FACE_VALUES, DEFAULT_AVATAR_APPEARANCE.face),
    expression: allowedValue(source.expression, EXPRESSION_VALUES, DEFAULT_AVATAR_APPEARANCE.expression),
    hairStyle: allowedValue(source.hairStyle, HAIR_VALUES, DEFAULT_AVATAR_APPEARANCE.hairStyle),
    hairColor: allowedColor(source.hairColor, HAIR_COLORS, DEFAULT_AVATAR_APPEARANCE.hairColor),
    outfit: allowedValue(source.outfit, OUTFIT_VALUES, DEFAULT_AVATAR_APPEARANCE.outfit),
    outfitColor: allowedColor(source.outfitColor, OUTFIT_COLORS, DEFAULT_AVATAR_APPEARANCE.outfitColor),
    accessory: allowedValue(source.accessory, ACCESSORY_VALUES, DEFAULT_AVATAR_APPEARANCE.accessory),
    backgroundColor: allowedColor(source.backgroundColor, BACKGROUND_COLORS, DEFAULT_AVATAR_APPEARANCE.backgroundColor),
  };
}

export function avatarAppearanceFor(agent: Agent): AvatarAppearance | undefined {
  const appearance = (agent as AgentWithAppearance).appearance;
  return appearance ? normalizeAppearance(appearance) : undefined;
}

export function agentInitials(agent?: Pick<Agent, 'avatar' | 'name'>): string {
  if (!agent) return '?';
  const source = agent.avatar?.trim() || agent.name;
  const letters = source.replace(/[^\p{L}\p{N}]/gu, '');
  if (letters.length <= 3) return letters.toUpperCase();
  return letters.slice(0, 2).toUpperCase();
}

export function presetForAgent(index: number): AvatarAppearance {
  return { ...AVATAR_PRESETS[index % AVATAR_PRESETS.length].appearance };
}

type AvatarVariant = 'portrait' | 'figure';
type AvatarSize = 'small' | 'medium' | 'large';
type AvatarPose = 'idle' | 'working';

export function AgentAvatar({
  agent,
  runtime,
  size = 'medium',
  variant = 'portrait',
  pose = 'idle',
  appearance,
  className = '',
  label,
}: {
  agent: Agent;
  runtime?: AgentRuntime;
  size?: AvatarSize;
  variant?: AvatarVariant;
  pose?: AvatarPose;
  appearance?: Partial<AvatarAppearance>;
  className?: string;
  label?: string;
}) {
  const savedAppearance = avatarAppearanceFor(agent);
  const resolvedAppearance = appearance || savedAppearance;
  const hasAppearance = Boolean(resolvedAppearance);
  const classes = ['avatar', `avatar-${size}`, 'agent-avatar', `agent-avatar-${variant}`, pose === 'working' ? 'is-working' : '', className].filter(Boolean).join(' ');
  const presenceClass = runtime && runtime.status !== 'Idle' ? `avatar-presence status-${runtime.status.toLowerCase()}` : '';
  return (
    <span className={classes} data-avatar-mode={hasAppearance ? 'illustrated' : 'legacy'} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <svg viewBox={variant === 'figure' ? '0 0 100 120' : '0 8 100 92'} className="agent-avatar-svg" focusable="false" aria-hidden="true">
        {hasAppearance ? <IllustratedAvatar appearance={normalizeAppearance(resolvedAppearance)} variant={variant} /> : <LegacyAvatar initials={agentInitials(agent)} variant={variant} color={colorForAvatar(agent.id)} />}
      </svg>
      {runtime && runtime.status !== 'Idle' && <i className={presenceClass} aria-hidden="true" />}
    </span>
  );
}

function LegacyAvatar({ initials, variant, color }: { initials: string; variant: AvatarVariant; color: string }) {
  return <><rect x="2" y="10" width="96" height="96" rx={variant === 'figure' ? 21 : 48} fill={color} /><path d="M18 106c3-22 16-32 32-32s29 10 32 32" fill="rgba(255,255,255,.22)" /><text x="50" y="59" textAnchor="middle" fill="#fff" fontFamily="Space Grotesk, sans-serif" fontSize="22" fontWeight="700">{initials}</text></>;
}

function IllustratedAvatar({ appearance, variant }: { appearance: AvatarAppearance; variant: AvatarVariant }) {
  const { skinTone, face, expression, hairStyle, hairColor, outfit, outfitColor, accessory, backgroundColor } = appearance;
  return <g className="illustrated-avatar">
    <rect x="1" y="8" width="98" height="110" rx={variant === 'figure' ? 19 : 49} fill={backgroundColor} />
    {variant === 'figure' && <FigureBody outfit={outfit} outfitColor={outfitColor} />}
    {variant === 'portrait' && <path d="M10 106c3-22 18-33 40-33s37 11 40 33" fill={outfitColor} />}
    <path d="M43 69h14v13H43z" fill={skinTone} />
    <Face face={face} expression={expression} skinTone={skinTone} />
    <Hair style={hairStyle} color={hairColor} />
    <Accessory kind={accessory} />
  </g>;
}

function FigureBody({ outfit, outfitColor }: { outfit: AvatarAppearance['outfit']; outfitColor: string }) {
  if (outfit === 'hoodie') return <><path d="M22 120V91c0-11 9-17 18-19l10 7 10-7c9 2 18 8 18 19v29H22z" fill={outfitColor} /><path d="M39 78l11 10 11-10" fill="none" stroke="rgba(255,255,255,.45)" strokeWidth="3" /></>;
  if (outfit === 'jacket') return <><path d="M18 120V92c0-11 11-18 23-21l9 8 9-8c12 3 23 10 23 21v28H18z" fill={outfitColor} /><path d="M50 80v40M40 84l10 8 10-8" fill="none" stroke="rgba(255,255,255,.52)" strokeWidth="2" /></>;
  if (outfit === 'sweater') return <><path d="M20 120V91c0-12 11-18 30-20 19 2 30 8 30 20v29H20z" fill={outfitColor} /><path d="M29 91c6 5 14 7 21 7s15-2 21-7" fill="none" stroke="rgba(255,255,255,.25)" strokeWidth="3" /></>;
  return <path d="M22 120V91c0-11 10-18 28-20 18 2 28 9 28 20v29H22z" fill={outfitColor} />;
}

function Face({ face, expression, skinTone }: { face: AvatarAppearance['face']; expression: AvatarAppearance['expression']; skinTone: string }) {
  const shape = face === 'round' ? <ellipse cx="50" cy="48" rx="23" ry="27" /> : face === 'angular' ? <path d="M29 37c2-11 10-17 21-17s19 6 21 17l-3 24-18 15-18-15-3-24z" /> : <path d="M27 39c1-13 10-20 23-20s22 7 23 20l-3 23c-4 12-12 17-20 17S34 74 30 62l-3-23z" />;
  const eye = expression === 'focused' ? <><path d="M37 46h7M56 46h7" stroke="#29343b" strokeWidth="2.4" strokeLinecap="round" /><path d="M43 62c4 2 10 2 14 0" fill="none" stroke="#29343b" strokeWidth="2" strokeLinecap="round" /></> : expression === 'neutral' ? <><circle cx="40" cy="46" r="2.1" fill="#29343b" /><circle cx="60" cy="46" r="2.1" fill="#29343b" /><path d="M44 62h12" stroke="#29343b" strokeWidth="2" strokeLinecap="round" /></> : <><path d="M37 45c2-2 5-2 7 0M56 45c2-2 5-2 7 0" fill="none" stroke="#29343b" strokeWidth="2" strokeLinecap="round" /><path d="M43 59c4 5 10 5 14 0" fill="none" stroke="#29343b" strokeWidth="2" strokeLinecap="round" /></>;
  return <g><g fill={skinTone}>{shape}</g>{eye}</g>;
}

function Hair({ style, color }: { style: AvatarAppearance['hairStyle']; color: string }) {
  if (style === 'curly') return <g fill={color}><circle cx="31" cy="33" r="9" /><circle cx="40" cy="23" r="10" /><circle cx="51" cy="20" r="10" /><circle cx="62" cy="23" r="10" /><circle cx="71" cy="33" r="9" /><path d="M29 37c4-17 12-22 21-22s17 5 22 22c-5-3-10-5-22-5s-17 2-21 5z" /></g>;
  if (style === 'long') return <path d="M27 46c-3-19 5-31 23-31s26 12 23 32l-5 31-9-8V37c-5-3-11-4-18 0v33l-9 9-5-33z" fill={color} />;
  if (style === 'bun') return <><circle cx="73" cy="19" r="10" fill={color} /><path d="M28 41c-2-19 7-29 22-29s24 10 22 29c-7-8-15-12-22-12s-15 4-22 12z" fill={color} /></>;
  if (style === 'shaved') return <path d="M30 35c2-14 10-22 20-22s18 8 20 22c-8-4-14-6-20-6s-12 2-20 6z" fill={color} opacity=".85" />;
  return <path d="M28 38c-1-18 8-27 22-27s23 9 22 27c-7-7-15-10-22-10s-15 3-22 10z" fill={color} />;
}

function Accessory({ kind }: { kind: AvatarAppearance['accessory'] }) {
  if (kind === 'glasses') return <g fill="none" stroke="#29343b" strokeWidth="2"><rect x="33" y="41" width="14" height="10" rx="4" /><rect x="53" y="41" width="14" height="10" rx="4" /><path d="M47 45h6" /></g>;
  if (kind === 'headset') return <g fill="none" stroke="#5367c9" strokeWidth="3" strokeLinecap="round"><path d="M27 50c-2-19 8-30 23-30s25 11 23 30" /><path d="M27 50v10M73 50v10" /></g>;
  if (kind === 'cap') return <><path d="M27 34c10-12 32-16 47 0l-2 6c-14-6-29-6-45 0z" fill="#D98268" /><path d="M61 37c8 0 14 2 18 4-8 3-15 3-21 1z" fill="#AA554B" /></>;
  return null;
}

function colorForAvatar(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = id.charCodeAt(index) + ((hash << 5) - hash);
  const palette = ['#5367c9', '#d67c63', '#3d8a77', '#8b6bb2', '#d2a74e', '#3d8caf'];
  return palette[Math.abs(hash) % palette.length];
}

const FACE_LABELS: Record<AvatarAppearance['face'], string> = {
  soft: 'Suave',
  round: 'Redondo',
  angular: 'Geométrico',
};
const EXPRESSION_LABELS: Record<AvatarAppearance['expression'], string> = {
  neutral: 'Calmo',
  friendly: 'Aberto',
  focused: 'Concentrado',
};
const HAIR_LABELS: Record<AvatarAppearance['hairStyle'], string> = {
  short: 'Curto',
  curly: 'Cacheado',
  long: 'Longo',
  shaved: 'Raspado',
  bun: 'Coque',
};
const OUTFIT_LABELS: Record<AvatarAppearance['outfit'], string> = {
  shirt: 'Camisa',
  hoodie: 'Moletom',
  jacket: 'Jaqueta',
  sweater: 'Suéter',
};
const ACCESSORY_LABELS: Record<AvatarAppearance['accessory'], string> = {
  none: 'Nenhum',
  glasses: 'Óculos',
  headset: 'Headset',
  cap: 'Boné',
};

function randomAppearance(): AvatarAppearance {
  const pick = <T,>(values: readonly T[]) => values[Math.floor(Math.random() * values.length)];
  return normalizeAppearance({
    skinTone: pick(SKIN_TONES).value,
    face: pick(FACE_VALUES),
    expression: pick(EXPRESSION_VALUES),
    hairStyle: pick(HAIR_VALUES),
    hairColor: pick(HAIR_COLORS).value,
    outfit: pick(OUTFIT_VALUES),
    outfitColor: pick(OUTFIT_COLORS).value,
    accessory: pick(ACCESSORY_VALUES),
    backgroundColor: pick(BACKGROUND_COLORS).value,
  });
}

function ChoiceButton({ selected, label, detail, onClick, swatch }: { selected: boolean; label: string; detail?: string; onClick: () => void; swatch?: string }) {
  return <button type="button" className={`avatar-choice ${selected ? 'is-selected' : ''}`} aria-pressed={selected} onClick={onClick}>
    {swatch ? <span className="avatar-choice-swatch" style={{ background: swatch }} aria-hidden="true" /> : <span className="avatar-choice-marker" aria-hidden="true" />}
    <span><strong>{label}</strong>{detail && <small>{detail}</small>}</span>
  </button>;
}

export function AvatarBuilderDialog({ agent, onApply, onCancel }: { agent: Agent; onApply: (appearance: AvatarAppearance) => void; onCancel: () => void }) {
  const savedAppearance = avatarAppearanceFor(agent);
  const [draft, setDraft] = useState<AvatarAppearance>(() => normalizeAppearance(savedAppearance ?? DEFAULT_AVATAR_APPEARANCE));
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onCancel]);

  const update = (patch: Partial<AvatarAppearance>) => setDraft((current) => normalizeAppearance({ ...current, ...patch }));
  const surprise = () => setDraft(randomAppearance());
  const restore = () => setDraft(normalizeAppearance(savedAppearance ?? DEFAULT_AVATAR_APPEARANCE));

  return <div className="avatar-builder-overlay" role="presentation">
    <section ref={dialogRef} tabIndex={-1} className="avatar-builder-dialog paper-panel" role="dialog" aria-modal="true" aria-labelledby="avatar-builder-title" aria-describedby="avatar-builder-description">
      <div className="avatar-builder-heading">
        <div><p className="eyebrow"><span className="eyebrow-dot" /> retrato do escritório</p><h2 id="avatar-builder-title">Montar boneco</h2><p id="avatar-builder-description">Escolha peças simples para reconhecer {agent.name || 'este agente'} de longe.</p></div>
        <AgentAvatar agent={agent} appearance={draft} size="large" variant="portrait" label={`Prévia do boneco de ${agent.name || 'agente'}`} className="avatar-builder-heading-avatar" />
      </div>
      <div className="avatar-builder-layout">
        <div className="avatar-builder-preview">
          <div className="avatar-builder-preview-stage"><AgentAvatar agent={agent} appearance={draft} size="large" variant="portrait" label={`Prévia grande do boneco de ${agent.name || 'agente'}`} className="avatar-builder-preview-avatar" /></div>
          <div className="avatar-builder-preview-copy"><strong>{agent.name || 'Agente sem nome'}</strong><span>{agent.role || 'Função não definida'}</span><small>O status continua aparecendo separado.</small></div>
          <button type="button" className="button button-quiet avatar-surprise" onClick={surprise}><span aria-hidden="true">✦</span> Surpreenda-me</button>
        </div>
        <div className="avatar-builder-controls">
          <section className="avatar-choice-group avatar-preset-group"><div className="avatar-choice-heading"><h3>Comece por um estilo</h3><span>Depois, refine cada detalhe</span></div><div className="avatar-preset-grid">{AVATAR_PRESETS.map((preset) => <button type="button" className="avatar-preset" key={preset.id} onClick={() => setDraft({ ...preset.appearance })}><AgentAvatar agent={agent} appearance={preset.appearance} size="small" variant="portrait" /><span><strong>{preset.label}</strong><small>{preset.note}</small></span></button>)}</div></section>
          <AvatarChoiceGroup title="Rosto" description="Formato e expressão" className="avatar-choice-grid-3">
            {FACE_VALUES.map((value) => <ChoiceButton key={value} selected={draft.face === value} label={FACE_LABELS[value]} onClick={() => update({ face: value })} />)}
            {EXPRESSION_VALUES.map((value) => <ChoiceButton key={value} selected={draft.expression === value} label={EXPRESSION_LABELS[value]} detail="expressão" onClick={() => update({ expression: value })} />)}
          </AvatarChoiceGroup>
          <AvatarChoiceGroup title="Cabelo" description="Estilo e cor">
            {HAIR_VALUES.map((value) => <ChoiceButton key={value} selected={draft.hairStyle === value} label={HAIR_LABELS[value]} onClick={() => update({ hairStyle: value })} />)}
            <div className="avatar-swatch-row" aria-label="Cor do cabelo">{HAIR_COLORS.map((color) => <button type="button" key={color.value} className={`avatar-swatch ${draft.hairColor === color.value ? 'is-selected' : ''}`} style={{ background: color.value }} aria-label={color.label} aria-pressed={draft.hairColor === color.value} onClick={() => update({ hairColor: color.value })} />)}</div>
          </AvatarChoiceGroup>
          <AvatarChoiceGroup title="Roupa" description="A assinatura da sala">
            {OUTFIT_VALUES.map((value) => <ChoiceButton key={value} selected={draft.outfit === value} label={OUTFIT_LABELS[value]} onClick={() => update({ outfit: value })} />)}
            <div className="avatar-swatch-row" aria-label="Cor da roupa">{OUTFIT_COLORS.map((color) => <button type="button" key={color.value} className={`avatar-swatch ${draft.outfitColor === color.value ? 'is-selected' : ''}`} style={{ background: color.value }} aria-label={color.label} aria-pressed={draft.outfitColor === color.value} onClick={() => update({ outfitColor: color.value })} />)}</div>
          </AvatarChoiceGroup>
          <AvatarChoiceGroup title="Acessório" description="Um detalhe para encontrar a pessoa">
            {ACCESSORY_VALUES.map((value) => <ChoiceButton key={value} selected={draft.accessory === value} label={ACCESSORY_LABELS[value]} onClick={() => update({ accessory: value })} />)}
          </AvatarChoiceGroup>
          <AvatarChoiceGroup title="Pele e cenário" description="Cores disponíveis na biblioteca local">
            <div className="avatar-swatch-row avatar-swatch-row-large" aria-label="Tom de pele">{SKIN_TONES.map((color) => <button type="button" key={color.value} className={`avatar-swatch ${draft.skinTone === color.value ? 'is-selected' : ''}`} style={{ background: color.value }} aria-label={color.label} aria-pressed={draft.skinTone === color.value} onClick={() => update({ skinTone: color.value })} />)}</div>
            <div className="avatar-swatch-row avatar-swatch-row-large avatar-background-row" aria-label="Cor do fundo">{BACKGROUND_COLORS.map((color) => <button type="button" key={color.value} className={`avatar-swatch ${draft.backgroundColor === color.value ? 'is-selected' : ''}`} style={{ background: color.value }} aria-label={color.label} aria-pressed={draft.backgroundColor === color.value } onClick={() => update({ backgroundColor: color.value })} />)}</div>
          </AvatarChoiceGroup>
        </div>
      </div>
      <div className="avatar-builder-footer"><button type="button" className="button button-text" onClick={onCancel}>Cancelar</button><button type="button" className="button button-quiet" onClick={restore}>Restaurar</button><button type="button" className="button button-primary" onClick={() => onApply(draft)}>Aplicar avatar</button></div>
    </section>
  </div>;
}

function AvatarChoiceGroup({ title, description, className = '', children }: { title: string; description: string; className?: string; children: React.ReactNode }) {
  return <section className="avatar-choice-group"><div className="avatar-choice-heading"><h3>{title}</h3><span>{description}</span></div><div className={`avatar-choice-grid ${className}`}>{children}</div></section>;
}
