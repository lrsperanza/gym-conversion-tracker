# Cópia dinâmica do EVO

Disponível no app Windows Skyfit EVO, sem extensão, AutoHotkey ou instalação adicional.
É preciso recompilar o desktop e disponibilizar o front atualizado.

1. No modal de evento, confira os dados para o EVO e clique em **Cópia dinâmica**.
2. No Chrome ou Edge, abra o cadastro novo do EVO e selecione **Nome**. Mantenha o DDI padrão **+55**.
3. Pressione **Ctrl+Shift+V** e solte as teclas. Aguarde sem usar o mouse ou teclado.
4. Revise o cadastro e salve manualmente no EVO.

A macro para após selecionar **Como conheceu**, sem Esc, TAB final ou ação em Salvar/Cancelar. A lista de opções pode permanecer aberta para revisão.

O app mantém os dados em memória por até cinco minutos, para uma execução. Uma nova cópia substitui a anterior. Não altera a área de transferência. Esc ou mudança de janela interrompe a digitação; o resultado aparece no modal do tracker. Se outro aplicativo já reservou o atalho, o botão informa o conflito.

**Registrar evento** grava somente o evento do tracker. **Abrir EVO e preencher automaticamente** salva os dados adicionais do lead e executa o Puppeteer, sem registrar evento. A cópia dinâmica também não registra evento e não exige credenciais EVO no tracker.

A macro usa `RegisterHotKey` e `SendInput` do Windows. Segue a ordem do HTML fornecido: Nome → Sobrenome → CPF → Nascimento → botão de calendário → Gênero → CEP → DDI → Celular → E-mail → Tipo de visita → Como conheceu. Campos vazios são pulados mantendo os TABs. Há uma pausa de 1,5 s após sair do CEP; os seletores usam a busca por digitação do Angular Material. Mudanças nessa ordem, endereço que adicione novos campos ou opções diferentes exigem ajustar a macro. Telefones internacionais são recusados antes de preparar o atalho; use o Puppeteer nesse caso.

Por ser uma macro de teclado, não inspeciona a página nem confirma os valores preenchidos. Ela verifica a janela Chrome/Edge com EVO no título e assume Nome selecionado no cadastro novo. Não use o navegador elevado como administrador enquanto o Skyfit roda sem elevação (o Windows pode bloquear `SendInput`).

Os comandos Tauri só aceitam a janela `main` em `http://localhost:4000`, `http://127.0.0.1:4000` ou na origem exata do front configurado no build (`SKYFIT_FRONT_URL`), com permissões explícitas. Isso permite usar a macro mesmo quando o launcher abre o front remoto por indisponibilidade do bridge. Não expõem simulação arbitrária de teclas ao front: recebem campos do cadastro e montam uma sequência fixa no Rust.

Validação: `cargo test --offline` em `desktop/src-tauri`; `bun run check` e `bun run test:unit -- --run` em `front`. O teste final contra o EVO requer o aplicativo recompilado e um cadastro novo aberto, sem salvar automaticamente.
