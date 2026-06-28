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

## Deploy e Build (Como atualizar)

Sempre que fizer alterações no projeto, siga os passos abaixo para construir (build) e atualizar os componentes:

### 1. Build da Interface (Site/GUI)
Se você alterou qualquer arquivo dentro da pasta `gui_src` (React/Vite), você precisa regerar o pacote estático para que o backend Python possa servi-lo ou o WebView possa exibi-lo:
```bash
npm run build --prefix .\gui_src\
```
*Este comando gera os arquivos minificados na pasta `opalatex/gui`, que são lidos pelo backend.*

### 2. Build do Executável Desktop (.exe)
Para gerar a versão executável final do OpalaTex para Windows (que empacota o backend e o navegador WebView), execute:
```powershell
.\build_exe.ps1
```
Após rodar o script, o arquivo compilado ficará disponível em `.\dist\OpalaTex\OpalaTex.exe`.

### 3. Deploy do Instalador para os Usuários (VPS)
Para compactar a versão final do Windows e enviar para o seu servidor VPS de modo que o comando de instalação (`irm https://opalacoder.com/install.ps1 | iex`) passe a baixar a nova versão, rode o script:
```powershell
.\binpacking.ps1
```
*Ele fará o `.zip` da pasta `dist` e fará o upload via SCP/SSH para a sua VPS (REDACTED_RELEASE_HOST), atualizando o link de download público.*

### 4. Deploy da API/Cloud (Opcional)
Se houver alterações que afetam a versão em nuvem (OpalaTexCloud API) hospedada na sua VPS:
1. Faça o commit das alterações geradas e rode `git push`.
2. No servidor, rode `git pull` e reinicie o serviço (`systemctl restart opalatex` ou similar).
