# Rodadas, cronômetro e entregas no Supabase

```
painel admin/ ──login + chave pública──▶ RPCs admin_* ──▶ Postgres (RLS)
                                                              │ estado da rodada,
editor/ e telão evento/ ──chave pública──▶ estado_atual ◀─────┘ materiais, entregas
                                           materiais_rodada (só depois do play)
                                           entregar (só com a rodada valendo)
```

- O **painel** dá o play, pausa, encerra, reinicia e mostra as entregas.
- O **editor** consulta o estado a cada 2 s. No play, carrega a referência e as
  instruções da rodada, limpa o editor (o código anterior fica guardado no
  navegador) e destrava. No fim do tempo, entrega o código sozinho e trava.
- O **telão** mostra o mesmo cronômetro, calculado com a hora do servidor.

## Arquivos

| Arquivo | Para quê |
| --- | --- |
| `supabase/migrations/20261029120000_code_in_the_dark_submissions.sql` | Base: organizadores, rodadas, entregas e RLS |
| `supabase/migrations/20261029160000_rodadas_cronometro_sem_token.sql` | Cronômetro, materiais escondidos, entrega sem token |
| `supabase/migrations/20261029190000_reiniciar_rodada.sql` | Reiniciar a qualquer momento (telão mostra a rodada reiniciada) |
| `desafios/halloween/gerar-sql.mjs` (fora do Git) | Gera `rodadas-halloween.sql`, com as 5 rodadas prontas |
| `supabase/tests/` | Testes do banco (PGlite) e de ponta a ponta (Chrome) |
| `citd-config.js` | Configuração **pública** (URL do projeto e chave pública) |
| `editor/assets/rodada.js` | Rodada ao vivo no editor (tempo, referência, Entregar) |
| `editor/assets/*.svg` | Imagens das rodadas usadas no código dos participantes |
| `evento/index.html` | Telão sincronizado |
| `admin/` | Painel da organização |
| `desafios/` (fora do Git) | Referências, instruções e gabaritos de cada rodada |

## Regras de segurança

- **Nunca** coloque a `service_role` / secret key em `citd-config.js`, no HTML ou em
  qualquer arquivo versionado. A chave pública pode ficar no site.
- Visitantes (chave pública) não leem nenhuma tabela. Só podem chamar
  `estado_atual`, `materiais_rodada` (recusada antes do play) e `entregar`
  (recusada fora do tempo).
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
- Duração de 1 a 120 minutos (padrão 15), editável no painel enquanto a rodada está Pronta.

## Colocar as rodadas no projeto `chcmtotuohtoyybvljrd`

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
npm test        # migrations no PGlite: permissões, play, pausa, fim, tolerância, limites, reiniciar
npm run seed    # rodadas-halloween.sql no estado atual do projeto (precisa da pasta desafios/)
npm run e2e     # Chrome headless: painel, telão e dois participantes contra um Supabase simulado
```

O `e2e` precisa do Chrome (ou Edge, via `CHROME=...`) e da pasta
`desafios/halloween`. O seletor de pasta nativo do **Importar desafios** não é
automatizável; o teste entrega os arquivos reais da pasta direto ao campo.
