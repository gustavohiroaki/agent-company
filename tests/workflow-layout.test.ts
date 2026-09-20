import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { defaults } from '../server/defaults.js';
import { Store, validateConfig } from '../server/store.js';
import type { Config } from '../shared/types.js';

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-office-workflow-layout-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Workflow layout persistence', () => {
  it('keeps legacy workflows valid when steps have no position', async () => {
    const root = await tempRoot();
    const store = new Store(root);
    const legacy = defaults(root);
    for (const workflow of legacy.workflows) {
      for (const step of workflow.steps) delete step.position;
    }

    assert.doesNotThrow(() => validateConfig(legacy));
    await store.save(legacy);
    const loaded = await store.load();

    assert.deepEqual(loaded, legacy);
    assert.ok(
      loaded.workflows.every((workflow) =>
        workflow.steps.every((step) => step.position === undefined),
      ),
    );
  });

  it('round-trips finite bounded positions through workflow YAML', async () => {
    const root = await tempRoot();
    const store = new Store(root);
    const original = defaults(root);
    original.workflows[0].steps[0].position = { x: 0, y: 100000 };
    original.workflows[0].steps[1].position = { x: 240.5, y: 512.25 };

    await store.save(original);
    const loaded = await store.load();
    const yaml = YAML.parse(
      await readFile(
        path.join(root, '.agent-office', 'workflows', `${original.workflows[0].id}.yaml`),
        'utf8',
      ),
    );

    assert.deepEqual(loaded, original);
    assert.deepEqual(yaml.steps[0].position, { x: 0, y: 100000 });
    assert.deepEqual(yaml.steps[1].position, { x: 240.5, y: 512.25 });
  });

  it('rejects positions outside the finite 0..100000 contract', async () => {
    const root = await tempRoot();
    const cases: Array<[string, (position: Record<string, unknown>) => void]> = [
      ['NaN x', (position) => { position.x = Number.NaN; }],
      ['infinite y', (position) => { position.y = Number.POSITIVE_INFINITY; }],
      ['negative x', (position) => { position.x = -0.01; }],
      ['too large y', (position) => { position.y = 100000.01; }],
      ['missing y', (position) => { delete position.y; }],
      ['string x', (position) => { position.x = '240'; }],
      ['null position', () => { /* replaced below */ }],
      ['array position', () => { /* replaced below */ }],
      ['primitive position', () => { /* replaced below */ }],
    ];

    for (const [label, mutate] of cases) {
      const config = defaults(root);
      const position = { x: 120, y: 240 } as Record<string, unknown>;
      if (label === 'null position') config.workflows[0].steps[0].position = null as never;
      else if (label === 'array position') config.workflows[0].steps[0].position = [] as never;
      else if (label === 'primitive position') config.workflows[0].steps[0].position = '120,240' as never;
      else {
        mutate(position);
        config.workflows[0].steps[0].position = position as never;
      }
      assert.throws(
        () => validateConfig(config),
        /posição inválida/i,
        label,
      );
    }
  });
});
