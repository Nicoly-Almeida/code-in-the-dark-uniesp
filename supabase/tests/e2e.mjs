// Teste de ponta a ponta: painel + telão + dois participantes, contra o
// Supabase simulado. Precisa do Chrome (ou Edge) e da pasta desafios/halloween.
// Uso, nesta pasta: npm run e2e   (CHROME=caminho do navegador, se necessário;
// SHOTS=pasta para salvar capturas de tela)
import fs from "node:fs";
import path from "node:path";
import { createDb, REPO } from "./db.mjs";
import { startServer } from "./mock-supabase.mjs";
import { launch } from "./cdp.mjs";

const repo = process.argv[2] ?? REPO;
const chromePath = process.argv[3] ?? [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => p && fs.existsSync(p));
const db = await createDb(repo);
const { origin, server, log } = await startServer(repo, db);
const chrome = await launch(chromePath);
let step = 0;
const ok = (msg) => console.log(`ok ${++step} - ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS;
async function shot(p, name) {
  if (!SHOTS) return;
  const { data } = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(SHOTS, name + ".png"), Buffer.from(data, "base64"));
}

function participant(name) {
  return chrome.page(`${origin}/editor/`, {
    isolated: true,
    dialog: (d) => d.type === "beforeunload" ? { accept: true }
      : /name/i.test(d.message) ? { accept: true, promptText: name }
      : { accept: true, promptText: "yes" },
  });
}
const tela1 = `document.querySelectorAll("#telas .tela")[0]`;
const lockText = `(() => { const l = document.querySelector(".citd-lock"); return l.hidden ? "" : l.textContent; })()`;
const readOnly = `document.getElementById("editor").env.editor.getReadOnly()`;
const barMsg = `document.querySelector(".citd-bar .msg").textContent`;
const typeConfirm = (value) => `(() => { const i = document.querySelector(".citd-modal input");
  i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event("input")); return document.querySelector(".citd-modal .confirm").disabled; })()`;

// Finish pela janela de confirmação: "yes" não libera, "sim" libera.
async function finishVia(p) {
  await p.eval(`document.querySelector(".finish-button").click()`);
  await p.waitFor(`!document.querySelector(".citd-modal").hidden`, "janela de confirmação do Finish");
  if (!(await p.eval(`document.querySelector(".citd-modal .confirm").disabled`))) throw new Error("Confirmar habilitado sem digitar");
  if (!(await p.eval(typeConfirm("yes")))) throw new Error("Confirmar habilitado com 'yes'");
  if (await p.eval(typeConfirm(" SIM "))) throw new Error("Confirmar desabilitado com 'sim'");
  await p.eval(`document.querySelector(".citd-modal .confirm").click()`);
  await p.waitFor(`document.querySelector(".citd-modal").hidden && document.querySelector(".result").style.display === "block"`, "resultado depois de confirmar");
}

try {
  // ---------------------------------------------------------------- setup
  const admin = await chrome.page(`${origin}/admin/`);
  const telao = await chrome.page(`${origin}/evento/`);
  const ana = await participant("Ana");

  await admin.waitFor(`!document.getElementById("login-section").hidden`, "tela de login");
  await admin.eval(`(() => { const f = document.getElementById("login-form");
    f.elements.email.value = "org@example.com"; f.elements.password.value = "senha-forte"; f.requestSubmit(); })()`);
  await admin.waitFor(`!document.getElementById("app").hidden`, "painel após login");
  ok("organizador entra no painel");

  // Importar desafios pela pasta. O Chrome headless não preenche inputs
  // webkitdirectory via DevTools; então entregamos ao input os arquivos reais
  // da pasta com o webkitRelativePath que o navegador geraria
  // ("halloween/..."), incluindo pacotes/ e referencia.html.
  const root = path.join(repo, "desafios", "halloween");
  const rels = fs.readdirSync(root, { recursive: true })
    .filter((p) => fs.statSync(path.join(root, p)).isFile())
    .map((p) => "halloween/" + p.split(path.sep).join("/"));
  await admin.eval(`(async () => {
    const files = [];
    for (const rel of ${JSON.stringify(rels)}) {
      const blob = await (await fetch("/desafios/" + rel)).blob();
      const file = new File([blob], rel.split("/").pop(), { type: blob.type });
      Object.defineProperty(file, "webkitRelativePath", { value: rel });
      files.push(file);
    }
    const input = document.getElementById("import-input");
    Object.defineProperty(input, "files", { configurable: true, get: () => files });
    input.dispatchEvent(new Event("change"));
    return files.length;
  })()`);
  const notice = await admin.waitFor(`(() => { const t = document.getElementById("notice").textContent; return /importada/.test(t) && t; })()`, "importação", 20000);
  if (!/^5 rodada\(s\) importada\(s\)/.test(notice) || /Falharam/.test(notice)) throw new Error("importação: " + notice);
  const rounds = await db.query(`select r.id, r.title, r.position, length(m.reference_image) as img,
    m.instructions_html like '%"Entregar"%' as regras_novas from public.rounds r join public.round_materials m on m.round_id = r.id order by position`);
  if (rounds.rows.length !== 5 || rounds.rows.some((r) => !r.regras_novas || r.img < 50000)) throw new Error(JSON.stringify(rounds.rows));
  if (rounds.rows[4].title !== "RODADA 5 · FINAL · EXORCIZA.DEV") throw new Error("título: " + rounds.rows[4].title);
  ok("importa as 5 rodadas da pasta (ignora pacotes/ e referencia.html): " + rounds.rows.map((r) => r.id).join(", "));
  await admin.waitFor(`document.querySelectorAll("#rounds-table tbody tr").length === 5`, "5 linhas na tabela");

  // Antes do play
  await ana.waitFor(`document.querySelector(".name-tag").textContent.trim() === "Ana"`, "nome da Ana");
  await ana.waitFor(`${lockText}.includes("Aguardando")`, "editor aguardando");
  if (!(await ana.eval(readOnly))) throw new Error("editor deveria estar travado antes do play");
  if (await ana.eval(`getComputedStyle(document.querySelector(".reference-screenshot-container")).display`) !== "none") throw new Error("referência visível antes do play");
  if (!(await ana.eval(`document.querySelector(".deliver-button").disabled`))) throw new Error("Entregar habilitado antes do play");
  await telao.waitFor(`document.getElementById("status").textContent === "Aguardando a próxima rodada"`, "telão aguardando");
  await shot(ana, "1-editor-aguardando"); await shot(telao, "1-telao-aguardando");
  ok("antes do play: editor travado, sem referência, Entregar desabilitado; telão aguardando");

  // Duração editável
  await admin.eval(`(() => { const i = document.querySelectorAll("#rounds-table input.minutes")[2]; i.value = "10"; i.dispatchEvent(new Event("change")); })()`);
  await sleep(500);
  const dur = await db.query(`select duration_seconds from public.rounds where position = 3`);
  if (dur.rows[0].duration_seconds !== 600) throw new Error("duração: " + dur.rows[0].duration_seconds);
  ok("duração da rodada 3 alterada para 10 min pelo painel");

  // ------------------------------------------------------------ play rodada 1
  await admin.eval(`[...document.querySelectorAll("#rounds-table tbody tr")][0].querySelector("button").click()`);
  await admin.waitFor(`document.getElementById("live-title").textContent.includes("RODADA 1")`, "rodada ao vivo no painel");
  await ana.waitFor(`${lockText} === ""`, "editor destravado", 6000);
  await ana.waitFor(`document.querySelector(".reference-screenshot").style.backgroundImage.startsWith('url("data:image/png')`, "referência carregada");
  await ana.waitFor(`(document.querySelector(".instructions").srcdoc || "").includes("RODADA 1 · POUSADA")`, "instruções da rodada");
  if (await ana.eval(readOnly)) throw new Error("editor ainda travado");
  await telao.waitFor(`document.body.classList.contains("running") && document.getElementById("title").textContent.includes("RODADA 1")`, "telão valendo");
  const clock = await telao.eval(`document.getElementById("clock").textContent`);
  if (!/^1[45]:\d\d$/.test(clock)) throw new Error("relógio do telão: " + clock);
  await sleep(300); await shot(ana, "2-editor-valendo"); await shot(telao, "2-telao-valendo"); await shot(admin, "2-painel-valendo");
  ok(`play: editor destrava com referência e instruções; telão em ${clock}`);

  await ana.eval(`document.getElementById("editor").env.editor.insert("<h1>Pousada da Ana</h1>")`);
  await ana.eval(`document.querySelector(".deliver-button").click()`);
  await ana.waitFor(`${barMsg}.startsWith("Entregue às")`, "entrega manual");
  ok("Ana entrega manualmente: " + (await ana.eval(barMsg)));

  await admin.waitFor(`!document.getElementById("round-detail").hidden && document.getElementById("submissions-table").textContent.includes("Ana")`, "entrega no painel", 8000);
  ok("painel abre as entregas da rodada iniciada e mostra a da Ana");

  // ------------------------------------------------------- telão ao vivo
  await telao.waitFor(`${tela1}.querySelector(".nome").textContent === "Ana" && ${tela1}.querySelector(".linhas").textContent.includes("Pousada da Ana")`, "código da Ana no telão", 8000);
  await telao.waitFor(`${tela1}.classList.contains("entregue")`, "selo de entregue no telão");
  if (!(await telao.eval(`!!(${tela1}.querySelector(".c-tag") && ${tela1}.querySelector(".cursor"))`))) throw new Error("telão sem realce ou sem cursor");
  if (await telao.eval(`document.querySelectorAll("#telas iframe, #telas script, #telas h1").length`)) throw new Error("telão interpretou o HTML do competidor");
  if (await telao.eval(`document.querySelectorAll("#telas .tela.vazia").length`) !== 2) throw new Error("telão deveria ter 2 telas vazias");
  if (!(await telao.eval(`document.getElementById("ver-resultados").hidden`))) throw new Error("resultados disponíveis durante a rodada");
  await admin.waitFor(`!document.getElementById("telao-box").hidden && document.getElementById("telao-table").textContent.includes("Tela 1")`, "Ana na tabela do telão no painel");
  await shot(telao, "2b-telao-ao-vivo"); await shot(admin, "2b-painel-telao");
  ok("telão mostra o código da Ana como texto (com realce e cursor) e o selo de entregue; painel lista a Ana na tela 1");

  await admin.waitFor(`[...document.querySelectorAll("#telao-table button")].some((b) => b.textContent === "Tirar do telão")`, "botão Tirar do telão");
  await admin.eval(`[...document.querySelectorAll("#telao-table button")].find((b) => b.textContent === "Tirar do telão").click()`);
  await telao.waitFor(`document.querySelectorAll("#telas .tela.vazia").length === 3`, "Ana fora do telão", 6000);
  await admin.waitFor(`[...document.querySelectorAll("#telao-table button")].some((b) => b.textContent === "Pôr no telão")`, "botão Pôr no telão");
  await admin.eval(`[...document.querySelectorAll("#telao-table button")].find((b) => b.textContent === "Pôr no telão").click()`);
  await telao.waitFor(`${tela1}.querySelector(".nome").textContent === "Ana"`, "Ana de volta ao telão", 6000);
  ok("painel tira a Ana do telão e devolve");

  // ---------------------------------------------------------- pausa/retoma
  await admin.eval(`document.getElementById("live-pause").click()`);
  await ana.waitFor(`${lockText}.includes("pausada")`, "editor pausado");
  if (!(await ana.eval(readOnly))) throw new Error("editor deveria travar na pausa");
  await telao.waitFor(`document.getElementById("status").textContent === "Rodada pausada"`, "telão pausado");
  const frozen1 = await telao.eval(`document.getElementById("clock").textContent`);
  await sleep(1500);
  if (await telao.eval(`document.getElementById("clock").textContent`) !== frozen1) throw new Error("relógio andou na pausa");
  await admin.waitFor(`document.getElementById("live-pause").textContent === "Retomar"`, "botão Retomar");
  await admin.eval(`document.getElementById("live-pause").click()`);
  await ana.waitFor(`${lockText} === ""`, "editor retomado");
  ok("pausar trava editor e congela telão; retomar destrava");

  // -------------------------------------------------------- fim do tempo
  await ana.eval(`document.getElementById("editor").env.editor.insert("<p>versão final</p>")`);
  await telao.waitFor(`${tela1}.querySelector(".linhas").textContent.includes("versão final")`, "digitação ao vivo no telão", 6000);
  ok("o que a Ana digita aparece no telão sem precisar entregar");
  await sleep(400); // salva no localStorage (debounce do editor)
  await db.exec(`update public.rounds set ends_at = now() + interval '3 seconds' where position = 1`);
  await ana.waitFor(`${lockText}.includes("Tempo esgotado")`, "tempo esgotado no editor", 10000);
  await ana.waitFor(`${barMsg}.includes("Finish")`, "entrega automática", 8000);
  if (!(await ana.eval(readOnly))) throw new Error("editor deveria travar no fim");
  await telao.waitFor(`document.body.classList.contains("finished")`, "telão encerrado");
  const subs = await db.query(`select submitted_name, code from public.submissions where round_id = 'rodada-1-pousada-meia-noite' order by submitted_at`);
  if (subs.rows.length !== 2 || !subs.rows[1].code.includes("versão final")) throw new Error(JSON.stringify(subs.rows));
  await shot(ana, "4-editor-fim");
  ok("fim do tempo: editor trava e entrega sozinho a versão final; telão mostra tempo esgotado");

  // ------------------------------------------------- resultados no telão
  await telao.waitFor(`!document.getElementById("ver-resultados").hidden`, "botão Mostrar resultados");
  await telao.eval(`document.getElementById("ver-resultados").click()`);
  await telao.waitFor(`document.body.classList.contains("resultados") && (${tela1}.querySelector(".previa iframe")?.srcdoc || "").includes("versão final")`, "prévia da Ana no telão");
  const thumb = await telao.eval(`(() => { const f = ${tela1}.querySelector(".previa iframe");
    return [f.getAttribute("sandbox"), f.srcdoc.includes('<base href="${origin}/editor/assets/">'), document.querySelectorAll("#telas iframe").length]; })()`);
  if (thumb[0] !== "" || !thumb[1] || thumb[2] !== 1) throw new Error("prévia no telão: " + JSON.stringify(thumb));
  await telao.send("Runtime.evaluate", { expression: `${tela1}.click()`, userGesture: true });
  await telao.waitFor(`!document.getElementById("comparar").hidden && document.getElementById("comparar-ref").src.startsWith("data:image/png") && (document.querySelector("#comparar-janela iframe")?.srcdoc || "").includes("versão final")`, "Ana ao lado da referência");
  const lado = await telao.eval(`(() => { const f = document.querySelector("#comparar-janela iframe"); const img = document.getElementById("comparar-ref");
    return [document.getElementById("comparar-nome").textContent, f.getAttribute("sandbox"), f.style.width, img.naturalWidth]; })()`);
  if (lado[0] !== "Ana" || lado[1] !== "" || lado[2] !== lado[3] + "px") throw new Error("comparação: " + JSON.stringify(lado));
  await sleep(300); await shot(telao, "4b-telao-comparar");
  await telao.eval(`document.getElementById("comparar-fechar").click()`);
  await telao.waitFor(`document.getElementById("comparar").hidden && !document.querySelector("#comparar-janela iframe")`, "fechar a comparação");
  await shot(telao, "4c-telao-resultados");
  ok("telão: rodada encerrada libera 'Mostrar resultados'; prévia da Ana (sandbox) ao lado da referência, na mesma escala");

  // ------------------------------------------------- voto do público
  await telao.waitFor(`!document.getElementById("abrir-votacao").hidden`, "botão Votação do público");
  await telao.eval(`document.getElementById("abrir-votacao").click()`);
  await telao.waitFor(`!document.getElementById("votacao").hidden && !!document.querySelector("#qr svg path") && document.getElementById("votacao-url").textContent.endsWith("/votar/")`, "QR code da votação");
  await telao.waitFor(`document.getElementById("votacao-candidatos").textContent.includes("Ana") && document.getElementById("votacao-estado").textContent.includes("Votação aberta · 0 votos")`, "candidatos ao lado do QR");
  const votarUrl = await telao.eval(`new URL("../votar/", location.href).href`);
  const eleitor = await chrome.page(votarUrl, { isolated: true });
  await eleitor.waitFor(`document.querySelectorAll("#candidatos button").length === 1 && !document.querySelector("#candidatos button").disabled`, "votação aberta no celular");
  if (!(await eleitor.eval(`document.querySelector("#candidatos button").textContent.includes("Ana")`))) throw new Error("celular sem a Ana");
  await eleitor.eval(`document.querySelector("#candidatos button").click()`);
  await eleitor.waitFor(`document.querySelector("#candidatos button").getAttribute("aria-pressed") === "true" && document.getElementById("mensagem").textContent.includes("registrado")`, "voto registrado");
  await telao.waitFor(`document.getElementById("votacao-estado").textContent.includes("1 voto")`, "total de votos no telão");
  if (await telao.eval(`document.getElementById("votacao-candidatos").textContent.includes("VOTO")`)) throw new Error("placar visível antes de mostrar o resultado");
  await shot(telao, "4d-telao-qr"); await shot(eleitor, "4e-celular-votou");
  await telao.eval(`document.getElementById("mostrar-placar").click()`);
  await telao.waitFor(`!document.getElementById("placar").hidden && (document.querySelector("#placar-lista li.vencedor")?.textContent || "").includes("Ana") && document.getElementById("placar-lista").textContent.includes("1 VOTO · 100%")`, "resultado do público");
  await telao.waitFor(`document.querySelector("#placar-lista li.vencedor .barra i").style.width === "100%"`, "barra do vencedor");
  await sleep(1400); await shot(telao, "4f-telao-placar");
  ok("votação: QR code no telão, celular vota na Ana, telão conta o voto e mostra a Ana vencedora no resultado do público");

  await admin.waitFor(`document.getElementById("votacao-painel-botao").textContent === "Encerrar votação" && document.getElementById("votacao-painel-texto").textContent.includes("1 voto")`, "votação no painel", 8000);
  await admin.eval(`document.getElementById("votacao-painel-botao").click()`);
  await eleitor.waitFor(`document.getElementById("mensagem").textContent.startsWith("Votação encerrada") && document.querySelector("#candidatos button").disabled`, "celular vê a votação encerrada", 8000);
  await telao.waitFor(`document.getElementById("placar-total").textContent === "1 voto no total" && document.getElementById("votacao").classList.contains("fechada")`, "telão com a votação encerrada");
  await telao.eval(`document.getElementById("votacao-fechar").click()`);
  await telao.waitFor(`document.getElementById("votacao").hidden`, "fechar a votação no telão");
  ok("painel encerra a votação: celular trava e o telão mostra o total final");

  // Quem abre depois do fim não entrega
  const bia = await participant("Bia");
  await bia.waitFor(`${lockText}.includes("Rodada encerrada")`, "Bia vê rodada encerrada");
  if (!(await bia.eval(`document.querySelector(".deliver-button").disabled`))) throw new Error("Bia não deveria poder entregar");
  ok("participante que abre depois do fim vê 'rodada encerrada' e não entrega");

  // Finish da Ana: cancelar não faz nada; confirmar com "sim" mostra o resultado.
  await ana.eval(`document.querySelector(".finish-button").click()`);
  await ana.waitFor(`!document.querySelector(".citd-modal").hidden`, "janela do Finish");
  await shot(ana, "7-editor-confirmar-finish");
  await ana.eval(`document.querySelector(".citd-modal .cancel").click()`);
  await sleep(300);
  if (await ana.eval(`document.querySelector(".result").style.display === "block" || document.body.classList.contains("citd-finished")`)) {
    throw new Error("Cancelar mostrou o resultado");
  }
  await finishVia(ana);
  await ana.waitFor(`document.body.classList.contains("citd-finished")`, "Finish");
  await ana.waitFor(`document.querySelector(".result").contentDocument.body.textContent.includes("versão final")`, "código no resultado");
  if (ana.dialogs.some((d) => /Type "yes"/.test(d))) throw new Error("o prompt em inglês do editor original apareceu");
  ok("Finish: janela em português, Cancelar não faz nada, Confirmar só com 'sim'; resultado mostra o código");

  // --------------------------------------------------- apresentação no painel
  // Logo após o fim, sem esperar a atualização automática da lista.
  await admin.send("Runtime.evaluate", { expression: `document.getElementById("present").click()`, userGesture: true });
  await admin.waitFor(`!document.getElementById("stage").hidden && (document.getElementById("stage-frame").srcdoc || "").includes("versão final")`, "palco com a entrega");
  await sleep(300); await shot(admin, "3-palco");
  const srcdoc = await admin.eval(`document.getElementById("stage-frame").srcdoc`);
  if (!srcdoc.includes(`<base href="${origin}/editor/assets/">`)) throw new Error("sem <base> para os assets: " + srcdoc.slice(0, 120));
  if (await admin.eval(`document.getElementById("stage-frame").getAttribute("sandbox")`) !== "") throw new Error("palco sem sandbox");
  await admin.send("Input.dispatchKeyEvent", { type: "keyDown", key: "r", text: "r" });
  await admin.waitFor(`!document.getElementById("stage-reference").hidden && document.getElementById("stage-reference").src.startsWith("data:image/png")`, "referência no palco");
  await admin.eval(`document.getElementById("stage-close").click()`);
  await admin.waitFor(`document.getElementById("stage").hidden`, "fechar palco");
  await admin.waitFor(`[...document.querySelectorAll("#submissions-table tbody tr")].some((tr) => tr.cells[1].textContent === "Ana" && tr.cells[2].textContent === "2")`, "Ana com 2 entregas na lista");
  ok("tela cheia mostra a última entrega da Ana isolada (sandbox, <base> dos assets) e a referência com R");

  // ------------------------------------------------- próxima rodada
  await admin.waitFor(`[...document.querySelectorAll("#rounds-table tbody tr")][1].querySelector("button").textContent.includes("Iniciar") && ![...document.querySelectorAll("#rounds-table tbody tr")][1].querySelector("button").disabled`, "Iniciar da rodada 2 habilitado");
  await admin.eval(`[...document.querySelectorAll("#rounds-table tbody tr")][1].querySelector("button").click()`);
  await ana.waitFor(`!document.body.classList.contains("citd-finished") && document.querySelector(".result").style.display === "none"`, "resultado escondido na nova rodada");
  await ana.waitFor(`(document.querySelector(".instructions").srcdoc || "").includes("RODADA 2 · DOCE")`, "instruções da rodada 2");
  await telao.waitFor(`!document.body.classList.contains("resultados") && document.getElementById("ver-resultados").hidden && !document.querySelector("#telas iframe")`, "telão volta ao código na rodada 2");
  await telao.waitFor(`document.getElementById("abrir-votacao").hidden`, "votação some do telão na rodada 2");
  // Abrir as outras páginas pode deixar o "celular" em segundo plano, onde ele
  // consulta a cada 15 s (de propósito); por isso a espera é maior.
  await eleitor.waitFor(`document.getElementById("mensagem").textContent.includes("abre quando a rodada terminar") && !document.querySelector("#candidatos button")`, "celular aguardando a próxima votação", 20000);
  const anaCode = await ana.eval(`document.getElementById("editor").env.editor.getValue()`);
  if (anaCode !== "") throw new Error("editor deveria começar vazio na rodada 2: " + anaCode);
  const backup = await ana.eval(`Object.keys(localStorage).filter((k) => k.startsWith("citd_backup_")).map((k) => localStorage[k]).join("|")`);
  if (!backup.includes("versão final")) throw new Error("backup da rodada 1 sumiu");
  await bia.waitFor(`${lockText} === ""`, "Bia destrava na rodada 2");
  await bia.eval(`document.getElementById("editor").env.editor.insert("<h1>Doces da Bia</h1>")`);
  ok("rodada 2: editor limpo (rodada 1 guardada como backup), resultado anterior fechado, Bia participa");

  // Reiniciar no meio da rodada (ex.: problema técnico) e começar de novo.
  await bia.eval(`document.querySelector(".deliver-button").click()`);
  await bia.waitFor(`${barMsg}.startsWith("Entregue às")`, "entrega da Bia antes de reiniciar");
  await admin.waitFor(`!document.getElementById("live-restart").hidden`, "Reiniciar no topo durante a rodada");
  await admin.eval(`document.getElementById("live-restart").click()`);
  await bia.waitFor(`${lockText}.includes("Aguardando")`, "Bia volta a aguardar");
  if (await bia.eval(`getComputedStyle(document.querySelector(".reference-screenshot-container")).display`) !== "none") throw new Error("referência visível depois de reiniciar");
  if (!(await bia.eval(`document.querySelector(".deliver-button").disabled`))) throw new Error("Entregar habilitado depois de reiniciar");
  await telao.waitFor(`document.getElementById("label").textContent === "Próxima rodada" && document.getElementById("title").textContent.includes("RODADA 2") && document.getElementById("clock").textContent === "15:00"`, "telão com a rodada 2 pronta");
  if (await telao.eval(`document.body.classList.contains("finished")`)) throw new Error("telão vermelho depois de reiniciar");
  await telao.waitFor(`document.querySelectorAll("#telas .tela.vazia").length === 3`, "telas vazias depois de reiniciar");
  await admin.waitFor(`!document.getElementById("live-start").hidden && document.getElementById("live-clock").textContent === "15:00"`, "Iniciar no topo");
  const apagadas = await db.query(`select count(*)::int as n from public.submissions where round_id = 'rodada-2-doce-mordida'`);
  if (apagadas.rows[0].n !== 0) throw new Error("entregas não apagadas");
  await shot(bia, "5-editor-reiniciada"); await shot(telao, "5-telao-reiniciada"); await shot(admin, "5-painel-reiniciada");
  ok("reiniciar no meio: editores voltam a aguardar, telão mostra RODADA 2 em 15:00, entregas apagadas");

  await admin.eval(`document.getElementById("live-start").click()`);
  await bia.waitFor(`${lockText} === ""`, "Bia destrava de novo");
  if (await bia.eval(`document.getElementById("editor").env.editor.getValue()`) !== "") throw new Error("editor da Bia não começou limpo");
  await bia.eval(`document.getElementById("editor").env.editor.insert("<h1>Doces da Bia v2</h1>")`);
  ok("▶ Iniciar de novo: tempo recomeça e o editor começa limpo");

  // Finish no meio da rodada, sem clicar em Entregar: entrega sozinho e trava.
  await sleep(400); // salva no localStorage (debounce do editor)
  await bia.eval(`document.querySelector(".finish-button").click()`);
  await bia.waitFor(`document.querySelector(".citd-modal .warning").textContent.includes("ainda está valendo")`, "aviso de rodada valendo");
  await bia.eval(`document.querySelector(".citd-modal .cancel").click()`);
  await finishVia(bia);
  await bia.waitFor(`document.body.classList.contains("citd-finished")`, "Finish da Bia");
  await bia.waitFor(`(() => { const t = document.querySelector(".citd-toast"); return !t.hidden && t.textContent.startsWith("Entregue às"); })()`, "aviso de entrega por cima do resultado");
  if (!(await bia.eval(readOnly))) throw new Error("editor deveria travar depois do Finish");
  const fin = await db.query(`select code from public.submissions where round_id = 'rodada-2-doce-mordida'`);
  if (fin.rows.length !== 1 || !fin.rows[0].code.includes("Doces da Bia v2")) throw new Error(JSON.stringify(fin.rows));
  await shot(bia, "6-editor-finish");
  ok("Finish sem Entregar: entrega o código, trava o editor e avisa por cima do resultado");

  await admin.eval(`document.getElementById("live-end").click()`);
  await ana.waitFor(`${barMsg}.includes("vazio")`, "Ana sem código na rodada 2", 8000);
  await sleep(2500); // tempo para uma entrega automática duplicada aparecer, se houvesse
  const r2 = await db.query(`select submitted_name from public.submissions where round_id = 'rodada-2-doce-mordida'`);
  if (r2.rows.length !== 1 || r2.rows[0].submitted_name !== "Bia") throw new Error(JSON.stringify(r2.rows));
  ok("encerrar agora: quem já deu Finish não entrega de novo; editor vazio da Ana não gera entrega");

  // Reiniciar
  await admin.waitFor(`[...document.querySelectorAll("#rounds-table tbody tr")][1].textContent.includes("Reiniciar")`, "botão Reiniciar");
  await admin.eval(`[...[...document.querySelectorAll("#rounds-table tbody tr")][1].querySelectorAll("button")].find((b) => b.textContent === "Reiniciar").click()`);
  await sleep(800);
  const r2b = await db.query(`select status, (select count(*)::int from public.submissions where round_id = 'rodada-2-doce-mordida') as n from public.rounds where position = 2`);
  if (r2b.rows[0].status !== "pronta" || r2b.rows[0].n !== 0) throw new Error(JSON.stringify(r2b.rows));
  ok("reiniciar volta a rodada para pronta e apaga as entregas");

  const errors = [admin, telao, ana, bia, eleitor].flatMap((p, i) => p.errors
    .filter((e) => !/favicon\.ico/.test(e)) // o servidor de teste não tem favicon
    .map((e) => ["admin", "telão", "ana", "bia", "celular"][i] + ": " + e));
  if (errors.length) throw new Error("erros de JS no navegador:\n" + errors.join("\n"));
  ok("nenhum erro de JavaScript nas 5 páginas");
  console.log(`\n${step} verificações passaram.`);
} catch (e) {
  console.log(`FALHA depois de ${step} verificações: ${e.message}`);
  console.log("últimas chamadas:", JSON.stringify(log.filter((l) => l.fn !== "estado_atual").slice(-6)));
  try {
    const pages = await Promise.all(chrome.pages.map(async (p) => [p.label, p.errors, await p.eval(`({
      notice: document.getElementById("notice") && document.getElementById("notice").textContent,
      detailHidden: document.getElementById("round-detail") && document.getElementById("round-detail").hidden,
      subs: document.getElementById("submissions-table") && document.getElementById("submissions-table").textContent,
      bar: document.querySelector(".citd-bar") && document.querySelector(".citd-bar").textContent,
    })`).catch((err) => err.message)]));
    console.log(JSON.stringify(pages, null, 1));
  } catch (err) { console.log("diag:", err.message); }
  process.exitCode = 1;
} finally {
  chrome.close();
  server.close();
}
