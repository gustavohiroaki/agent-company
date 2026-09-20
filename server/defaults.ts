import type { Agent, AvatarAppearance, Config, Workflow } from "../shared/types.js";

/**
 * Stable presets for the shipped team. Keep these as data (rather than a
 * random generator) so a first load and a recreated local workspace have the
 * same visual identity for each standard role.
 */
export const DEFAULT_AVATAR_APPEARANCE: AvatarAppearance = {
  version: 1,
  skinTone: "#E7AD82",
  face: "soft",
  expression: "neutral",
  hairStyle: "short",
  hairColor: "#2E2523",
  outfit: "shirt",
  outfitColor: "#4F65C8",
  accessory: "none",
  backgroundColor: "#F7F3E8",
};

export const DEFAULT_AVATAR_APPEARANCES: Readonly<Record<string, AvatarAppearance>> = {
  planner: {
    version: 1,
    skinTone: "#E7AD82",
    face: "soft",
    expression: "focused",
    hairStyle: "short",
    hairColor: "#2E2523",
    outfit: "jacket",
    outfitColor: "#4F65C8",
    accessory: "glasses",
    backgroundColor: "#EAF0F6",
  },
  researcher: {
    version: 1,
    skinTone: "#C98762",
    face: "round",
    expression: "friendly",
    hairStyle: "curly",
    hairColor: "#8C5A3C",
    outfit: "sweater",
    outfitColor: "#45A086",
    accessory: "headset",
    backgroundColor: "#E8F3EC",
  },
  developer: {
    version: 1,
    skinTone: "#75452F",
    face: "angular",
    expression: "focused",
    hairStyle: "shaved",
    hairColor: "#5B392A",
    outfit: "hoodie",
    outfitColor: "#293235",
    accessory: "none",
    backgroundColor: "#E7ECEB",
  },
  tester: {
    version: 1,
    skinTone: "#F6D0B1",
    face: "round",
    expression: "friendly",
    hairStyle: "bun",
    hairColor: "#D8B56D",
    outfit: "shirt",
    outfitColor: "#D98268",
    accessory: "glasses",
    backgroundColor: "#FFF0E6",
  },
  reviewer: {
    version: 1,
    skinTone: "#4A2A21",
    face: "soft",
    expression: "neutral",
    hairStyle: "long",
    hairColor: "#EFE7D7",
    outfit: "jacket",
    outfitColor: "#9278BE",
    accessory: "cap",
    backgroundColor: "#F0EAF5",
  },
};

/** Return a fresh object so editing one agent cannot mutate a preset. */
export function defaultAvatarAppearance(agentId: string): AvatarAppearance {
  return {
    ...(DEFAULT_AVATAR_APPEARANCES[agentId] ?? DEFAULT_AVATAR_APPEARANCE),
  };
}

export function defaults(cwd: string): Config {
  const roles: Array<[string, string, string, Agent["area"], string]> = [
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
      appearance: defaultAvatarAppearance(id),
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
