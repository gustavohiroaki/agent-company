# Agent Office

Escritório visual de agentes para Linux. Aplicação web local com React, TypeScript, Vite, Node.js e WebSocket. Configura agentes e workflows, executa CLIs reais e acompanha saída, mensagens e transições. Sem Electron, cloud ou banco de dados.

Planejamento e retomada: [plano de implementação](PLAN.md), [guia para o orquestrador Sol](docs/HANDOFF.md) e [direção visual](docs/DESIGN.md).

## Iniciar

Requer Linux, Node.js 22.12+ (ou 24+) e npm.

```bash
npm install
npm run dev
```

Abra http://127.0.0.1:4310. Para a versão compilada:

```bash
npm run build
npm start
```

`PORT=4311 npm run dev` altera a porta. `AGENT_OFFICE_ROOT=/caminho/absoluto` altera onde a configuração é guardada; o diretório deve existir. O servidor escuta somente em 127.0.0.1 e rejeita origens externas. CLIs rodam com as permissões do seu usuário Linux, no diretório escolhido.

## Primeiro uso

1. Em **Projects**, defina o caminho absoluto do repositório, regras, equipe e workflow padrão.
2. Em **Team**, configure o executável e argumentos de cada agente. O CLI precisa estar instalado e autenticado no ambiente que inicia o servidor.
   No perfil do agente, **Montar boneco** abre o criador de avatar local. Escolha um preset ou combine rosto, expressão, cabelo, roupa, acessório e cores; aplique o boneco e use **Salvar mudanças** para persistir. Configurações antigas continuam exibindo as iniciais como fallback.
3. Em **Workflow**, monte o mapa visual: arraste as etapas para posicioná-las e ligue a saída de um resultado à entrada da próxima etapa. Você também pode clicar na saída e depois no destino. Selecione uma etapa para editar agente e instrução; a lista oferece edição por formulário. `done` encerra com sucesso; `error` encerra com erro. Etapas de teste exigem `PASS` ou `FAIL` no resultado; saída zero sozinha produz `DONE`.
4. Em **Run**, descreva a tarefa e inicie. Clique nos agentes para ver saída, mensagens e arquivos declarados pelo CLI. A timeline registra transições reais.
5. Em **Aparência**, personalize as cores primária e secundária e envie uma logo PNG, JPEG, WebP ou SVG de até 512 KB. A prévia é imediata; use **Salvar mudanças** para persistir. O tema próprio Agent Office é o padrão, e a skin Flash fica disponível somente como alternativa em **Temas incluídos**.

No primeiro uso, o painel de onboarding oferece uma demonstração determinística e um diagnóstico local. O diagnóstico verifica diretório, executável, equipe e estrutura do workflow sem iniciar o CLI; autenticação e modelo permanecem marcados como não verificados. Durante um run, a configuração pode ser consultada em modo somente leitura.

No editor de workflow, use os controles de zoom para navegar e organize as etapas quando precisar reorganizar o mapa. As ligações continuam seguindo PASS, FAIL, DONE e ERROR, incluindo ciclos de correção limitados pelo máximo de etapas. Mover um bloco muda apenas sua posição visual. Use **Salvar mudanças** para persistir posições e regras; workflows antigos continuam funcionando sem posições salvas. Escape cancela um gesto de arraste ou conexão em andamento.

Os templates iniciais usam o executável `codex` e modelo `gpt-5.6-luna`, editável conforme os modelos disponíveis no seu CLI/conta. O aplicativo não altera sua configuração de modelos nem ativa execução sem aprovações. Configure argumentos e permissões de acordo com o CLI instalado.

## Contrato do runner

`cli` é um executável (por exemplo `codex`, `claude`, `node` ou um caminho absoluto), não uma linha de shell. Cada item de `args` é um argumento separado. `{prompt}`, `{model}` e `{cwd}` são substituídos em cada argumento. Nenhum comando é interpolado em um shell. O contexto combina regras do projeto, papel do agente, instrução da etapa, tarefa e apenas o resultado estruturado anterior.

Exemplos de argumentos, que devem ser compatíveis com sua versão do CLI:

```json
["exec", "--model", "{model}", "{prompt}"]
```

Para wrappers próprios, a tarefa também está disponível em `AGENT_OFFICE_PROMPT`. O processo deve emitir uma linha JSON ao terminar:

```json
{
  "status": "PASS",
  "summary": "Testes passaram",
  "changed_files": ["src/example.ts"],
  "issues": [],
  "notes": []
}
```

Os status são `PASS`, `FAIL`, `DONE`, `ERROR`. Saída não zero é erro, mesmo quando o stdout declara sucesso. Arquivos alterados são os declarados pelo agente, não um rastreamento automático de git. O modelo e o CLI determinam os custos de IA; o painel não faz chamadas a modelos por conta própria.

O runner usa processos Linux e pipes diretamente, evitando a dependência de tmux/agent-mux nesta versão. O painel de terminal exibe stdout/stderr; não é um emulador de terminal interativo. **Enviar instrução** escreve no stdin do processo ativo; CLIs de execução única podem não consumir mensagens adicionais. Nesses casos, pare e reinicie com uma tarefa atualizada. **Stop** cancela a execução e encerra seu grupo de processos. **Restart** do workflow repete desde o início; do agente repete a etapa atual e continua o workflow. Uma etapa antiga deve ser repetida reiniciando o workflow completo.

## Testar sem custo de IA

O arquivo `scripts/example-agent.mjs` é um CLI de exemplo real e determinístico. Crie uma pasta de teste e um agente com:

- CLI: `node`
- Modelo: vazio
- Diretório: o caminho absoluto da pasta de teste
- Argumentos: `["/caminho/absoluto/agent-company/scripts/example-agent.mjs", "{prompt}"]`

Crie um workflow de uma etapa, com `PASS → done` e `ERROR → error`, e inclua esse agente na equipe do projeto. A execução cria `agent-office-example.txt` na pasta escolhida e reporta o arquivo. Não usa IA nem simula estados no painel.

## Arquivos locais

```text
.agent-office/
  team.yaml             # agentes, projetos, equipe, identidade visual e índice de workflows
  agents/<id>.md        # instruções de cada agente
  workflows/<id>.yaml   # etapas e transições
  config-manifest.json  # revisão e hashes da configuração íntegra publicada
  backups/              # gerações anteriores usadas para recuperação
  history.json          # runs, tentativas, saídas e timeline limitadas
```

A interface escreve esses arquivos. Alterações manuais são carregadas ao reiniciar o servidor (ou via `POST /api/config/reload` com JSON). A logo personalizada é embutida em `team.yaml`; URLs remotas, CSS e outros formatos não são aceitos, mantendo o aplicativo offline. Configurações não podem mudar durante um run. A API usa uma revisão para impedir que duas abas sobrescrevam mudanças silenciosamente. IDs são validados, gravações por arquivo usam rename atômico, o manifesto permite recuperar a última geração íntegra e requisições de alteração são serializadas. Histórico inválido é preservado para diagnóstico antes de iniciar um histórico vazio. O histórico é limitado a 1.000 eventos, 100 mensagens e 100 mil caracteres de saída por agente; a interface permite consultar execuções e tentativas separadamente. Não guarde segredos em prompts se não quiser registrá-los no disco.

Um reinício do servidor marca execuções interrompidas; não as retoma automaticamente. Timeout e limite de etapas evitam processos e ciclos indefinidos. Só uma execução fica ativa por vez.

## Validação

```bash
npm test
npm run build
npx tsx tests/browser.mjs
```

Os testes usam processos reais e diretórios temporários. O teste de navegador inicia uma instância de produção isolada, usa um fixture Node sem IA e requer o Chromium do Playwright disponível. A interface e o backend compartilham os contratos em `shared/types.ts`; `server/runner.ts` isola execução, `server/engine.ts` controla transições e `server/store.ts` persiste arquivos. A evidência final está em [docs/VALIDATION.md](docs/VALIDATION.md).

Referências técnicas: [processos no Node.js](https://nodejs.org/api/child_process.html) e [Vite](https://vite.dev/guide/).
