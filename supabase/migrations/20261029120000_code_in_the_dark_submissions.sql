-- Code in the Dark UNIESP — submissões de trabalhos
--
-- Modelo de segurança:
-- * Nenhuma tabela é legível por `anon`. RLS ativado em todas.
-- * Somente organizadores (linhas em public.organizers) autenticados leem
--   rodadas, participantes e submissões.
-- * Submissões só entram pela Edge Function `submit`, que usa a chave de
--   serviço no servidor e chama public.submit_entry(). Nenhum papel do
--   navegador pode inserir em public.submissions.
-- * Tokens de participação nunca são armazenados em texto: só o SHA-256 (hex).

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------------

create table public.organizers (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

comment on table public.organizers is
  'Usuários do Supabase Auth com acesso ao painel. Inserir manualmente pelo SQL Editor.';

create table public.rounds (
  id             text primary key
                 check (id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  title          text not null
                 check (char_length(title) between 1 and 120),
  is_open        boolean not null default false,
  max_code_bytes integer not null default 100000
                 check (max_code_bytes between 1000 and 500000),
  opened_at      timestamptz,
  closed_at      timestamptz,
  created_at     timestamptz not null default now()
);

comment on column public.rounds.id is
  'Identificador curto digitado pelo participante, ex.: rodada-1, final.';

create table public.participants (
  id           uuid primary key default gen_random_uuid(),
  round_id     text not null references public.rounds (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz not null default now()
);

create index participants_round_id_idx on public.participants (round_id);

create table public.submissions (
  id             uuid primary key default gen_random_uuid(),
  round_id       text not null references public.rounds (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  submitted_name text not null check (char_length(submitted_name) between 1 and 80),
  code           text not null,
  code_bytes     integer not null check (code_bytes > 0),
  submitted_at   timestamptz not null default now()
);

create index submissions_round_submitted_idx on public.submissions (round_id, submitted_at desc);
create index submissions_participant_idx on public.submissions (participant_id);

-- ---------------------------------------------------------------------------
-- Privilégios de tabela (o Supabase concede tudo a anon/authenticated por
-- padrão no schema public; aqui fechamos e liberamos só o necessário).
-- ---------------------------------------------------------------------------

revoke all on table public.organizers, public.rounds, public.participants, public.submissions
  from anon, authenticated;

grant select, delete on table public.rounds to authenticated;
grant insert (id, title, max_code_bytes) on table public.rounds to authenticated;
grant update (title, max_code_bytes) on table public.rounds to authenticated;
-- token_hash fica de fora: nem o painel precisa lê-lo.
grant select (id, round_id, display_name, created_at) on table public.participants to authenticated;
grant delete on table public.participants to authenticated;
grant select, delete on table public.submissions to authenticated;

alter table public.organizers   enable row level security;
alter table public.rounds       enable row level security;
alter table public.participants enable row level security;
alter table public.submissions  enable row level security;

-- ---------------------------------------------------------------------------
-- Funções auxiliares
-- ---------------------------------------------------------------------------

create or replace function public.is_organizer()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organizers o where o.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_organizer() from public, anon;
grant execute on function public.is_organizer() to authenticated;

-- ---------------------------------------------------------------------------
-- Políticas RLS (somente organizador autenticado). organizers não tem
-- política alguma: só é acessível pelo SQL Editor / service role.
-- ---------------------------------------------------------------------------

create policy "organizador lê rodadas" on public.rounds
  for select to authenticated using ((select public.is_organizer()));
create policy "organizador cria rodadas" on public.rounds
  for insert to authenticated with check ((select public.is_organizer()));
create policy "organizador edita rodadas" on public.rounds
  for update to authenticated
  using ((select public.is_organizer())) with check ((select public.is_organizer()));
create policy "organizador remove rodadas" on public.rounds
  for delete to authenticated using ((select public.is_organizer()));

create policy "organizador lê participantes" on public.participants
  for select to authenticated using ((select public.is_organizer()));
create policy "organizador remove participantes" on public.participants
  for delete to authenticated using ((select public.is_organizer()));

create policy "organizador lê submissões" on public.submissions
  for select to authenticated using ((select public.is_organizer()));
create policy "organizador remove submissões" on public.submissions
  for delete to authenticated using ((select public.is_organizer()));

-- ---------------------------------------------------------------------------
-- RPCs do painel
-- ---------------------------------------------------------------------------

-- Gera um token aleatório, guarda só o hash e devolve o token UMA vez.
create or replace function public.admin_create_participant(p_round text, p_name text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token text;
  v_name  text := btrim(coalesce(p_name, ''));
begin
  if not public.is_organizer() then
    raise exception 'CITD_FORBIDDEN' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'CITD_INVALID_NAME' using errcode = '22023';
  end if;
  if not exists (select 1 from public.rounds r where r.id = p_round) then
    raise exception 'CITD_UNKNOWN_ROUND' using errcode = '22023';
  end if;

  -- 24 bytes aleatórios em base64url (32 caracteres, sem "=").
  v_token := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_');

  insert into public.participants (round_id, display_name, token_hash)
  values (p_round, v_name, encode(extensions.digest(v_token, 'sha256'), 'hex'));

  return v_token;
end;
$$;

revoke all on function public.admin_create_participant(text, text) from public, anon;
grant execute on function public.admin_create_participant(text, text) to authenticated;

-- Abre ou encerra uma rodada, registrando os horários.
create or replace function public.admin_set_round_open(p_round text, p_open boolean)
returns public.rounds
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_round public.rounds;
begin
  if not public.is_organizer() then
    raise exception 'CITD_FORBIDDEN' using errcode = '42501';
  end if;

  update public.rounds r
     set is_open   = p_open,
         opened_at = case when p_open then now() else r.opened_at end,
         closed_at = case when p_open then null else now() end
   where r.id = p_round
  returning * into v_round;

  if v_round.id is null then
    raise exception 'CITD_UNKNOWN_ROUND' using errcode = '22023';
  end if;
  return v_round;
end;
$$;

revoke all on function public.admin_set_round_open(text, boolean) from public, anon;
grant execute on function public.admin_set_round_open(text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC da Edge Function (somente service_role)
-- ---------------------------------------------------------------------------

create or replace function public.submit_entry(
  p_round      text,
  p_token_hash text,
  p_name       text,
  p_code       text
)
returns table (submission_id uuid, submitted_at timestamptz)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_round       public.rounds;
  v_participant uuid;
  v_count       integer;
  v_max_per_participant constant integer := 20;
begin
  -- FOR SHARE: um "encerrar rodada" concorrente espera este envio terminar;
  -- tudo que confirmou antes do encerramento conta, nada entra depois.
  select r.* into v_round
    from public.rounds r
   where r.id = p_round
   for share;

  select p.id into v_participant
    from public.participants p
   where p.token_hash = p_token_hash
     and p.round_id   = p_round
   for update; -- serializa envios do mesmo participante (limite abaixo)

  -- Rodada inexistente e token errado devolvem o mesmo erro.
  if v_round.id is null or v_participant is null then
    raise exception 'CITD_INVALID_TOKEN';
  end if;

  if not v_round.is_open then
    raise exception 'CITD_ROUND_CLOSED';
  end if;

  if octet_length(p_code) > v_round.max_code_bytes then
    raise exception 'CITD_CODE_TOO_LARGE';
  end if;

  select count(*) into v_count
    from public.submissions s
   where s.participant_id = v_participant;
  if v_count >= v_max_per_participant then
    raise exception 'CITD_RATE_LIMIT';
  end if;

  return query
  insert into public.submissions (round_id, participant_id, submitted_name, code, code_bytes)
  values (p_round, v_participant, p_name, p_code, octet_length(p_code))
  returning id, public.submissions.submitted_at;
end;
$$;

revoke all on function public.submit_entry(text, text, text, text) from public, anon, authenticated;
grant execute on function public.submit_entry(text, text, text, text) to service_role;
