# OpalaTex

**OpalaTex** é o seu assistente de Inteligência Artificial e editor LaTeX local integrado. Projetado para acelerar o seu fluxo de escrita acadêmica e tipografia de documentos.

Ele fornece um ambiente completo, mesclando um layout de painéis divididos (Editor de Código + Visualização de PDF) e um **Assistente de Inteligência Artificial** que entende profundamente o LaTeX, te ajuda a escrever equações complexas, gera tabelas e explica os erros de compilação instantaneamente.

A compilação depende do **Tectonic**, garantindo um build local super-rápido, sem a dor de cabeça de gerenciar pacotes `.sty`.

---

## Funcionalidades

🤖 **Seu Assistente Pessoal de IA**
OpalaTex não é apenas um editor LaTeX; é um assistente completo que compreende o seu documento inteiro. Ele te ajuda a formatar tabelas complexas, escrever figuras TikZ e corrigir erros de sintaxe e lógica automaticamente.

🧠 **Compilação de PDF Local (Tectonic)**
Alimentado pelo Tectonic, você pode compilar os seus documentos localmente sem se preocupar em baixar arquivos de estilos ou dependências manuais. Você inclusive pode instalar o Tectonic diretamente pelas configurações do app (Settings -> Preferences).

🛠️ **Modo LaTeX Dinâmico**
Escreva seu código-fonte de um lado e visualize a prévia em PDF automaticamente do outro.

☁️ **Modelos de IA Locais e em Nuvem**
Conecte-se a grandes modelos comerciais via API ou rode modelos Open-Source completamente offline de forma segura com Ollama.

---

## Primeiros Passos

### Instalação para Desenvolvimento

```bash
git clone https://github.com/opalacoderdev/OpalaTex
cd OpalaTex
python -m venv .venv
# Windows: .venv\Scripts\activate
# Linux/macOS: source .venv/bin/activate

# Instalar dependências
pip install -r requirements.txt
```

### Rodando o OpalaTex

Inicie a aplicação:

```bash
python main.py
```

*Opcional: O Tectonic pode ser instalado via script ou pelo menu de configurações dentro do programa.*

---

## Licença

OpalaTex é um software Open-Source disponibilizado sob a licença **MIT**.
