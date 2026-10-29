# Code in the Dark no UNIESP

## Endereços

- Editor (computadores dos participantes): https://nicoly-almeida.github.io/code-in-the-dark-uniesp/editor/
- Telão (projetor): https://nicoly-almeida.github.io/code-in-the-dark-uniesp/evento/
- Painel (organização): https://nicoly-almeida.github.io/code-in-the-dark-uniesp/admin/

## Como funciona

- As 5 rodadas de Halloween ficam no Supabase, importadas pelo painel. A referência e as instruções de cada rodada só aparecem nos editores quando a organização dá o play.
- O **▶ Iniciar** no painel começa o tempo de todos. O telão e os editores acompanham sozinhos. **Pausar** trava os editores e congela o telão.
- Quando o tempo acaba (ou com **Encerrar agora**), cada editor entrega o código sozinho e trava.
- O participante só digita o nome ao abrir o editor; não há token. O botão **Entregar** pode ser usado a qualquer momento e vale a última entrega.
- No painel, **Apresentar em tela cheia** mostra a última entrega de cada participante: ← → trocam de participante, R mostra a referência e Esc sai.

Detalhes técnicos e configuração do Supabase: `SUPABASE.md`.

## Preparação

- Em cada computador, abra o endereço do editor (não o arquivo local `file://`) e digite o nome. O editor fica travado em "Aguardando a rodada começar" até o play.
- No computador do projetor, abra o telão e aperte F para tela cheia.
- No painel, confira se as 5 rodadas aparecem como **Pronta**. Se não aparecerem, use **Importar desafios** e escolha a pasta `desafios/halloween`.
- Faça um ensaio completo antes do público: Iniciar uma rodada, Entregar de um editor, Encerrar agora, apresentar em tela cheia e **Reiniciar** (a rodada volta para Pronta e as entregas do ensaio são apagadas).
- Conecte e espelhe os monitores dos participantes para a audiência; deixe o computador do telão separado para projeção.
- Prepare e teste uma sala de votação atual (por exemplo, Mentimeter) e deixe QR code e endereço curtos visíveis. O redirecionamento em `vote/index.html` aponta para uma sala já configurada no passado; não o use sem confirmar que ainda é a sala certa.
- Plano B: se a internet cair, o editor continua funcionando e guarda o código no navegador; o `Finish` mostra o resultado mesmo sem conexão. Para um evento todo offline, os pacotes em `desafios/halloween/pacotes/` (pendrive) ainda funcionam, mas sem tempo sincronizado nem entrega.
- Explique as regras antes de iniciar. Durante a rodada: HTML/CSS, sem previews, sem ferramentas de medição e sem sair do editor.

## Roteiro simples

1. Recepção: cada participante abre o editor e digita o nome.
2. Teste de espelhamento e do telão.
3. Explicação das regras e escolha de quem vai controlar o painel e a votação.
4. Contagem regressiva; no sinal combinado, **▶ Iniciar** a rodada no painel.
5. Ao fim do tempo, os editores entregam e travam sozinhos. Os participantes clicam em `Finish` para mostrar o resultado; no painel, use **Apresentar em tela cheia**.
6. Abrir a votação, anunciar o encerramento e reconhecer o vencedor. Para a próxima rodada, **▶ Iniciar** a seguinte: os editores limpam e liberam a nova referência sozinhos.

O README do repositório também registra as regras de organização e as condições de uso comunitário. Consulte-o e o arquivo `LICENSE` antes do evento.
