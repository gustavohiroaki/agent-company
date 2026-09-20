import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessRunner } from '../server/runner.js';
import type { Agent } from '../shared/types.js';

for (const scenario of [
  { name: 'an unexpected process signal is ERROR', source: "process.kill(process.pid, 'SIGTERM')", expected: 'ERROR' },
  { name: 'exit zero without a structured result is DONE, never PASS', source: "console.log('finished')", expected: 'DONE' },
  { name: 'nonzero exit overrides a claimed PASS', source: `console.log(JSON.stringify({status:'PASS',summary:'claimed success',changed_files:[],issues:[],notes:[]}));process.exitCode=7`, expected: 'ERROR' },
]) {
  test(scenario.name, async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'office-error-'));
    const runner = new ProcessRunner();
    const agent: Agent = { id: 'fixture', name: 'Fixture', role: 'Developer', area: 'Dev Lab', avatar: 'FX', cli: process.execPath, args: ['-e', scenario.source], model: '', cwd, instructions: '', timeoutMs: 2000 };
    try {
      await runner.start(agent);
      const result = await runner.execute(agent.id, { prompt: 'test', cwd });
      assert.equal(result.status, scenario.expected);
    } finally {
      await runner.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test('prompt placeholders remain literal within user content and overwrite inherited context', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'office-prompt-'));
  const runner = new ProcessRunner();
  const prompt = 'Keep {model} and {cwd} literally, including ação.';
  const source = `console.log(JSON.stringify({status:'DONE',summary:process.argv[1],changed_files:[],issues:[],notes:[process.env.AGENT_OFFICE_PROMPT]}))`;
  const agent: Agent = { id: 'fixture', name: 'Fixture', role: 'Developer', area: 'Dev Lab', avatar: 'FX', cli: process.execPath, args: ['-e', source, '{prompt}'], model: 'different-model', cwd, instructions: '', timeoutMs: 2000 };
  const inherited = process.env.AGENT_OFFICE_PROMPT;
  process.env.AGENT_OFFICE_PROMPT = 'stale inherited prompt';
  try {
    await runner.start(agent);
    const result = await runner.execute(agent.id, { prompt, cwd });
    assert.equal(result.summary, prompt);
    assert.deepEqual(result.notes, [prompt]);
  } finally {
    if (inherited === undefined) delete process.env.AGENT_OFFICE_PROMPT;
    else process.env.AGENT_OFFICE_PROMPT = inherited;
    await runner.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
