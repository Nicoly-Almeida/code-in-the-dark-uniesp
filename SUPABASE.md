# Rodadas, cronômetro e entregas no Supabase

```
painel admin/ ──login + chave pública──▶ RPCs admin_* ──▶ Postgres (RLS)
                                                              │ estado da rodada,
editor/ e telão evento/ ──chave pública──▶ estado_atual ◀─────┘ materiais, entregas
                                           materiais_rodada (só depois do play)
                                           entregar (só com a rodada valendo)
```

- O **painel** importa as rodadas, dá o play, pausa, encerra e mostra as entregas.
- O **editor** consulta o estado a cada 2 s. No play, carrega a referência e as
  instruções da rodada, limpa o editor (o código anterior fica guardado no
  navegador) e destrava. No fim do tempo, entrega o código sozinho e trava.
- O **telão** mostra o mesmo cronômetro, calculado com a hora do servidor.

## Arquivos

| Arquivo | Para quê |
| --- | --- |
| `supabase/migrations/20261029120000_code_in_the_dark_submissions.sql` | Base: organizadores, rodadas, entregas e RLS |
| `supabase/migrations/20261029160000_rodadas_cronometro_sem_token.sql` | Cronômetro, materiais escondidos, entrega sem token |
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

## Atualizar o projeto `chcmtotuohtoyybvljrd`

A primeira migration já foi aplicada. Para o modelo novo:

1. **SQL Editor > New query**: cole o conteúdo de
   `supabase/migrations/20261029160000_rodadas_cronometro_sem_token.sql` e clique
   em **Run**. Ela apaga as tabelas e funções de token (incluindo participantes e
   envios de teste antigos) e cria o cronômetro.
2. **Edge Functions**: a função `submit` não é mais usada. Pode apagá-la, junto com
   o secret `ALLOWED_ORIGINS`.
3. Publique o site (merge na `master`).
4. Abra o painel, entre e use **Importar desafios** escolhendo a pasta
   `desafios/halloween`. As 5 rodadas aparecem como **Pronta**. Reimportar
   atualiza título, instruções e referência sem duplicar.
5. Faça um ensaio (veja `EVENTO-UNIESP.md`) e termine com **Reiniciar**.

Se for usar o Supabase CLI depois:
`npx supabase migration repair --status applied 20261029120000 20261029160000`.

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
nunca é enviado.

## Testes

```bash
cd supabase/tests
npm install
npm test        # migrations no PGlite: permissões, play, pausa, fim, tolerância, limites
npm run e2e     # Chrome headless: painel, telão e dois participantes contra um Supabase simulado
```

O `e2e` precisa do Chrome (ou Edge, via `CHROME=...`) e da pasta
`desafios/halloween`. O seletor de pasta nativo do **Importar desafios** não é
automatizável; o teste entrega os arquivos reais da pasta direto ao campo.
