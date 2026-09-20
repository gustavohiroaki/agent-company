# Plano de implementação — Agent Office

> Documento de estado para retomada. Leia também [docs/HANDOFF.md](docs/HANDOFF.md).
> Atualizado durante a implementação inicial em 20/09/2026 (UTC).
> Os itens marcados como concluídos devem ter evidência; código escrito não equivale a comportamento validado.

## Objetivo e escopo autorizado

Aplicação web local para Linux que permite cadastrar agentes de IA, configurar seu CLI/modelo/instruções, montar workflows determinísticos, executar tarefas reais e acompanhar estados, saída e mensagens em um escritório visual.

O usuário prioriza funcionamento, simplicidade, confiabilidade, manutenção e custo, antes da aparência. A imagem fornecida é apenas uma referência: não reproduzir exatamente. Usar **Frontend Design** para orientação visual; **não usar Impeccable** neste projeto, conforme correção explícita do usuário.

Sem Electron, cloud, multiusuário, autenticação, banco pesado, framework multiagente, RAG ou editor drag-and-drop sofisticado nesta versão.

## Organização do trabalho e modelos

- Orquestrador atual: agente principal desta sessão; integra, decide arquitetura e verifica evidências.
- Orquestrador futuro: **Sol**, conforme intenção do usuário. Começar pelo guia de retomada.
- Executor preferencial: **Luna Max** (`gpt-5.6-luna`, esforço `max`). Dividir tarefas antes de escalar.
- Validação independente: outro agente; não aceitar apenas a declaração do implementador. Usar navegador nos fluxos de interface.
- Cada subagente recebe arquivos sob sua responsabilidade, contrato, entradas, critérios de conclusão e limite de escopo.
- Não reverter alterações alheias. Não abrir agentes para tarefas sobrepostas.

## Arquitetura decidida

```text
React / Vite
    │ HTTP para comandos e configuração
    │ WebSocket para snapshots e estado ao vivo
Servidor Node (127.0.0.1:4310)
    ├── OfficeEngine: transições, contexto, limite de etapas e cancelamento
    ├── ProcessRunner: executável + argumentos, processos Linux, stdin/stdout/stderr
    └── Store: YAML, Markdown e histórico JSON local
```

### Decisões e motivos

1. **Processos Linux com pipes e grupos de processos**, sem tmux/agent-mux: dispensa dependência externa para CLIs batch e permite capturar saída e encerrar descendentes. Não é terminal PTY interativo. `AgentRunner` permite substituir a implementação depois.
2. **Workflow controla a orquestração**: nenhum prompt decide qual agente executar. As transições são explícitas por `PASS`, `FAIL`, `DONE`, `ERROR`.
3. **Saída zero sem JSON produz DONE**, nunca PASS fictício. Testes/revisões precisam reportar PASS ou FAIL. Sem transição compatível, o run termina com erro explicativo.
4. **Uma execução por vez**, evitando coordenação e conflitos desnecessários nesta primeira versão.
5. **Configuração bloqueada durante execução**, para preservar os agentes e etapas referenciados pelo run.
6. **Contexto separado**: regras do projeto + papel + instrução da etapa + tarefa + resultado estruturado anterior. Sem histórico completo de conversas.
7. **Persistência local simples**: `.agent-office/team.yaml`, `agents/*.md`, `workflows/*.yaml`, `history.json`. Escritas por arquivo usam rename atômico; API serializa alterações. Não há transação atômica envolvendo todos os arquivos simultaneamente.
8. **Estados reais** e nenhum percentual de progresso inventado.
9. **Servidor restrito ao loopback**, com verificação de Host/Origin e JSON nas alterações. Sem login, conforme escopo local.
10. **Modelos e CLIs configuráveis**: template usa Luna; disponibilidade/autenticação depende do CLI instalado. Nenhuma chamada paga é necessária para a suíte de testes.

## Mapa de responsabilidade

| Parte                             | Arquivos                                                               | Implementador nesta sessão | Validação                                                          |
| --------------------------------- | ---------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------ |
| Contratos, scaffold, dependências | `shared/types.ts`, `package.json`, `tsconfig.json`, `vite.config.ts`   | Orquestrador               | TypeScript/build + integração                                      |
| ProcessRunner                     | `server/runner.ts`                                                     | Luna Max / runner          | Testes do executor + revisão do orquestrador + agente independente |
| Persistência e templates          | `server/store.ts`, `server/defaults.ts`                                | Orquestrador               | Luna Max / validation                                              |
| Workflow Engine                   | `server/engine.ts`                                                     | Orquestrador               | Luna Max / validation                                              |
| HTTP e WebSocket                  | `server/index.ts`                                                      | Orquestrador               | Luna Max / validation, testes end-to-end                           |
| Interface completa                | `src/*`                                                                | Luna Max / frontend        | Build + navegador por agente independente                          |
| Testes independentes              | `tests/store.test.ts`, `tests/engine.test.ts`, `tests/e2e.test.ts`     | Luna Max / validation      | Execução da suíte e análise dos resultados                         |
| Documentação e exemplo sem IA     | `README.md`, `PLAN.md`, `docs/HANDOFF.md`, `scripts/example-agent.mjs` | Orquestrador               | Conferência com comportamento entregue                             |

## Etapas e estado atual

### 1. Base e contratos — implementado

- [x] Repositório inicial vazio identificado; sem `.codegraph/`.
- [x] Stack TypeScript, React, Vite, Node.js, ws e YAML.
- [x] Tipos compartilhados de agente, projeto, workflow, runtime, resultado e runner.
- [x] Comandos `npm run dev`, `npm run build`, `npm start`, `npm test`.

### 2. Persistência e configuração — implementado e validado

- [x] Templates Planner, Researcher, Developer, Tester e Reviewer.
- [x] Workflows Simple, Feature e Bugfix.
- [x] Validação de IDs, referências, diretórios absolutos, limites e transições.
- [x] Instruções Markdown separadas e workflows YAML.
- [x] Testes independentes de round-trip e configurações inválidas.
- [x] Confirmar edição pela UI, recarga e preservação após reinício.

### 3. Execução real — implementado e validado com processos Node

- [x] Implementação de `AgentRunner` com processos reais.
- [x] Saída incremental, stdin, timeout e resultado estruturado.
- [x] Testes iniciais PASS/FAIL, CLI ausente, stop, restart, stdin e timeout passaram.
- [x] Encerrar descendentes mesmo quando o processo principal termina antes deles.
- [x] Garantir envio ao stdin com timeout e sem mensagens duplicadas.
- [x] Verificar substituição de argumentos sem alterar placeholders dentro do prompt.
- [x] Validar cleanup independente e executar novamente a suíte após correções.

### 4. Workflow e API — implementado e validado independentemente

- [x] Transições determinísticas e erro quando não existe destino compatível.
- [x] Limite máximo de etapas contra loops indefinidos.
- [x] Stop invalida a continuação do workflow; restart completo ou da etapa atual.
- [x] Histórico persistido; run interrompido não é retomado automaticamente no startup.
- [x] HTTP de comandos e WebSocket de snapshots.
- [x] PASS/FAIL com retorno ao Developer, erro de CLI e limite de etapas por testes reais.
- [x] WebSocket, cancelamento, reinício e persistência por testes HTTP.

### 5. Interface — implementada e validada no navegador

- [x] Run: escritório, áreas, seleção, timeline, task e equipe.
- [x] Painel de agente: resultado, arquivos declarados, mensagens, saída, stop e restart.
- [x] Projects: caminho, equipe, regras e workflow padrão.
- [x] Team: CRUD, templates e campos avançados.
- [x] Workflow: etapas, agente, instrução e destinos por status.
- [x] Conexão, reconexão, erros, vazios, controles acessíveis e responsividade.
- [x] Navegador: fluxo completo com CLI determinístico real e capturas.

### 6. Integração e entrega — concluída para a primeira versão

- [x] Corrigir findings materiais da validação independente.
- [x] `npm test` sem falhas.
- [x] `npm run build` sem erros de tipos ou bundling.
- [x] Confirmar `npm start` e o fluxo no navegador.
- [x] Atualizar este plano, guia de retomada e evidências reais.
- [x] Informar ao usuário como iniciar e quais limitações permanecem.

## Critérios para concluir a primeira versão

Todos devem ser demonstráveis:

1. Cadastrar/editar agente e ver os arquivos correspondentes no disco.
2. Selecionar um diretório real e uma equipe para o projeto.
3. Criar/editar workflow e executar as transições previstas, incluindo FAIL → Developer.
4. Executar processo real, capturar saída e resultado sem estados fabricados.
5. Ver mudanças de estado e timeline pelo WebSocket.
6. Parar execução sem continuar a próxima etapa nem deixar descendentes rodando.
7. Reiniciar com semântica documentada e sem eventos antigos contaminando o novo run.
8. Exibir falha de CLI e encerramento inesperado como erro útil.
9. Reabrir aplicação preservando configuração e histórico limitado.
10. Validar no navegador por agente diferente de quem implementou a UI.

## Limitações assumidas e extensões possíveis

- Output é um painel de logs, não PTY interativo; CLIs que exigem TTY precisam de futuro adaptador.
- Stdin enviado não garante que um CLI batch consumiu a instrução; UI/documentação devem ser explícitas.
- Arquivos alterados são declarados no resultado do agente, não derivados automaticamente do git.
- Somente uma execução simultânea; sem isolamento por worktrees nesta versão.
- Startup marca run interrompido. SIGKILL do servidor/queda do SO não tem recuperação transacional de processos.
- Histórico tem limites; não é armazenamento de auditoria ilimitado.
- Um teste com CLI Node prova o caminho real de execução, mas não prova autenticação, permissões ou disponibilidade de um modelo em Codex/Claude.

Não ampliar essas limitações para novos projetos sem uma tarefa explícita e critérios claros.

## Avaliação de melhorias — 20/09/2026

- Relatório de produto, engenharia e UI/UX: [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md), com prioridades, evidências e critérios de aceite para execução incremental.
- Revalidação nesta avaliação: `npm test` (30/30), `npm run build` e `npx tsx tests/browser.mjs` passaram; capturas desktop/mobile inspecionadas. Fixtures locais, sem CLI de IA autenticado.
- Revisão independente confirmou mistura de dados entre runs, inconsistência de atividade e falta de validação estrutural do histórico. O revisor observou falha transitória no teste de descendentes na suíte completa, que passou isoladamente; estabilidade desse teste permanece a investigar.
- Pendências propostas: consistência entre rascunho e execução, preservação de erros/mensagens, separação de resultados por execução e correção do contrato de atividade; melhorias de onboarding, acompanhamento, acessibilidade, workflows e revisão de resultados detalhadas no relatório.
- Este trecho registra o diagnóstico anterior à execução. As melhorias P1 e P2 foram implementadas e validadas nas fases abaixo.

## Execução do backlog de melhorias — concluída

Orquestração iniciada em 20/09/2026, seguindo `docs/IMPROVEMENTS.md` e usando Luna Max para implementação e validação independente.

### Fase A — confiança na execução (P1)

- [x] Revisão concorrente da configuração e fluxo salvar/executar/descartar sem perder rascunho.
- [x] Erros separados por origem e mensagem de stdin preservada quando o envio falhar.
- [x] Histórico limitado de runs/tentativas, configuração utilizada e identificação por run/etapa/tentativa.
- [x] `lastActivityAt` separado da descrição, com compatibilidade de histórico antigo.
- [x] Validação independente por testes de backend e navegador em duas abas.

Evidência da Fase A: `npm test` 38/38, `npm run build` aprovado e `npx tsx tests/browser.mjs` aprovado. A validação independente cobriu revisão stale/409, falha 503 preservando draft, stdin com descritor fechado e rascunho preservado, dois runs, ciclo FAIL → correção, restart, histórico v2 e migração de atividade. Detalhes em `docs/VALIDATION.md` e `tests/p1-independent.test.ts`.

### Fase B — uso diário (P2)

- [x] Onboarding e diagnóstico local sem chamadas de IA.
- [x] Tela Run orientada à etapa atual, mobile e timeline paginada.
- [x] Legibilidade, português consistente, teclado, zoom e contraste.
- [x] Editor de workflow com nomes, resumo e diagnósticos de grafo/equipe.
- [x] Saída e resultados revisáveis, incluindo notes, busca, copiar/baixar e truncamento explícito.
- [x] Persistência recuperável, histórico versionado e checkpoints sob output contínuo.

Evidência da Fase B: `npm test` passou com **48/48**, `npm run build` passou e `npx tsx tests/browser.mjs` passou em Chromium desktop e 390 px. A validação independente cobriu onboarding e demonstração local, diagnóstico sem iniciar CLI, workflow com ciclo de correção, timeline com 1.000 eventos, painel de evidências, acessibilidade, zoom, movimento reduzido e ausência de overflow horizontal. Também cobriu recuperação após gravação parcial, histórico inválido preservado e checkpoints durante output contínuo. A intermitência do teste de encerramento de descendentes foi reproduzida e localizada numa corrida do fixture ao ler o arquivo antes do PID estar completo. O teste passou a aguardar um PID válido em diretório temporário isolado; a validação independente passou 20/20 no caso focal e 48/48 na suíte completa, sem alterar o runner. Detalhes em `docs/VALIDATION.md`, `tests/p2-independent.test.ts` e `tests/browser.mjs`.

As duas fases foram concluídas com fixtures locais determinísticas. Nenhuma integração com provedor autenticado é alegada a partir desses testes.

## Registro de validação — 20/09/2026 UTC

- Baseline final: `npm test` passou com **30 testes**, cobrindo Store, Engine, HTTP, WebSocket e runner; `npm run build` passou; `npm start` abriu o servidor de produção em loopback.
- Processo real verificado com fixtures Node: resultados estruturados, arquivos em diretórios temporários, PID encerrado, timeout, stdin e transições.
- Revisão cruzada de runner/engine/API encontrou e corrigiu cleanup de descendentes, stdin sem timeout, duplicação de mensagem e Stop de agente nunca iniciado.
- A auditoria independente da UI encontrou seis bloqueios: restart completo ausente, IDs de passos duplicáveis, controles de agentes inativos, edição durante run, erro de args órfão e overflow móvel. Todos foram corrigidos e revalidados.
- `npx tsx tests/browser.mjs` passou em Chromium com raiz temporária e sem chamadas de IA. Cobriu edição, save/reload, workflow, execução real, output, resultado, timeline, Stop, restart de etapa ativa, restart completo, bloqueio de edição durante run, IDs únicos e viewport de 390 px nas quatro telas.
- Evidência detalhada e comandos reproduzíveis estão em `docs/VALIDATION.md`; capturas finais estão em `artifacts/validation-desktop.png` e `artifacts/validation-mobile.png` (diretório ignorado pelo git).
- Limite da evidência: o fixture prova a integração local; autenticação, permissões e disponibilidade de Codex/Claude ou outro provedor dependem do ambiente do usuário e não foram exercitadas automaticamente.
