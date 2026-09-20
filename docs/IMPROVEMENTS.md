# Agent Office — avaliação e backlog priorizado

Avaliação em 20/09/2026. Objetivo: orientar melhorias incrementais por outro modelo, sem reescrever a aplicação.

> **Estado em 20/09/2026:** itens P1 e P2 implementados e validados. A evidência final está em [`PLAN.md`](../PLAN.md) e [`docs/VALIDATION.md`](VALIDATION.md). As descrições abaixo permanecem como registro dos problemas e critérios de aceite que orientaram a execução.

**Parecer:** a base do MVP funciona; o próximo investimento deve aumentar a confiança na execução e reduzir o esforço de configuração. A identidade de escritório é coerente, mas hoje ocupa mais espaço que as informações necessárias para acompanhar e revisar o trabalho.

**Evidência:** leitura de frontend, contratos e backend e revisão independente; nesta execução principal, `npm test` (30/30), `npm run build` e `npx tsx tests/browser.mjs` passaram; capturas desktop/mobile inspecionadas. O revisor encontrou falha transitória no teste de encerramento de descendentes na suíte completa, com aprovação isolada: investigar estabilidade antes de alterar o runner. Fixtures Node, sem chamadas pagas. Os testes existentes não cobrem todos os achados estáticos abaixo. Não foi validado um provedor autenticado nem realizada pesquisa com usuários.

## P1 — corrigir antes de ampliar funcionalidades

### 1. Impedir execução com configuração diferente da editada

- **Problema:** `startRun` usa a configuração salva mesmo com `configDirty`; recarregar perde o rascunho. O aviso de alterações pendentes não impede essa surpresa (`src/App.tsx`: `startRun`, `saveConfig`).
- **Entrega:** oferecer salvar e executar ou descartar explicitamente; impedir início/reinício durante salvamento. Proteger saída com rascunho e oferecer descarte. Adicionar revisão da configuração na API para detectar gravação desatualizada entre duas abas.
- **Aceite:** editar CLI/instruções e iniciar nunca usa silenciosamente a versão antiga; falha no save preserva rascunho; duas abas não sobrescrevem mudanças sem aviso.

### 2. Preservar erros e mensagens não enviadas

- **Problema:** `receiveSnapshot` limpa qualquer erro; `perform` captura falha sem propagá-la e `sendMessage` apaga o texto mesmo quando o envio falha (`src/App.tsx`).
- **Entrega:** separar erros de conexão, configuração e execução; limpar apenas o erro resolvido. Retornar sucesso/falha da operação e apagar mensagem somente após sucesso. Explicar junto ao campo que stdin não confirma leitura pelo CLI.
- **Aceite:** fixture com stdin fechado mantém mensagem e erro após novos snapshots; reconexão não esconde falha de persistência; nenhum texto afirma que o agente leu a mensagem sem confirmação.

### 3. Separar execução atual de resultados anteriores

- **Problema:** `OfficeEngine.begin` muda estados, mas conserva dados anteriores até cada agente executar. `Snapshot` guarda apenas um run e a timeline não possui `runId`; o painel pode misturar mensagens antigas com tarefa atual (`server/engine.ts`, `shared/types.ts`).
- **Entrega:** primeiro limpar ou identificar explicitamente dados anteriores ao iniciar. Depois registrar execuções e tentativas de etapa em arquivos locais, com retenção limitada, configuração utilizada e consulta/exportação pela UI.
- **Aceite:** dois runs consecutivos e um ciclo FAIL → correção mantêm resultados distinguíveis por run/etapa/tentativa; reiniciar servidor preserva consulta; nenhum resultado antigo aparece como entrega da tarefa atual.

### 4. Corrigir o contrato de atividade

- **Problema confirmado no código e na captura:** engine grava instrução/resumo em `lastActivity`, mas `relativeActivity` interpreta o campo como data, mostrando texto no lugar de horário.
- **Entrega:** separar `lastActivityAt` e descrição; atualizar timestamp em eventos relevantes e adaptar histórico antigo (`shared/types.ts`, `server/engine.ts`, `src/App.tsx`).
- **Aceite:** instruções longas não ocupam o indicador de tempo; atividade mostra horário relativo correto e se atualiza mesmo sem novo snapshot; histórico antigo abre sem erro.

## P2 — tornar o produto utilizável no dia a dia

### 5. Guiar a primeira execução e diagnosticar configuração

- **Lacuna:** o usuário precisa conhecer caminho, CLI, argumentos, equipe e transições antes de obter valor; defaults não comprovam instalação/autenticação (`server/defaults.ts`, `ProjectsScreen`, `AgentEditor`).
- **Entrega:** checklist com links para os campos pendentes e ação de diagnóstico sem IA: diretório, executável e compatibilidade equipe/workflow. Disponibilizar demonstração determinística em pasta temporária. Explicar placeholders e precedência de diretório do agente sobre projeto.
- **Aceite:** instalação limpa permite completar uma demonstração pela UI sem editar YAML; CLI ausente e agente fora da equipe apontam a correção antes do run. Autenticação/modelo aparecem como “não verificados” quando não há evidência; diagnóstico não dispara chamada paga.

### 6. Fazer a tela de execução responder “o que ocorre e o que faço agora?”

- **Evidência visual:** planta e equipe duplicam seleção; timeline cresce sem paginação; no mobile o inspetor aparece depois de toda a timeline (`RunScreen`, `Timeline`, `src/styles.css`).
- **Entrega:** destacar etapa/agente atual, tempo decorrido, última atividade e motivo de término; selecionar agente ativo inicialmente sem sobrescrever escolha manual. Preservar escritório como visão recolhível; oferecer lista da equipe do projeto. Colocar inspetor antes da timeline no mobile e paginar eventos. Permitir consultar configurações durante execução em modo somente leitura.
- **Aceite:** em 390 px, selecionar agente torna seus detalhes imediatamente acessíveis; 1.000 eventos não empurram controles essenciais para o fim; status distingue conexão do servidor de atividade do processo; nenhum percentual estimado.

### 7. Melhorar legibilidade, linguagem e acessibilidade

- **Evidência:** estados/textos operacionais têm 8–10 px; rótulos misturam português e inglês; filtro da timeline não tem nome textual explícito (`src/styles.css`, `src/App.tsx`).
- **Entrega:** elevar texto operacional para aproximadamente 14 px e metadados para 12 px; medir e corrigir contraste; padronizar linguagem visível em português, preservando termos do protocolo. Nomear controles e anunciar mudanças importantes de estado sem ler todo o log.
- **Aceite:** navegação por teclado completa, foco visível, zoom 200% sem perda de ações, contraste de texto normal ≥ 4,5:1 e verificação de nomes acessíveis; manter movimento reduzido e estados identificáveis sem cor.

### 8. Prevenir workflows difíceis de entender ou executar

- **Lacuna:** editor exibe “Passo N” e seletores de transições sem uma visão do caminho; a checagem de equipe ocorre ao iniciar (`WorkflowEditor`, `WorkflowStepCard`, `validateConfig`, `runTask`).
- **Entrega:** nomes de etapas e resumo visual simples das ligações; alertar etapas inalcançáveis, incompatibilidade com equipe e saídas sem destino. Explicar PASS/FAIL/DONE/ERROR junto ao editor. Ciclos de correção continuam permitidos e limitados.
- **Aceite:** workflow inválido identifica etapa/campo; remover etapa mostra as ligações afetadas; FAIL → Developer continua funcionando; não introduzir editor drag-and-drop ou rejeitar ciclos válidos.

### 9. Transformar saída em evidência revisável

- **Lacuna:** log é um `<pre>` pequeno; `AgentResultView` omite `notes`, arquivos são apenas declarados e não há resumo consolidado da execução (`AgentInspector`, `AgentResultView`).
- **Entrega:** ampliar/copiar/baixar log, busca e controle de acompanhamento automático; mostrar truncamento, notas e resumo final com problemas e verificações declaradas. Rotular arquivos como “declarados pelo agente”. Opcionalmente comparar git antes/depois, distinguindo mudanças preexistentes, sem atribuir autoria automaticamente.
- **Aceite:** resultados extensos continuam legíveis; notes aparecem; copiar preserva conteúdo disponível; truncamento é explícito; projeto sem git funciona normalmente; declaração do agente nunca vira “teste verificado pelo aplicativo”.

### 10. Fortalecer persistência e comportamento sob carga

- **Riscos estáticos:** `Store.save` substitui arquivos separadamente; falha intermediária pode deixar configuração mista. `history()` faz parse sem validar estrutura. `OfficeEngine.changed` adia persistência a cada evento e copia snapshot completo, enquanto WebSocket retransmite todo o estado (`server/store.ts`, `server/engine.ts`, `server/index.ts`).
- **Entrega:** recuperação da última configuração íntegra e validação/versionamento do histórico; checkpoint com intervalo máximo mesmo com output contínuo. Medir carga antes de introduzir mensagens incrementais.
- **Aceite:** injetar falha entre gravações e recuperar configuração consistente; histórico malformado gera diagnóstico preservando o original; fixture com output contínuo produz checkpoints durante o run e mantém Stop responsivo. Sem banco novo.

## Orientação de execução

Executar P1 primeiro, em entregas pequenas; depois onboarding, acompanhamento e revisão. Cada item exige reprodução/fixture relevante e validação independente. Para UI, testar desktop e 390 px, teclado e erros; preservar os testes atuais. Extrair componentes/hooks de `src/App.tsx` conforme as alterações, sem uma refatoração geral prévia. Centralizar templates hoje duplicados em frontend/backend quando trabalhar no onboarding.

Manter `AgentRunner`, transições explícitas, encerramento de grupos, loopback, arquivos locais e uma execução por vez. Não adicionar cloud, autenticação, banco pesado, framework multiagente ou aprovação automática de CLI. Adiar paralelismo/worktrees, PTY, dashboards de custo e aprovação humana até existir necessidade demonstrada; custo só deve aparecer com dados reais do provedor. Atualizar `PLAN.md` com evidência e pendências ao concluir cada entrega.
