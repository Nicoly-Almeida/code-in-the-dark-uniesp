# Envio de trabalhos para o Supabase

Fluxo: o participante clica em **Enviar trabalho** no editor → a Edge Function
`submit` valida e grava no banco → a organização consulta em `admin/`.

```
editor/ (GitHub Pages) ──POST JSON──▶ Edge Function submit ──RPC──▶ Postgres (RLS)
                                         (service role só aqui)          ▲
admin/ (GitHub Pages) ──login Supabase Auth + chave pública──────────────┘
```

## Arquivos

| Arquivo | Para quê |
| --- | --- |
| `supabase/migrations/20261029120000_code_in_the_dark_submissions.sql` | Tabelas, RLS, privilégios e RPCs |
| `supabase/functions/submit/index.ts` e `handler.ts` | Edge Function de envio |
| `supabase/config.toml` | `verify_jwt = false` para a função `submit` |
| `supabase/tests/database/submissions.test.sql` | Testes pgTAP de RLS e regras |
| `supabase/functions/tests/submit-handler.test.ts` | Testes Deno da função |
| `supabase/teste/seed-teste.sql` / `limpar-teste.sql` | Modo de teste com dados fictícios |
| `citd-config.js` | Configuração **pública** (URL do projeto e chave pública) |
| `editor/assets/submit.js` | Botão "Enviar trabalho" no editor |
| `admin/` | Painel da organização |
| `.env.example` | Variáveis da função (sem valores reais) |

## Regras de segurança

- **Nunca** coloque a `service_role` / secret key em `citd-config.js`, no HTML, no
  GitHub Pages ou em qualquer arquivo versionado. Ela só existe dentro da Edge
  Function, injetada pelo Supabase como `SUPABASE_SERVICE_ROLE_KEY`.
- A chave pública (`anon` ou `publishable`) pode ficar no site: o banco tem RLS
  e `anon` não tem nenhum privilégio nas tabelas.
- Tokens de participação são gerados aleatoriamente e só o SHA-256 é salvo.
  O painel mostra cada token **uma única vez**.
- O código enviado é tratado como não confiável. O painel mostra o código como
  texto. A prévia roda num iframe `sandbox=""` (sem scripts, formulários ou
  acesso ao painel), que também herda a CSP do painel.
- O CORS aceita somente as origens em `ALLOWED_ORIGINS`. Requisições sem
  `Origin`, de outra origem ou com `Origin: null` (editor aberto via `file://`)
  são recusadas.

> **Importante para o dia do evento:** para enviar, o participante precisa abrir o
> editor pelo endereço publicado (ex.: `https://nicoly-almeida.github.io/code-in-the-dark-uniesp/editor/`),
> e não pelo arquivo copiado do pendrive (`file://`).

## Status do projeto `chcmtotuohtoyybvljrd` (29/10/2026)

Já feito no painel do Supabase:

- [x] Migration aplicada pelo SQL Editor. As 4 tabelas estão com RLS ativo, `anon` não tem privilégio em nenhuma e só `service_role` executa `submit_entry`.
- [x] Edge Function `submit` implantada (`index.ts` + `handler.ts`), com **Verify JWT desligado**.
- [x] Secret `ALLOWED_ORIGINS=https://nicoly-almeida.github.io`.
- [x] Chave pública (`sb_publishable_...`) em `citd-config.js`.
- [x] Verificado: origem permitida + token falso → `401 invalid_credentials` (a função chegou ao banco). Outra origem → `403 forbidden_origin`. A API pública com a chave publishable nas tabelas e RPCs → `42501 permission denied`.

Falta:

- [ ] Criar o usuário organizador e incluí-lo em `organizers` (passo 5).
- [ ] Publicar o repositório no GitHub Pages (passo 6).
- [ ] Rodar o modo de teste com o site publicado.
- [ ] Se for usar o CLI: `npx supabase migration repair --status applied 20261029120000`.

## Passo a passo de configuração

Projeto: `https://chcmtotuohtoyybvljrd.supabase.co`. Ajuste se usar outro.

### 1. Aplicar a migration

**Opção A — Supabase CLI**

```bash
npx supabase login
npx supabase link --project-ref chcmtotuohtoyybvljrd
npx supabase db push
```

**Opção B — Painel:** abra **SQL Editor > New query**, cole o conteúdo de
`supabase/migrations/20261029120000_code_in_the_dark_submissions.sql` e clique
em **Run**. Se depois passar a usar o CLI, registre que ela já foi aplicada:

```bash
npx supabase migration repair --status applied 20261029120000
```

### 2. Implantar a Edge Function

**CLI:**

```bash
npx supabase functions deploy submit --no-verify-jwt
```

**Painel:** **Edge Functions > Deploy a new function > Via Editor**, nome `submit`.
Crie os arquivos `index.ts` e `handler.ts` com o conteúdo de
`supabase/functions/submit/`. Em seguida abra a função, vá em **Details/Settings** e
**desative "Verify JWT with legacy secret" / "Enforce JWT verification"**. O editor
não envia JWT; a proteção é o token de participação.

### 3. Definir o secret de origem

**CLI:**

```bash
npx supabase secrets set ALLOWED_ORIGINS=https://nicoly-almeida.github.io
# opcional: npx supabase secrets set MAX_CODE_BYTES=200000
```

**Painel:** **Edge Functions > Secrets**: crie `ALLOWED_ORIGINS` com o valor
`https://nicoly-almeida.github.io`. É só a origem (esquema + domínio), sem caminho
e sem barra no fim. Se usar domínio próprio, inclua-o separado por vírgula.

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já existem na função; não crie nem copie.

### 4. Configurar o site

Em **Project Settings > API Keys**, copie a chave **pública** (`anon` ou
`publishable`, nunca a `secret`/`service_role`) para `supabasePublishableKey` em
`citd-config.js`. Confira `supabaseUrl` e `submitUrl`. Faça commit e publique.

### 5. Criar o acesso da organização

1. **Authentication > Users > Add user > Create new user**: informe o e-mail e
   uma senha forte e marque **Auto Confirm User**.
2. **Authentication > Sign In / Providers**: se não for usar cadastro público,
   desative **Allow new users to sign up**. O painel não precisa disso.
3. No **SQL Editor**, rode (trocando o e-mail):

   ```sql
   insert into public.organizers (user_id)
   select id from auth.users where email = 'SEU-EMAIL@exemplo.com';
   ```

4. Abra `https://nicoly-almeida.github.io/code-in-the-dark-uniesp/admin/` e entre.

### 6. GitHub Pages

**Settings > Pages**: publique a branch principal (pasta raiz). O `CNAME` herdado
(`codeinthedark.com`) foi removido para o site responder em `nicoly-almeida.github.io`.

## Operação no evento

1. No painel, crie a rodada (ex.: `rodada-1`). Ela nasce **fechada**.
2. Cadastre cada participante/equipe e entregue o token (papel ou mensagem). O
   token só aparece uma vez; se perder, remova e gere outro.
3. Abra a rodada quando o cronômetro começar.
4. No fim do tempo, os participantes clicam em **Enviar trabalho** e depois em
   **Finish**. Reenvios são aceitos enquanto a rodada estiver aberta; o painel
   mostra por padrão só o último envio de cada participante.
5. Dê uma pequena tolerância (ex.: 1 minuto) e clique em **Encerrar rodada**. A
   partir daí a função responde "rodada encerrada".
6. Consulte o código como texto, baixe o `.html` ou use a prévia isolada.

Dica: um link `editor/?rodada=rodada-1` já preenche a rodada (não coloque o
token na URL).

Limites: nome até 80 caracteres; rodada `a-z`, `0-9` e `-` (até 40); código até
o limite da rodada (padrão 100 KB) e teto global `MAX_CODE_BYTES`; até 20 envios
por participante.

## Modo de teste (dados fictícios)

1. Faça os passos 1 a 5.
2. No SQL Editor, rode `supabase/teste/seed-teste.sql`. Ele cria a rodada aberta
   `teste` e dois participantes fictícios e mostra os tokens gerados (só nesse
   resultado).
3. **Envio:** abra o editor publicado, digite algo e clique em **Enviar trabalho**.
   Use o nome `Equipe Fictícia Alfa`, a rodada `teste` e o token gerado. Deve
   aparecer "Trabalho enviado às ...".
4. **Listagem restrita:**
   - No painel, logado como organizador, a rodada `teste` mostra o envio.
   - Sem login, ou logado com um usuário fora de `organizers`, o painel não lista nada.
   - Pela API pública, com a chave pública, o acesso é negado:

     ```bash
     curl -s "https://chcmtotuohtoyybvljrd.supabase.co/rest/v1/submissions?select=*" \
       -H "apikey: CHAVE_PUBLICA" -H "Authorization: Bearer CHAVE_PUBLICA"
     # esperado: erro "permission denied for table submissions"
     ```

5. **Origem recusada:**

   ```bash
   curl -si -X POST https://chcmtotuohtoyybvljrd.supabase.co/functions/v1/submit \
     -H "Origin: https://exemplo-nao-autorizado.com" -H "Content-Type: application/json" \
     -d '{}' | head -1
   # esperado: HTTP/2 403
   ```

6. **Rodada encerrada:** no painel, clique em **Encerrar rodada** e envie de
   novo pelo editor. Deve aparecer "A rodada está encerrada...".
7. Ao terminar, rode `supabase/teste/limpar-teste.sql`.

## Testes locais

```bash
# Função (sem rede):
deno test supabase/functions/tests/

# Banco (requer Docker + Supabase CLI):
npx supabase start
npx supabase test db

# Função local apontando para o banco local:
cp .env.example supabase/functions/.env   # ajuste ALLOWED_ORIGINS=http://localhost:8080
npx supabase functions serve submit --env-file supabase/functions/.env
```

Para testar o editor localmente, sirva a raiz com `python3 -m http.server 8080` e
aponte `submitUrl` para `http://localhost:54321/functions/v1/submit` numa cópia
local de `citd-config.js`, sem fazer commit dessa mudança.
