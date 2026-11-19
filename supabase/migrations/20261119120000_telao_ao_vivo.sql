-- Code in the Dark UNIESP — telão com o código dos competidores ao vivo
--
-- Rode DEPOIS de 20261029190000_reiniciar_rodada.sql. Idempotente: pode rodar
-- mais de uma vez.
--
-- * Durante a rodada, cada editor manda o código atual e a posição do cursor
--   a cada ~1 s para public.enviar_ao_vivo() (uma linha por máquina).
-- * O telão lê public.telao_ao_vivo(): o estado da rodada e as 3 primeiras
--   máquinas que entraram nela, menos as que o painel tirou do telão.
-- * O painel lista as máquinas da rodada (admin_ao_vivo) e tira ou devolve
--   uma máquina do telão (admin_telao_mostrar).
-- * O telão mostra só o TEXTO do código, nunca o resultado renderizado: os
--   competidores também enxergam o projetor.

create table if not exists public.live_code (
  round_id       text not null references public.rounds (id) on delete cascade,
  device_id      uuid not null,
  -- started_at da rodada quando o código chegou: separa um "play" do outro
  -- (depois de Reiniciar, as linhas antigas deixam de aparecer).
  run_started_at timestamptz not null,
  name           text not null check (char_length(name) between 1 and 80),
  code           text not null default '',
  cursor_row     integer not null default 0 check (cursor_row >= 0),
  cursor_col     integer not null default 0 check (cursor_col >= 0),
  -- Versão do código: o telão só baixa o texto de novo quando ela muda.
  seq            bigint not null default 1,
  joined_at      timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  hidden         boolean not null default false,
  primary key (round_id, device_id)
);

comment on table public.live_code is
  'Código atual de cada máquina na rodada, para o telão. Sem acesso direto: só via RPCs.';

revoke all on table public.live_code from anon, authenticated;
alter table public.live_code enable row level security;
-- Sem políticas: só as funções security definer abaixo e o SQL Editor acessam.

-- ---------------------------------------------------------------------------
-- Editor: manda o código atual (mesma janela de tempo do entregar). Devolve a
-- versão gravada, ou null se a rodada não está valendo.
-- ---------------------------------------------------------------------------

create or replace function public.enviar_ao_vivo(
  p_round  text,
  p_device uuid,
  p_name   text,
  p_code   text,
  p_row    integer,
  p_col    integer
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_round public.rounds;
  v_name  text := btrim(coalesce(p_name, ''));
  v_code  text := coalesce(p_code, '');
  v_count integer;
  v_seq   bigint;
begin
  if char_length(v_name) not between 1 and 80 or v_name ~ '[[:cntrl:]]' then
    raise exception 'CITD_INVALID_NAME';
  end if;
  if p_device is null then
    raise exception 'CITD_INVALID_DEVICE';
  end if;
  if octet_length(v_code) > 1000000 then
    raise exception 'CITD_CODE_TOO_LARGE';
  end if;

  select r.* into v_round from public.rounds r where r.id = p_round;
  if v_round.id is null then
    raise exception 'CITD_UNKNOWN_ROUND';
  end if;
  -- Fora do tempo, ignora sem erro e devolve null: o editor pode ainda não
  -- ter visto o Reiniciar ou o fim (ele consulta o estado a cada 2 s).
  if v_round.started_at is null
     or (v_round.status <> 'pausada' and now() > v_round.ends_at + interval '60 seconds') then
    return null;
  end if;

  -- Teto de máquinas por rodada: protege o banco de abuso pelo link público.
  if not exists (select 1 from public.live_code l
                  where l.round_id = p_round and l.device_id = p_device
                    and l.run_started_at = v_round.started_at) then
    select count(*) into v_count from public.live_code l
     where l.round_id = p_round and l.run_started_at = v_round.started_at;
    if v_count >= 100 then
      raise exception 'CITD_RATE_LIMIT';
    end if;
  end if;

  -- Os valores à direita do SET são os da linha antiga: num "play" novo a
  -- máquina entra de novo no fim da fila e volta a aparecer no telão.
  insert into public.live_code as l
    (round_id, device_id, run_started_at, name, code, cursor_row, cursor_col)
  values
    (p_round, p_device, v_round.started_at, v_name, v_code,
     greatest(coalesce(p_row, 0), 0), greatest(coalesce(p_col, 0), 0))
  on conflict (round_id, device_id) do update set
    name           = excluded.name,
    code           = excluded.code,
    cursor_row     = excluded.cursor_row,
    cursor_col     = excluded.cursor_col,
    seq            = l.seq + 1,
    updated_at     = now(),
    joined_at      = case when l.run_started_at = excluded.run_started_at then l.joined_at else now() end,
    hidden         = case when l.run_started_at = excluded.run_started_at then l.hidden else false end,
    run_started_at = excluded.run_started_at
  returning l.seq into v_seq;
  return v_seq;
end;
$$;

-- ---------------------------------------------------------------------------
-- Telão: estado da rodada + as 3 telas
-- ---------------------------------------------------------------------------

-- p_conhecidos: {"<device>": seq} que o telão já tem. Para essas máquinas o
-- código só volta quando muda (economiza tráfego: o telão pergunta a cada 1 s).
create or replace function public.telao_ao_vivo(p_conhecidos jsonb default '{}'::jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with e as (
    select public.estado_atual() as estado
  ),
  atual as (
    select r.* from public.rounds r, e where r.id = e.estado ->> 'round'
  ),
  telas as (
    select l.*, row_number() over (order by l.joined_at, l.device_id) as tela
      from public.live_code l
      join atual r on l.round_id = r.id and l.run_started_at = r.started_at
     where not l.hidden
     order by l.joined_at, l.device_id
     limit 3
  )
  select jsonb_build_object(
    'estado', e.estado,
    -- Posição da rodada atual entre todas (1, 2, ...) e o total: a última é a final.
    'ordem',  (select count(*) from public.rounds x, atual r
                where (x.position, x.id) <= (r.position, r.id)),
    'total',  (select count(*) from public.rounds),
    'telas',  coalesce((
      select jsonb_agg(jsonb_build_object(
               'tela',       t.tela,
               'device',     t.device_id,
               'nome',       t.name,
               'seq',        t.seq,
               'linha',      t.cursor_row,
               'coluna',     t.cursor_col,
               'atualizado', t.updated_at,
               'codigo',     case when p_conhecidos ->> t.device_id::text = t.seq::text
                                  then null else t.code end,
               'entregue',   (select max(s.submitted_at) from public.submissions s
                               where s.round_id = t.round_id and s.device_id = t.device_id)
             ) order by t.tela)
        from telas t), '[]'::jsonb)
  )
  from e;
$$;

-- ---------------------------------------------------------------------------
-- Painel: quem está ao vivo e quem aparece no telão
-- ---------------------------------------------------------------------------

-- Máquinas da rodada mostrada no telão, na ordem em que entraram. "tela" é
-- 1, 2 ou 3 para quem aparece no telão e null para quem está fora dele.
create or replace function public.admin_ao_vivo()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not public.is_organizer() then
    raise exception 'CITD_FORBIDDEN' using errcode = '42501';
  end if;

  with atual as (
    select r.* from public.rounds r where r.id = public.estado_atual() ->> 'round'
  ),
  maquinas as (
    select l.*,
           count(*) filter (where not l.hidden)
             over (order by l.joined_at, l.device_id rows unbounded preceding) as posicao
      from public.live_code l
      join atual r on l.round_id = r.id and l.run_started_at = r.started_at
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'round',      m.round_id,
           'device',     m.device_id,
           'nome',       m.name,
           'oculto',     m.hidden,
           'tela',       case when not m.hidden and m.posicao <= 3 then m.posicao end,
           'entrou',     m.joined_at,
           'atualizado', m.updated_at,
           'bytes',      octet_length(m.code)
         ) order by m.joined_at, m.device_id), '[]'::jsonb)
    into v_result
    from maquinas m;
  return v_result;
end;
$$;

create or replace function public.admin_telao_mostrar(p_round text, p_device uuid, p_mostrar boolean)
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
  update public.live_code l
     set hidden = not coalesce(p_mostrar, true)
   where l.round_id = p_round and l.device_id = p_device;
  if not found then
    raise exception 'CITD_UNKNOWN_DEVICE' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.enviar_ao_vivo(text, uuid, text, text, integer, integer) from public;
revoke all on function public.telao_ao_vivo(jsonb) from public;
revoke all on function public.admin_ao_vivo() from public, anon;
revoke all on function public.admin_telao_mostrar(text, uuid, boolean) from public, anon;
grant execute on function public.enviar_ao_vivo(text, uuid, text, text, integer, integer) to anon, authenticated;
grant execute on function public.telao_ao_vivo(jsonb) to anon, authenticated;
grant execute on function public.admin_ao_vivo() to authenticated;
grant execute on function public.admin_telao_mostrar(text, uuid, boolean) to authenticated;
