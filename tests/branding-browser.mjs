import { chromium } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifacts = path.join(repo, "artifacts");
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), "agent-office-branding-browser-"));
const logoFile = path.join(root, "custom-logo.svg");
await writeFile(logoFile, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 48"><rect width="180" height="48" rx="12" fill="#1473E6"/><text x="90" y="31" text-anchor="middle" font-family="sans-serif" font-size="20" font-weight="700" fill="white">ACME</text></svg>');

const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  cwd: repo,
  env: { ...process.env, NODE_ENV: "production", AGENT_OFFICE_ROOT: root, PORT: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
child.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
child.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
const childClosed = new Promise((resolve) => child.once("close", resolve));

async function waitForServer(timeoutMs = 10_000) {
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

async function saveDraft(page) {
  const button = page.locator(".save-button").first();
  await page.waitForFunction(() => {
    const save = document.querySelector(".save-button");
    return save && !save.disabled && save.classList.contains("is-dirty");
  });
  await button.click();
  await page.waitForFunction(() => {
    const save = document.querySelector(".save-button");
    return save && save.disabled && !save.classList.contains("is-dirty") && save.textContent?.includes("Tudo salvo");
  });
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function themeTokens(page) {
  return page.locator(".app-shell").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      primary: style.getPropertyValue("--theme-primary").trim(),
      secondary: style.getPropertyValue("--theme-secondary").trim(),
      onPrimary: style.getPropertyValue("--theme-on-primary").trim(),
    };
  });
}

async function noHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  requireCondition(!overflow, `${label} has horizontal overflow`);
}

const baseUrl = await waitForServer();
const browser = await chromium.launch({ headless: true });
const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });

try {
  await desktop.goto(baseUrl, { waitUntil: "networkidle" });
  const defaults = await themeTokens(desktop);
  requireCondition(defaults.primary === "#4F5DFF" && defaults.secondary === "#17223B", `unexpected default theme: ${JSON.stringify(defaults)}`);
  requireCondition((await desktop.locator(".topbar .brand-logo").getAttribute("src")) === "/brands/default/logo.svg", "Agent Office logo is not the default");
  await desktop.getByRole("button", { name: "Appearance", exact: true }).click();
  await desktop.getByRole("heading", { name: "Aparência", exact: true }).waitFor();

  await desktop.getByRole("button", { name: /Flash Alternativa/ }).click();
  let included = await themeTokens(desktop);
  requireCondition(included.primary === "#FE2B8F" && included.secondary === "#33153D", "Flash alternative did not apply its colors");
  requireCondition((await desktop.locator(".topbar .brand-logo").getAttribute("src")) === "/brands/flash/logo.svg", "Flash alternative did not apply its logo");
  await desktop.getByRole("button", { name: /Agent Office Padrão/ }).click();
  included = await themeTokens(desktop);
  requireCondition(included.primary === "#4F5DFF" && included.secondary === "#17223B", "Agent Office preset did not restore defaults");
  await desktop.screenshot({ path: path.join(artifacts, "branding-default-desktop.png"), fullPage: true });

  await desktop.getByLabel("Cor primária", { exact: true }).fill("#1473e6");
  await desktop.getByLabel("Cor secundária", { exact: true }).fill("#f5c542");
  await desktop.locator('input[type="file"]').setInputFiles(logoFile);
  await desktop.getByAltText("Logo personalizada").waitFor();

  const custom = await themeTokens(desktop);
  requireCondition(custom.primary === "#1473E6" && custom.secondary === "#F5C542", `custom theme was not applied: ${JSON.stringify(custom)}`);
  requireCondition(custom.onPrimary === "#FFFFFF", `primary contrast color is wrong: ${custom.onPrimary}`);
  await saveDraft(desktop);

  let state = await apiState(baseUrl);
  requireCondition(state.config.branding?.primaryColor === "#1473E6", "primary color was not persisted");
  requireCondition(state.config.branding?.secondaryColor === "#F5C542", "secondary color was not persisted");
  requireCondition(state.config.branding?.logoDataUrl?.startsWith("data:image/svg+xml;base64,"), "embedded logo was not persisted");

  await desktop.reload({ waitUntil: "networkidle" });
  await desktop.getByAltText("Logo personalizada").waitFor();
  requireCondition((await themeTokens(desktop)).primary === "#1473E6", "custom theme did not survive reload");
  await desktop.getByRole("button", { name: "Appearance", exact: true }).click();
  await desktop.getByRole("heading", { name: "Aparência", exact: true }).waitFor();
  await noHorizontalOverflow(desktop, "desktop appearance");
  await desktop.screenshot({ path: path.join(artifacts, "branding-desktop.png"), fullPage: true });

  await mobile.goto(baseUrl, { waitUntil: "networkidle" });
  await mobile.getByRole("button", { name: "Appearance", exact: true }).click();
  await mobile.getByRole("heading", { name: "Aparência", exact: true }).waitFor();
  await noHorizontalOverflow(mobile, "mobile appearance");
  await mobile.screenshot({ path: path.join(artifacts, "branding-mobile.png"), fullPage: true });

  await desktop.getByRole("button", { name: "Appearance", exact: true }).click();
  await desktop.getByRole("button", { name: "Usar logo padrão", exact: true }).click();
  requireCondition((await desktop.locator(".topbar .brand-logo").getAttribute("src")) === "/brands/default/logo.svg", "default logo was not restored in the draft");
  await desktop.getByRole("button", { name: /Agent Office Padrão/ }).click();
  requireCondition((await themeTokens(desktop)).primary === "#4F5DFF", "default colors were not restored in the draft");
  await saveDraft(desktop);
  state = await apiState(baseUrl);
  requireCondition(state.config.branding === undefined, "restoring defaults persisted a redundant branding object");

  await mobile.reload({ waitUntil: "networkidle" });
  requireCondition((await mobile.locator(".topbar .brand-logo").getAttribute("src")) === "/brands/default/logo.svg", "Agent Office logo did not survive the reset");
  await mobile.getByRole("button", { name: "Appearance", exact: true }).click();
  await noHorizontalOverflow(mobile, "default mobile appearance");
  await mobile.screenshot({ path: path.join(artifacts, "branding-default-mobile.png"), fullPage: true });

  console.log(JSON.stringify({ ok: true, baseUrl, artifacts: [path.join(artifacts, "branding-default-desktop.png"), path.join(artifacts, "branding-default-mobile.png"), path.join(artifacts, "branding-desktop.png"), path.join(artifacts, "branding-mobile.png")] }));
} finally {
  await browser.close();
  child.kill("SIGTERM");
  await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 3000))]);
  await rm(root, { recursive: true, force: true });
}
