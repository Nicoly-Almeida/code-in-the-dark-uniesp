# Code in the Dark no UNIESP

## O que este repositorio oferece

O repositório contém o site institucional e o editor offline em `editor/`. O editor já inclui uma referência visual: uma página da Shopify com as seções Start e Market (`editor/assets/page.png`) e três imagens listadas nas instruções. Há material para uma rodada; rodadas eliminatórias com referências diferentes precisam de pacotes preparados separadamente.

O cronômetro de palco está em `evento/index.html`. Abra esse arquivo no navegador do apresentador e projete em tela cheia. Ele inicia em 15 minutos, permite pausar/retomar e reiniciar, e também responde a Espaço, R e F. Use o reinício antes de cada rodada.

## Preparacao para hoje

- Copie a pasta `editor/` completa para cada computador participante. Não distribua apenas o `index.html`: os arquivos da pasta `assets/` são necessários.
- Em cada computador, abra `editor/index.html` no navegador e confirme que o editor e a imagem de referência aparecem. Teste o nome do participante e o botão `Finish` em um navegador real antes de receber o público; o navegador automatizado desta sessão bloqueou o `prompt()` usado pelo editor.
- Envio dos trabalhos: para usar o botão **Enviar trabalho**, abra o editor pelo endereço publicado (GitHub Pages), não pelo arquivo local (`file://`). Crie a rodada e os tokens no painel `admin/` antes de começar. Veja `SUPABASE.md`.
- Conecte e espelhe os monitores dos participantes para a audiência; deixe o computador do cronômetro separado para projeção.
- Combine previamente como os resultados serão apresentados. O editor tem um fluxo próprio de `Finish`; faça um teste com antecedência e não dependa de recuperar o código depois da rodada.
- Prepare e teste uma sala de votação atual (por exemplo, Mentimeter) e deixe QR code e endereço curtos visíveis. O redirecionamento em `vote/index.html` aponta para uma sala já configurada no passado; não o use sem confirmar que ainda é a sala certa.
- Deixe um plano B para internet, energia, adaptadores, arquivos e exibição dos trabalhos.
- Explique as regras antes de iniciar. Durante os 15 minutos: HTML/CSS, sem previews, sem ferramentas de medição e sem sair do editor. Ao zerar, todos param de digitar.

## Roteiro simples

1. Recepção e instalação dos arquivos nos computadores.
2. Teste de espelhamento, editor, referência e apresentação dos resultados.
3. Explicação das regras e escolha de quem vai controlar o tempo e a votação.
4. Contagem regressiva; iniciar o cronômetro projetado no sinal combinado.
5. Ao zerar, pedir que todos parem, cliquem em **Enviar trabalho**, depois em `Finish`, e apresentem os resultados. Encerrar a rodada no painel após uma pequena tolerância.
6. Abrir a votação, anunciar o encerramento e reconhecer o vencedor.

O README do repositório também registra as regras de organização e as condições de uso comunitário. Consulte-o e o arquivo `LICENSE` antes do evento.