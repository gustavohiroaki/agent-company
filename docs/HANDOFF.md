# Retomada por Sol — guia do orquestrador

## Comece aqui

1. Leia `PLAN.md` e `README.md`.
2. Leia `git status --short` antes de editar. Não descarte alterações existentes.
3. Confira se existe `.codegraph/`: se existir, use CodeGraph antes de grep/leitura para localizar código. Não crie um índice por conta própria.
4. Execute `npm test` e `npm run build` uma vez para obter o baseline. Investigue falhas antes de ampliar escopo.
5. Escolha o primeiro item pendente do plano que bloqueia os critérios de conclusão. Não recomece a implementação.

A primeira versão e o backlog P1/P2 de `docs/IMPROVEMENTS.md` foram concluídos e validados em 20/09/2026. Se o baseline continuar verde, trate trabalho futuro como manutenção ou nova solicitação; não reabra itens concluídos sem uma reprodução concreta.

## Estratégia de modelos solicitada pelo usuário

Você pode usar **Sol como orquestrador**. Prefira **Luna Max como executor** e decomponha problemas grandes antes de trocar de modelo. Use outro agente para validar as partes relevantes; o autor não deve ser o único validador. Para interface, rode um navegador quando necessário, como o usuário solicitou explicitamente.

A orientação visual permitida neste projeto é **Frontend Design**. O usuário pediu explicitamente para **não usar Impeccable**. A imagem original inspira o escritório, sem obrigação de reprodução fiel.

## Fontes de verdade

| Pergunta                                          | Fonte                                               |
| ------------------------------------------------- | --------------------------------------------------- |
| O que falta e o que já foi verificado?            | `PLAN.md`, resultados atuais de testes e evidências |
| Quais objetos trafegam?                           | `shared/types.ts`                                   |
| Onde uma tarefa avança/para?                      | `server/engine.ts`                                  |
| Como CLI e processos são tratados?                | `server/runner.ts`                                  |
| Quais arquivos a UI edita?                        | `server/store.ts`                                   |
| Quais rotas a interface chama?                    | `server/index.ts`                                   |
| Como iniciar, configurar ou demonstrar sem custo? | `README.md`                                         |
| Como é a interface e onde ficam as ações?         | `src/App.tsx` e `src/styles.css`                    |
| Qual foi a evidência independente final?          | `docs/VALIDATION.md` e `tests/browser.mjs`          |

## Contratos que precisam continuar válidos

- `AgentRunner` não depende de fornecedor; novos adaptadores ficam atrás da interface.
- `cli` é executável e `args` é lista: não converter tudo em shell command.
- O mecanismo escolhe transições pelo resultado, não por palavras soltas na saída.
- Exit code não zero sempre é ERROR. Saída zero sem resultado é DONE, não PASS.
- Run ativo impede alterar configuração e iniciar outro run.
- Stop invalida a continuação antes de encerrar o processo.
- As rotas de alteração são serializadas. Nenhuma operação de stdin pode bloquear para sempre.
- O servidor permanece local e não adiciona CORS aberto.
- UI não inventa atividade, histórico, percentual ou arquivos alterados.
- Não configurar aprovações automáticas de CLI sem pedido do usuário.

## Como delegar uma tarefa

Use um contrato curto:

```text
Objetivo: corrigir [comportamento concreto].
Responsabilidade: editar somente [arquivos]. Você não está sozinho; preserve alterações alheias.
Contexto: leia [contrato/funções/teste relevante], não todo o histórico.
Entrada e reprodução: [passos ou teste].
Comportamento esperado: [observável].
Limites: não mudar [API, escopo, dependências] sem comunicar.
Verificação: executar [teste/comando] e reportar saída, arquivos e limitações.
Entrega: implementação para revisão; não declarar o projeto inteiro concluído.
```

Não delegue dois agentes para escrever no mesmo arquivo ao mesmo tempo. Uma segunda pessoa pode revisar em modo leitura enquanto a primeira implementa.

## Sequência para cada alteração

1. Reproduza o problema com evidência mínima.
2. Escreva no plano a tarefa e o critério de aceite.
3. Delegue implementação pequena para Luna Max.
4. Integre sem sobrescrever trabalho paralelo.
5. Delegue revisão/teste independente, de preferência com um caso que possa falhar por um motivo real.
6. Corrija somente findings sustentados por evidência.
7. Execute os checks apropriados. Não repita suites sem mudança ou incerteza nova.
8. Atualize `PLAN.md` com o resultado e riscos que restam.

## Navegador e execução real

- `npm run dev`: servidor local padrão `http://127.0.0.1:4310`.
- Para testar sem mexer no projeto do usuário, inicie com `AGENT_OFFICE_ROOT` apontando para uma pasta temporária e `PORT` livre.
- Use `scripts/example-agent.mjs` ou fixtures temporárias Node para provar filesystem, stdout, resultado e transições sem chamadas pagas.
- Valide pelo menos: edição/salvamento, troca de telas, início de run, seleção de agente, saída, erro e stop/restart.
- Registre screenshots e resultado em `artifacts/` (ignorado pelo git); resuma evidência durável no plano.
- Teste desktop; confira overflow e controles na largura pequena. Desktop permanece a prioridade.
- Não diga que a integração com um modelo/CLI autenticado foi validada se só usou fixture Node.

## Endpoints atuais

- `GET /api/state` → `Snapshot`
- `PUT /api/config` com `{config, expectedRevision}` → `Snapshot`; revisão desatualizada retorna 409
- `POST /api/config/reload` com `{expectedRevision?}` → recarrega arquivos locais
- `GET /api/diagnostics` → diagnóstico da configuração salva sem iniciar CLI
- `POST /api/diagnostics` com `{config?, projectId?, workflowId?}` → diagnóstico do rascunho sem iniciar CLI
- `POST /api/run` com `{projectId, workflowId, task}`
- `POST /api/run/stop` e `/api/run/restart` com `{}`
- `POST /api/agents/:id/send` com `{message}`
- `POST /api/agents/:id/stop` e `/api/agents/:id/restart` com `{}`
- `WS /ws`: `{type:"snapshot",data:Snapshot}`; falha de persistência pode enviar `{type:"error",error:string}`

Alterações exigem `Content-Type: application/json`. Erros HTTP retornam `{error:string}`. Leia os arquivos atuais se o contrato tiver sido alterado posteriormente.

## Prompt pronto para uma próxima sessão

> Continue o Agent Office como orquestrador Sol. Leia PLAN.md, docs/HANDOFF.md e README.md, confira o estado do git e execute o baseline. Trabalhe no primeiro bloqueio comprovado do plano. Delegue subtarefas pequenas para Luna Max e use validação independente com navegador para a interface. Não use Impeccable, não recomece o projeto e não expanda o escopo sem necessidade. Atualize o plano com evidências antes de encerrar.
