-- Code in the Dark UNIESP — votação do público
--
-- Rode DEPOIS de 20261119120000_telao_ao_vivo.sql. Idempotente: pode rodar
-- mais de uma vez.
--
-- * A votação abre sozinha quando a rodada termina e vale para os 3
--   competidores que estão no telão. Fecha quando a próxima rodada começa (ou
--   é reiniciada) ou quando o painel clica em "Encerrar votação".
-- * Cada celular gera um identificador aleatório (eleitor): um voto por
--   celular por rodada, que pode ser trocado enquanto a votação está aberta.
-- * O telão (QR code e resultado), a página de votação e o painel leem
--   public.votacao(); o celular vota com public.votar().

create table if not exists public.votes (
  round_id       text not null references public.rounds (id) on delete cascade,
  run_started_at timestamptz not null, -- o "play" da rodada em que o voto valeu
  voter_id       uuid not null,
  device_id      uuid not null,        -- máquina do competidor escolhido
  voted_at       timestamptz not null default now(),
  primary key (round_id, run_started_at, voter_id)
);

comment on table public.votes is
  'Votos do público por rodada. Sem acesso direto: só via votar() e votacao().';

revoke all on table public.votes from anon, authenticated;
alter table public.votes enable row level security;
-- Sem políticas: só as funções security definer abaixo e o SQL Editor acessam.

-- Votação encerrada pelo painel depois do play atual (null: aberta).
alter table public.rounds add column if not exists votes_closed_at timestamptz;

-- ---------------------------------------------------------------------------
-- Candidatos: as mesmas 3 telas do telão (uso interno)
-- ---------------------------------------------------------------------------

create or replace function public.candidatos_votacao()
returns table (round_id text, run_started_at timestamptz, tela bigint, device_id uuid, nome text)
language sql
stable
security definer
set search_path = ''
as $$
  select l.round_id, l.run_started_at,
         row_number() over (order by l.joined_at, l.device_id), l.device_id, l.name
    from public.live_code l
    join public.rounds r
      on r.id = public.estado_atual() ->> 'round'
     and l.round_id = r.id and l.run_started_at = r.started_at
   where not l.hidden
   order by l.joined_at, l.device_id
   limit 3;
$$;

-- ---------------------------------------------------------------------------
-- Estado da votação, candidatos e placar
-- ---------------------------------------------------------------------------

-- status: "aguardando" (rodada ainda não terminou), "aberta" ou "encerrada".
-- p_eleitor (opcional): devolve em "meu_voto" a máquina em que esse celular votou.
create or replace function public.votacao(p_eleitor uuid default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with e as (
    select public.estado_atual() as estado
  ),
  r as (
    select x.* from public.rounds x, e where x.id = e.estado ->> 'round'
  ),
  v as (
    select vt.device_id, vt.voter_id
      from public.votes vt join r on vt.round_id = r.id and vt.run_started_at = r.started_at
  )
  select jsonb_build_object(
    'round',  r.id,
    'title',  r.title,
    'status', case
                when r.started_at is null or e.estado ->> 'status' <> 'encerrada' then 'aguardando'
                when r.votes_closed_at >= r.started_at then 'encerrada'
                else 'aberta'
              end,
    'total',  (select count(*) from v join public.candidatos_votacao() c on c.device_id = v.device_id),
    'candidatos', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tela',   c.tela,
               'device', c.device_id,
               'nome',   c.nome,
               'votos',  (select count(*) from v where v.device_id = c.device_id)
             ) order by c.tela)
        from public.candidatos_votacao() c), '[]'::jsonb),
    'meu_voto', (select v.device_id from v where v.voter_id = p_eleitor)
  )
  from e left join r on true;
$$;

-- ---------------------------------------------------------------------------
-- Voto (celular do público)
-- ---------------------------------------------------------------------------

create or replace function public.votar(p_eleitor uuid, p_device uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_round public.rounds;
  v_count integer;
  v_at    timestamptz;
begin
  if p_eleitor is null or p_device is null then
    raise exception 'CITD_INVALID_VOTE';
  end if;

  -- FOR SHARE: "Encerrar votação" e o play da próxima rodada esperam os votos em andamento.
  select r.* into v_round from public.rounds r
   where r.id = public.estado_atual() ->> 'round'
   for share;
  if v_round.id is null or v_round.started_at is null
     or public.estado_atual() ->> 'status' <> 'encerrada'
     or v_round.votes_closed_at >= v_round.started_at then
    raise exception 'CITD_VOTING_CLOSED';
  end if;
  if not exists (select 1 from public.candidatos_votacao() c where c.device_id = p_device) then
    raise exception 'CITD_INVALID_VOTE';
  end if;

  -- Teto por rodada: protege o banco de abuso pelo link público.
  if not exists (select 1 from public.votes vt
                  where vt.round_id = v_round.id and vt.run_started_at = v_round.started_at
                    and vt.voter_id = p_eleitor) then
    select count(*) into v_count from public.votes vt
     where vt.round_id = v_round.id and vt.run_started_at = v_round.started_at;
    if v_count >= 5000 then
      raise exception 'CITD_RATE_LIMIT';
    end if;
  end if;

  insert into public.votes as vt (round_id, run_started_at, voter_id, device_id)
  values (v_round.id, v_round.started_at, p_eleitor, p_device)
  on conflict (round_id, run_started_at, voter_id) do update
    set device_id = excluded.device_id, voted_at = now()
  returning vt.voted_at into v_at;
  return v_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- Painel: encerrar ou reabrir a votação da rodada
-- ---------------------------------------------------------------------------

create or replace function public.admin_votacao(p_round text, p_aberta boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_organizer() then
    raise exception 'CITD_FORBIDDEN' using errcode = '42501';
  end if;
  update public.rounds r
     set votes_closed_at = case when coalesce(p_aberta, false) then null else now() end
   where r.id = p_round;
  if not found then
    raise exception 'CITD_UNKNOWN_ROUND' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.candidatos_votacao() from public, anon, authenticated;
revoke all on function public.votacao(uuid) from public;
revoke all on function public.votar(uuid, uuid) from public;
revoke all on function public.admin_votacao(text, boolean) from public, anon;
grant execute on function public.votacao(uuid) to anon, authenticated;
grant execute on function public.votar(uuid, uuid) to anon, authenticated;
grant execute on function public.admin_votacao(text, boolean) to authenticated;
