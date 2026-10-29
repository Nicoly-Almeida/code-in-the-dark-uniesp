-- Code in the Dark UNIESP — reiniciar uma rodada a qualquer momento
--
-- Depois de "Reiniciar", o telão e os editores mostram a rodada reiniciada
-- como "pronta" (aguardando o play), e não a última rodada encerrada.
-- Idempotente: pode rodar mais de uma vez.

alter table public.rounds add column if not exists status_changed_at timestamptz;
update public.rounds set status_changed_at = started_at
 where status_changed_at is null and started_at is not null;

comment on column public.rounds.status_changed_at is
  'Última ação do painel (iniciar, pausar, retomar, encerrar, reiniciar). Define a rodada mostrada no telão.';

-- Rodada em andamento ou, se não houver, a última mexida pelo painel
-- (inclusive uma reiniciada, que aparece como "pronta").
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
  where r.status_changed_at is not null
  order by (r.status in ('valendo', 'pausada')) desc, r.status_changed_at desc
  limit 1;
$$;

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
           ends_at = now() + make_interval(secs => r.duration_seconds),
           status_changed_at = now()
     where r.id = p_round
    returning * into v_round;

  when 'pausar' then
    if v_round.status <> 'valendo' then
      raise exception 'CITD_INVALID_STATE' using errcode = '22023';
    end if;
    v_restante := greatest(1, ceil(extract(epoch from v_round.ends_at - now()))::integer);
    update public.rounds r
       set status = 'pausada', ends_at = null, remaining_seconds = v_restante,
           status_changed_at = now()
     where r.id = p_round
    returning * into v_round;

  when 'retomar' then
    if v_round.status <> 'pausada' then
      raise exception 'CITD_INVALID_STATE' using errcode = '22023';
    end if;
    update public.rounds r
       set status = 'valendo', ends_at = now() + make_interval(secs => r.remaining_seconds),
           remaining_seconds = null, status_changed_at = now()
     where r.id = p_round
    returning * into v_round;

  when 'encerrar' then
    if v_round.status in ('valendo', 'pausada') then
      update public.rounds r
         set status = 'encerrada', ends_at = now(), remaining_seconds = null,
             status_changed_at = now()
       where r.id = p_round
      returning * into v_round;
    elsif v_round.status <> 'encerrada' then
      raise exception 'CITD_INVALID_STATE' using errcode = '22023';
    end if;

  when 'reiniciar' then
    -- Em qualquer estado: volta para "pronta" e apaga as entregas (o painel
    -- pede confirmação). Depois é só iniciar de novo.
    delete from public.submissions s where s.round_id = p_round;
    update public.rounds r
       set status = 'pronta', started_at = null, ends_at = null, remaining_seconds = null,
           status_changed_at = now()
     where r.id = p_round
    returning * into v_round;

  else
    raise exception 'CITD_INVALID_ACTION' using errcode = '22023';
  end case;

  return v_round;
end;
$$;
