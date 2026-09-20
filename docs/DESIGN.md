# Direção visual

Referência: escritório de agentes fornecido pelo usuário, usada como inspiração, sem reprodução fiel. Orientação aplicada: Frontend Design. Impeccable não deve ser usado neste projeto.

## Composição

- Navegação curta: Run, Projects, Team, Workflow e Aparência.
- Run reúne tarefa, planta do escritório, equipe e timeline; o painel do agente fica ao lado em desktop.
- Salas são superfícies suaves com nomes e identidade própria. A planta usa móveis geométricos simples e bonecos vetoriais locais; configurações antigas sem aparência continuam usando iniciais.
- Formulários de configuração usam lista à esquerda e editor à direita.
- Em telas menores, os painéis se empilham; nenhuma ação pode depender apenas de hover.

## Tipografia e cor

DM Sans para interface e Space Grotesk para títulos. Fontes empacotadas localmente para funcionar offline. A identidade Agent Office usa azul-violeta `#4F5DFF` nas ações e seleções, azul-noturno `#17223B` nos títulos e superfícies frias `#F6F7FB`. O símbolo próprio representa quatro ambientes de trabalho em torno de um ponto de atividade. As salas mantêm cores distintas e estados continuam legíveis também por texto.

O cabeçalho usa por padrão a marca própria em `public/brands/default/logo.svg`. A logo SVG pública da Flash permanece empacotada em `public/brands/flash/logo.svg`, sem dependência de rede, mas só é aplicada quando o usuário escolhe o tema Flash alternativo. O nome Agent Office aparece ao lado da marca em telas com espaço suficiente.

## Identidade configurável

A tela Aparência controla dois tokens globais: a cor primária para ações/seleção e a secundária para títulos/identidade. A interface calcula automaticamente a cor sobre botões e escurece a secundária somente na renderização quando necessário para manter contraste; os valores escolhidos continuam preservados na configuração.

A logo personalizada é convertida no navegador para uma data URL e persistida localmente. São aceitos PNG, JPEG, WebP e SVG de até 512 KB. Sem `branding`, o aplicativo usa `#4F5DFF`, `#17223B` e `public/brands/default/logo.svg`. Escolher Agent Office remove o objeto opcional em vez de gravar valores redundantes; escolher Flash grava apenas suas cores e o identificador seguro do asset incluído.

A paleta ajuda a reconhecer salas; estado também precisa de texto, nunca apenas cor. Os valores efetivos estão em `src/styles.css`.

## Bonecos dos agentes

- A aparência é composta por peças SVG internas: rosto, expressão, cabelo, roupa, acessório e cores de uma paleta limitada.
- O mesmo perfil produz um retrato nas listas e no inspetor e uma figura na planta do escritório.
- O criador fica no perfil do agente em Team e edita apenas o rascunho até o usuário aplicar e salvar a configuração.
- Presets e aleatorização usam somente valores aceitos pelo contrato local; não há upload, SVG arbitrário, rede ou geração por IA.
- Movimento é discreto e reservado ao agente da etapa atual, com `prefers-reduced-motion` respeitado.

## Regras de produto

- Nenhum percentual de progresso inventado.
- Salas e timeline devem refletir dados reais do backend.
- Saída vazia, agente inativo e erro são estados explícitos.
- Modelos, custos, arquivos e resultados não devem ser inventados para preencher espaço.
- Campos menos usados podem ficar em detalhes avançados; operações principais devem ser encontráveis.
- Não transformar a aplicação em um dashboard de métricas fictícias.

## Editor visual de workflow

O canvas é a área principal: blocos representam etapas reais, portas representam resultados e setas mostram os destinos configurados. A lista de workflows permite trocar de mapa; a seleção de uma etapa abre seus detalhes. A edição por formulário continua disponível para teclado e telas estreitas.

- Base branca `#FFFFFF`, superfície fria `#F6F7FB`, texto azul-noturno `#17223B`, seleção azul-violeta `#4F5DFF` e linhas neutras. PASS/FAIL/DONE/ERROR aparecem escritos nas saídas, além da diferenciação por cor.
- DM Sans para controles e conteúdo; Space Grotesk para títulos, mantendo a identidade existente.
- Grade discreta orienta o posicionamento. Conectores têm direção e terminais explícitos para concluir ou encerrar com erro.
- Movimento acompanha o arraste do usuário. Zoom e enquadramento ajudam a navegar; organização redistribui os blocos sem mudar as regras de execução.
- Posições pertencem ao rascunho e são persistidas por Salvar mudanças. Workflows antigos recebem disposição inicial automática sem migração obrigatória.

Composição escolhida: `workflows | canvas + detalhes da etapa`, empilhada quando faltar largura. O destaque visual fica no próprio grafo; métricas, decoração e instruções técnicas não competem com as conexões.
