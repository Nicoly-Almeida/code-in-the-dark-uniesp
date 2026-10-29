-- Testes pgTAP de RLS e regras de submissão.
-- Rode com: supabase test db   (requer o stack local: supabase start)
-- Tudo roda dentro de uma transação e é desfeito no final.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(22);

-- Dados fictícios ------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'organizacao-teste@example.com'),
  ('00000000-0000-4000-8000-0000000000b2', 'curioso-teste@example.com');
insert into public.organizers (user_id) values ('00000000-0000-4000-8000-0000000000a1');

insert into public.rounds (id, title, is_open, max_code_bytes)
values ('teste-rls', 'Rodada de teste', true, 2000);

insert into public.participants (round_id, display_name, token_hash)
values ('teste-rls', 'Equipe Fictícia Alfa',
        encode(extensions.digest('token-ficticio-alfa-0000000001', 'sha256'), 'hex'));

-- anon --------------------------------------------------------------------
set local role anon;
select throws_ok($$ select * from public.submissions $$, '42501', null, 'anon não lê submissões');
select throws_ok($$ select * from public.rounds $$, '42501', null, 'anon não lê rodadas');
select throws_ok($$ select * from public.participants $$, '42501', null, 'anon não lê participantes');
select throws_ok($$ select public.submit_entry('teste-rls', 'x', 'y', 'z') $$, '42501', null,
  'anon não chama submit_entry');
select throws_ok($$ select public.admin_create_participant('teste-rls', 'x') $$, '42501', null,
  'anon não cria participante');
reset role;

-- authenticated que NÃO é organizador ---------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.submissions)::int, 0, 'não organizador vê 0 submissões');
select is((select count(*) from public.rounds)::int, 0, 'não organizador vê 0 rodadas');
select throws_ok(
  $$ insert into public.submissions (round_id, participant_id, submitted_name, code, code_bytes)
     select 'teste-rls', id, 'x', 'x', 1 from public.participants $$,
  '42501', null, 'authenticated não insere submissão direto');
select throws_ok($$ select public.admin_set_round_open('teste-rls', false) $$, '42501', null,
  'não organizador não encerra rodada');
select throws_ok($$ select public.submit_entry('teste-rls', 'x', 'y', 'z') $$, '42501', null,
  'authenticated não chama submit_entry');
reset role;

-- service_role (Edge Function) ---------------------------------------------
set local role service_role;
select lives_ok(
  $$ select * from public.submit_entry('teste-rls',
       encode(extensions.digest('token-ficticio-alfa-0000000001', 'sha256'), 'hex'),
       'Equipe Fictícia Alfa', '<h1>Olá</h1>') $$,
  'envio válido é aceito');
select throws_ok(
  $$ select * from public.submit_entry('teste-rls', repeat('0', 64), 'X', '<p>x</p>') $$,
  'P0001', 'CITD_INVALID_TOKEN', 'token desconhecido é recusado');
select throws_ok(
  $$ select * from public.submit_entry('outra-rodada',
       encode(extensions.digest('token-ficticio-alfa-0000000001', 'sha256'), 'hex'), 'X', '<p>x</p>') $$,
  'P0001', 'CITD_INVALID_TOKEN', 'token de outra rodada é recusado');
select throws_ok(
  $$ select * from public.submit_entry('teste-rls',
       encode(extensions.digest('token-ficticio-alfa-0000000001', 'sha256'), 'hex'), 'X', repeat('a', 2001)) $$,
  'P0001', 'CITD_CODE_TOO_LARGE', 'código acima do limite da rodada é recusado');
reset role;

-- organizador ---------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.submissions)::int, 1, 'organizador vê a submissão');
select is((select code from public.submissions limit 1), '<h1>Olá</h1>', 'código salvo como texto');
select throws_ok($$ select token_hash from public.participants $$, '42501', null,
  'nem o organizador lê token_hash');
select matches(public.admin_create_participant('teste-rls', 'Participante Fictícia Beta'),
  '^[A-Za-z0-9_-]{32}$', 'organizador gera token de 32 caracteres');
select throws_ok($$ insert into public.rounds (id, title, is_open) values ('x', 'x', true) $$,
  '42501', null, 'abrir rodada só pela RPC (coluna is_open protegida)');
select is((public.admin_set_round_open('teste-rls', false)).is_open, false, 'organizador encerra rodada');
reset role;

set local role service_role;
select throws_ok(
  $$ select * from public.submit_entry('teste-rls',
       encode(extensions.digest('token-ficticio-alfa-0000000001', 'sha256'), 'hex'), 'X', '<p>x</p>') $$,
  'P0001', 'CITD_ROUND_CLOSED', 'rodada encerrada recusa envio');
reset role;

-- limite de envios por participante
update public.rounds set is_open = true where id = 'teste-rls';
insert into public.submissions (round_id, participant_id, submitted_name, code, code_bytes)
select 'teste-rls', p.id, 'Equipe Fictícia Alfa', 'x', 1
  from public.participants p, generate_series(1, 19)
 where p.display_name = 'Equipe Fictícia Alfa';
set local role service_role;
select throws_ok(
  $$ select * from public.submit_entry('teste-rls',
       encode(extensions.digest('token-ficticio-alfa-0000000001', 'sha256'), 'hex'), 'X', '<p>x</p>') $$,
  'P0001', 'CITD_RATE_LIMIT', 'limite de 20 envios por participante');
reset role;

select * from finish();
rollback;
