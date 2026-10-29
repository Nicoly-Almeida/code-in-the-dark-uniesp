// Postgres em WASM (PGlite) com o mínimo do Supabase: papéis, auth.uid() e
// as migrations do repositório aplicadas em ordem.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../..", import.meta.url));
export const ORG = "00000000-0000-4000-8000-0000000000a1";
export const CURIOSO = "00000000-0000-4000-8000-0000000000b2";

export async function createDb(repo) {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema extensions;
    create schema auth;
    grant usage on schema auth, extensions, public to anon, authenticated, service_role;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
    $$;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    -- Como no Supabase: tudo novo em public já nasce liberado para os papéis da API.
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `);
  const dir = join(repo, "supabase", "migrations");
  for (const file of readdirSync(dir).sort()) {
    let sql = readFileSync(join(dir, file), "utf8");
    sql = sql.replace(/create extension if not exists pgcrypto[^;]*;/, "");
    await db.exec(sql);
  }
  await db.exec(`
    insert into auth.users (id, email) values ('${ORG}', 'org@example.com'), ('${CURIOSO}', 'curioso@example.com');
    insert into public.organizers (user_id) values ('${ORG}');
  `);
  return db;
}

// Executa como um papel da API (anon / authenticated com sub).
export async function as(db, role, sub, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify(sub ? { sub, role } : { role })]);
    await tx.exec(`set local role ${role}`);
    return tx.query(sql, params);
  });
}
