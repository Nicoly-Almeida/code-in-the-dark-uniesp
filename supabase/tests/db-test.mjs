// Testes das migrations com PGlite (Postgres em WASM, sem Docker).
// Uso, nesta pasta: npm install && npm test
import assert from "node:assert/strict";
import { as, createDb, CURIOSO, ORG, REPO } from "./db.mjs";

const db = await createDb(process.argv[2] ?? REPO);
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const DEV1 = "11111111-1111-4111-8111-111111111111";
const DEV2 = "22222222-2222-4222-8222-222222222222";
let passed = 0;

async function t(name, fn) {
  try { await fn(); passed++; console.log("ok  -", name); }
  catch (e) { console.log("FAIL -", name, "\n     ", e.message); process.exitCode = 1; }
}
async function rejects(promise, pattern) {
  await assert.rejects(promise, (e) => { assert.match(e.message, pattern); return true; });
}
const anon = (sql, p) => as(db, "anon", null, sql, p);
const org = (sql, p) => as(db, "authenticated", ORG, sql, p);
const curioso = (sql, p) => as(db, "authenticated", CURIOSO, sql, p);
const estado = async () => (await anon("select public.estado_atual() as e")).rows[0].e;
const entregar = (round, dev, name, code) =>
  anon("select public.entregar($1, $2, $3, $4) as at", [round, dev, name, code]);
// Como o PostgREST: função no FROM (com "(f()).*" o Postgres chamaria f uma vez por coluna).
const ctl = (round, acao) => org("select * from public.admin_controlar_rodada($1, $2)", [round, acao]);

await t("tabelas antigas de token sumiram", async () => {
  const r = await db.query(`select to_regclass('public.participants') as p,
    to_regprocedure('public.submit_entry(text,text,text,text)') as f`);
  assert.equal(r.rows[0].p, null);
  assert.equal(r.rows[0].f, null);
});

await t("anon não lê tabelas", async () => {
  for (const table of ["rounds", "submissions", "round_materials", "organizers"]) {
    await rejects(anon(`select * from public.${table}`), /permission denied/);
  }
});

await t("anon e não organizador não usam RPCs do painel", async () => {
  await rejects(anon("select public.admin_importar_rodada('x','x',1,'x',$1)", [PNG]), /permission denied/);
  await rejects(anon("select public.admin_controlar_rodada('x','iniciar')"), /permission denied/);
  await rejects(curioso("select public.admin_importar_rodada('x','x',1,'x',$1)", [PNG]), /CITD_FORBIDDEN/);
  await rejects(curioso("select public.admin_controlar_rodada('x','iniciar')"), /CITD_FORBIDDEN/);
});

await t("organizador importa rodadas (e reimporta sem duplicar)", async () => {
  await org("select public.admin_importar_rodada('rodada-1-a', 'RODADA 1 · A', 1, '<pre>um</pre>', $1)", [PNG]);
  await org("select public.admin_importar_rodada('rodada-2-b', 'RODADA 2 · B', 2, '<pre>dois</pre>', $1)", [PNG]);
  await org("select public.admin_importar_rodada('rodada-1-a', 'RODADA 1 · A2', 1, '<pre>um v2</pre>', $1)", [PNG]);
  const r = await org("select id, title, status, duration_seconds from public.rounds order by position");
  assert.deepEqual(r.rows.map((x) => [x.id, x.title, x.status, x.duration_seconds]),
    [["rodada-1-a", "RODADA 1 · A2", "pronta", 900], ["rodada-2-b", "RODADA 2 · B", "pronta", 900]]);
  await rejects(org("select public.admin_importar_rodada('Inválida', 'x', 1, 'x', $1)", [PNG]), /check constraint/);
  await rejects(org("select public.admin_importar_rodada('rodada-9', 'x', 1, 'x', 'http://x/y.png')"), /check constraint/);
});

await t("não organizador não vê rodadas", async () => {
  assert.equal((await curioso("select count(*)::int as n from public.rounds")).rows[0].n, 0);
});

await t("antes do play: sem estado, materiais escondidos, entrega recusada", async () => {
  assert.equal(await estado(), null);
  await rejects(anon("select public.materiais_rodada('rodada-1-a')"), /CITD_NOT_STARTED/);
  await rejects(entregar("rodada-1-a", DEV1, "Ana", "<h1>oi</h1>"), /CITD_ROUND_CLOSED/);
  const m = await org("select public.materiais_rodada('rodada-1-a') as m");
  assert.equal(m.rows[0].m.instructions_html, "<pre>um v2</pre>", "organizador vê antes do play");
});

await t("play: estado valendo com 15 min, materiais liberados, entrega aceita", async () => {
  await ctl("rodada-1-a", "iniciar");
  const e = await estado();
  assert.equal(e.round, "rodada-1-a");
  assert.equal(e.status, "valendo");
  const restante = (Date.parse(e.ends_at) - Date.parse(e.server_now)) / 1000;
  assert.ok(restante > 899 && restante <= 900, `restante ${restante}`);
  const m = (await anon("select public.materiais_rodada('rodada-1-a') as m")).rows[0].m;
  assert.equal(m.reference_image, PNG);
  await rejects(anon("select public.materiais_rodada('rodada-2-b')"), /CITD_NOT_STARTED/);
  const at = (await entregar("rodada-1-a", DEV1, "  Ana  ", "<h1>oi</h1>")).rows[0].at;
  assert.ok(at instanceof Date);
  await entregar("rodada-1-a", DEV1, "Ana", "<h1>oi 2</h1>");
  await entregar("rodada-1-a", DEV2, "Ana", "<p>outra máquina</p>");
  const s = await org("select submitted_name, device_id, code_bytes from public.submissions order by submitted_at");
  assert.equal(s.rows.length, 3);
  assert.equal(s.rows[0].submitted_name, "Ana", "nome sem espaços nas pontas");
});

await t("só uma rodada ativa por vez", async () => {
  await rejects(ctl("rodada-2-b", "iniciar"), /CITD_OTHER_ROUND_ACTIVE/);
  await rejects(ctl("rodada-1-a", "iniciar"), /CITD_INVALID_STATE/);
});

await t("validações da entrega", async () => {
  await rejects(entregar("rodada-1-a", DEV1, "", "x"), /CITD_INVALID_NAME/);
  await rejects(entregar("rodada-1-a", DEV1, "a".repeat(81), "x"), /CITD_INVALID_NAME/);
  await rejects(entregar("rodada-1-a", DEV1, "linha\nquebrada", "x"), /CITD_INVALID_NAME/);
  await rejects(entregar("rodada-1-a", null, "Ana", "x"), /CITD_INVALID_DEVICE/);
  await rejects(entregar("rodada-1-a", DEV1, "Ana", "   "), /CITD_EMPTY_CODE/);
  await rejects(entregar("rodada-1-a", DEV1, "Ana", "a".repeat(1000001)), /CITD_CODE_TOO_LARGE/);
  await rejects(entregar("nao-existe", DEV1, "Ana", "x"), /CITD_UNKNOWN_ROUND/);
  // código grande (300 KB) passa: não há limite para quem digita
  await entregar("rodada-1-a", DEV2, "Bia", "<p>" + "x".repeat(300000) + "</p>");
});

await t("anon não insere nem apaga entrega direto", async () => {
  await rejects(anon("insert into public.submissions (round_id, device_id, submitted_name, code, code_bytes) values ('rodada-1-a', $1, 'x', 'x', 1)", [DEV1]), /permission denied/);
  await rejects(curioso("insert into public.submissions (round_id, device_id, submitted_name, code, code_bytes) values ('rodada-1-a', $1, 'x', 'x', 1)", [DEV1]), /permission denied/);
  assert.equal((await curioso("delete from public.submissions returning id")).rows.length, 0);
});

await t("pausar guarda o restante; entrega aceita na pausa; retomar recalcula o fim", async () => {
  const p = (await ctl("rodada-1-a", "pausar")).rows[0];
  assert.equal(p.status, "pausada");
  assert.equal(p.ends_at, null);
  assert.ok(p.remaining_seconds > 890 && p.remaining_seconds <= 900);
  assert.equal((await estado()).status, "pausada");
  await entregar("rodada-1-a", DEV1, "Ana", "<h1>na pausa</h1>");
  await rejects(ctl("rodada-1-a", "pausar"), /CITD_INVALID_STATE/);
  const r = (await ctl("rodada-1-a", "retomar")).rows[0];
  assert.equal(r.status, "valendo");
  assert.equal(r.remaining_seconds, null);
  const restante = (r.ends_at - Date.now()) / 1000;
  assert.ok(Math.abs(restante - p.remaining_seconds) < 3, `restante ${restante}`);
});

await t("tempo esgotado: estado encerrada, tolerância de 60 s, depois recusa", async () => {
  // Simula o fim do tempo 30 s atrás.
  await db.exec(`update public.rounds set ends_at = now() - interval '30 seconds' where id = 'rodada-1-a'`);
  assert.equal((await estado()).status, "encerrada");
  await entregar("rodada-1-a", DEV1, "Ana", "<h1>dentro da tolerância</h1>");
  await db.exec(`update public.rounds set ends_at = now() - interval '61 seconds' where id = 'rodada-1-a'`);
  await rejects(entregar("rodada-1-a", DEV1, "Ana", "<h1>tarde</h1>"), /CITD_ROUND_CLOSED/);
  // encerrar depois do tempo esgotado é aceito (idempotente) e grava o status
  const e = (await ctl("rodada-1-a", "encerrar")).rows[0];
  assert.equal(e.status, "encerrada");
});

await t("rodada encerrada libera o play da próxima; estado mostra a ativa", async () => {
  await ctl("rodada-2-b", "iniciar");
  assert.equal((await estado()).round, "rodada-2-b");
  const e = (await ctl("rodada-2-b", "encerrar")).rows[0];
  assert.equal(e.status, "encerrada");
  const st = await estado();
  assert.equal(st.round, "rodada-2-b", "última iniciada continua no estado");
  assert.equal(st.status, "encerrada");
  await rejects(entregar("rodada-2-b", DEV1, "Ana", "x").then(() => db.exec(
    `update public.rounds set ends_at = now() - interval '2 minutes' where id = 'rodada-2-b'`))
    .then(() => entregar("rodada-2-b", DEV1, "Ana", "x")), /CITD_ROUND_CLOSED/);
});

await t("reiniciar apaga entregas e volta para pronta", async () => {
  const antes = (await org("select count(*)::int as n from public.submissions where round_id = 'rodada-1-a'")).rows[0].n;
  assert.ok(antes > 0);
  const r = (await ctl("rodada-1-a", "reiniciar")).rows[0];
  assert.equal(r.status, "pronta");
  assert.equal(r.started_at, null);
  const depois = (await org("select count(*)::int as n from public.submissions where round_id = 'rodada-1-a'")).rows[0].n;
  assert.equal(depois, 0);
  await rejects(anon("select public.materiais_rodada('rodada-1-a')"), /CITD_NOT_STARTED/);
});

await t("limite de 50 entregas por máquina", async () => {
  await ctl("rodada-1-a", "iniciar");
  await db.exec(`insert into public.submissions (round_id, device_id, submitted_name, code, code_bytes)
    select 'rodada-1-a', '${DEV1}', 'Ana', 'x', 1 from generate_series(1, 50)`);
  await rejects(entregar("rodada-1-a", DEV1, "Ana", "x"), /CITD_RATE_LIMIT/);
  await entregar("rodada-1-a", DEV2, "Bia", "x");
});

await t("reiniciar no meio da rodada: estado mostra a rodada como pronta; dá para iniciar de novo", async () => {
  assert.equal((await estado()).status, "valendo");
  const r = (await ctl("rodada-1-a", "reiniciar")).rows[0];
  assert.equal(r.status, "pronta");
  const e = await estado();
  assert.deepEqual([e.round, e.status, e.ends_at, e.duration_seconds], ["rodada-1-a", "pronta", null, 900]);
  assert.equal((await org("select count(*)::int as n from public.submissions where round_id = 'rodada-1-a'")).rows[0].n, 0);
  await rejects(entregar("rodada-1-a", DEV2, "Bia", "x"), /CITD_ROUND_CLOSED/);
  await rejects(anon("select public.materiais_rodada('rodada-1-a')"), /CITD_NOT_STARTED/);
  await ctl("rodada-1-a", "iniciar");
  assert.equal((await estado()).status, "valendo");
  await ctl("rodada-1-a", "pausar");
  await ctl("rodada-1-a", "reiniciar");
  assert.equal((await estado()).status, "pronta", "também a partir da pausa");
});

await t("organizador ajusta duração e título; não altera status direto", async () => {
  await org("update public.rounds set duration_seconds = 600, title = 'Novo' where id = 'rodada-2-b'");
  await rejects(org("update public.rounds set status = 'valendo' where id = 'rodada-2-b'"), /permission denied/);
  await rejects(org("insert into public.rounds (id, title) values ('x', 'x')"), /permission denied/);
  await rejects(org("select * from public.round_materials"), /permission denied/);
  await rejects(org("update public.rounds set duration_seconds = 10 where id = 'rodada-2-b'"), /check constraint/);
});

await t("ação inválida e rodada inexistente", async () => {
  await rejects(ctl("rodada-1-a", "explodir"), /CITD_INVALID_ACTION/);
  await rejects(ctl("nao-existe", "iniciar"), /CITD_UNKNOWN_ROUND/);
});

console.log(`\n${passed} testes passaram${process.exitCode ? ", com falhas" : ""}.`);
