# Validação independente

Validado em 20 de setembro de 2026 com `AGENT_OFFICE_ROOT` temporário, fixtures locais determinísticas em Node.js e Chromium headless. Nenhum CLI de modelo autenticado ou chamada paga foi usado.

Comandos finais:

- `npm test` — 48 testes passaram, 0 falharam.
- `npm run build` — verificação TypeScript e build de produção Vite passaram.
- `npx tsx tests/browser.mjs` — passou; o script cria servidor e raiz temporários, usa Chromium, executa fixtures locais e limpa os recursos ao terminar.
- `npx tsx --test --test-name-pattern='stop kills descendants that ignore SIGTERM' tests/runner.test.ts` repetido 20 vezes após a correção — 20/20 passaram na validação independente.

Os testes independentes de backend em `tests/p2-independent.test.ts` passaram 5/5. Eles verificam diagnóstico de diretório/executável sem iniciar CLI, problemas de grafo e compatibilidade de equipe, recuperação da última geração íntegra após falha entre gravações, preservação dos bytes de histórico inválido ao lado do histórico vazio e checkpoint periódico de saída contínua com Stop responsivo. O erro de tipagem do teste foi corrigido lendo o manifesto com encoding `utf8`; a intenção do assert de revisão foi preservada.

A rodada Chromium usa desktop em 1440×1000 e mobile em 390×844. A cobertura P2 inclui:

- onboarding inicial, demonstração determinística sem editar YAML e sem IA, diagnóstico local com checks `ok`/`erro`/`não verificado` e renderização de issues com correção sugerida;
- etapa/agente atuais, nome derivado da instrução, tempo decorrido, última atividade, motivo de término, seleção manual, planta recolhível, dock da equipe e consulta de configuração somente leitura;
- ciclo de correção `PASS → Developer` limitado por `maxSteps`, transições editáveis e diagnóstico de etapas alcançáveis;
- execução real com fixture Node, saída estruturada `DONE`, notes, issues e arquivos declarados, com o aviso de que declarações não são verificação do aplicativo;
- log extenso com limite de retenção explícito, busca e contagem de ocorrências, cópia, download, acompanhamento automático e expansão;
- 1.000 eventos de instrução durante um run real, retenção do limite do servidor e paginação da linha do tempo. Em 390px, o inspetor aparece antes da timeline e a primeira página monta no máximo 24 eventos;
- nomes acessíveis em controles, região `aria-live`, foco visível por teclado, contraste calculado de texto normal ≥ 4,5:1 nos elementos operacionais verificados, zoom 200%, `prefers-reduced-motion` e ausência de overflow horizontal em Run, Projects, Team e Workflow;
- edição de dois agentes, argumentos JSON inválidos preservando o rascunho parcial, criação de projeto, equipe e workflow, salvamento/reload, conflito stale entre abas e falha HTTP de save preservando draft e erro;
- bloqueio de edição durante execução, controles desabilitados para agente aguardando, Stop, restart da etapa ativa com novo PID, restart completo do workflow, histórico v2 com IDs de run/tentativas/configuração e remoção de agente não referenciado.

As capturas finais estão em [desktop](/home/gustavohiroaki/Documentos/ChatGPT/agent-company/artifacts/validation-desktop.png) e [mobile](/home/gustavohiroaki/Documentos/ChatGPT/agent-company/artifacts/validation-mobile.png).

Durante a primeira rodada após o painel de evidências, o teste encontrou overflow real de 15px em 390px: `.launcher-actions` alcançava 405px. A UI foi corrigida com quebra de ações no mobile e regras para toolbar do log; a rodada final passou. O teste não ignora overflow interno intencional de docks e navegação rolável.

Uma rodada completa posterior reproduziu a intermitência antiga do teste de descendentes: 47/48 na suíte e 9/10 no caso focal, falhando porque o arquivo do fixture já existia enquanto o conteúdo do PID ainda estava vazio. A sincronização foi corrigida em `tests/runner.test.ts`: cada execução usa diretório temporário próprio e espera um PID inteiro válido antes de parar o runner. O comportamento testado continua exigindo que o descendente que ignora SIGTERM deixe de existir. Depois da correção, o orquestrador e um Luna Max independente obtiveram 20/20 execuções focais cada; a suíte completa voltou a 48/48. `server/runner.ts` não foi alterado.

Limitações: as fixtures provam execução local, persistência, renderização e ciclo de vida. Elas não provam autenticação, permissões, disponibilidade ou comportamento de um provedor real. Arquivos alterados continuam sendo declarações do agente; não há atribuição automática pelo git. A saída retida pode omitir o início após 100.000 caracteres, e a UI sinaliza esse truncamento.
