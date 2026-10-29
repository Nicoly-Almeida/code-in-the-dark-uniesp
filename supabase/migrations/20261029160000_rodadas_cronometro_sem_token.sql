-- Code in the Dark UNIESP — rodadas pré-configuradas, cronômetro e entrega sem token
--
-- Rode DEPOIS de 20261029120000_code_in_the_dark_submissions.sql.
--
-- * O participante entrega só com o nome: o editor chama public.entregar()
--   direto com a chave pública. A função só aceita enquanto a rodada está
--   valendo ou pausada, com 60 s de tolerância depois do fim.
-- * Referência e instruções ficam em public.round_materials, sem acesso direto.
--   public.materiais_rodada() só as devolve depois do play (organizador vê antes).
-- * O cronômetro é o estado da rodada (status, ends_at, remaining_seconds).
--   Editor, telão e painel leem public.estado_atual().
-- * Tokens, participantes e a Edge Function `submit` deixam de ser usados.

-- ---------------------------------------------------------------------------
-- Remove o modelo com token
-- ---------------------------------------------------------------------------

drop function if exists public.submit_entry(text, text, text, text);
drop function if exists public.admin_create_participant(text, text);
drop function if exists public.admin_set_round_open(text, boolean);

alter table public.submissions drop column participant_id;
drop table public.participants;

-- Cada navegador gera um identificador aleatório: agrupa as entregas da mesma
-- máquina mesmo que duas pessoas usem o mesmo nome.
alter table public.submissions add column device_id uuid not null default gen_random_uuid();
alter table public.submissions alter column device_id drop default;
create index submissions_round_device_idx on public.submissions (round_id, device_id);

-- ---------------------------------------------------------------------------
-- Rodadas com cronômetro
-- ---------------------------------------------------------------------------

alter table public.rounds
  drop column is_open,
  drop column opened_at,
  drop column closed_at,
  drop column max_code_bytes,
  add column position          integer not null default 0,
  add column duration_seconds  integer not null default 900
                               check (duration_seconds between 60 and 7200),
  add column status            text not null default 'pronta'
                               check (status in ('pronta', 'valendo', 'pausada', 'encerrada')),
  add column started_at        timestamptz,
  add column ends_at           timestamptz,
  add column remaining_seconds integer;

alter table public.rounds add constraint rounds_estado_consistente check (
  (status = 'pronta'    and started_at is null     and ends_at is null     and remaining_seconds is null) or
  (status = 'valendo'   and started_at is not null and ends_at is not null and remaining_seconds is null) or
  (status = 'pausada'   and started_at is not null and ends_at is null     and remaining_seconds > 0) or
  (status = 'encerrada' and started_at is not null and ends_at is not null and remaining_seconds is null)
);

-- No máximo uma rodada valendo ou pausada por vez.
create unique index rounds_uma_ativa_idx on public.rounds ((true))
  where status in ('valendo', 'pausada');

comment on column public.rounds.ends_at is
  'Fim do tempo. "valendo" com ends_at no passado é tratada como encerrada.';

-- O painel lê as rodadas e ajusta título/ordem/duração; criar, iniciar e
-- encerrar passam pelas RPCs abaixo.
revoke all on table public.rounds from anon, authenticated;
grant select on table public.rounds to authenticated;
grant update (title, position, duration_seconds) on table public.rounds to authenticated;
grant delete on table public.rounds to authenticated;

create table public.round_materials (
  round_id          text primary key references public.rounds (id) on delete cascade,
  instructions_html text not null check (char_length(instructions_html) between 1 and 100000),
  reference_image   text not null
                    check (reference_image ~ '^data:image/(png|jpeg|webp);base64,'
                           and octet_length(reference_image) <= 5000000),
  updated_at        timestamptz not null default now()
);

comment on table public.round_materials is
  'Referência e instruções de cada rodada. Sem acesso direto: só via materiais_rodada().';

revoke all on table public.round_materials from anon, authenticated;
alter table public.round_materials enable row level security;
-- Sem políticas: só funções security definer e o SQL Editor acessam.

-- ---------------------------------------------------------------------------
-- RPCs públicas (editor e telão)
-- ---------------------------------------------------------------------------

-- Rodada em andamento (ou a última iniciada) e a hora do servidor, para os
-- clientes calcularem o tempo restante sem depender do relógio local.
create or replace function public.estado_atual()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'round',             r.id,
    'title',             r.title,
    'position',          r.position,
    'status',            case when r.status = 'valendo' and r.ends_at <= now()
                              then 'encerrada' else r.status end,
    'duration_seconds',  r.duration_seconds,
    'started_at',        r.started_at,
    'ends_at',           r.ends_at,
    'remaining_seconds', r.remaining_seconds,
    'server_now',        now()
  )
  from public.rounds r
  where r.started_at is not null
  order by (r.status in ('valendo', 'pausada')) desc, r.started_at desc
  limit 1;
$$;

create or replace function public.materiais_rodada(p_round text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_started timestamptz;
  v_result  jsonb;
begin
  select r.started_at into v_started from public.rounds r where r.id = p_round;
  if v_started is null and not public.is_organizer() then
    raise exception 'CITD_NOT_STARTED';
  end if;

  select jsonb_build_object('instructions_html', m.instructions_html,
                            'reference_image',   m.reference_image)
    into v_result
    from public.round_materials m
   where m.round_id = p_round;
  if v_result is null then
    raise exception 'CITD_NO_MATERIALS';
  end if;
  return v_result;
end;
$$;

create or replace function public.entregar(
  p_round  text,
  p_device uuid,
  p_name   text,
  p_code   text
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_round public.rounds;
  v_name  text := btrim(coalesce(p_name, ''));
  v_bytes integer := octet_length(coalesce(p_code, ''));
  v_count integer;
  v_at    timestamptz;
begin
  if char_length(v_name) not between 1 and 80 or v_name ~ '[[:cntrl:]]' then
    raise exception 'CITD_INVALID_NAME';
  end if;
  if p_device is null then
    raise exception 'CITD_INVALID_DEVICE';
  end if;
  if btrim(coalesce(p_code, '')) = '' then
    raise exception 'CITD_EMPTY_CODE';
  end if;
  -- Sem limite para quem digita; o teto só protege o banco de abuso.
  if v_bytes > 1000000 then
    raise exception 'CITD_CODE_TOO_LARGE';
  end if;

  -- FOR SHARE: pausar/encerrar esperam as entregas em andamento terminarem.
  select r.* into v_round
    from public.rounds r
   where r.id = p_round
   for share;

  if v_round.id is null then
    raise exception 'CITD_UNKNOWN_ROUND';
  end if;
  if v_round.started_at is null
     or (v_round.status <> 'pausada' and now() > v_round.ends_at + interval '60 seconds') then
    raise exception 'CITD_ROUND_CLOSED';
  end if;

  select count(*) into v_count
    from public.submissions s
   where s.round_id = p_round and s.device_id = p_device;
  if v_count >= 50 then
    raise exception 'CITD_RATE_LIMIT';
  end if;
  select count(*) into v_count from public.submissions s where s.round_id = p_round;
  if v_count >= 2000 then
    raise exception 'CITD_RATE_LIMIT';
  end if;

  insert into public.submissions (round_id, device_id, submitted_name, code, code_bytes)
  values (p_round, p_device, v_name, p_code, v_bytes)
  returning submitted_at into v_at;
  return v_at;
end;
$$;

revoke all on function public.estado_atual() from public;
revoke all on function public.materiais_rodada(text) from public;
revoke all on function public.entregar(text, uuid, text, text) from public;
grant execute on function public.estado_atual() to anon, authenticated;
grant execute on function public.materiais_rodada(text) to anon, authenticated;
grant execute on function public.entregar(text, uuid, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPCs do painel
-- ---------------------------------------------------------------------------

create or replace function public.admin_controlar_rodada(p_round text, p_acao text)
returns public.rounds
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_round    public.rounds;
  v_restante integer;
begin
  if not public.is_organizer() then
    raise exception 'CITD_FORBIDDEN' using errcode = '42501';
  end if;

  -- Rodada cujo tempo acabou passa a "encerrada" de fato.
  update public.rounds r set status = 'encerrada'
   where r.status = 'valendo' and r.ends_at <= now();

  select r.* into v_round from public.rounds r where r.id = p_round for update;
  if v_round.id is null then
    raise exception 'CITD_UNKNOWN_ROUND' using errcode = '22023';
  end if;

  case p_acao
  when 'iniciar' then
    if v_round.status <> 'pronta' then
      raise exception 'CITD_INVALID_STATE' using errcode = '22023';
    end if;
    if exists (select 1 from public.rounds r where r.status in ('valendo', 'pausada')) then
      raise exception 'CITD_OTHER_ROUND_ACTIVE' using errcode = '22023';
    end if;
    if not exists (select 1 from public.round_materials m where m.round_id = p_round) then
      raise exception 'CITD_NO_MATERIALS' using errcode = '22023';
    end if;
    update public.rounds r
       set status = 'valendo', started_at = now(),
           ends_at = now() + make_interval(secs => r.duration_seconds)
     where r.id = p_round
    returning * into v_round;

  when 'pausar' then
    if v_round.status <> 'valendo' then
      raise exception 'CITD_INVALID_STATE' using errcode = '22023';
    end if;
    v_restante := greatest(1, ceil(extract(epoch from v_round.ends_at - now()))::integer);
    update public.rounds r
       set status = 'pausada', ends_at = null, remaining_seconds = v_restante
     where r.id = p_round
    returning * into v_round;

  when 'retomar' then
    if v_round.status <> 'pausada' then
      raise exception 'CITD_INVALID_STATE' using errcode = '22023';
    end if;
    update public.rounds r
       set status = 'valendo', ends_at = now() + make_interval(secs => r.remaining_seconds),
           remaining_seconds = null
     where r.id = p_round
    returning * into v_round;

  when 'encerrar' then
    if v_round.status in ('valendo', 'pausada') then
      update public.rounds r
         set status = 'encerrada', ends_at = now(), remaining_seconds = null
       where r.id = p_round
      returning * into v_round;
    elsif v_round.status <> 'encerrada' then
      raise exception 'CITD_INVALID_STATE' using errcode = '22023';
    end if;

  when 'reiniciar' then
    -- Volta para "pronta" e apaga as entregas (o painel pede confirmação).
    delete from public.submissions s where s.round_id = p_round;
    update public.rounds r
       set status = 'pronta', started_at = null, ends_at = null, remaining_seconds = null
     where r.id = p_round
    returning * into v_round;

  else
    raise exception 'CITD_INVALID_ACTION' using errcode = '22023';
  end case;

  return v_round;
end;
$$;

-- Cria ou atualiza uma rodada com seus materiais (botão "Importar desafios").
create or replace function public.admin_importar_rodada(
  p_round        text,
  p_title        text,
  p_position     integer,
  p_instructions text,
  p_reference    text
)
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

  insert into public.rounds (id, title, position)
  values (p_round, btrim(p_title), coalesce(p_position, 0))
  on conflict (id) do update
    set title = excluded.title, position = excluded.position;

  insert into public.round_materials (round_id, instructions_html, reference_image)
  values (p_round, p_instructions, p_reference)
  on conflict (round_id) do update
    set instructions_html = excluded.instructions_html,
        reference_image   = excluded.reference_image,
        updated_at        = now();
end;
$$;

revoke all on function public.admin_controlar_rodada(text, text) from public, anon;
revoke all on function public.admin_importar_rodada(text, text, integer, text, text) from public, anon;
grant execute on function public.admin_controlar_rodada(text, text) to authenticated;
grant execute on function public.admin_importar_rodada(text, text, integer, text, text) to authenticated;
