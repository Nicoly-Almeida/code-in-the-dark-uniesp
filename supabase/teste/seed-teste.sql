-- MODO DE TESTE — rodada e participantes FICTÍCIOS.
-- Rode no SQL Editor do Supabase. Gera tokens aleatórios e mostra cada um
-- UMA vez no resultado (só o hash fica no banco). Não há tokens fixos no Git.
-- Ao terminar, rode limpar-teste.sql.

insert into public.rounds (id, title, is_open, max_code_bytes, opened_at)
values ('teste', 'Rodada de teste (fictícia)', true, 100000, now())
on conflict (id) do update
  set is_open = true, opened_at = now(), closed_at = null;

with novos (nome) as (
  values ('Equipe Fictícia Alfa'), ('Participante Fictícia Beta')
),
tokens as (
  select nome,
         translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_') as token
    from novos
),
gravados as (
  insert into public.participants (round_id, display_name, token_hash)
  select 'teste', nome, encode(extensions.digest(token, 'sha256'), 'hex') from tokens
  returning display_name
)
select t.nome, t.token
  from tokens t
  join gravados g on g.display_name = t.nome;
