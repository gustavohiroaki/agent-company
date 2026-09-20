# Direção visual

Referência: escritório de agentes fornecido pelo usuário, usada como inspiração, sem reprodução fiel. Orientação aplicada: Frontend Design. Impeccable não deve ser usado neste projeto.

## Composição

- Navegação curta: Run, Projects, Team, Workflow.
- Run reúne tarefa, planta do escritório, equipe e timeline; o painel do agente fica ao lado em desktop.
- Salas são superfícies suaves com nomes e identidade própria. A planta usa móveis geométricos simples e bonecos vetoriais locais; configurações antigas sem aparência continuam usando iniciais.
- Formulários de configuração usam lista à esquerda e editor à direita.
- Em telas menores, os painéis se empilham; nenhuma ação pode depender apenas de hover.

## Tipografia e cor

DM Sans para interface e Space Grotesk para títulos. Fontes empacotadas localmente para funcionar offline. Fundo de papel e piso quente, texto escuro, ação principal azul. Executive pêssego, Research verde suave, Dev azul, Review lilás, Approval amarelo suave e Content rosa.

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
