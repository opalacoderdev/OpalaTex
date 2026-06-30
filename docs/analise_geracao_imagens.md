# Análise: Adição de Geração de Imagens aos Agentes do OpalaTex

## Contexto

O OpalaTex já possui um mecanismo de **análise de imagens** (`analyze_image`) que usa `litellm.completion` com mensagens multimodais (base64 + `image_url`). O que não existe ainda é a capacidade de **gerar imagens a partir de texto** (text-to-image / image generation).

---

## O que o stack atual suporta

| Camada | Situação atual |
|---|---|
| **AgenticBlocks** | Não possui suporte nativo a geração de imagens. O framework só expõe `LLMAgentBlock` / `MemGPTAgentBlock` baseados em chat completions. Nenhuma referência a `image_url`, `dall-e`, `imagen`, `stability` foi encontrada no código instalado. |
| **LiteLLM** | Suporta chamadas de geração de imagens via `litellm.image_generation(model=..., prompt=...)`. Essa rota já existe no LiteLLM mas **nunca é chamada** pelo OpalaTex hoje. |
| **`tools.py`** | Apenas `analyze_image` (visão). Não existe `generate_image`. |
| **`get_available_tools()`** | Lista fixa que alimenta os sub-agentes (workers). Não inclui nenhuma ferramenta de geração. |
| **Orchestrator (`memgpt_runtime.py`)** | `orchestrator_tools` registra `analyze_image` mas não registra nenhuma geração. |
| **Cloud Proxy (`opalacoder.com`)** | Só proxeia `chat/completions` (LLM). Não há endpoint de proxy para image generation. |

---

## O que precisaria ser feito (apenas análise)

### 1. Nova ferramenta Python: `generate_image` em `tools.py`

A ferramenta precisaria:
- Receber `prompt: str` e opcionalmente `size`, `quality`, `n` (número de imagens).
- Chamar **`litellm.image_generation(model=..., prompt=...)`** — que é a interface correta do LiteLLM para DALL-E 3, Stable Diffusion (via API), etc.
- Salvar a(s) imagem(ns) gerada(s) no disco (dentro do projeto ou em um diretório configurável).
- Retornar o caminho do arquivo salvo para que o agente possa referenciá-lo no LaTeX.

> [!IMPORTANT]
> A regra do projeto proíbe chamar `litellm` diretamente. Porém, o `analyze_image` já usa `litellm.completion` diretamente. A geração de imagens (`litellm.image_generation`) segue o mesmo padrão — se o princípio for preservado, seria necessário verificar se o AgenticBlocks expõe um wrapper equivalente. **Atualmente ele não expõe.** Isso precisaria ser discutido com você antes de qualquer implementação.

### 2. Registro da ferramenta

A ferramenta precisa ser adicionada em **três lugares**:

| Arquivo | O que mudar |
|---|---|
| [`tools.py`](file:///c:/Users/gilza/projetos/OpalaTex/opalatex/tools.py) | Definir `generate_image` com `@opalatex_tool` e adicioná-la à lista `get_available_tools()` |
| [`memgpt_runtime.py`](file:///c:/Users/gilza/projetos/OpalaTex/opalatex/memgpt_runtime.py#L680-L689) | Adicionar `wrap_tool(generate_image)` à lista `orchestrator_tools` do `build_chat_orchestrator` |
| [`agent_stdin.py`](file:///c:/Users/gilza/projetos\OpalaTex\opalatex\agent_stdin.py#L171-L201) | Importar e registrar no `ALL_TOOLS_MAP` |

### 3. Compatibilidade de modelos e providers

Nem todos os modelos configuráveis no OpalaTex suportam geração de imagens. Os que suportam via LiteLLM:

| Provider | Modelo | Exige chave |
|---|---|---|
| OpenAI | `dall-e-3`, `dall-e-2` | `OPENAI_API_KEY` |
| Google (Vertex) | `imagen-3.0-generate-001` | Vertex AI credentials |
| Stability AI | `stability/stable-diffusion-xl-1024-v1-0` | `STABILITY_API_KEY` |
| Replicate | `black-forest-labs/flux-schnell` | `REPLICATE_API_KEY` |

A ferramenta precisaria detectar qual modelo usar (configurável pelo usuário), diferente do modelo de chat.

### 4. Entrega do resultado ao frontend

O arquivo gerado (PNG/JPEG) fica no disco local. Para exibi-lo no chat React:

- O `ide_server.py` já serve arquivos estáticos do projeto via HTTP.
- A ferramenta poderia retornar o **caminho relativo** e o agente mencioná-lo como um arquivo que pode ser inserido no LaTeX (`\includegraphics{...}`).
- Se quiser pré-visualização no chat, o frontend (`App.jsx`) precisaria renderizar o `file://` ou o `/files/...` path — o que implicaria uma mudança no componente de mensagem do chat.

### 5. Proxy Cloud (opcional)

Se o usuário usar o **OpalaTex Cloud** (`opalacoder.com`), o proxy atual em Express.js **não suporta** image generation. O endpoint `/api/chat-proxy/...` só lida com `chat/completions`. Para suporte cloud seria necessário:
- Novo endpoint no servidor Express: `POST /api/image-proxy/...`
- Mapeamento do payload para a API Gemini Imagen ou OpenAI Images
- Dedução de tokens/créditos diferenciada (imagens têm custo por imagem, não por token)

> [!WARNING]
> A parte do proxy cloud é uma mudança de infraestrutura no servidor remoto (`opalacoder.com`) e é substancialmente mais complexa.

---

## Resumo do esforço (apenas local, sem proxy cloud)

```
opalatex/tools.py          → Nova função generate_image (~40 linhas)
opalatex/memgpt_runtime.py → 1 linha (registrar a ferramenta no orchestrador)
opalatex/agent_stdin.py    → 2 linhas (importar + registrar no ALL_TOOLS_MAP)
```

O ponto mais delicado não é técnico, é **arquitetural**: a ferramenta precisaria chamar `litellm.image_generation` diretamente (assim como `analyze_image` já chama `litellm.completion`), o que está em tensão com a regra de não chamar litellm diretamente. Esse é o único ponto que precisaria de sua aprovação explícita antes de avançar.
