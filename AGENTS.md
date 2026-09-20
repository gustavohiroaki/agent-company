# Agent Office — orientação para continuar

Antes de alterar o projeto, leia `PLAN.md`, `docs/HANDOFF.md` e `README.md`. Continue do estado existente; não recomece a aplicação. Atualize o plano com mudanças, validações e pendências concretas ao terminar uma tarefa relevante.

## Preferências explícitas do usuário

- Sol pode atuar como orquestrador; Luna Max é a primeira opção para execução de subtarefas.
- Decomponha antes de escalar para modelos mais caros. Delegue tarefas pequenas com responsabilidade por arquivos e critérios de aceite.
- O implementador não deve ser o único validador. Use validação independente e navegador para fluxos de interface quando necessário.
- Para design, use **Frontend Design**, **não Impeccable**. A imagem fornecida é referência, sem obrigação de copiar.
- Prioridades: funcionamento real, simplicidade, confiabilidade, manutenção, custo, UX, aparência.

## Limites do projeto

Aplicação web local Linux com TypeScript, Node.js, React, Vite, WebSocket e arquivos locais. Não adicionar Electron, cloud, autenticação, banco pesado ou frameworks multiagente sem necessidade estabelecida pelo usuário.

Preserve o contrato `AgentRunner`, as transições explícitas e o encerramento de grupos de processos. Não invente progresso, arquivos alterados ou testes aprovados. CLI e modelo são configuração do usuário; não introduza argumentos de aprovação automática silenciosamente.

Comandos principais: `npm test`, `npm run build`, `npm run dev`. Teste de navegador: consulte `tests/browser.mjs` e `docs/VALIDATION.md` quando existirem. Testes devem usar diretórios temporários e CLIs determinísticos, evitando chamadas pagas involuntárias.

Não descarte alterações de outros agentes. Revise `git status` e mantenha responsabilidades de edição sem sobreposição.

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
