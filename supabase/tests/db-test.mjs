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

// ------------------------------------------------------------ telão ao vivo
const DEV3 = "33333333-3333-4333-8333-333333333333";
const DEV4 = "44444444-4444-4444-8444-444444444444";
const aoVivo = (round, dev, name, code, row = 0, col = 0) =>
  anon("select public.enviar_ao_vivo($1, $2, $3, $4, $5, $6) as seq", [round, dev, name, code, row, col]);
const telao = async (known = {}) =>
  (await anon("select public.telao_ao_vivo($1::jsonb) as t", [JSON.stringify(known)])).rows[0].t;
const nomes = (t) => t.telas.map((x) => x.nome);
const mostrar = (dev, sim) => org("select public.admin_telao_mostrar('rodada-1-a', $1, $2)", [dev, sim]);
const painel = async () => (await org("select public.admin_ao_vivo() as l")).rows[0].l;

await t("código ao vivo: tabela fechada; RPCs do painel só para organizador", async () => {
  await rejects(anon("select * from public.live_code"), /permission denied/);
  await rejects(org("select * from public.live_code"), /permission denied/);
  await rejects(anon("select public.admin_ao_vivo()"), /permission denied/);
  await rejects(anon("select public.admin_telao_mostrar('rodada-1-a', $1, false)", [DEV1]), /permission denied/);
  await rejects(curioso("select public.admin_ao_vivo()"), /CITD_FORBIDDEN/);
  await rejects(curioso("select public.admin_telao_mostrar('rodada-1-a', $1, false)", [DEV1]), /CITD_FORBIDDEN/);
});

await t("código ao vivo só depois do play; telão mostra as 3 primeiras máquinas", async () => {
  assert.equal((await estado()).status, "pronta");
  assert.equal((await aoVivo("rodada-1-a", DEV1, "Ana", "<h1>")).rows[0].seq, null, "antes do play é ignorado");
  assert.deepEqual((await telao()).telas, [], "rodada pronta não tem telas");
  await ctl("rodada-1-a", "iniciar");
  await aoVivo("rodada-1-a", DEV1, "Ana", "<h1>Ana</h1>", 0, 13);
  await aoVivo("rodada-1-a", DEV2, "Bia", "");
  await aoVivo("rodada-1-a", DEV3, "Caio", "<p>Caio</p>");
  await aoVivo("rodada-1-a", DEV4, "Davi", "<p>Davi</p>");
  const t1 = await telao();
  assert.equal(t1.estado.round, "rodada-1-a");
  assert.equal(t1.estado.status, "valendo");
  assert.deepEqual([t1.ordem, t1.total], [1, 2]);
  assert.deepEqual(nomes(t1), ["Ana", "Bia", "Caio"]);
  assert.deepEqual(t1.telas.map((x) => x.tela), [1, 2, 3]);
  assert.deepEqual([t1.telas[0].codigo, t1.telas[0].linha, t1.telas[0].coluna], ["<h1>Ana</h1>", 0, 13]);
  assert.equal(t1.telas[1].codigo, "", "quem ainda não digitou aparece com o editor vazio");
});

await t("telão só recebe de novo o código que mudou", async () => {
  const t1 = await telao();
  const known = Object.fromEntries(t1.telas.map((x) => [x.device, x.seq]));
  const t2 = await telao(known);
  assert.deepEqual(t2.telas.map((x) => x.codigo), [null, null, null]);
  await aoVivo("rodada-1-a", DEV1, "Ana", "<h1>Ana</h1>\n<p>mais</p>", 1, 11);
  const t3 = await telao(known);
  assert.equal(t3.telas[0].codigo, "<h1>Ana</h1>\n<p>mais</p>");
  assert.equal(t3.telas[0].linha, 1);
  assert.ok(t3.telas[0].seq > known[DEV1]);
  assert.equal(t3.telas[2].codigo, null);
});

await t("painel tira e devolve uma máquina do telão", async () => {
  await mostrar(DEV2, false);
  assert.deepEqual(nomes(await telao()), ["Ana", "Caio", "Davi"]);
  const lista = await painel();
  assert.deepEqual(lista.map((x) => [x.nome, x.oculto, x.tela]),
    [["Ana", false, 1], ["Bia", true, null], ["Caio", false, 2], ["Davi", false, 3]]);
  await mostrar(DEV2, true);
  assert.deepEqual(nomes(await telao()), ["Ana", "Bia", "Caio"]);
  assert.equal((await painel())[3].tela, null, "a 4ª máquina fica fora do telão");
  await rejects(mostrar("55555555-5555-4555-8555-555555555555", false), /CITD_UNKNOWN_DEVICE/);
});

await t("telão mostra quem já entregou", async () => {
  assert.equal((await telao()).telas[0].entregue, null);
  await entregar("rodada-1-a", DEV1, "Ana", "<h1>Ana</h1>");
  assert.ok((await telao()).telas[0].entregue);
  assert.equal((await telao()).telas[1].entregue, null);
});

await t("validação e teto de máquinas do código ao vivo", async () => {
  await rejects(aoVivo("rodada-1-a", DEV1, " ", "x"), /CITD_INVALID_NAME/);
  await rejects(aoVivo("rodada-1-a", DEV1, "Ana", "x".repeat(1000001)), /CITD_CODE_TOO_LARGE/);
  await rejects(aoVivo("nao-existe", DEV1, "Ana", "x"), /CITD_UNKNOWN_ROUND/);
  await db.exec(`insert into public.live_code (round_id, device_id, run_started_at, name)
    select 'rodada-1-a', gen_random_uuid(), r.started_at, 'extra'
      from public.rounds r, generate_series(1, 96) where r.id = 'rodada-1-a'`);
  await rejects(aoVivo("rodada-1-a", "66666666-6666-4666-8666-666666666666", "Novo", "x"), /CITD_RATE_LIMIT/);
  await aoVivo("rodada-1-a", DEV1, "Ana", "quem já está continua mandando");
  await db.exec(`delete from public.live_code where name = 'extra'`);
});

await t("reiniciar esvazia o telão; no play seguinte a fila recomeça", async () => {
  await mostrar(DEV1, false);
  await ctl("rodada-1-a", "reiniciar");
  assert.deepEqual((await telao()).telas, []);
  assert.equal((await aoVivo("rodada-1-a", DEV1, "Ana", "x")).rows[0].seq, null, "depois de reiniciar é ignorado");
  assert.deepEqual((await telao()).telas, []);
  await ctl("rodada-1-a", "iniciar");
  await aoVivo("rodada-1-a", DEV3, "Caio", "");
  await aoVivo("rodada-1-a", DEV1, "Ana", "");
  assert.deepEqual(nomes(await telao()), ["Caio", "Ana"], "Ana volta ao telão e entra depois do Caio");
  assert.deepEqual((await painel()).map((x) => x.nome), ["Caio", "Ana"], "painel ignora o play anterior");
});

await t("pausada aceita; depois do fim só na tolerância de 60 s", async () => {
  await ctl("rodada-1-a", "pausar");
  await aoVivo("rodada-1-a", DEV1, "Ana", "na pausa");
  await ctl("rodada-1-a", "retomar");
  await db.exec(`update public.rounds set ends_at = now() - interval '30 seconds' where id = 'rodada-1-a'`);
  await aoVivo("rodada-1-a", DEV1, "Ana", "logo depois do fim");
  const t1 = await telao();
  assert.equal(t1.estado.status, "encerrada");
  assert.equal(t1.telas.find((x) => x.nome === "Ana").codigo, "logo depois do fim", "telão encerrado mantém o código final");
  await db.exec(`update public.rounds set ends_at = now() - interval '2 minutes' where id = 'rodada-1-a'`);
  assert.equal((await aoVivo("rodada-1-a", DEV1, "Ana", "tarde demais")).rows[0].seq, null);
  assert.equal((await telao()).telas.find((x) => x.nome === "Ana").codigo, "logo depois do fim", "o atrasado não grava");
});

// ------------------------------------------------------------- votação
const ELEITOR1 = "e1111111-1111-4111-8111-111111111111";
const ELEITOR2 = "e2222222-2222-4222-8222-222222222222";
const ELEITOR3 = "e3333333-3333-4333-8333-333333333333";
const votacao = async (eleitor = null) => (await anon("select public.votacao($1) as v", [eleitor])).rows[0].v;
const votar = (eleitor, dev) => anon("select public.votar($1, $2) as at", [eleitor, dev]);
const placar = (v) => v.candidatos.map((c) => [c.nome, c.votos]);

await t("votação: votos fechados; candidatos internos; painel só para organizador", async () => {
  await rejects(anon("select * from public.votes"), /permission denied/);
  await rejects(anon("select * from public.candidatos_votacao()"), /permission denied/);
  await rejects(anon("select public.admin_votacao('rodada-1-a', false)"), /permission denied/);
  await rejects(curioso("select public.admin_votacao('rodada-1-a', false)"), /CITD_FORBIDDEN/);
});

await t("votação abre com a rodada encerrada, só para os competidores do telão", async () => {
  const v = await votacao();
  assert.deepEqual([v.round, v.status, v.total], ["rodada-1-a", "aberta", 0]);
  assert.deepEqual(placar(v), [["Caio", 0], ["Ana", 0]]);
  assert.deepEqual(v.candidatos.map((c) => c.tela), [1, 2]);
  await votar(ELEITOR1, DEV1);
  await votar(ELEITOR2, DEV1);
  await votar(ELEITOR3, DEV3);
  await rejects(votar(ELEITOR1, DEV4), /CITD_INVALID_VOTE/, "Davi não está no telão");
  await rejects(votar(null, DEV1), /CITD_INVALID_VOTE/);
  const depois = await votacao(ELEITOR1);
  assert.deepEqual(placar(depois), [["Caio", 1], ["Ana", 2]]);
  assert.equal(depois.total, 3);
  assert.equal(depois.meu_voto, DEV1);
  assert.equal((await votacao()).meu_voto, null);
});

await t("trocar o voto: vale o último, um voto por celular", async () => {
  await votar(ELEITOR1, DEV3);
  const v = await votacao(ELEITOR1);
  assert.deepEqual(placar(v), [["Caio", 2], ["Ana", 1]]);
  assert.equal(v.total, 3);
  assert.equal(v.meu_voto, DEV3);
});

await t("painel encerra e reabre a votação", async () => {
  await org("select public.admin_votacao('rodada-1-a', false)");
  assert.equal((await votacao()).status, "encerrada");
  await rejects(votar(ELEITOR2, DEV3), /CITD_VOTING_CLOSED/);
  assert.deepEqual(placar(await votacao()), [["Caio", 2], ["Ana", 1]], "o placar continua visível");
  await org("select public.admin_votacao('rodada-1-a', true)");
  assert.equal((await votacao()).status, "aberta");
  await votar(ELEITOR2, DEV3);
  assert.deepEqual(placar(await votacao()), [["Caio", 3], ["Ana", 0]]);
  await rejects(org("select public.admin_votacao('nao-existe', false)"), /CITD_UNKNOWN_ROUND/);
});

await t("rodada seguinte valendo: votação aguardando e sem candidatos", async () => {
  await ctl("rodada-1-a", "encerrar");
  await ctl("rodada-2-b", "reiniciar");
  await ctl("rodada-2-b", "iniciar");
  const v = await votacao(ELEITOR1);
  assert.deepEqual([v.round, v.status, v.total, v.candidatos, v.meu_voto], ["rodada-2-b", "aguardando", 0, [], null]);
  await rejects(votar(ELEITOR1, DEV1), /CITD_VOTING_CLOSED/);
  await ctl("rodada-2-b", "encerrar");
  assert.equal((await votacao()).status, "aberta", "abre sozinha no fim");
});

console.log(`\n${passed} testes passaram${process.exitCode ? ", com falhas" : ""}.`);
