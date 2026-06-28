# Walkthrough: Landing Page & Stripe Integration

A Landing Page da **OpalaCoder** foi atualizada para apresentar claramente os dois principais produtos da suíte (OmniMe e OpalaTex) e agora conta com uma infraestrutura robusta para pagamentos e downloads usando o Stripe.

## 1. O que foi construído

### A. Novo Backend Express (`server.js`)
Criamos um pequeno servidor Node.js em `apps/web/server.js` que resolve três problemas de uma vez:
1. **API do Stripe:** Gerencia a criação da sessão de Checkout (`/api/create-checkout-session`) para comprar o OpalaTex por R$ 30,00 e ouve Webhooks de confirmação de pagamento de forma segura.

### B. Novo "Products Section"
No arquivo `HomePage.jsx` (e seu contexto de traduções `LanguageContext.jsx`), removemos as antigas seções genéricas "Problema" e "Solução" e inserimos uma bela seção **"Nossos Produtos"** contendo:
- O card do **OmniMe** detalhando o aspecto Open Source, privacidade total e com botão para o GitHub.
- O card do **OpalaTex** com uma hierarquia visual de produto Premium, destacando o preço (R$ 30,00). 
- Botões integrados na interface do OpalaTex para acionar o Checkout do Stripe via API, e links prontos para o download dos binários de 14-dias (Windows e Linux).

### C. Página de Sucesso (`SuccessPage.jsx`)
Construímos a página para onde o usuário é redirecionado após pagar.
- Essa página intercepta o `session_id` na URL.
- Faz uma chamada silenciosa ao nosso backend Node.js (`/api/get-license?session_id=...`).
- Uma vez validado, exibe a chave da licença em tamanho generoso na tela com um botão moderno de "Copiar para Área de Transferência".
- Também mostra o link direto de download para facilitar o onboarding.

## 2. Como Testar e Usar

1. **Inicie o Servidor Backend (API + Frontend):**
   Rode `node apps/web/server.js` a partir da raiz (lembre-se de configurar a variável `STRIPE_SECRET_KEY` na sua máquina local ou servidor via `.env` se for testar pra valer).

2. **Inicie a interface de Dev (Se não for rodar a build):**
   `npm run dev` na pasta `apps/web`.

3. **Fluxo Visual:**
   - Acesse a Home. Verifique se os cards OmniMe e OpalaTex estão aparecendo belamente!
   - Clique em "Comprar Licença". Você será levado ao mock do Checkout (ou Stripe real se colocar as chaves).
   - Ao finalizar, o redirecionamento irá para `/success`, mostrando uma bela notificação com a licença oficial!

> [!CAUTION]
> Ao subir os binários gerados pelo seu PyInstaller, certifique-se de colocá-los na pasta `C:\Users\gilza\projetos\OpalaWebPage\apps\web\public\downloads\` com os nomes `OpalaTex-windows-x64.zip` e `OpalaTex-linux-x64.tar.gz`. Caso contrário, os links na UI retornarão 404 (Not Found).
