# Rodadas, cronômetro e entregas no Supabase

```
painel admin/ ──login + chave pública──▶ RPCs admin_* ──▶ Postgres (RLS)
                                                              │ estado da rodada,
editor/ e telão evento/ ──chave pública──▶ estado_atual ◀─────┘ materiais, entregas
                                           materiais_rodada (só depois do play)
                                           entregar (só com a rodada valendo)
                                           enviar_ao_vivo (editor → código ao vivo)
                                           telao_ao_vivo (telão ← tempo + 3 telas)
votar/ (celular do público) ─────────────▶ votacao, votar (depois do fim da rodada)
```

- O **painel** dá o play, pausa, encerra, reinicia e mostra as entregas.
- O **editor** consulta o estado a cada 2 s. No play, carrega a referência e as
  instruções da rodada, limpa o editor (o código anterior fica guardado no
  navegador) e destrava. No fim do tempo, entrega o código sozinho e trava.
  Durante a rodada, manda o código e o cursor para o telão a cada segundo
  (só quando mudou).
- O **telão** mostra o mesmo cronômetro, calculado com a hora do servidor, e o
  código ao vivo de 3 competidores: as 3 primeiras máquinas que entram na
  rodada. O painel pode tirar uma máquina do telão (a próxima sobe).

## Arquivos

| Arquivo | Para quê |
| --- | --- |
| `supabase/migrations/20261029120000_code_in_the_dark_submissions.sql` | Base: organizadores, rodadas, entregas e RLS |
| `supabase/migrations/20261029160000_rodadas_cronometro_sem_token.sql` | Cronômetro, materiais escondidos, entrega sem token |
| `supabase/migrations/20261029190000_reiniciar_rodada.sql` | Reiniciar a qualquer momento (telão mostra a rodada reiniciada) |
| `supabase/migrations/20261119120000_telao_ao_vivo.sql` | Código ao vivo dos competidores no telão |
| `supabase/migrations/20261119150000_votacao_publico.sql` | Votação do público (QR code no telão) |
| `desafios/devfestjp/gerar-sql.mjs` (fora do Git) | Gera `rodadas-devfestjp.sql`: migrations do telão e da votação + as 4 rodadas da DevFest |
| `desafios/halloween/gerar-sql.mjs` (fora do Git) | Edição anterior: gera `rodadas-halloween.sql` com as 5 rodadas |
| `supabase/tests/` | Testes do banco (PGlite) e de ponta a ponta (Chrome) |
| `citd-config.js` | Configuração **pública** (URL do projeto e chave pública) |
| `editor/assets/rodada.js` | Rodada ao vivo no editor (tempo, referência, Entregar) |
| `editor/assets/*.svg` | Imagens das rodadas usadas no código dos participantes |
| `evento/index.html`, `evento/telao.js` | Telão: cronômetro, rodadas (1, 2, 3, FINAL), as 3 telas ao vivo e, com a rodada encerrada, os resultados ao lado da referência |
| `votar/` | Página de votação do público (aberta pelo QR code do telão) |
| `evento/vendor/` | Gerador de QR code (qrcode-generator 2.0.4, MIT) |
| `evento/assets/` | Fonte Press Start 2P (a do editor, SIL OFL 1.1) e o logo ciano do POWER MODE |
| `admin/` | Painel da organização |
| `desafios/` (fora do Git) | Referências, instruções e gabaritos de cada rodada |

## Regras de segurança

- **Nunca** coloque a `service_role` / secret key em `citd-config.js`, no HTML ou em
  qualquer arquivo versionado. A chave pública pode ficar no site.
- Visitantes (chave pública) não leem nenhuma tabela. Só podem chamar
  `estado_atual`, `materiais_rodada` (recusada antes do play), `entregar`
  (recusada fora do tempo), `enviar_ao_vivo` (ignorada fora do tempo) e
  `telao_ao_vivo`, `votacao` e `votar` (recusada fora da votação).
- O código ao vivo é público enquanto a rodada acontece (é o que o telão
  projeta). Durante a rodada o telão mostra só o **texto** do código, nunca o
  resultado renderizado: os competidores também enxergam o projetor. As
  prévias só aparecem com a rodada encerrada, em `iframe sandbox=""` (sem
  scripts) sob a CSP do telão (nada de fora; só os assets do editor). A prévia
  usa o último código ao vivo, o mesmo que a entrega automática do fim manda.
- A referência e as instruções ficam na tabela `round_materials`, sem acesso
  direto. A pasta `desafios/` está no `.gitignore`: o repositório é público e o
  `referencia.html` é o gabarito.
- Sem token, qualquer pessoa com o link consegue entregar com qualquer nome
  enquanto a rodada está valendo. O painel agrupa as entregas por navegador e
  permite apagar a rodada inteira com **Reiniciar**.
- O código entregue é tratado como não confiável: o painel mostra como texto e a
  prévia roda em `iframe sandbox=""` (sem scripts), com a CSP do painel.

## Limites

- Uma rodada valendo ou pausada por vez.
- Entregas aceitas até 60 s depois do fim (tolerância para a entrega automática).
- Sem limite de tamanho para quem digita; o teto técnico é 1 MB por entrega.
- Até 50 entregas por navegador por rodada e 2000 por rodada.
- Código ao vivo: até 100 máquinas por rodada; o telão mostra 3.
- Votação: um voto por celular (identificador aleatório guardado no navegador)
  por rodada, até 5000 votos por rodada. Quem limpa os dados do navegador ou
  usa outra aba anônima consegue votar de novo: é uma votação de plateia, não
  uma eleição.
- Duração de 1 a 120 minutos (padrão 15), editável no painel enquanto a rodada está Pronta.

## DevFest JP 2026: deixar o projeto `chcmtotuohtoyybvljrd` pronto

Uma colagem só faz tudo: aplica as migrations de Reiniciar, do telão ao vivo e
da votação (todas podem rodar de novo), **apaga todas as outras rodadas** (Halloween,
rodadas de teste ou criadas por engano, com
as entregas, o código ao vivo e os votos delas) e cria as 4 rodadas da DevFest.

1. Abra `desafios/devfestjp/rodadas-devfestjp.sql` (fica só no seu computador),
   selecione tudo e copie.
2. **SQL Editor > New query**: cole e clique em **Run**. O resultado lista só as
   4 rodadas da DevFest como `pronta`, cada uma com a referência.
3. No painel, confira as 4 rodadas e faça um ensaio (veja `EVENTO-UNIESP.md`).

Cada rodada é uma pasta `N-nome/assets/` com `instructions.html` (a linha
`=== TÍTULO ===` vira o nome da rodada no telão) e `page.jpg` (a referência).
As imagens que os competidores usam no código ficam em `editor/assets/`. Se
mudar algo na pasta, gere de novo com `node desafios/devfestjp/gerar-sql.mjs`
ou use **Atualizar desafios a partir da pasta** no painel. As instruções
originais ficam em `N-nome/instructions.original.html`.

## Edição anterior (Halloween)

As migrations `20261029120000` e `20261029160000` já foram aplicadas. Falta um
arquivo só, que já traz a migration de **Reiniciar** e as 5 rodadas prontas:

1. Abra `desafios/halloween/rodadas-halloween.sql` (fica só no seu computador),
   selecione tudo e copie.
2. **SQL Editor > New query**: cole e clique em **Run**. O resultado lista as 5
   rodadas como `pronta`, cada uma com a referência.
3. No painel, as rodadas já aparecem como **Pronta**: é só dar **▶ Iniciar**.
4. Faça um ensaio (veja `EVENTO-UNIESP.md`) e termine com **Reiniciar**.

O arquivo pode ser rodado de novo: atualiza título, instruções e referência sem
duplicar e sem mexer em rodada valendo nem em entregas. Se mudar algo em
`desafios/halloween`, gere de novo com `node desafios/halloween/gerar-sql.mjs`.
Também dá para atualizar pelo painel, em **Atualizar desafios a partir da pasta**.

A Edge Function `submit` e o secret `ALLOWED_ORIGINS` não são mais usados e podem
ser apagados em **Edge Functions**.

Se for usar o Supabase CLI depois:
`npx supabase migration repair --status applied 20261029120000 20261029160000 20261029190000`.

### Telão ao vivo (migration de 19/11)

Rode uma vez no **SQL Editor** o arquivo
`supabase/migrations/20261119120000_telao_ao_vivo.sql` (copie tudo, cole e
**Run**). Pode rodar de novo sem problema. Antes disso, o telão mostra só o
cronômetro ("Telas ao vivo desligadas") e o painel avisa no quadro **No telão
ao vivo**; editores e entregas funcionam normalmente.

O telão numera as rodadas pela ordem (`position`) e chama a última de
**FINAL**. Para uma edição com 4 rodadas (3 + a final), deixe no painel só as
4 rodadas da edição. Para apagar uma rodada que sobrou (com as entregas dela):

```sql
delete from public.rounds where id = 'rodada-5-exorciza-dev';
```

Se for usar o Supabase CLI depois, marque também esta migration como aplicada:
`npx supabase migration repair --status applied 20261119120000`.

### Votação do público (migration de 19/11)

Rode uma vez no **SQL Editor** o arquivo
`supabase/migrations/20261119150000_votacao_publico.sql` (depois da migration
do telão ao vivo). Pode rodar de novo sem problema.

- A votação abre sozinha quando a rodada termina (tempo zerado ou **Encerrar
  agora**) e vale para os 3 competidores do telão.
- Fecha quando a próxima rodada começa (ou a rodada é reiniciada) ou pelo botão
  **Encerrar votação** do painel (quadro **No telão ao vivo**), que também reabre.
- Os votos ficam na tabela `votes`, sem acesso direto. Para conferir no SQL Editor:
  `select round_id, device_id, count(*) from public.votes group by 1, 2;`

Se for usar o Supabase CLI depois:
`npx supabase migration repair --status applied 20261119150000`.

### Novo organizador

Crie o usuário em **Authentication > Users > Add user** (marque **Auto Confirm
User**) e rode no SQL Editor:

```sql
insert into public.organizers (user_id)
select id from auth.users where email = 'EMAIL@exemplo.com'
on conflict (user_id) do nothing;
```

### Novos desafios

Cada rodada é uma pasta `rodada-N-nome/assets/` com `instructions.html` (a
primeira linha `=== TÍTULO ===` vira o nome da rodada) e `page.png` (a
referência). As imagens que os participantes usam no código vão para
`editor/assets/` (públicas, nomes únicos entre rodadas). O `referencia.html`
nunca é enviado. Depois, gere o SQL com `gerar-sql.mjs` e rode no SQL Editor.

### Reiniciar

**Reiniciar** funciona em qualquer momento (valendo, pausada ou encerrada): o
tempo para, a rodada volta para **Pronta**, as entregas dela são apagadas e o
telão e os editores voltam a aguardar. No próximo **▶ Iniciar**, os editores
começam limpos (o código anterior fica guardado no navegador do participante).

## Testes

```bash
cd supabase/tests
npm install
npm test        # migrations no PGlite: permissões, play, pausa, fim, tolerância, limites, reiniciar, telão ao vivo, votação
npm run seed    # rodadas-halloween.sql no estado atual do projeto (precisa da pasta desafios/)
npm run e2e     # Chrome headless: painel, telão (telas ao vivo, resultados e votação), dois participantes e um celular votando contra um Supabase simulado
```

O `e2e` precisa do Chrome (ou Edge, via `CHROME=...`) e da pasta
`desafios/halloween`. O seletor de pasta nativo do **Importar desafios** não é
automatizável; o teste entrega os arquivos reais da pasta direto ao campo.
