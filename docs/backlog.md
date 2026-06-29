# 0.1.1

1. Aprimoramento e correção de bugs.

2. Restrição de tamanho de pdf a ser carregado no chat, com funcionalidade de quebra em páginas e processamento por partes.


# 0.1.2

1. Aprimoramento do documento License.md: Adição de informações sobre a licença e como ela será aplicada.

2. Compilar de markdown para latex, via LLM, com geração automática em pdf. 
    Durante a compilação, o usuário seleciona o tipo de documento que deseja gerar, baseado em templates pré-definidos. O usuário pode acrescentar informações extrar (máximo 500 palavras).
    1. Opção de gerar em um formato de apresentação.
    2. Opção de gerar em um formato de artigo.
    3. Opção de gerar em um formato de livro.
    4. Opção de gerar em um formato de relatorío.
    5. Opção de gerar em um formato de TCC.

4. Adicionar uma skill research_and_write_tex, em que o agente faz uma pesquisa profunda, organiza os resultados em um documento latex.
    2.1 O agente deverá fazer uma pesquisa, baseado nas fontes fornecidas pelo usuário e, posteriormente, gerar um documento latex.
    2.2 O agente deverá gerar um resumo em portugues e em ingles.
    2.3 O agente deverá gerar um documento .tex com imagens, tabelas e gráficos (se pertinente).
    2.4 O agente deverá gerar uma bibliografia completa.
    2.5 O agente deverá gerar um documento .pdf compilado.

3. Disponibilizar links para as versões mais antigas (no máximo 2 anteriores) no footer da página.

# 0.1.3

3. Sistema de colaboração em latex:
    3.1 Criar histórico de revisões (semelhante ao overleaf).
    3.2 Adicionar função de marcação e comentário do trecho marcado.
    3.3 Acesso compartilhado de documento via gogole drive (anotações e comentários sendo sincronizados).
