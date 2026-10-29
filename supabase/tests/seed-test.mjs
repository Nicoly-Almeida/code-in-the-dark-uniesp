// Testa o SQL gerado por desafios/halloween/gerar-sql.mjs (fica fora do Git).
// Uso, nesta pasta: npm run seed
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { as, createDb, ORG, REPO } from "./db.mjs";

const pasta = join(REPO, "desafios", "halloween");
const arquivo = join(pasta, "rodadas-halloween.sql");
if (!existsSync(arquivo)) {
  console.log("rodadas-halloween.sql não encontrado; rode antes: node desafios/halloween/gerar-sql.mjs");
  process.exit(1);
}
const sql = readFileSync(arquivo, "utf8");
// Como no projeto real em 29/10: só as duas primeiras migrations aplicadas;
// a de "Reiniciar" vem dentro do próprio arquivo.
const db = await createDb(REPO, { skip: ["20261029190000_reiniciar_rodada.sql"] });
const DEV = "11111111-1111-4111-8111-111111111111";
assert.equal((await db.query(`select to_regclass('public.rounds') is not null as ok,
  exists (select 1 from information_schema.columns where table_name = 'rounds' and column_name = 'status_changed_at') as tem`)).rows[0].tem, false);

// Como no projeto real: pode existir a rodada "teste" do modo antigo.
await db.exec(`insert into public.rounds (id, title) values ('teste', 'Rodada de teste (fictícia)')`);

await db.exec(sql);
const r = await db.query(`select r.id, r.title, r.position, r.status, m.instructions_html, m.reference_image
  from public.rounds r join public.round_materials m on m.round_id = r.id order by r.position`);
assert.equal(r.rows.length, 5);
assert.equal((await db.query(`select count(*)::int as n from public.rounds`)).rows[0].n, 5, "rodada 'teste' removida");
for (const row of r.rows) {
  const assets = join(pasta, row.id, "assets");
  assert.equal(row.instructions_html, readFileSync(join(assets, "instructions.html"), "utf8"), row.id + " instruções");
  assert.equal(row.reference_image, "data:image/png;base64," + readFileSync(join(assets, "page.png")).toString("base64"), row.id + " referência");
  assert.equal(row.status, "pronta");
}
console.log("ok - 5 rodadas prontas, referências e instruções idênticas aos arquivos:");
r.rows.forEach((x) => console.log(`     ${x.position}. ${x.title}`));

// Play numa rodada, uma entrega, e o SQL de novo: estado e entregas ficam.
await as(db, "authenticated", ORG, "select * from public.admin_controlar_rodada('rodada-1-pousada-meia-noite', 'iniciar')");
await as(db, "anon", null, "select public.entregar('rodada-1-pousada-meia-noite', $1, 'Ana', '<h1>oi</h1>')", [DEV]);
await db.exec(sql);
const depois = await db.query(`select status, (select count(*)::int from public.submissions) as n,
  (select count(*)::int from public.round_materials) as m from public.rounds where position = 1`);
assert.deepEqual(depois.rows[0], { status: "valendo", n: 1, m: 5 });
console.log("ok - rodar de novo não duplica nem mexe na rodada valendo nem nas entregas");

// O participante recebe a referência pela RPC pública depois do play.
const mat = (await as(db, "anon", null, "select public.materiais_rodada('rodada-1-pousada-meia-noite') as m")).rows[0].m;
assert.ok(mat.reference_image.startsWith("data:image/png;base64,iVBOR"));
await assert.rejects(as(db, "anon", null, "select public.materiais_rodada('rodada-2-doce-mordida')"), /CITD_NOT_STARTED/);
console.log("ok - referência liberada só para a rodada iniciada");

// A migration de "Reiniciar" veio junto: reiniciar no meio mostra a rodada como pronta.
await as(db, "authenticated", ORG, "select * from public.admin_controlar_rodada('rodada-1-pousada-meia-noite', 'reiniciar')");
const e = (await as(db, "anon", null, "select public.estado_atual() as e")).rows[0].e;
assert.deepEqual([e.round, e.status], ["rodada-1-pousada-meia-noite", "pronta"]);
console.log("ok - migration de Reiniciar aplicada pelo mesmo arquivo");
