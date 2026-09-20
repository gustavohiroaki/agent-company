// A real, zero-cost CLI example. It writes a file only inside the working directory.
import { writeFile } from "node:fs/promises";
const prompt = process.argv[2] || process.env.AGENT_OFFICE_PROMPT || "";
console.log(
  "Example CLI: recebendo tarefa e verificando o diretório de trabalho.",
);
await new Promise((resolve) => setTimeout(resolve, 700));
const file = "agent-office-example.txt";
await writeFile(
  file,
  "Agent Office executou um processo real.\n" + prompt.slice(0, 500) + "\n",
);
console.log(
  JSON.stringify({
    status: "PASS",
    summary: "Arquivo de exemplo criado pelo processo local.",
    changed_files: [file],
    issues: [],
    notes: ["Exemplo determinístico, sem chamada a modelo de IA."],
  }),
);
