import type { Agent, Config, Workflow } from "../shared/types.js";
export function defaults(cwd: string): Config {
  const roles = [
    [
      "planner",
      "Planner",
      "Planeja etapas pequenas e critérios verificáveis.",
      "Executive",
      "PL",
    ],
    [
      "researcher",
      "Researcher",
      "Investiga o repositório e reúne evidências.",
      "Research Hub",
      "RE",
    ],
    [
      "developer",
      "Developer",
      "Implementa a tarefa com mudanças pequenas e verificáveis.",
      "Dev Lab",
      "DE",
    ],
    [
      "tester",
      "Tester",
      "Executa testes reais e reporta PASS ou FAIL com evidências.",
      "Review Zone",
      "TE",
    ],
    [
      "reviewer",
      "Reviewer",
      "Revisa as mudanças e reporta PASS ou FAIL com evidências.",
      "Approval",
      "RV",
    ],
  ];
  const agents: Agent[] = roles.map(
    ([id, name, instructions, area, avatar]) => ({
      id,
      name,
      role: name,
      area: area as Agent["area"],
      avatar,
      cli: "codex",
      args: ["exec", "--model", "{model}", "{prompt}"],
      model: "gpt-5.6-luna",
      cwd: "",
      instructions,
      timeoutMs: 600000,
    }),
  );
  const make = (id: string, name: string, ids: string[]): Workflow => ({
    id,
    name,
    start: ids[0],
    maxSteps: 20,
    steps: ids.map((agentId, i) => ({
      id: agentId,
      agentId,
      instruction:
        agentId === "tester"
          ? "Execute os testes relevantes. Retorne PASS ou FAIL."
          : agentId === "reviewer"
            ? "Revise as alterações. Retorne PASS ou FAIL."
            : "Realize sua parte da tarefa e retorne DONE.",
      transitions:
        agentId === "tester" || agentId === "reviewer"
          ? { PASS: ids[i + 1] || "done", FAIL: "developer", ERROR: "error" }
          : { DONE: ids[i + 1] || "done", ERROR: "error" },
    })),
  });
  return {
    agents,
    workflows: [
      make("simple", "Simple", ["developer", "tester"]),
      make("feature", "Feature", [
        "planner",
        "developer",
        "tester",
        "reviewer",
      ]),
      make("bugfix", "Bugfix", ["researcher", "developer", "tester"]),
    ],
    projects: [
      {
        id: "local",
        name: "Meu projeto",
        cwd,
        rules: "",
        workflowId: "feature",
        agentIds: agents.map((a) => a.id),
      },
    ],
    activeProjectId: "local",
  };
}
