import { chromium } from "playwright";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifacts = path.join(repo, "artifacts");
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), "agent-office-browser-"));
const fixture = path.join(root, "ui-fixture.mjs");
const pidFile = path.join(root, "ui-fixture.pid");
const fixtureSource = `
const fs = await import('node:fs');
const pidFile = ${JSON.stringify(pidFile)};
const prompt = process.argv.slice(2).join('\\n');
if (prompt.includes('UI_HANG')) {
  fs.writeFileSync(pidFile, String(process.pid));
  fs.appendFileSync(pidFile + '.log', String(process.pid) + '\\n');
  process.stdin.resume();
  process.stdin.on('data', () => {});
  setInterval(() => {}, 1000);
} else if (prompt.includes('UI_STDIN_CLOSED')) {
  fs.closeSync(0);
  setInterval(() => console.log('snapshot after stdin close'), 80);
} else if (prompt.includes('UI_EVIDENCE')) {
  process.stdout.write('evidence SEARCH_ME\\n'.repeat(6000));
  console.log(JSON.stringify({status:'DONE', summary:'fixture evidence completed', changed_files:['declared-from-fixture.txt'], issues:['declared issue from fixture'], notes:['declared note from fixture']}));
} else {
  console.log(JSON.stringify({status:'DONE', summary:'fixture UI completed', changed_files:[], issues:[], notes:[]}));
}
`;
await writeFile(fixture, fixtureSource, { mode: 0o700 });

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
child.stdout.on("data", (chunk) => {
  serverOutput += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  serverOutput += chunk.toString();
});
const childClosed = new Promise((resolve) => child.once("close", resolve));

async function waitForServer(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = serverOutput.match(
      /Agent Office: http:\/\/127\.0\.0\.1:(\d+)/,
    );
    if (match) return `http://127.0.0.1:${match[1]}`;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not start: ${serverOutput}`);
}

async function waitForText(page, text, timeout = 8_000) {
  await page
    .getByText(text, { exact: true })
    .first()
    .waitFor({ state: "visible", timeout });
}

async function selectResource(page, text) {
  const row = page.locator(".resource-row").filter({ hasText: text }).first();
  await row.waitFor({ state: "visible" });
  await row.click();
}

async function configureAgent(page, name, cli, cwd, exerciseJson = false) {
  await selectResource(page, name);
  await page.getByLabel("CLI", { exact: true }).fill(cli);
  await page.getByLabel("Diretório padrão", { exact: true }).fill(cwd);
  const advanced = page.locator(".advanced-details").first();
  if ((await advanced.getAttribute("open")) === null)
    await advanced.locator("summary").click();
  const args = page.locator(".args-field textarea");
  await args.scrollIntoViewIfNeeded();
  if (exerciseJson) {
    await advanced.getByRole("button", { name: "JSON", exact: true }).click();
    await args.fill("");
    await args.type("[", { delay: 5 });
    const error = page.locator(".args-field .field-error");
    await error.waitFor({ state: "visible" });
    if ((await args.inputValue()) !== "[")
      throw new Error(
        "JSON editor lost the partial value while reporting a parse error",
      );
    await args.fill(JSON.stringify([fixture, "{prompt}"]));
    await error.waitFor({ state: "hidden" });
  } else {
    await args.fill(`${fixture}\n{prompt}`);
  }
  await page
    .getByPlaceholder("Como este agente deve trabalhar…")
    .fill("Run the local browser fixture and report DONE.");
}

async function waitForRunStatus(page, statusText, timeout = 8_000) {
  await page
    .locator(".run-pill")
    .filter({ hasText: statusText })
    .waitFor({ state: "visible", timeout });
}

async function apiState(baseUrl) {
  const response = await fetch(`${baseUrl}/api/state`);
  if (!response.ok)
    throw new Error(`state request failed (${response.status})`);
  return response.json();
}

async function waitForPidCount(file, count, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const lines = (await readFile(file, "utf8"))
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      if (lines.length >= count) return lines.map(Number);
    } catch {
      // The first hanging fixture has not started yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `timed out waiting for ${count} fixture process starts in ${file}`,
  );
}

async function waitForHistory(file, predicate, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (predicate(value)) return value;
    } catch {
      // The engine may still be flushing the latest run.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for persisted history in ${file}`);
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertNoMobileOverflow(page, screenName) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  requireCondition(
    !overflow,
    `${screenName} has horizontal document overflow at 390px`,
  );
}

async function assertAccessibleBasics(page) {
  const unnamed = await page
    .locator("button, input, textarea, select")
    .evaluateAll((elements) =>
      elements
        .filter((element) => {
          const labels = element.labels
            ? [...element.labels]
                .map((label) => label.textContent?.trim())
                .filter(Boolean)
            : [];
          const name =
            element.getAttribute("aria-label") ||
            element.getAttribute("title") ||
            labels.join(" ") ||
            element.getAttribute("placeholder") ||
            element.textContent?.trim();
          return !name;
        })
        .map((element) => `${element.tagName}.${element.className}`),
    );
  requireCondition(
    unnamed.length === 0,
    `unnamed interactive controls: ${unnamed.join(", ")}`,
  );
  requireCondition(
    (await page
      .locator('[aria-live="polite"], [aria-live="assertive"]')
      .count()) > 0,
    "important state changes have no aria-live region",
  );
  await page.locator("body").click({ position: { x: 8, y: 8 } });
  await page.keyboard.press("Tab");
  const focusEvidence = await page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return null;
    const style = getComputedStyle(element);
    return {
      tag: element.tagName,
      outline: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      shadow: style.boxShadow,
    };
  });
  requireCondition(
    Boolean(
      focusEvidence &&
      (focusEvidence.outline !== "none" ||
        focusEvidence.outlineWidth !== "0px" ||
        focusEvidence.shadow !== "none"),
    ),
    `keyboard focus is not visibly indicated: ${JSON.stringify(focusEvidence)}`,
  );
}

async function assertTextContrast(page) {
  const values = await page.evaluate(() => {
    const parse = (value) => {
      const match = value.match(
        /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/,
      );
      if (!match || (match[4] !== undefined && Number(match[4]) === 0))
        return null;
      return [Number(match[1]), Number(match[2]), Number(match[3])];
    };
    const luminance = (rgb) =>
      rgb
        .map((channel) => channel / 255)
        .map((channel) =>
          channel <= 0.03928
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4,
        )
        .reduce(
          (sum, channel, index) =>
            sum + channel * [0.2126, 0.7152, 0.0722][index],
          0,
        );
    const contrast = (foreground, background) => {
      const light = Math.max(luminance(foreground), luminance(background));
      const dark = Math.min(luminance(foreground), luminance(background));
      return (light + 0.05) / (dark + 0.05);
    };
    const background = (element) => {
      let current = element;
      while (current) {
        const color = parse(getComputedStyle(current).backgroundColor);
        if (color) return color;
        current = current.parentElement;
      }
      return [255, 253, 250];
    };
    const selectors = [
      "h1",
      ".intro-copy",
      ".button-primary",
      ".field-label",
      ".panel-heading p",
      ".run-status-grid strong",
      ".diagnostic-issues article p",
    ];
    return selectors.flatMap((selector) =>
      [...document.querySelectorAll(selector)].slice(0, 2).map((element) => ({
        selector,
        text: (element.textContent || "").trim().slice(0, 50),
        ratio: contrast(
          parse(getComputedStyle(element).color) || [0, 0, 0],
          background(element),
        ),
      })),
    );
  });
  const failures = values.filter((item) => item.ratio < 4.5);
  requireCondition(
    failures.length === 0,
    `text contrast below 4.5:1: ${JSON.stringify(failures)}`,
  );
}

async function assertReducedMotion(page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  requireCondition(
    await page.evaluate(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
    "Chromium did not apply prefers-reduced-motion",
  );
  const animated = await page
    .locator(".spin, .connection-connecting, .live-tag span")
    .evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).animationDuration),
    );
  requireCondition(
    animated.every((duration) => duration === "0.001ms" || duration === "0s"),
    `reduced motion left long animations active: ${animated.join(", ")}`,
  );
}

const baseUrl = await waitForServer();
const browser = await chromium.launch({ headless: true });
const desktop = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
const mobile = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
});
const second = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
desktop.setDefaultTimeout(4_000);
mobile.setDefaultTimeout(4_000);
second.setDefaultTimeout(4_000);

try {
  await desktop.goto(baseUrl, { waitUntil: "networkidle" });
  await waitForText(desktop, "O trabalho acontece aqui.");
  await waitForText(desktop, "Ao vivo");

  // The first-run guide is local and deterministic. Its diagnostic request must
  // render actionable issues/checks without launching any configured CLI.
  await desktop.locator(".demo-guide summary").click();
  await desktop
    .getByText(
      "Essa demonstração usa arquivos locais e não exige editar YAML.",
      { exact: false },
    )
    .waitFor({ state: "visible" });
  await desktop
    .getByRole("button", { name: "Diagnóstico local", exact: true })
    .click();
  await desktop
    .getByText("Detalhes verificados pelo servidor local", { exact: true })
    .waitFor({ state: "visible" });
  await desktop
    .getByText("não verificado", { exact: true })
    .first()
    .waitFor({ state: "visible" });
  requireCondition(
    (await desktop.locator(".diagnostic-issues article").count()) > 0,
    "diagnostic issues were not rendered",
  );

  // Edit both steps used by the shipped Simple workflow to run a harmless local fixture.
  await desktop.getByRole("button", { name: "Team", exact: true }).click();
  await waitForText(desktop, "Equipe");
  await configureAgent(desktop, "Developer", process.execPath, root, true);
  await configureAgent(desktop, "Tester", process.execPath, root);

  // An invalid JSON draft on an unreferenced agent must disappear with the agent and
  // must not block saving the remaining valid configuration.
  await desktop
    .getByRole("button", { name: "Agente em branco", exact: true })
    .click();
  const blankAgentTitle = desktop.locator(".editor-person-title h2");
  await blankAgentTitle.waitFor({ state: "visible" });
  requireCondition(
    (await blankAgentTitle.textContent())?.startsWith("New agent"),
    "blank agent was not created",
  );
  const blankAdvanced = desktop.locator(".advanced-details").first();
  if ((await blankAdvanced.getAttribute("open")) === null)
    await blankAdvanced.locator("summary").click();
  await blankAdvanced
    .getByRole("button", { name: "JSON", exact: true })
    .click();
  const blankArgs = desktop.locator(".args-field textarea");
  await blankArgs.fill("[");
  await desktop
    .locator(".args-field .field-error")
    .waitFor({ state: "visible" });
  desktop.once("dialog", (dialog) => dialog.accept());
  await desktop.locator('button[title="Remover agente"]').click();
  await desktop
    .getByRole("button", { name: "Salvar mudanças", exact: true })
    .click();
  await waitForText(desktop, "Tudo salvo");

  // Create a project through the UI and make it runnable by the edited workflow team.
  await desktop.getByRole("button", { name: "Projects", exact: true }).click();
  await waitForText(desktop, "Projetos");
  await desktop
    .getByRole("button", { name: "Novo projeto", exact: true })
    .click();
  await desktop.getByLabel("Nome", { exact: true }).fill("UI Fixture Project");
  await desktop.getByLabel("Diretório de trabalho", { exact: true }).fill(root);
  await desktop
    .locator("label.field-label")
    .filter({ hasText: "Workflow padrão" })
    .locator("select")
    .selectOption({ label: "Simple" });
  const teamChecks = desktop.locator(".check-option");
  for (const label of ["Developer", "Tester"]) {
    const option = teamChecks
      .filter({ hasText: label })
      .first()
      .locator('input[type="checkbox"]');
    if (!(await option.isChecked())) await option.check();
  }

  // Configure the terminal DONE transition for the tester step.
  await desktop.getByRole("button", { name: "Workflow", exact: true }).click();
  await waitForText(desktop, "Workflows");
  await selectResource(desktop, "Simple");
  const testerCard = desktop.locator(".workflow-step-card").nth(1);
  // Keep a bounded correction loop valid: Tester PASS returns to Developer and
  // DONE still terminates the workflow.
  await testerCard
    .locator(".transition-select")
    .nth(0)
    .selectOption("developer");
  await testerCard.locator(".transition-select").nth(2).selectOption("done");

  // Add, remove, and add a step again. Each saved config must keep unique IDs and
  // the replacement step must receive a fresh ID.
  const initialState = await apiState(baseUrl);
  const initialWorkflow = initialState.config.workflows.find(
    (workflow) => workflow.id === "simple",
  );
  const initialIds = initialWorkflow.steps.map((step) => step.id);
  requireCondition(
    new Set(initialIds).size === initialIds.length,
    "initial workflow step IDs are duplicated",
  );
  await desktop
    .getByRole("button", { name: "Adicionar passo", exact: true })
    .click();
  requireCondition(
    (await desktop.locator(".workflow-step-card").count()) ===
      initialIds.length + 1,
    "adding a workflow step did not render a new card",
  );
  await desktop
    .getByRole("button", { name: "Salvar mudanças", exact: true })
    .click();
  await waitForText(desktop, "Tudo salvo");
  const addedState = await apiState(baseUrl);
  const addedIds = addedState.config.workflows
    .find((workflow) => workflow.id === "simple")
    .steps.map((step) => step.id);
  requireCondition(
    addedIds.length === initialIds.length + 1 &&
      new Set(addedIds).size === addedIds.length,
    "adding a workflow step produced duplicate IDs",
  );
  const removedId = addedIds.at(-1);
  await desktop
    .locator(".workflow-step-card")
    .last()
    .locator('button[title="Remover passo"]')
    .click();
  await desktop
    .getByRole("button", { name: "Salvar mudanças", exact: true })
    .click();
  await waitForText(desktop, "Tudo salvo");
  const removedState = await apiState(baseUrl);
  const removedIds = removedState.config.workflows
    .find((workflow) => workflow.id === "simple")
    .steps.map((step) => step.id);
  requireCondition(
    removedIds.length === initialIds.length && !removedIds.includes(removedId),
    "removing a workflow step left a stale ID",
  );
  const cycleProject = (await apiState(baseUrl)).config.projects.find(
    (project) => project.name === "UI Fixture Project",
  );
  const cycleDiagnosisResponse = await fetch(
    `${baseUrl}/api/diagnostics?projectId=${encodeURIComponent(cycleProject.id)}&workflowId=simple`,
  );
  requireCondition(
    cycleDiagnosisResponse.ok,
    "workflow diagnosis request failed",
  );
  const cycleDiagnosis = await cycleDiagnosisResponse.json();
  requireCondition(
    cycleDiagnosis.workflow?.reachableStepIds.includes("developer") &&
      cycleDiagnosis.workflow?.reachableStepIds.includes("tester") &&
      !cycleDiagnosis.issues.some((issue) => issue.code === "cycle"),
    "bounded FAIL/PASS correction cycle was rejected or not diagnosed",
  );
  await desktop
    .getByRole("button", { name: "Adicionar passo", exact: true })
    .click();
  await desktop
    .getByRole("button", { name: "Salvar mudanças", exact: true })
    .click();
  await waitForText(desktop, "Tudo salvo");
  const readdedState = await apiState(baseUrl);
  const readdedIds = readdedState.config.workflows
    .find((workflow) => workflow.id === "simple")
    .steps.map((step) => step.id);
  requireCondition(
    readdedIds.length === initialIds.length + 1 &&
      new Set(readdedIds).size === readdedIds.length,
    "re-adding a workflow step produced duplicate IDs",
  );
  requireCondition(
    readdedIds.at(-1) !== removedId,
    "re-added workflow step reused a removed ID",
  );

  await desktop.reload({ waitUntil: "networkidle" });
  await waitForText(desktop, "O trabalho acontece aqui.");
  await waitForText(desktop, "Ao vivo");

  // Two tabs editing the same revision must preserve the stale tab's draft,
  // reject its save, and leave the first tab's configuration intact.
  await second.goto(baseUrl, { waitUntil: "networkidle" });
  await waitForText(second, "O trabalho acontece aqui.");
  await second.getByRole("button", { name: "Team", exact: true }).click();
  await waitForText(second, "Equipe");
  await selectResource(second, "Developer");
  const staleName = second.getByLabel("Nome", { exact: true });
  await staleName.fill("Stale tab draft");
  await desktop.getByRole("button", { name: "Team", exact: true }).click();
  await waitForText(desktop, "Equipe");
  await selectResource(desktop, "Developer");
  await desktop.getByLabel("Nome", { exact: true }).fill("Fresh tab config");
  await desktop
    .getByRole("button", { name: "Salvar mudanças", exact: true })
    .click();
  await waitForText(desktop, "Tudo salvo");
  await second
    .getByRole("alert")
    .filter({ hasText: "A configuração mudou em outra aba" })
    .waitFor({ state: "visible" });
  requireCondition(
    (await staleName.inputValue()) === "Stale tab draft",
    "stale tab lost its local draft after the other tab saved",
  );
  await second
    .getByRole("button", { name: "Salvar mudanças", exact: true })
    .click();
  await second
    .getByRole("alert")
    .filter({ hasText: "alterada em outra aba" })
    .waitFor({ state: "visible" });
  const afterStaleSave = await apiState(baseUrl);
  requireCondition(
    afterStaleSave.config.agents.find((agent) => agent.id === "developer")
      ?.name === "Fresh tab config",
    "stale tab overwrote the configuration after a revision conflict",
  );
  await second
    .getByRole("button", { name: "Descartar rascunho", exact: true })
    .click();

  // A failed save must keep the draft and its error visible after a later
  // snapshot arrives. The route only fails PUT /api/config, so reload is a
  // real server snapshot rather than a mocked websocket frame.
  const failedSaveDraft = "SAVE_FAILURE_DRAFT";
  await desktop.getByRole("button", { name: "Team", exact: true }).click();
  await waitForText(desktop, "Equipe");
  await selectResource(desktop, "Fresh tab config");
  await desktop
    .getByPlaceholder("Como este agente deve trabalhar…")
    .fill(failedSaveDraft);
  await desktop.route("**/api/config", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "forced browser save failure" }),
    });
  });
  await desktop
    .getByRole("button", { name: "Salvar mudanças", exact: true })
    .click();
  await desktop
    .getByRole("alert")
    .filter({ hasText: "forced browser save failure" })
    .waitFor({ state: "visible" });
  requireCondition(
    (await desktop
      .getByPlaceholder("Como este agente deve trabalhar…")
      .inputValue()) === failedSaveDraft,
    "failed save discarded the local instructions draft",
  );
  const reloadResponse = await desktop.evaluate(async () => {
    const response = await fetch("/api/config/reload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return { status: response.status, body: await response.text() };
  });
  requireCondition(
    reloadResponse.status === 200,
    `config reload failed (${reloadResponse.status}): ${reloadResponse.body}`,
  );
  await desktop.waitForTimeout(250);
  requireCondition(
    await desktop
      .getByRole("alert")
      .filter({ hasText: "forced browser save failure" })
      .isVisible(),
    "later config snapshot cleared the failed-save error",
  );
  requireCondition(
    (await desktop
      .getByPlaceholder("Como este agente deve trabalhar…")
      .inputValue()) === failedSaveDraft,
    "later config snapshot discarded the failed-save draft",
  );
  await desktop.unroute("**/api/config");
  await desktop
    .getByRole("button", { name: "Salvar mudanças", exact: true })
    .click();
  await waitForText(desktop, "Tudo salvo");

  // Starting with a dirty configuration must expose an explicit save/discard
  // decision. Exercise the save path and verify the saved draft executes.
  await desktop.reload({ waitUntil: "networkidle" });
  await waitForText(desktop, "O trabalho acontece aqui.");
  await desktop.getByRole("button", { name: "Team", exact: true }).click();
  await waitForText(desktop, "Equipe");
  await selectResource(desktop, "Developer");
  await desktop
    .getByPlaceholder("Como este agente deve trabalhar…")
    .fill("SAVE_AND_RUN_DRAFT");
  await desktop.getByRole("button", { name: "Run", exact: true }).click();
  await waitForText(desktop, "O trabalho acontece aqui.");
  await desktop
    .locator(".run-form-grid label.field-label")
    .filter({ hasText: "Projeto" })
    .locator("select")
    .selectOption({ label: "UI Fixture Project" });
  await desktop
    .locator(".run-form-grid label.field-label")
    .filter({ hasText: "Workflow" })
    .locator("select")
    .selectOption({ label: "Simple" });
  await desktop.locator(".task-field textarea").fill("UI_PASS");
  await desktop
    .getByRole("button", { name: "Iniciar workflow", exact: true })
    .click();
  const runDecision = desktop.locator(".run-decision[role=status]");
  await runDecision.waitFor({ state: "visible" });
  await runDecision
    .getByRole("button", { name: "Salvar e iniciar", exact: true })
    .waitFor({ state: "visible" });
  await runDecision
    .getByRole("button", {
      name: "Descartar alterações e iniciar",
      exact: true,
    })
    .waitFor({ state: "visible" });
  await runDecision
    .getByRole("button", { name: "Salvar e iniciar", exact: true })
    .click();
  await waitForRunStatus(desktop, "Concluído");
  await waitForText(desktop, "fixture UI completed");

  await desktop.getByRole("button", { name: "Run", exact: true }).click();
  await waitForText(desktop, "O trabalho acontece aqui.");
  await desktop
    .locator(".run-form-grid label.field-label")
    .filter({ hasText: "Projeto" })
    .locator("select")
    .selectOption({ label: "UI Fixture Project" });
  await desktop
    .locator(".run-form-grid label.field-label")
    .filter({ hasText: "Workflow" })
    .locator("select")
    .selectOption({ label: "Simple" });
  await desktop.locator(".task-field textarea").fill("UI_PASS");
  await desktop
    .getByRole("button", { name: "Iniciar workflow", exact: true })
    .click();
  await waitForRunStatus(desktop, "Concluído");
  await waitForText(desktop, "fixture UI completed");

  // A large deterministic result keeps the review controls honest: notes and
  // declared files remain visible, the retained tail advertises truncation, and
  // search/copy/download/expand operate on the output actually available in the run.
  await desktop.locator(".task-field textarea").fill("UI_EVIDENCE");
  await desktop
    .getByRole("button", { name: "Iniciar workflow", exact: true })
    .click();
  await waitForRunStatus(desktop, "Concluído");
  await waitForText(desktop, "fixture evidence completed");
  const evidenceInspector = desktop.locator(".agent-inspector");
  await evidenceInspector
    .getByText("declared note from fixture", { exact: true })
    .waitFor({ state: "visible" });
  await evidenceInspector
    .getByText("declared-from-fixture.txt", { exact: true })
    .waitFor({ state: "visible" });
  await evidenceInspector
    .locator(".output-meta")
    .filter({ hasText: "Limite de retenção" })
    .waitFor({ state: "visible" });
  const outputSearch = evidenceInspector.getByPlaceholder("Buscar no log");
  await outputSearch.fill("SEARCH_ME");
  await evidenceInspector
    .locator(".output-meta")
    .filter({ hasText: /ocorr.ncia/ })
    .waitFor({ state: "visible" });
  requireCondition(
    (await evidenceInspector.locator(".output-meta").textContent())?.includes(
      "ocorr",
    ) === true,
    "output search did not report matches",
  );
  await desktop
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: baseUrl,
    });
  await evidenceInspector
    .getByRole("button", { name: "Copiar", exact: true })
    .click();
  await evidenceInspector
    .getByRole("button", { name: "Copiado", exact: true })
    .waitFor({ state: "visible" });
  const downloadPromise = desktop.waitForEvent("download");
  await evidenceInspector
    .getByRole("button", { name: "Baixar", exact: true })
    .click();
  const outputDownload = await downloadPromise;
  requireCondition(
    outputDownload.suggestedFilename().endsWith("-output.txt"),
    `unexpected output download name: ${outputDownload.suggestedFilename()}`,
  );
  await evidenceInspector
    .getByRole("button", { name: "Expandir", exact: true })
    .click();
  requireCondition(
    await evidenceInspector
      .locator(".output-block pre")
      .evaluate((element) => element.classList.contains("is-expanded")),
    "expand output did not change the log viewport",
  );

  // A closed stdin must surface an action error without clearing the compose
  // field, while output snapshots continue to update the inspector.
  await desktop.locator(".task-field textarea").fill("UI_STDIN_CLOSED");
  await desktop
    .getByRole("button", { name: "Iniciar workflow", exact: true })
    .click();
  await desktop
    .getByRole("button", { name: "Parar execução", exact: true })
    .waitFor({ state: "visible" });
  await waitForRunStatus(desktop, "Em execução");
  const stdinDeveloper = desktop
    .locator(".dock-member")
    .filter({ hasText: "Developer" })
    .first();
  await stdinDeveloper.click();
  const stdinInspector = desktop.locator(".agent-inspector");
  const stdinInput = stdinInspector.locator(".message-composer input");
  await stdinInput.waitFor({ state: "visible" });
  await stdinInput.fill("KEEP_UI_MESSAGE");
  await stdinInspector.getByRole("button", { name: "Enviar mensagem" }).click();
  const sendError = desktop
    .locator(".error-banner")
    .filter({ hasText: /send|stdin/i });
  await sendError.waitFor({ state: "visible" });
  requireCondition(
    /send|stdin/i.test((await sendError.textContent()) || ""),
    "closed stdin did not produce a readable send error",
  );
  requireCondition(
    (await stdinInput.inputValue()) === "KEEP_UI_MESSAGE",
    "closed stdin send cleared the browser compose field",
  );
  await stdinInspector
    .locator(".output-block pre")
    .filter({ hasText: "snapshot after stdin close" })
    .waitFor({ state: "visible" });
  const activityTime = await stdinInspector
    .locator(".activity-time")
    .textContent();
  requireCondition(
    /agora|há|sem atividade/i.test(activityTime || ""),
    "activity timestamp was not rendered separately from the live output",
  );
  requireCondition(
    Boolean(
      (
        await stdinInspector.locator(".activity-description").textContent()
      )?.trim(),
    ),
    "activity description was empty while snapshots were arriving",
  );
  requireCondition(
    (await stdinInput.inputValue()) === "KEEP_UI_MESSAGE",
    "later stdin snapshots cleared the browser compose field",
  );
  await desktop
    .getByRole("button", { name: "Parar execução", exact: true })
    .click();
  await waitForRunStatus(desktop, "Parado");

  // Start a hanging run and verify that all configuration controls are locked while
  // running, while the Waiting tester cannot be stopped, restarted, or messaged.
  await desktop.locator(".task-field textarea").fill("UI_HANG");
  await desktop
    .getByRole("button", { name: "Iniciar workflow", exact: true })
    .click();
  await desktop
    .getByRole("button", { name: "Parar execução", exact: true })
    .waitFor({ state: "visible" });
  await waitForRunStatus(desktop, "Em execução");
  await waitForPidCount(`${pidFile}.log`, 1);
  for (const navLabel of ["Projects", "Team", "Workflow"]) {
    requireCondition(
      await desktop
        .getByRole("button", { name: navLabel, exact: true })
        .isDisabled(),
      `${navLabel} remained enabled during a run`,
    );
  }
  requireCondition(
    await desktop.locator(".save-button").isDisabled(),
    "Save remained enabled during a run",
  );

  const testerMember = desktop
    .locator(".dock-member")
    .filter({ hasText: "Tester" })
    .first();
  await testerMember.click();
  const testerInspector = desktop.locator(".agent-inspector");
  await testerInspector
    .locator(".status-badge")
    .filter({ hasText: "Aguardando" })
    .waitFor({ state: "visible" });
  requireCondition(
    await testerInspector
      .getByRole("button", { name: "Reiniciar", exact: true })
      .isDisabled(),
    "Waiting agent Restart was enabled",
  );
  requireCondition(
    await testerInspector
      .getByRole("button", { name: "Parar", exact: true })
      .isDisabled(),
    "Waiting agent Stop was enabled",
  );
  requireCondition(
    await testerInspector
      .getByRole("button", { name: "Enviar mensagem" })
      .isDisabled(),
    "Waiting agent Send was enabled",
  );
  requireCondition(
    await testerInspector.locator(".message-composer input").isDisabled(),
    "Waiting agent message input was enabled",
  );

  // Exercise the timeline cap with a real running process. Each message is an
  // explicit instruction event; the server retains at most 1,000 and the UI
  // renders the tail in pages instead of mounting the full list at once.
  const developerMember = desktop
    .locator(".dock-member")
    .filter({ hasText: "Developer" })
    .first();
  await developerMember.click();
  for (let index = 0; index < 1000; index += 1) {
    const response = await fetch(`${baseUrl}/api/agents/developer/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `TIMELINE_EVENT_${index}` }),
    });
    if (!response.ok)
      throw new Error(`timeline event ${index} failed (${response.status})`);
  }
  const timelineState = await apiState(baseUrl);
  requireCondition(
    timelineState.timeline.length === 1000,
    `expected the server timeline cap at 1000 events, got ${timelineState.timeline.length}`,
  );
  const timelineEvents = desktop.locator(".timeline-event");
  await timelineEvents.first().waitFor({ state: "visible" });
  requireCondition(
    (await timelineEvents.count()) <= 24,
    "timeline mounted more than one page of events",
  );
  const loadOlder = desktop.getByRole("button", {
    name: "Carregar eventos anteriores",
    exact: true,
  });
  await loadOlder.waitFor({ state: "visible" });
  const firstPageCount = await timelineEvents.count();
  await loadOlder.click();
  requireCondition(
    (await timelineEvents.count()) > firstPageCount,
    "loading older timeline events did not append a page",
  );
  await mobile.goto(baseUrl, { waitUntil: "networkidle" });
  await waitForText(mobile, "O trabalho acontece aqui.");
  const mobileInspector = mobile.locator(".agent-inspector");
  const mobileTimeline = mobile.locator(".timeline-section");
  requireCondition(
    (await mobileInspector.boundingBox())?.y <
      (await mobileTimeline.boundingBox())?.y,
    "mobile inspector rendered after the timeline",
  );
  requireCondition(
    (await mobile.locator(".timeline-event").count()) <= 24,
    "mobile timeline mounted more than one page of events",
  );
  await assertNoMobileOverflow(mobile, "Run during 1000-event timeline");

  // Restart the active Developer step in place while the run is live, and prove a
  // new fixture process was started before stopping it.
  await developerMember.click();
  const developerInspector = desktop.locator(".agent-inspector");
  await developerInspector
    .getByRole("button", { name: "Reiniciar", exact: true })
    .click();
  await waitForRunStatus(desktop, "Em execução");
  await waitForPidCount(`${pidFile}.log`, 2);
  await desktop
    .getByRole("button", { name: "Parar execução", exact: true })
    .click();
  await waitForRunStatus(desktop, "Parado");

  // Restart the complete workflow from the stopped run, confirm it is Running again,
  // then stop it once more.
  await desktop
    .getByRole("button", { name: "Reiniciar workflow", exact: true })
    .click();
  await waitForRunStatus(desktop, "Em execução");
  await waitForPidCount(`${pidFile}.log`, 3);
  await desktop
    .getByRole("button", { name: "Parar execução", exact: true })
    .click();
  await waitForRunStatus(desktop, "Parado");

  const persistedHistory = await waitForHistory(
    path.join(root, ".agent-office", "history.json"),
    (history) =>
      history.version === 2 &&
      Array.isArray(history.runHistory) &&
      history.runHistory.length >= 4,
  );
  const persistedRunIds = new Set(
    persistedHistory.runHistory.map((run) => run.id),
  );
  requireCondition(
    persistedRunIds.size >= 4,
    "browser runs did not persist distinct run IDs",
  );
  requireCondition(
    persistedHistory.runHistory.every(
      (run) =>
        run.config && Array.isArray(run.attempts) && run.attempts.length > 0,
    ),
    "persisted browser history lost run config or attempts",
  );
  requireCondition(
    persistedHistory.runHistory.some((run) => run.task === "UI_PASS") &&
      persistedHistory.runHistory.some((run) => run.task === "UI_STDIN_CLOSED"),
    "persisted history omitted the P1 browser tasks",
  );

  await desktop.screenshot({
    path: path.join(artifacts, "validation-desktop.png"),
    fullPage: true,
  });
  for (const [navLabel, heading] of [
    ["Projects", "Projetos"],
    ["Team", "Equipe"],
    ["Workflow", "Workflows"],
  ]) {
    await mobile.goto(baseUrl, { waitUntil: "networkidle" });
    await waitForText(mobile, "O trabalho acontece aqui.");
    await mobile.getByRole("button", { name: navLabel, exact: true }).click();
    await waitForText(mobile, heading);
    await assertNoMobileOverflow(mobile, navLabel);
  }
  await mobile.goto(baseUrl, { waitUntil: "networkidle" });
  await waitForText(mobile, "O trabalho acontece aqui.");
  await assertNoMobileOverflow(mobile, "Run");
  await assertAccessibleBasics(mobile);
  await assertTextContrast(mobile);
  await assertReducedMotion(mobile);
  await desktop.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await desktop
    .getByRole("button", { name: "Iniciar workflow", exact: true })
    .waitFor({ state: "visible" });
  await desktop.evaluate(() => {
    document.documentElement.style.zoom = "";
  });
  await mobile.screenshot({
    path: path.join(artifacts, "validation-mobile.png"),
    fullPage: true,
  });

  console.log(
    JSON.stringify({
      ok: true,
      baseUrl,
      artifacts: [
        path.join(artifacts, "validation-desktop.png"),
        path.join(artifacts, "validation-mobile.png"),
      ],
    }),
  );
} finally {
  await browser.close();
  child.kill("SIGTERM");
  await Promise.race([
    childClosed,
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await childClosed;
  }
  await rm(root, { recursive: true, force: true });
}
