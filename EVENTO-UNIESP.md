# Code in the Dark no UNIESP

## Endereços

- Editor (computadores dos participantes): https://nicoly-almeida.github.io/code-in-the-dark-uniesp/editor/
- Telão (projetor): https://nicoly-almeida.github.io/code-in-the-dark-uniesp/evento/
- Painel (organização): https://nicoly-almeida.github.io/code-in-the-dark-uniesp/admin/

## Como funciona

- As 4 rodadas da DevFest JP 2026 (3 + a final, pasta `desafios/devfestjp`) ficam prontas no Supabase. A referência e as instruções de cada rodada só aparecem nos editores quando a organização dá o play.
- O **▶ Iniciar** no painel começa o tempo de todos. O telão e os editores acompanham sozinhos. **Pausar** trava os editores e congela o telão. **Reiniciar** (a qualquer momento, se algo der errado) para o tempo, volta a rodada para Pronta e apaga as entregas dela; depois é só **▶ Iniciar** de novo.
- Quando o tempo acaba (ou com **Encerrar agora**), cada editor entrega o código sozinho e trava.
- O participante só digita o nome ao abrir o editor; não há token. O botão **Entregar** pode ser usado a qualquer momento e vale a última entrega.
- No painel, **Apresentar em tela cheia** mostra a última entrega de cada participante: ← → trocam de participante, R mostra a referência e Esc sai.
- O **telão** mostra, além do cronômetro, o código dos 3 competidores da rodada ao vivo (atualiza a cada segundo, com a linha do cursor em destaque e "POWER MODE!" para quem digita rápido). Aparecem as 3 primeiras máquinas que entram na rodada, na ordem em que entraram. O telão mostra só o código, nunca o resultado: os competidores também enxergam o projetor.
- No topo do telão ficam as rodadas (1, 2, 3, FINAL); a final usa o ciano do POWER MODE.
- Quando a rodada termina (tempo zerado ou **Encerrar agora** no painel), aparece no telão o botão **Mostrar resultados** (ou tecla R): as 3 telas trocam o código pela prévia de cada competidor. Clique num competidor (ou teclas 1, 2, 3) para abrir em tela cheia o resultado dele ao lado da **ideia original** do desafio, na mesma escala. ← → trocam de competidor, Esc volta (segurar o Esc sai da tela cheia) e **Voltar ao código** sai dos resultados. Durante a rodada as prévias não existem: os competidores também enxergam o telão.
- **Votação do público:** abre sozinha quando a rodada termina e vale para os 3 competidores do telão. No telão, **Votação do público** (ou tecla V) mostra o QR code da página de votação e os nomes; o público vota no celular (um voto por celular, que pode ser trocado enquanto a votação estiver aberta). **Mostrar resultado do público** (abaixo do QR code) mostra o placar com o vencedor destacado; Esc volta ao QR code. A votação fecha quando a próxima rodada começa ou quando a organização clica em **Encerrar votação** no painel (dá para reabrir).
- Se alguém que não é competidor abrir o editor durante a rodada (o link é público), a máquina pode aparecer no telão. No painel, no quadro **No telão ao vivo**, clique em **Tirar do telão**: a próxima máquina sobe.

Detalhes técnicos e configuração do Supabase: `SUPABASE.md`.

## Preparação

- Em cada computador, abra o endereço do editor (não o arquivo local `file://`) e digite o nome. O editor fica travado em "Aguardando a rodada começar" até o play.
- No computador do projetor, abra o telão e aperte F para tela cheia. Com o mouse parado, o cursor e o botão somem.
- Uma vez só: rode no SQL Editor a migration `supabase/migrations/20261119120000_telao_ao_vivo.sql` (veja `SUPABASE.md`). Sem ela o telão mostra só o cronômetro.
- Deixe no painel só as 4 rodadas da edição (3 + a final), na ordem certa: o telão chama a última de FINAL.
- Em cada rodada, só os 3 competidores abrem o editor. Os outros computadores (organização, projetor) usam só o painel e o telão.
- No painel, confira se aparecem só as 4 rodadas da DevFest como **Pronta** (Rodada 1 · Inscrições, Rodada 2 · Chamada de palestrantes, Rodada 3 · Voluntariado, Final · Contagem regressiva). Se não, rode o `desafios/devfestjp/rodadas-devfestjp.sql` no SQL Editor (veja `SUPABASE.md`).
- Os desafios usam fontes do Google Fonts: a internet do local precisa liberar `fonts.googleapis.com` e `fonts.gstatic.com` para os competidores e para o telão.
- Faça um ensaio completo antes do público: Iniciar uma rodada, Entregar de um editor, Encerrar agora, apresentar em tela cheia e **Reiniciar** (a rodada volta para Pronta e as entregas do ensaio são apagadas).
- Conecte e espelhe os monitores dos participantes para a audiência; deixe o computador do telão separado para projeção.
- Votação do público: rode também a migration `supabase/migrations/20261119150000_votacao_publico.sql` (veja `SUPABASE.md`). Teste com o seu celular lendo o QR code do telão numa rodada de ensaio. A Wi-Fi do local precisa deixar o público abrir o site. O antigo `vote/index.html` (redirecionamento para o Mentimeter) não é mais necessário.
- Plano B: se a internet cair, o editor continua funcionando e guarda o código no navegador; o `Finish` mostra o resultado mesmo sem conexão. Para um evento todo offline, as pastas de `desafios/devfestjp/` trazem cada uma o editor e os arquivos da rodada (pendrive) e ainda funcionam, mas sem tempo sincronizado nem entrega.
- Explique as regras antes de iniciar. Durante a rodada: HTML/CSS, sem previews, sem ferramentas de medição e sem sair do editor.

## Roteiro simples

1. Recepção: cada participante abre o editor e digita o nome.
2. Teste de espelhamento e do telão.
3. Explicação das regras e escolha de quem vai controlar o painel e a votação.
4. Contagem regressiva; no sinal combinado, **▶ Iniciar** a rodada no painel. Confira no quadro **No telão ao vivo** que as telas 1, 2 e 3 são os 3 competidores.
5. Ao fim do tempo, os editores entregam e travam sozinhos. No telão, clique em **Mostrar resultados** e em cada competidor para comparar com a ideia original. (Também dá para usar **Apresentar em tela cheia** no painel ou o `Finish` de cada participante.)
6. No telão, clique em **Votação do público** (ou V): aparece o QR code para o público votar no celular em quem leva a rodada. Quando quiser, clique em **Mostrar resultado do público** (logo abaixo do QR code) e reconheça o vencedor. Para fechar os votos antes, use **Encerrar votação** no painel. Para a próxima rodada, **▶ Iniciar** a seguinte: os editores limpam e liberam a nova referência sozinhos, e a votação da rodada anterior fecha.

O README do repositório também registra as regras de organização e as condições de uso comunitário. Consulte-o e o arquivo `LICENSE` antes do evento.
