import { chromium } from "playwright";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Independent browser coverage for the visual workflow editor.
 *
 * The editor intentionally exposes data-step-id/data-status attributes. They
 * keep this test independent of copy, CSS and the order of controls while the
 * accessible names below still exercise the keyboard fallback.
 */

const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifacts = path.join(repo, "artifacts");
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), "agent-office-workflow-browser-"));
const fixture = path.join(root, "workflow-fixture.mjs");
const pidFile = path.join(root, "workflow-fixture.pid");
await writeFile(
  fixture,
  `
import fs from 'node:fs';
const pidFile = ${JSON.stringify(pidFile)};
const prompt = process.argv.slice(2).join('\\n');
if (prompt.includes('WORKFLOW_HANG')) {
  fs.writeFileSync(pidFile, String(process.pid));
  process.stdin.resume();
  process.stdin.on('data', () => {});
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({status:'DONE', summary:'workflow browser fixture completed', changed_files:[], issues:[], notes:[]}));
}
`,
  { mode: 0o700 },
);

const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  cwd: repo,
  env: {
    ...process.env,
    NODE_ENV: "production",
    AGENT_OFFICE_ROOT: root,
    PORT: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
child.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
child.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

async function waitForServer(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = serverOutput.match(/Agent Office: http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) return `http://127.0.0.1:${match[1]}`;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`server did not start: ${serverOutput}`);
}

async function apiState(baseUrl) {
  const response = await fetch(`${baseUrl}/api/state`);
  if (!response.ok) throw new Error(`GET /api/state failed (${response.status})`);
  return response.json();
}

async function saveConfig(baseUrl, config, expectedRevision) {
  const response = await fetch(`${baseUrl}/api/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config, expectedRevision }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`PUT /api/config failed (${response.status}): ${text}`);
  return JSON.parse(text);
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForText(page, text, timeout = 8000) {
  await page.getByText(text, { exact: true }).first().waitFor({ state: "visible", timeout });
}

async function waitForRunStatus(page, text, timeout = 8000) {
  await page.locator(".run-pill").filter({ hasText: text }).waitFor({ state: "visible", timeout });
}

async function workflowCanvas(page) {
  const canvas = page.locator('[data-testid="workflow-canvas"], .workflow-canvas, .workflow-canvas-card').first();
  await canvas.waitFor({ state: "visible" });
  return canvas;
}

async function stepNode(page, stepId) {
  const index = preparedWorkflow.steps.findIndex((step) => step.id === stepId);
  const byId = page.locator(`[data-step-id="${stepId}"]`).first();
  const node = (await byId.count()) > 0 ? byId : page.locator('.workflow-canvas-node').nth(index);
  await node.waitFor({ state: "visible" });
  return node;
}

async function outputPort(page, stepId, status) {
  const node = await stepNode(page, stepId);
  const byStatus = node.locator(
    `[data-status="${status}"], [data-output-status="${status}"], [data-port-status="${status}"]`,
  ).first();
  const port = (await byStatus.count()) > 0
    ? byStatus
    : node.getByRole("button", { name: new RegExp(`Saída ${status}`) }).first();
  await port.waitFor({ state: "visible" });
  return port;
}

async function inputPort(page, stepId) {
  const node = await stepNode(page, stepId);
  const port = node.locator('[data-input-handle], [data-input-port], [data-port="input"], .workflow-node-input').first();
  return (await port.count()) > 0 ? port : node;
}

async function dragBetween(page, from, to) {
  const sourceBox = await from.boundingBox();
  const targetBox = await to.boundingBox();
  requireCondition(sourceBox && targetBox, "workflow connection endpoints are not measurable");
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 12 });
  await page.mouse.up();
}

async function connectByDrag(page, fromStep, status, toStep) {
  await dragBetween(page, await outputPort(page, fromStep, status), await inputPort(page, toStep));
}

async function connectByClick(page, fromStep, status, toStep) {
  await (await outputPort(page, fromStep, status)).click();
  await (await inputPort(page, toStep)).click();
}

async function terminal(page, target) {
  const button = page.locator(`[data-target="${target}"]`).first();
  await button.waitFor({ state: "visible" });
  return button;
}

async function connectByDragToTerminal(page, fromStep, status, target) {
  await dragBetween(page, await outputPort(page, fromStep, status), await terminal(page, target));
}

async function connectByClickToTerminal(page, fromStep, status, target) {
  await (await outputPort(page, fromStep, status)).click();
  await (await terminal(page, target)).click();
}

async function clickNamed(page, patterns, description) {
  for (const pattern of patterns) {
    const button = page.getByRole("button", { name: pattern }).first();
    if ((await button.count()) > 0 && await button.isVisible().catch(() => false)) {
      await button.click();
      return;
    }
  }
  throw new Error(`missing ${description} control`);
}

async function waitForPersistedWorkflow(baseUrl, workflowId, beforeRevision, predicate, description, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastState;
  while (Date.now() < deadline) {
    lastState = await apiState(baseUrl);
    const workflow = lastState.config.workflows.find((item) => item.id === workflowId);
    // configRevision is content-addressed; adding and removing a draft step
    // can legitimately save the same final bytes and keep the prior revision.
    // The completed save-button transition proves the request finished, while
    // this predicate verifies the persisted API state.
    if (workflow && predicate(workflow)) {
      return lastState;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const workflow = lastState?.config.workflows.find((item) => item.id === workflowId);
  throw new Error(`timed out waiting for ${description}; revision changed=${lastState?.configRevision !== beforeRevision}; persisted workflow=${JSON.stringify(workflow)}`);
}

async function saveWorkflowDraft(page, baseUrl, workflowId, predicate, description) {
  const button = page.locator(".save-button").first();
  await button.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const saveButton = document.querySelector(".save-button");
    return saveButton && !saveButton.disabled && saveButton.classList.contains("is-dirty") && saveButton.textContent?.includes("Salvar mudanças");
  }, undefined, { timeout: 8000 });
  const before = await apiState(baseUrl);
  await button.click();
  await page.waitForFunction(() => {
    const saveButton = document.querySelector(".save-button");
    return saveButton && saveButton.disabled && !saveButton.classList.contains("is-dirty") && saveButton.textContent?.includes("Tudo salvo");
  }, undefined, { timeout: 8000 });
  return waitForPersistedWorkflow(baseUrl, workflowId, before.configRevision, predicate, description);
}

async function selectStartStep(page, stepId) {
  for (const pattern of [/Definir como início/i, /Tornar.*início/i, /Definir.*início/i]) {
    const button = page.getByRole("button", { name: pattern }).first();
    if ((await button.count()) > 0 && await button.isVisible().catch(() => false)) {
      await button.click();
      return;
    }
  }
  const select = page.getByLabel("Começa em", { exact: true }).first();
  if ((await select.count()) > 0 && await select.isVisible().catch(() => false)) {
    await select.selectOption(stepId);
    return;
  }
  throw new Error("missing start-step control");
}

async function waitForPid(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(file, "utf8")).trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // Fixture has not reached the hanging branch yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("timed out waiting for workflow fixture PID");
}

async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  requireCondition(!overflow, `${label} has horizontal document overflow`);
}

const baseUrl = await waitForServer();
const initial = await apiState(baseUrl);
const workflow = initial.config.workflows.find((item) => item.id === "simple") ?? initial.config.workflows[0];
const developer = workflow.steps.find((step) => step.id === "developer") ?? workflow.steps[0];
const tester = workflow.steps.find((step) => step.id === "tester") ?? workflow.steps[1];
requireCondition(Boolean(developer && tester), "the fixture workflow needs two steps");
const prepared = structuredClone(initial.config);
const preparedWorkflow = prepared.workflows.find((item) => item.id === workflow.id);
const preparedDeveloper = preparedWorkflow.steps.find((step) => step.id === developer.id);
const preparedTester = preparedWorkflow.steps.find((step) => step.id === tester.id);
prepared.agents = prepared.agents.map((agent) =>
  [developer.agentId, tester.agentId].includes(agent.id)
    ? { ...agent, cli: process.execPath, cwd: root, model: "", args: [fixture, "{prompt}"] }
    : agent,
);
prepared.projects = prepared.projects.map((project) =>
  project.id === prepared.activeProjectId
    ? {
        ...project,
        workflowId: preparedWorkflow.id,
        cwd: root,
        agentIds: [...new Set([...project.agentIds, developer.agentId, tester.agentId])],
      }
    : project,
);
preparedWorkflow.start = preparedDeveloper.id;
preparedWorkflow.maxSteps = Math.max(preparedWorkflow.maxSteps, 8);
preparedDeveloper.position = { x: 120, y: 140 };
preparedTester.position = { x: 520, y: 140 };
// Start with the transitions exercised by this test empty. Otherwise a broken
// gesture could appear to pass simply because the seed already had the target.
preparedDeveloper.transitions = {};
preparedTester.transitions = {};
const seeded = await saveConfig(baseUrl, prepared, initial.configRevision);

const browser = await chromium.launch({ headless: true });
const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
desktop.setDefaultTimeout(5000);
mobile.setDefaultTimeout(5000);

try {
  await desktop.goto(baseUrl, { waitUntil: "networkidle" });
  await desktop.getByRole("button", { name: "Workflow", exact: true }).click();
  await waitForText(desktop, "Workflows");
  const canvas = await workflowCanvas(desktop);
  const developerNode = await stepNode(desktop, preparedDeveloper.id);
  const testerNode = await stepNode(desktop, preparedTester.id);
  await desktop.screenshot({ path: path.join(artifacts, "workflow-editor-initial.png"), fullPage: true });
  const beforeDrag = await developerNode.boundingBox();
  requireCondition(beforeDrag, "developer node has no bounding box before drag");

  // Pointer drag moves a node and the new position is a draft until save.
  const dragHandle = developerNode.locator('[data-drag-handle], .workflow-node-header, .workflow-node-title').first();
  await dragBetween(desktop, (await dragHandle.count()) > 0 ? dragHandle : developerNode, canvas);
  const afterDrag = await developerNode.boundingBox();
  requireCondition(
    afterDrag && (Math.abs(afterDrag.x - beforeDrag.x) > 4 || Math.abs(afterDrag.y - beforeDrag.y) > 4),
    "dragging a workflow node did not move it",
  );

  // Exercise all four statuses with both node and terminal targets. PASS is
  // dragged to the success terminal, ERROR uses the click fallback, DONE is
  // dragged to the tester node, and FAIL is clicked back to developer.
  await connectByDragToTerminal(desktop, preparedDeveloper.id, "PASS", "done");
  await connectByDrag(desktop, preparedDeveloper.id, "DONE", preparedTester.id);
  await connectByClick(desktop, preparedTester.id, "FAIL", preparedDeveloper.id);
  await connectByClickToTerminal(desktop, preparedTester.id, "ERROR", "error");
  await desktop.keyboard.press("Escape");
  let saved = await saveWorkflowDraft(
    desktop,
    baseUrl,
    preparedWorkflow.id,
    (candidate) => candidate.steps.find((step) => step.id === preparedDeveloper.id)?.transitions.PASS === "done" && candidate.steps.find((step) => step.id === preparedDeveloper.id)?.transitions.DONE === preparedTester.id && candidate.steps.find((step) => step.id === preparedTester.id)?.transitions.FAIL === preparedDeveloper.id && candidate.steps.find((step) => step.id === preparedTester.id)?.transitions.ERROR === "error",
    "initial workflow connections",
  );
  let savedWorkflow = saved.config.workflows.find((item) => item.id === preparedWorkflow.id);
  requireCondition(savedWorkflow.steps.find((step) => step.id === preparedDeveloper.id).transitions.DONE === preparedTester.id, "drag connection was not persisted");
  requireCondition(savedWorkflow.steps.find((step) => step.id === preparedTester.id).transitions.FAIL === preparedDeveloper.id, "click connection was not persisted");
  const persistedDeveloperPosition = savedWorkflow.steps.find((step) => step.id === preparedDeveloper.id).position;
  requireCondition(
    persistedDeveloperPosition &&
      (persistedDeveloperPosition.x !== 120 || persistedDeveloperPosition.y !== 140),
    "dragged position was not persisted as a changed coordinate",
  );

  // Select and delete the edge, then restore it through the click fallback.
  const edge = desktop.locator(`[data-edge-from="${preparedTester.id}"][data-edge-status="FAIL"], [data-edge-source="${preparedTester.id}"][data-edge-status="FAIL"], .workflow-edge-group`).filter({ hasText: "FAIL" }).first();
  await edge.waitFor({ state: "visible" });
  await edge.click();
  await desktop.keyboard.press("Delete");
  saved = await saveWorkflowDraft(
    desktop,
    baseUrl,
    preparedWorkflow.id,
    (candidate) => !candidate.steps.find((step) => step.id === preparedTester.id)?.transitions.FAIL,
    "edge deletion",
  );
  savedWorkflow = saved.config.workflows.find((item) => item.id === preparedWorkflow.id);
  requireCondition(!savedWorkflow.steps.find((step) => step.id === preparedTester.id).transitions.FAIL, "deleting an edge left the transition persisted");
  await connectByClick(desktop, preparedTester.id, "FAIL", preparedDeveloper.id);
  // Persist the restored edge before changing the selected start step so a
  // later failure identifies whether the click fallback or another editor
  // action dropped the cycle.
  saved = await saveWorkflowDraft(
    desktop,
    baseUrl,
    preparedWorkflow.id,
    (candidate) => candidate.steps.find((step) => step.id === preparedTester.id)?.transitions.FAIL === preparedDeveloper.id,
    "edge restoration",
  );
  savedWorkflow = saved.config.workflows.find((item) => item.id === preparedWorkflow.id);
  requireCondition(
    savedWorkflow.steps.find((step) => step.id === preparedTester.id).transitions.FAIL === preparedDeveloper.id,
    `click restoration was not persisted (${JSON.stringify(savedWorkflow.steps.find((step) => step.id === preparedTester.id).transitions)})`,
  );

  // Start selection and node deletion use visible controls, not API shortcuts.
  await testerNode.locator('.workflow-node-header').click();
  await selectStartStep(desktop, preparedTester.id);
  saved = await saveWorkflowDraft(
    desktop,
    baseUrl,
    preparedWorkflow.id,
    (candidate) => candidate.start === preparedTester.id,
    "start selection",
  );
  savedWorkflow = saved.config.workflows.find((item) => item.id === preparedWorkflow.id);
  requireCondition(savedWorkflow.start === preparedTester.id, "start-step selection was not persisted");

  await desktop.getByRole("tab", { name: "Lista", exact: true }).click();
  await clickNamed(desktop, [/Adicionar (etapa|passo)/i], "add workflow step");
  const nodesAfterAdd = desktop.locator("[data-step-id]");
  const addedNodeCount = await nodesAfterAdd.count();
  requireCondition(addedNodeCount >= 3, "adding a workflow step did not create a canvas node");
  const stepIdsAfterAdd = await nodesAfterAdd.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-step-id")));
  const addedStepId = stepIdsAfterAdd.find((stepId) => stepId && ![preparedDeveloper.id, preparedTester.id].includes(stepId));
  requireCondition(Boolean(addedStepId), "added workflow step has no stable data-step-id");
  const addedCard = desktop.locator(`.steps-list [data-step-id="${addedStepId}"]`).first();
  await addedCard.click();
  const removeAddedNode = addedCard.getByRole("button", { name: /Remover (etapa|passo|nó)|Excluir (etapa|passo|nó)/i }).first();
  await removeAddedNode.click();
  await desktop.waitForFunction(() => document.querySelectorAll(".steps-list [data-step-id]").length === 2, undefined, { timeout: 5000 });
  saved = await saveWorkflowDraft(
    desktop,
    baseUrl,
    preparedWorkflow.id,
    (candidate) => candidate.steps.length === 2,
    "node deletion",
  );
  savedWorkflow = saved.config.workflows.find((item) => item.id === preparedWorkflow.id);
  requireCondition(savedWorkflow.steps.length === 2, "deleting a workflow node did not persist");

  // Organize and zoom are observable canvas actions and must not alter edges.
  await desktop.getByRole("tab", { name: "Mapa", exact: true }).click();
  const beforeOrganize = await (await stepNode(desktop, preparedDeveloper.id)).boundingBox();
  await clickNamed(desktop, [/Organizar/i, /Auto.?layout/i], "organize");
  await clickNamed(desktop, [/Aumentar zoom/i, /Aproximar mapa/i, /Zoom \+/i, /Ampliar/i], "zoom in");
  await clickNamed(desktop, [/Diminuir zoom/i, /Afastar mapa/i, /Zoom -/i, /Reduzir/i], "zoom out");
  await clickNamed(desktop, [/Restaurar zoom/i, /Reset.*zoom/i, /Zoom 100/i, /^Ajustar$/i, /Ajustar mapa/i], "zoom reset");
  const afterOrganize = await (await stepNode(desktop, preparedDeveloper.id)).boundingBox();
  requireCondition(beforeOrganize && afterOrganize, "organized node has no bounding box");
  saved = await saveWorkflowDraft(
    desktop,
    baseUrl,
    preparedWorkflow.id,
    (candidate) => candidate.steps.every((step) => Number.isFinite(step.position?.x) && Number.isFinite(step.position?.y)),
    "organized layout",
  );

  // Reload is a real persistence check for coordinates and transitions.
  await desktop.reload({ waitUntil: "networkidle" });
  await desktop.getByRole("button", { name: "Workflow", exact: true }).click();
  await waitForText(desktop, "Workflows");
  await stepNode(desktop, preparedDeveloper.id);
  saved = await apiState(baseUrl);
  savedWorkflow = saved.config.workflows.find((item) => item.id === preparedWorkflow.id);
  requireCondition(savedWorkflow.start === preparedTester.id, "start selection was lost after reload");
  requireCondition(savedWorkflow.steps.find((step) => step.id === preparedTester.id).transitions.FAIL === preparedDeveloper.id, "cycle transition was lost after reload");
  requireCondition(savedWorkflow.steps.every((step) => Number.isFinite(step.position?.x) && Number.isFinite(step.position?.y)), "saved workflow positions are not finite after reload");

  // Keyboard fallback: a node is reachable without pointer-only interaction,
  // and Escape cancels an in-progress connection.
  const keyboardNode = await stepNode(desktop, preparedDeveloper.id);
  await keyboardNode.focus();
  requireCondition(await keyboardNode.evaluate((element) => document.activeElement === element || element.contains(document.activeElement)), "workflow node is not keyboard focusable");
  await desktop.keyboard.press("Enter");
  await desktop.keyboard.press("Escape");

  await desktop.screenshot({ path: path.join(artifacts, "workflow-editor-desktop.png"), fullPage: true });

  // Run lock: a hanging local fixture makes all workflow controls read-only.
  await desktop.getByRole("button", { name: "Run", exact: true }).click();
  await waitForText(desktop, "O trabalho acontece aqui.");
  const task = desktop.locator(".task-field textarea");
  await task.fill("WORKFLOW_HANG");
  await desktop.getByRole("button", { name: "Iniciar workflow", exact: true }).click();
  await waitForRunStatus(desktop, "Em execução");
  await waitForPid(pidFile);
  requireCondition(await desktop.getByRole("button", { name: "Workflow", exact: true }).isDisabled(), "Workflow navigation stayed editable during a run");
  requireCondition(await desktop.locator(".save-button").isDisabled(), "save stayed enabled during a run");
  await desktop.getByRole("button", { name: "Parar execução", exact: true }).click();
  await waitForRunStatus(desktop, "Parado");

  await mobile.goto(baseUrl, { waitUntil: "networkidle" });
  await mobile.getByRole("button", { name: "Workflow", exact: true }).click();
  await waitForText(mobile, "Workflows");
  await workflowCanvas(mobile);
  await assertNoHorizontalOverflow(mobile, "workflow editor at 390px");
  await mobile.screenshot({ path: path.join(artifacts, "workflow-editor-mobile.png"), fullPage: true });
  console.log("workflow browser validation passed");
} finally {
  await browser.close();
  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await rm(root, { recursive: true, force: true });
}
