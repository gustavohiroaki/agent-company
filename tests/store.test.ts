import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { defaults } from '../server/defaults.js';
import { Store, validateConfig } from '../server/store.js';
import type { Config } from '../shared/types.js';

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-office-store-'));
  tempRoots.push(root);
  return root;
}

function expectInvalid(config: Config, message: RegExp): void {
  assert.throws(() => validateConfig(config), message);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Store persistence', () => {
  it('initializes a missing directory with valid defaults and persists split files', async () => {
    const root = await tempRoot();
    const store = new Store(root);

    const config = await store.load();

    assert.equal(config.activeProjectId, 'local');
    assert.equal(config.projects[0]?.cwd, root);
    assert.ok(config.agents.length > 0);
    assert.ok(config.workflows.length > 0);
    assert.deepEqual(await readdir(path.join(root, '.agent-office', 'agents')), config.agents.map(a => `${a.id}.md`).sort());
    assert.deepEqual(await readdir(path.join(root, '.agent-office', 'workflows')), config.workflows.map(w => `${w.id}.yaml`).sort());
    assert.ok((await readFile(path.join(root, '.agent-office', 'team.yaml'), 'utf8')).includes('workflowIds:'));
    assert.ok((await readFile(path.join(root, '.agent-office', 'agents', 'developer.md'), 'utf8')).includes('Implementa'));
    assert.equal((await YAML.parse(await readFile(path.join(root, '.agent-office', 'workflows', 'feature.yaml'), 'utf8'))).id, 'feature');
  });

  it('ships deterministic avatar appearances for the standard team', async () => {
    const root = await tempRoot();
    const first = defaults(root);
    const second = defaults(root);

    assert.ok(first.agents.every((agent) => agent.appearance));
    assert.deepEqual(
      first.agents.map((agent) => agent.appearance),
      second.agents.map((agent) => agent.appearance),
    );
    assert.notEqual(first.agents[0].appearance, first.agents[1].appearance);
    assert.doesNotThrow(() => validateConfig(first));
  });

  it('round-trips YAML, markdown instructions, nested transitions, and agent args', async () => {
    const root = await tempRoot();
    const store = new Store(root);
    const original = defaults(root);
    original.agents[0].instructions = '# Planner\n\nUse the exact output: PASS ✓\n';
    original.agents[0].args = ['exec', '--model', '{model}', '--json', '{prompt}'];
    original.agents[0].cwd = path.join(root, 'agent-worktree');
    original.workflows[0].steps[0].transitions = { DONE: 'tester', ERROR: 'error' };
    original.projects[0].rules = 'Keep changes small.\nUse tests.';

    await store.save(original);
    const loaded = await store.load();

    assert.deepEqual(loaded, original);
    assert.equal(await readFile(path.join(root, '.agent-office', 'agents', 'planner.md'), 'utf8'), original.agents[0].instructions);
    const persistedWorkflow = YAML.parse(await readFile(path.join(root, '.agent-office', 'workflows', 'simple.yaml'), 'utf8'));
    assert.deepEqual(persistedWorkflow.steps[0].transitions, { DONE: 'tester', ERROR: 'error' });
    const index = YAML.parse(await readFile(path.join(root, '.agent-office', 'team.yaml'), 'utf8'));
    assert.equal(index.agents[0].instructions, undefined);
    assert.deepEqual(index.workflowIds, original.workflows.map(w => w.id));
  });

  it('round-trips an explicit versioned avatar appearance through YAML', async () => {
    const root = await tempRoot();
    const store = new Store(root);
    const original = defaults(root);
    original.agents[0].appearance = {
      ...original.agents[0].appearance!,
      version: 1,
      expression: 'friendly',
      hairStyle: 'long',
      accessory: 'headset',
      backgroundColor: '#E8F3EC',
    };

    await store.save(original);
    const loaded = await store.load();

    assert.deepEqual(loaded.agents[0].appearance, original.agents[0].appearance);
    const index = YAML.parse(await readFile(path.join(root, '.agent-office', 'team.yaml'), 'utf8'));
    assert.deepEqual(index.agents[0].appearance, original.agents[0].appearance);
  });

  it('round-trips an optional custom brand while legacy configs keep the built-in skin', async () => {
    const root = await tempRoot();
    const store = new Store(root);
    const legacy = defaults(root);

    assert.equal(legacy.branding, undefined);
    assert.doesNotThrow(() => validateConfig(legacy));

    const branded = defaults(root);
    branded.branding = {
      primaryColor: '#1A73E8',
      secondaryColor: '#16213A',
      logoDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    };
    await store.save(branded);

    const loaded = await store.load();
    assert.deepEqual(loaded.branding, branded.branding);
    const index = YAML.parse(await readFile(path.join(root, '.agent-office', 'team.yaml'), 'utf8'));
    assert.deepEqual(index.branding, branded.branding);

    const flash = defaults(root);
    flash.branding = {
      primaryColor: '#FE2B8F',
      secondaryColor: '#33153D',
      logoAsset: 'flash',
    };
    await store.save(flash);
    assert.deepEqual((await store.load()).branding, flash.branding);
  });

  it('accepts and preserves an older agent without an appearance', async () => {
    const root = await tempRoot();
    const store = new Store(root);
    const legacy = defaults(root);
    delete legacy.agents[0].appearance;

    assert.doesNotThrow(() => validateConfig(legacy));
    await store.save(legacy);
    const loaded = await store.load();

    assert.equal(loaded.agents[0].appearance, undefined);
    assert.ok(loaded.agents[1].appearance);
  });

  it('removes unreferenced agent and workflow files after a save', async () => {
    const root = await tempRoot();
    const store = new Store(root);
    const config = defaults(root);
    await store.save(config);

    const extraAgentFile = path.join(root, '.agent-office', 'agents', 'orphan.md');
    const extraWorkflowFile = path.join(root, '.agent-office', 'workflows', 'orphan.yaml');
    await writeFile(extraAgentFile, 'orphan');
    await writeFile(extraWorkflowFile, 'id: orphan\n');
    await store.save(config);

    await assert.rejects(readFile(extraAgentFile), { code: 'ENOENT' });
    await assert.rejects(readFile(extraWorkflowFile), { code: 'ENOENT' });
  });

  it('recovers the last complete configuration when the published index is malformed', async () => {
    const root = await tempRoot();
    const store = new Store(root);
    const original = await store.load();
    await writeFile(path.join(root, '.agent-office', 'team.yaml'), 'agents: []\nprojects: []\n');

    assert.deepEqual(await store.load(), original);
    assert.ok((await readFile(path.join(root, '.agent-office', 'team.yaml'), 'utf8')).includes('workflowIds:'));
  });

  it('recovers referenced files removed after a published configuration', async () => {
    const root = await tempRoot();
    const store = new Store(root);
    const config = defaults(root);
    await store.save(config);
    await rm(path.join(root, '.agent-office', 'agents', 'planner.md'));
    assert.deepEqual(await store.load(), config);

    await store.save(config);
    await rm(path.join(root, '.agent-office', 'workflows', 'feature.yaml'));
    assert.deepEqual(await store.load(), config);
  });

  it('recovers the previous generation after a failure between split-file writes', async () => {
    const root = await tempRoot();
    const store = new Store(root);
    const original = await store.load();
    const draft = structuredClone(original);
    draft.agents[0].instructions = 'new generation that must publish atomically';

    class FailingStore extends Store {
      writes = 0;
      constructor(rootPath: string, private failAt: number) {
        super(rootPath);
      }
      override async atomic(file: string, contents: string): Promise<void> {
        this.writes += 1;
        if (this.writes === this.failAt) throw new Error('injected split-file failure');
        await super.atomic(file, contents);
      }
    }
    const failing = new FailingStore(root, 2);
    await assert.rejects(failing.save(draft), /injected split-file failure/);
    const recovered = await new Store(root).load();
    assert.deepEqual(recovered, original);
  });

  it('migrates legacy history activity text and preserves a run record', async () => {
    const root = await tempRoot();
    const store = new Store(root);
    const config = await store.load();
    const at = '2026-09-20T12:00:00.000Z';
    const run = {
      id: 'legacy-run',
      projectId: config.projects[0].id,
      workflowId: config.workflows[0].id,
      task: 'legacy task',
      status: 'Done',
      stepId: config.workflows[0].start,
      startedAt: at,
      endedAt: at,
    };
    const agent = config.agents[0];
    await writeFile(path.join(root, '.agent-office', 'history.json'), JSON.stringify({
      agents: {
        [agent.id]: {
          status: 'Done',
          task: 'legacy task',
          lastActivity: 'legacy summary text',
          output: '',
          messages: [{ at, text: 'legacy summary text', direction: 'agent' }],
          result: { status: 'DONE', summary: 'legacy summary text', changed_files: [], issues: [], notes: [] },
        },
      },
      timeline: [{ id: 'legacy-event', at, agentId: agent.id, kind: 'DONE', text: 'legacy summary text' }],
      run,
    }));

    const history = await store.history();
    assert.equal(history?.version, 2);
    assert.equal(history?.runHistory[0]?.id, 'legacy-run');
    assert.equal(history?.runHistory[0]?.config, undefined);
    assert.equal(history?.agents[agent.id]?.lastActivity, 'legacy summary text');
    assert.equal(history?.agents[agent.id]?.lastActivityAt, at);
    assert.equal(history?.timeline[0]?.runId, 'legacy-run');
  });

  it('starts with an empty history and preserves malformed bytes for diagnosis', async () => {
    const root = await tempRoot();
    const store = new Store(root);
    await store.load();
    const file = path.join(root, '.agent-office', 'history.json');
    const malformed = '{"version":2,"agents": []}';
    await writeFile(file, malformed);

    assert.equal(await store.history(), null);
    assert.equal(await readFile(file, 'utf8'), malformed);
    assert.equal(await readFile(file + '.invalid', 'utf8'), malformed);
  });
});

describe('validateConfig', () => {
  it('accepts the shipped defaults', async () => {
    const root = await tempRoot();
    assert.doesNotThrow(() => validateConfig(defaults(root)));
  });

  it('rejects unknown avatar parts, colors, versions, and extra fields', async () => {
    const root = await tempRoot();

    const invalidFace = defaults(root);
    (invalidFace.agents[0].appearance as unknown as Record<string, unknown>).face = '<svg />';
    expectInvalid(invalidFace, /face inválido/i);

    const invalidColor = defaults(root);
    (invalidColor.agents[0].appearance as unknown as Record<string, unknown>).hairColor = '#ffffff';
    expectInvalid(invalidColor, /hairColor inválido/i);

    const invalidVersion = defaults(root);
    (invalidVersion.agents[0].appearance as unknown as Record<string, unknown>).version = 2;
    expectInvalid(invalidVersion, /version inválida/i);

    const extraField = defaults(root);
    (extraField.agents[0].appearance as unknown as Record<string, unknown>).svg = '<svg />';
    expectInvalid(extraField, /campos inválidos/i);
  });

  it('rejects unsafe brand colors, logo sources, oversized images, and extra fields', async () => {
    const root = await tempRoot();

    const invalidColor = defaults(root);
    invalidColor.branding = { primaryColor: 'hotpink', secondaryColor: '#33153D' };
    expectInvalid(invalidColor, /primaryColor/i);

    const remoteLogo = defaults(root);
    remoteLogo.branding = {
      primaryColor: '#FE2B8F',
      secondaryColor: '#33153D',
      logoDataUrl: 'https://example.com/logo.svg',
    };
    expectInvalid(remoteLogo, /logoDataUrl/i);

    const oversizedLogo = defaults(root);
    oversizedLogo.branding = {
      primaryColor: '#FE2B8F',
      secondaryColor: '#33153D',
      logoDataUrl: `data:image/png;base64,${'A'.repeat(700_001)}`,
    };
    expectInvalid(oversizedLogo, /logoDataUrl/i);

    const executableSvg = defaults(root);
    executableSvg.branding = {
      primaryColor: '#FE2B8F',
      secondaryColor: '#33153D',
      logoDataUrl: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`,
    };
    expectInvalid(executableSvg, /conteúdo externo ou executável/i);

    const unknownAsset = defaults(root);
    unknownAsset.branding = {
      primaryColor: '#FE2B8F',
      secondaryColor: '#33153D',
      logoAsset: 'unknown',
    } as never;
    expectInvalid(unknownAsset, /alternativa desconhecida/i);

    const ambiguousLogo = defaults(root);
    ambiguousLogo.branding = {
      primaryColor: '#FE2B8F',
      secondaryColor: '#33153D',
      logoAsset: 'flash',
      logoDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    };
    expectInvalid(ambiguousLogo, /não ambas/i);

    const extraField = defaults(root);
    extraField.branding = {
      primaryColor: '#FE2B8F',
      secondaryColor: '#33153D',
      css: 'body{display:none}',
    } as never;
    expectInvalid(extraField, /campos inválidos/i);
  });

  it('rejects duplicate, malformed, and reserved IDs', async () => {
    const root = await tempRoot();
    const duplicateAgent = defaults(root);
    duplicateAgent.agents[1].id = duplicateAgent.agents[0].id;
    expectInvalid(duplicateAgent, /ID duplicado/);

    const malformedId = defaults(root);
    malformedId.agents[0].id = 'bad/id';
    expectInvalid(malformedId, /ID inválido/);

    const reservedStep = defaults(root);
    reservedStep.workflows[0].steps[0].id = 'done';
    reservedStep.workflows[0].start = 'done';
    expectInvalid(reservedStep, /reservados/);
  });

  it('rejects transitions that use an unknown status or destination', async () => {
    const root = await tempRoot();
    const unknownStatus = defaults(root);
    unknownStatus.workflows[0].steps[0].transitions = { MAYBE: 'tester' } as never;
    expectInvalid(unknownStatus, /Status de transição inválido/);

    const unknownTarget = defaults(root);
    unknownTarget.workflows[0].steps[0].transitions = { DONE: 'missing-step' };
    expectInvalid(unknownTarget, /Destino inválido/);
  });

  it('rejects missing agents, start steps, workflows, active projects, and team members', async () => {
    const root = await tempRoot();

    const missingAgent = defaults(root);
    missingAgent.workflows[0].steps[0].agentId = 'ghost';
    expectInvalid(missingAgent, /Agente da etapa/);

    const missingStart = defaults(root);
    missingStart.workflows[0].start = 'ghost';
    expectInvalid(missingStart, /Etapa inicial não existe/);

    const missingWorkflow = defaults(root);
    missingWorkflow.projects[0].workflowId = 'ghost';
    expectInvalid(missingWorkflow, /Workflow padrão não existe/);

    const missingActiveProject = defaults(root);
    missingActiveProject.activeProjectId = 'ghost';
    expectInvalid(missingActiveProject, /Projeto ativo inválido/);

    const missingTeamMember = defaults(root);
    missingTeamMember.projects[0].agentIds = ['ghost'];
    expectInvalid(missingTeamMember, /Equipe do projeto inválida/);
  });

  it('rejects relative project and agent directories', async () => {
    const root = await tempRoot();
    const relativeProject = defaults(root);
    relativeProject.projects[0].cwd = 'relative';
    expectInvalid(relativeProject, /diretório do projeto precisa ser absoluto/);

    const relativeAgent = defaults(root);
    relativeAgent.agents[0].cwd = 'relative';
    expectInvalid(relativeAgent, /diretório do agente precisa ser absoluto/);
  });
});
