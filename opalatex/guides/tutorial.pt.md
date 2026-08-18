# OpalaTex — Guia rápido de uso

Bem-vindo ao **OpalaTex**, um editor LaTeX com assistente de IA integrado. Tudo roda na
sua máquina: o LaTeX é compilado localmente com o Tectonic e a IA roda em um modelo
local do Ollama ou em um provedor que você configura com a sua própria chave de API.
Não há conta, nem cobrança, nem serviço de nuvem do OpalaTex.

Este chat é o seu tutorial. Escolha uma pergunta no menu abaixo e eu respondo na hora —
não é preciso ter nenhum modelo configurado para isso. Depois de cadastrar um modelo,
você também pode digitar suas próprias perguntas aqui: mantenho este guia inteiro na
memória desta conversa.

## overview :: Como o OpalaTex funciona?

O OpalaTex tem três partes trabalhando juntas:

1. **O editor** — editor de código-fonte com pré-visualização do PDF lado a lado,
   SyncTeX para pular entre o PDF e a linha `.tex` que o gerou, além de um modo rich
   text e um explorador de arquivos.
2. **O assistente de IA** — um orquestrador de chat que lê e edita seus arquivos, roda
   comandos, pesquisa na web e delega trabalho especializado para *skills*.
3. **Compilação local** — o Tectonic compila o documento sem exigir uma instalação de
   LaTeX no sistema.

O fluxo normal de trabalho é:

- criar ou importar um projeto (um projeto é uma pasta);
- cadastrar uma conexão de provedor e um modelo, e depois selecionar o modelo na barra
  do chat;
- pedir o que você precisa ao assistente no chat;
- compilar e conferir o PDF;
- revisar as alterações do assistente no modo **Review** antes de mantê-las.

O assistente roda em um de três **modos**, selecionáveis na barra do chat:

- **auto** — autonomia total; executa ferramentas sem pedir permissão a cada passo;
- **plan** — não pode modificar nada; reúne contexto e propõe um plano que você aprova
  antes;
- **edit** — edita arquivos diretamente, mas pergunta antes de rodar comandos no
  terminal.

## projects :: Como crio e organizo um projeto?

Um projeto é uma pasta mais os metadados que o OpalaTex guarda sobre ela (modelos
selecionados, modo, chats, memória, checkpoints).

- **Novo projeto** — o diálogo "Novo Projeto" pede um nome, uma pasta-mãe e,
  opcionalmente, um modelo. Só é permitido um projeto por pasta.
- **Importar projeto** — aponte o OpalaTex para uma pasta existente que já contenha os
  seus fontes `.tex`.

Duas coisas costumam surpreender quem está começando, e as duas são intencionais:

- **Um projeto começa sem modelo configurado.** O OpalaTex nunca escolhe um modelo por
  você. Enquanto você não selecionar um, o assistente se recusa a rodar e avisa que é
  preciso escolher — ele não cai silenciosamente em algum padrão.
- **Não escolher modelo é um estado válido.** Você pode limpar a seleção nas
  Configurações do Projeto e voltar ao estado não configurado.

As configurações por projeto (diálogo de Configurações do Projeto) cobrem o modelo
orquestrador, o modelo worker, os parâmetros de execução de cada papel, o modo e as
skills ativas. Credenciais globais nunca ficam no diálogo do projeto — elas pertencem ao
catálogo de modelos.

## providers :: Como cadastro um provedor e um modelo?

O cadastro é um **catálogo em duas etapas**, para você digitar as credenciais uma vez só
e reaproveitá-las em todos os modelos que as compartilham.

**Etapa 1 — cadastre uma conexão de provedor** (Configurações → Editar Modelos →
Gerenciar Conexões → Adicionar):

- **Rótulo** — um nome para você, por exemplo "OpenRouter (pessoal)".
- **Provedor** — o slug de provedor do LiteLLM: `ollama`, `openai`, `gemini`,
  `anthropic`, `mistral`, `groq`, `together_ai`, `openrouter`, …
- **Chave de API** — a sua própria chave. Ela fica na sua máquina.
- **URL base da API** — só quando o provedor exige. Exemplos: Ollama local usa
  `http://localhost:11434/v1`; o Ollama Cloud usa `https://ollama.com`; o OpenRouter usa
  `https://openrouter.ai/api/v1`.

**Etapa 2 — cadastre um modelo vinculado a essa conexão** (Configurações → Editar
Modelos → Adicionar):

- **Nome** — o nome do modelo exatamente como o provedor o escreve, por exemplo
  `qwen2.5-coder:7b`, `gpt-5.5`, `gemini-2.5-pro`.
- **Conexão** — escolha a conexão que você criou; as credenciais vêm dela.
- **Capacidades** — veja o tópico "models" abaixo.

O modelo passa a aparecer no catálogo com o id `<provedor>/<nome>`. É esse id que os
projetos guardam, e ele não muda quando você edita as credenciais da conexão — então
trocar uma chave de API não quebra nenhum projeto.

Dois atalhos úteis:

- **Importar modelos locais do Ollama** — um botão em Editar Modelos consulta o Ollama
  em execução no endereço `http://127.0.0.1:11434/api/tags` e cadastra tudo que
  encontrar.
- **Apagar uma conexão que ainda tem modelos é recusado.** Isso é proposital: um projeto
  nunca pode acabar apontando para um modelo cujas credenciais não podem ser resolvidas.

## models :: Orquestrador, worker e capacidades do modelo

Um projeto usa **dois papéis de modelo**:

- **Orquestrador** — o modelo com quem você conversa no chat. Ele planeja, chama
  ferramentas e escreve as respostas finais. Reserve para ele o seu melhor modelo.
- **Worker** — o modelo usado pelos sub-agentes efêmeros das skills (`run_skill`).
  Workers fazem tarefas estreitas, cheias de ferramentas, e terminam rápido; um modelo
  menor e mais rápido serve bem e normalmente é até preferível.

Ao cadastrar um modelo você pode declarar duas capacidades. As duas vêm **desligadas**
por padrão, e você só deve ativá-las quando a documentação do modelo confirmar:

- **`supports_thinking`** — o modelo aceita um parâmetro de raciocínio (thinking). O
  OpalaTex só envia `think` quando isso está ativado. O raciocínio vem ligado por padrão
  para o orquestrador e desligado para os workers, porque um worker preso num laço de
  raciocínio trava uma chamada de ferramenta, enquanto o raciocínio do orquestrador fica
  visível e é útil para você. Para um modelo `ollama/` com thinking ativado, o OpalaTex
  passa a usar `ollama_chat/` internamente para que o raciocínio possa ser transmitido
  nativamente.
- **`requires_single_system_message`** — alguns templates de chat (observado com um
  qwen3.8 servido pelo Ollama) rejeitam uma requisição com mais de uma mensagem
  `system`, com o erro `system message must be at the beginning`. Ative essa opção para
  um modelo assim e o OpalaTex passa a unir todas as mensagens de sistema em uma única
  mensagem inicial — só para ele.

## settings :: Quais configurações eu devo usar?

**Janela de contexto (`num_ctx`)** — esta é a configuração mais importante para modelos
locais. O número que você define é o limite real, independentemente do que o modelo
anuncia: um "modelo de 128K" roda com o `num_ctx` que o seu projeto definir. Dimensione
conforme a sua VRAM (veja o tópico sobre modelos locais). O indicador de contexto do chat
mede contra esse valor, mostra quanto da janela foi consumido e reporta os tokens que o
provedor realmente cobrou, não uma estimativa.

**Modo** — comece em **auto** no dia a dia. Use **plan** quando quiser revisar o que o
assistente pretende fazer antes de ele tocar em qualquer coisa, e **edit** para
correções rápidas e pontuais.

**Streaming** — deixe ligado. Você vê a resposta sendo produzida e pode interromper uma
execução que está indo pelo caminho errado.

**Limite de detecção de laço** — padrão `3`. Quando o assistente repete a mesma chamada
de ferramenta com os mesmos argumentos essa quantidade de vezes, a repetição é bloqueada
antes de executar e o modelo é orientado a mudar de abordagem. Reduza se um modelo local
pequeno tende a girar em falso; aumente apenas se você tiver um fluxo legitimamente
repetitivo.

**Limiar de evicção** — padrão `0,85`. Os turnos mais antigos começam a ser resumidos e
retirados do contexto de trabalho quando a janela chega a 85% de ocupação, em vez de
esperar o estouro.

**Thinking** — deixe desligado a menos que a documentação do modelo confirme o suporte.
Veja o tópico "models".

**Skills** — ative só o que você precisa. Cada skill ativa acrescenta a sua descrição ao
prompt de sistema, o que custa contexto em todos os turnos.

## local-models :: Dicas para modelos locais (Ollama)

Rodar localmente é gratuito e privado, e funciona bem quando você respeita os limites.

- **Ollama 0.30.5 ou mais recente.** Versões anteriores não suportam chamadas de
  ferramenta corretamente, e é por meio delas que o assistente lê e edita seus arquivos.
- **Escolha um modelo que realmente suporte tool calling.** Um modelo sem isso conversa,
  mas não consegue fazer nada no seu projeto. Qwen2.5-Coder e famílias equivalentes com
  suporte a ferramentas são a escolha segura.
- **Dimensione o `num_ctx` pela sua VRAM, não pela ambição.** Um contexto que não cabe na
  VRAM transborda para a RAM do sistema e o modelo fica inutilizavelmente lento. Pontos
  de partida aproximados: ~8 GB de VRAM → modelo de 7B com contexto de 8K–16K; ~12–16 GB
  → modelo de 7B–14B com 16K–32K; menos de 6 GB → modelo de 3B, e encare isso como uma
  forma de conhecer a interface, não de fazer trabalho de verdade.
- **Use um modelo worker menor que o orquestrador.** Workers são executores de
  ferramentas; não precisam da qualidade de raciocínio que você quer no chat.
- **Mantenha o thinking desligado nos workers.** Um modelo local de raciocínio, diante de
  uma entrada complexa, pode ficar em laço por muito tempo dentro de uma chamada de
  ferramenta.
- **Mantenha poucas skills ativas.** Cada uma custa contexto em todos os turnos.
- **Seja realista.** Modelos locais pequenos são ótimos para edições curtas, formatação e
  para aprender a interface. Eles sofrem com documentos longos, grandes volumes de dados
  e refatorações de vários passos — que é justamente o assunto do próximo tópico.

## local-skills :: Quais skills combinam com modelos locais pequenos?

Skills são arquivos markdown de instruções que ensinam ao assistente uma tarefa
especializada. O assistente delega para elas com `run_skill`, que cria um sub-agente novo
e sem memória. Para um modelo local pequeno, prefira skills que transformem um trabalho
grande em um **script**, e não em uma conversa longa:

- **`command-line`** — a mais útil de todas. Comandos de terminal, scripts de build,
  trechos de Python, operações em lote sobre arquivos. Quando a tarefa é grande, um
  modelo pequeno se sai muito melhor escrevendo um script Python de dez linhas e
  executando-o do que raciocinando sobre os dados.
- **`log-table-condenser`** — para logs e tabelas grandes (`.jsonl`, `.csv`, `.tsv`,
  `.log`). Ela processa e condensa o arquivo em fluxo, em vez de carregá-lo na janela de
  contexto. Use sempre que um arquivo de dados tiver mais que algumas centenas de linhas.
- **`latex-assistant`** — explica erros do compilador e gera fragmentos de LaTeX e
  matemática. São prompts curtos e bem delimitados, exatamente o que modelos pequenos
  fazem bem.

Saber o que está aberto no editor não exige skill alguma: o assistente já enxerga as abas
abertas, o arquivo em foco e o texto selecionado por meio da ferramenta nativa
`get_editor_state`. Pode dizer "este arquivo" ou "o trecho selecionado" à vontade.

Regras práticas para modelos pequenos:

- ative duas ou três skills, não todas;
- prefira edições cirúrgicas (`search_code` → `read_content_pos` →
  `replace_content_range`) a pedir um arquivo inteiro reescrito — um JSON de chamada de
  ferramenta muito longo é truncado pelo limite de saída;
- se a mesma skill falhar duas vezes seguidas, pare e mude de abordagem; o OpalaTex
  detecta isso e orienta o assistente a parar de redelegar.

## cloud-for-big-data :: Quando devo usar modelos em nuvem?

**Quando o seu problema envolve grande quantidade de dados, use um modelo em nuvem.**
Este é o conselho mais útil de todo este guia.

Documentos grandes, logs longos, bases de dados extensas, refatorações do projeto inteiro
e tarefas longas de vários passos exigem uma janela de contexto grande e um modelo que
acerte as chamadas de ferramenta de primeira. Um modelo local pequeno nessa situação vai
encher a janela, começar a descartar a conversa, produzir chamadas de ferramenta
malformadas e consumir muito mais do seu tempo do que a chamada de API teria custado.

Duas boas opções, ambas configuradas exatamente como qualquer outro provedor:

- **Ollama Cloud** — o mesmo Ollama que você já conhece, com os modelos rodando na
  infraestrutura deles. Cadastre uma conexão com provedor `ollama`, URL base
  `https://ollama.com` e a sua chave; os nomes dos modelos trazem o sufixo `:cloud`. O
  OpalaTex reconhece esses ids e aplica uma janela de 65K por padrão. É o menor degrau se
  você já usa o Ollama local.
- **Provedores de API** — o **OpenRouter** dá uma única chave e uma única conexão para
  modelos de vários fabricantes, o que facilita trocar de modelo sem recadastrar
  credenciais (slug de provedor `openrouter`, URL base `https://openrouter.ai/api/v1`).
  Gemini, OpenAI, Anthropic, Mistral, Groq e Together AI também são suportados
  diretamente.

Um híbrido prático que funciona bem: mantenha um modelo local como **worker** para os
passos mecânicos baratos e use um modelo em nuvem como **orquestrador** para o
raciocínio. Você pode trocar qualquer um dos dois pela barra do chat a qualquer momento,
sem mexer no projeto.

## context :: Como funciona a janela de contexto aqui?

O cabeçalho do chat mostra um indicador de contexto. Ele reporta os tokens que o provedor
realmente cobrou pela requisição — não um palpite por contagem de caracteres — e mede
contra a janela efetiva (`num_ctx`), que é o limite real independentemente do que o
modelo anuncia. O número indica quanto foi **consumido**, e a barra esvazia conforme a
janela enche.

Dois comportamentos decorrem disso, e ambos são intencionais:

- **`read_file` recusa um arquivo que não cabe no orçamento restante.** Ele informa o
  tamanho do arquivo, o orçamento que sobrou e o caminho de paginação a usar no lugar.
  Uma leitura grande demais é irrecuperável: ela entraria no histórico, o provedor
  truncaria a requisição pela frente e o assistente acabaria respondendo a uma pergunta
  que já não consegue mais ver.
- **`read_content_pos` pagina um arquivo grande** e sempre avisa quando devolve menos do
  que você pediu, incluindo a chamada exata para continuar. A receita normal para um
  arquivo grande é `search_code` para achar os números de linha e depois
  `read_content_pos` só naquele trecho.

Quando a janela enche mesmo assim, os turnos mais antigos são resumidos em um resumo
corrente em vez de simplesmente descartados — e o turno em andamento nunca é removido.

## compile-git :: Compilação, PDF e revisão das alterações

**Compilação** — o Tectonic compila localmente; não é preciso instalar LaTeX no sistema.
Você tem compilação completa, compilação parcial (um capítulo ou arquivo) e um rascunho
rápido de passe único para conferências ligeiras. Erros de compilação podem ser passados
ao assistente ou corrigidos direto pelo painel de problemas.

**PDF e SyncTeX** — a pré-visualização fica ao lado do fonte, e o SyncTeX mapeia um ponto
do PDF de volta para a linha `.tex` que o gerou.

**Checkpoints e modo Review** — todo turno do agente é envolvido por checkpoints de Git
sombra: um antes de rodar, outro depois. Se o turno não mudou nada, os dois são
descartados. Se mudou, o modo **Review** mostra aquele turno como uma única linha cujo
diff é a alteração inteira do início ao fim, para você ver exatamente o que o assistente
fez e desfazer se não concordar. O Git normal (seus próprios commits, branches e
histórico) fica na barra lateral de Controle de Versão e é totalmente separado desses
checkpoints.

## chat-memory :: Chats, memória e edição de mensagens

**Vários chats** — um projeto pode ter muitas conversas. Cada uma tem o seu próprio
histórico e o seu próprio contexto de trabalho, então uma longa sessão de depuração não
polui o chat em que você está escrevendo o seu artigo. Crie um com o `+` na barra lateral
de chats.

**Memória** — o assistente guarda fatos persistentes na *core memory* (coisas que valem a
pena lembrar entre conversas) e pode pesquisar todo o histórico de conversas do projeto.
Ele escreve na core memory depois de decisões relevantes; você não precisa gerenciar
isso.

**Limpar o chat** — "Limpar chat" é uma operação real no servidor: apaga o histórico
armazenado, reinicia o estado de trabalho do assistente, remove as entradas de arquivo
daquele chat e zera o indicador de contexto. Não é um reset de interface que deixaria o
modelo ainda lembrando de tudo.

**Editar uma mensagem** — nada é destruído:

- editar a sua **última** mensagem marca ela e tudo depois dela como substituído — a
  resposta some da tela, mas o histórico continua auditável;
- editar uma mensagem **anterior** ramifica a conversa em um novo chat e deixa a original
  intacta.

**Interromper** — você pode parar uma execução a qualquer momento. O que o assistente já
tinha feito é preservado como contexto, então dá para mandar continuar com instruções
corrigidas em vez de recomeçar do zero.

**Comandos de barra** — mensagens que começam com `/` são comandos do OpalaTex, e não
prompts: `/help`, `/clear`, `/skills`, `/models`, `/set-main-model <id>`,
`/set-worker-model <id>`, `/undo`, `/commit <msg>`, entre outros. Digite `/help` para ver
a lista completa.
