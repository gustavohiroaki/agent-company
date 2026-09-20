# Validação independente

Validado em 20 de setembro de 2026 com `AGENT_OFFICE_ROOT` temporário, fixtures locais determinísticas em Node.js e Chromium headless. Nenhum CLI de modelo autenticado ou chamada paga foi usado.

Comandos finais:

- `npm test` — 55 testes passaram, 0 falharam.
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

### Criador de avatares vetoriais

A rodada independente foi ampliada para cobrir o criador local de bonecos:

- abertura pelo perfil em Team, prévia ao vivo, presets, peças, paletas, Cancelar sem alterar o rascunho e Aplicar alterando o rascunho;
- foco inicial no diálogo, retenção de foco com Tab/Shift+Tab e fechamento por Escape;
- salvamento pela rota real de configuração, aceitação da aparência validada pelo servidor e preservação após recarga;
- retrato ilustrado em Team e no inspetor, figura ilustrada dentro da sala e iniciais para agente legado sem `appearance`;
- editor sem overflow horizontal em 390 px e animação do agente ativo desabilitada sob `prefers-reduced-motion`;
- testes de Store para presets determinísticos, round-trip YAML, configuração legada e rejeição de versão, peça, cor ou campo arbitrário.

Os avatares são SVGs compostos internamente e não fazem chamadas de rede ou de IA. A validação não cobre upload de imagem ou SVG externo porque essas capacidades não fazem parte do recurso.

As capturas finais estão em [desktop](/home/gustavohiroaki/Documentos/ChatGPT/agent-company/artifacts/validation-desktop.png) e [mobile](/home/gustavohiroaki/Documentos/ChatGPT/agent-company/artifacts/validation-mobile.png).

Durante a primeira rodada após o painel de evidências, o teste encontrou overflow real de 15px em 390px: `.launcher-actions` alcançava 405px. A UI foi corrigida com quebra de ações no mobile e regras para toolbar do log; a rodada final passou. O teste não ignora overflow interno intencional de docks e navegação rolável.

Uma rodada completa posterior reproduziu a intermitência antiga do teste de descendentes: 47/48 na suíte e 9/10 no caso focal, falhando porque o arquivo do fixture já existia enquanto o conteúdo do PID ainda estava vazio. A sincronização foi corrigida em `tests/runner.test.ts`: cada execução usa diretório temporário próprio e espera um PID inteiro válido antes de parar o runner. O comportamento testado continua exigindo que o descendente que ignora SIGTERM deixe de existir. Depois da correção, o orquestrador e um Luna Max independente obtiveram 20/20 execuções focais cada; a suíte completa voltou a 48/48. `server/runner.ts` não foi alterado.

Limitações: as fixtures provam execução local, persistência, renderização e ciclo de vida. Elas não provam autenticação, permissões, disponibilidade ou comportamento de um provedor real. Arquivos alterados continuam sendo declarações do agente; não há atribuição automática pelo git. A saída retida pode omitir o início após 100.000 caracteres, e a UI sinaliza esse truncamento.

## Extensão do editor visual de workflow — validação independente

A extensão adiciona posições opcionais em `Step`. A cobertura de persistência está em
`tests/workflow-layout.test.ts` e verifica configuração legada sem `position`, round-trip
de YAML com coordenadas finitas nos limites `0..100000` e rejeição de `NaN`, infinito,
valores negativos, valores acima do limite, coordenadas ausentes e tipos incorretos.

O fluxo de navegador dedicado está em `tests/workflow-browser.mjs` e foi executado com uma
raiz `AGENT_OFFICE_ROOT` temporária e uma fixture Node determinística, sem chamadas de IA.
A rodada Chromium cobriu, em desktop e em 390px:

- arraste de nós e persistência das posições após salvar e recarregar;
- ligação por arraste de uma saída nomeada e ligação pela alternativa de clique saída → nó;
- transições `PASS`, `FAIL`, `DONE` e `ERROR`, inclusive ciclo de correção quando o fluxo o suporta;
- remoção de ligação e etapa, seleção da etapa inicial, organizar, zoom, reset e Escape;
- navegação por teclado e alternativa de lista, sem depender apenas de pointer/hover;
- bloqueio da tela durante um run pendurado e ausência de mutações por pointer nesse estado;
- ausência de overflow horizontal no viewport móvel e screenshots em `artifacts/workflow-editor-*.png`.

O teste exige atributos estáveis `data-step-id`, `data-status` nas portas e atributos de
origem/status nas ligações para que a verificação permaneça independente de texto e CSS.

### Resultado final do editor visual

Em 20 de setembro de 2026, a rodada dedicada passou com Chromium real:

- `npx tsx tests/workflow-browser.mjs` — passou em desktop 1440×1000 e mobile 390×844,
  usando uma raiz `AGENT_OFFICE_ROOT` temporária e uma fixture Node determinística sem IA;
- `npm test` — 55/55 testes passaram;
- `npm run build` — TypeScript e build de produção Vite passaram;
- `npx tsx tests/browser.mjs` — regressão completa passou após adaptar a seleção de recursos
  ao `.workflow-picker-row` da aba Workflow e estabilizar a remoção por `data-step-id`.

A rodada dedicada verificou arraste e persistência de posições, ligações por arraste e por
clique para nós e terminais `done`/`error`, remoção de ligação e etapa, seleção da etapa
inicial, organizar/zoom/ajustar/Escape, lista e teclado, recarga, ciclo limitado, bloqueio
durante execução e ausência de overflow horizontal no viewport móvel. As capturas foram
inspecionadas visualmente: [desktop do editor](/home/gustavohiroaki/Documentos/ChatGPT/agent-company/artifacts/workflow-editor-desktop.png),
[mobile do editor](/home/gustavohiroaki/Documentos/ChatGPT/agent-company/artifacts/workflow-editor-mobile.png)
e [estado inicial](/home/gustavohiroaki/Documentos/ChatGPT/agent-company/artifacts/workflow-editor-initial.png).

## Identidade visual configurável

`tests/branding-browser.mjs` usa Chromium real e uma raiz temporária para verificar a identidade sem tocar na configuração do usuário. A rodada cobre a logo e paleta próprias Agent Office como padrão, aplicação do preset Flash alternativo, retorno ao padrão sem objeto redundante, cores primária/secundária, contraste automático do botão, upload SVG embutido, persistência pela API, recarga e ausência de overflow em 1440×1000 e 390×844.

O Store cobre compatibilidade de configuração sem `branding`, round-trip do preset incluído e de logo personalizada no `team.yaml`, além da rejeição de alternativa desconhecida, combinação ambígua de duas logos, cor não hexadecimal, URL remota, imagem acima do limite e campo extra. Na rodada final, `npm test` passou com 57/57, o build passou e os testes Chromium dedicado, geral e do editor de workflow passaram. Capturas da identidade padrão inspecionadas: [desktop](/home/gustavohiroaki/Documentos/ChatGPT/agent-company/artifacts/branding-default-desktop.png) e [mobile](/home/gustavohiroaki/Documentos/ChatGPT/agent-company/artifacts/branding-default-mobile.png). Capturas da configuração personalizada: [desktop](/home/gustavohiroaki/Documentos/ChatGPT/agent-company/artifacts/branding-desktop.png) e [mobile](/home/gustavohiroaki/Documentos/ChatGPT/agent-company/artifacts/branding-mobile.png).
