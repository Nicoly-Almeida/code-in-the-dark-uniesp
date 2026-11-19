// Telão: cronômetro da rodada e o código dos 3 competidores ao vivo. Com a
// rodada encerrada, "Mostrar resultados" troca o código pelas prévias e cada
// competidor abre em tela cheia ao lado da referência do desafio; "Votação
// do público" mostra o QR code da página votar/ e o resultado dos votos.
// O código vem de qualquer pessoa com o link do editor: durante a rodada entra
// na página só como texto (textContent); a prévia só existe depois do fim,
// num iframe sandbox="" (sem scripts) sob a CSP do telão.
(function () {
  var POLL_MS = 1000;
  var SEM_TELAS_RETRY_MS = 30000;
  var DIGITANDO_MS = 2500;   // atualizado há pouco: "digitando"
  var POWER_JANELA_MS = 4000;
  var POWER_CARACTERES = 60; // tantos caracteres em 4 s: POWER MODE!
  var TELAS = 3;
  var LARGURA_PADRAO = 1440; // largura das referências, até a imagem carregar

  var cfg = window.CITD_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };
  var label = $("label");
  var title = $("title");
  var clock = $("clock");
  var status = $("status");
  var trilha = $("trilha");
  var fullscreen = $("fullscreen");

  var state = null;        // estado_atual()
  var info = null;         // ordem/total da rodada
  var screens = [];        // dados das telas na última resposta
  var cache = {};          // device -> { seq, code }
  var history = {};        // device -> [{ at, size }] para o POWER MODE
  var run = "";
  var offsetMs = 0;
  var offline = false;
  var semTelasAte = 0;     // migration do telão ainda não aplicada
  var resultados = false;  // prévias no lugar do código
  var comparing = -1;      // tela aberta lado a lado com a referência
  var reference = { run: "", loading: "", width: LARGURA_PADRAO };

  // ------------------------------------------------------------ telas
  var views = [];
  for (var i = 0; i < TELAS; i++) {
    var node = document.getElementById("modelo-tela").content.firstElementChild.cloneNode(true);
    node.querySelector(".numero").textContent = String(i + 1);
    $("telas").appendChild(node);
    views.push({
      root: node,
      name: node.querySelector(".nome"),
      seal: node.querySelector(".selo"),
      box: node.querySelector(".codigo"),
      lines: node.querySelector(".linhas"),
      wait: node.querySelector(".espera"),
      size: node.querySelector(".medidas"),
      activity: node.querySelector(".atividade"),
      preview: node.querySelector(".previa"),
      frame: null,          // iframe da prévia, só no modo resultados
      shown: "",            // device|seq já desenhado
      previewShown: "",
    });
    node.addEventListener("click", openCompare.bind(null, i));
  }

  // Realce no estilo do tema do editor. Cada pedaço vira um nó de texto.
  var TOKENS = new RegExp([
    "(<!--[\\s\\S]*?(?:-->|$)|\\/\\*[\\s\\S]*?(?:\\*\\/|$))", // 1 comentário
    "(<!doctype[^>\\n]*>?|<\\/?[A-Za-z][\\w:-]*|\\/?>)",     // 2 tag
    "(\"[^\"\\n]*\"?|'[^'\\n]*'?)",                           // 3 texto entre aspas
    "(#[0-9A-Fa-f]{3,8}\\b)",                                 // 4 cor
    "(-?\\b\\d*\\.?\\d+(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr)?\\b)", // 5 número
    "([A-Za-z_:][\\w:.-]*(?=\\s*=))",                         // 6 atributo
    "(-{0,2}[A-Za-z][\\w-]*(?=\\s*:(?!:)))",                  // 7 propriedade CSS
  ].join("|"), "gi");
  var CLASSES = [null, "c-com", "c-tag", "c-str", "c-cor", "c-num", "c-attr", "c-prop"];

  function tokens(code) {
    var out = [];
    var last = 0;
    var m;
    TOKENS.lastIndex = 0;
    while ((m = TOKENS.exec(code))) {
      if (!m[0]) { TOKENS.lastIndex++; continue; }
      if (m.index > last) out.push({ t: code.slice(last, m.index), c: null });
      for (var g = 1; g < CLASSES.length; g++) if (m[g] !== undefined) break;
      out.push({ t: m[0], c: CLASSES[g] });
      last = m.index + m[0].length;
    }
    if (last < code.length) out.push({ t: code.slice(last), c: null });
    return out;
  }

  function splitLines(parts) {
    var lines = [[]];
    parts.forEach(function (p) {
      var pieces = p.t.split("\n");
      pieces.forEach(function (piece, k) {
        if (k > 0) lines.push([]);
        if (piece) lines[lines.length - 1].push({ t: piece, c: p.c });
      });
    });
    return lines;
  }

  function addText(parent, text, cls) {
    if (!text) return;
    if (!cls) { parent.appendChild(document.createTextNode(text)); return; }
    var span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    parent.appendChild(span);
  }

  function cursorNode() {
    var c = document.createElement("span");
    c.className = "cursor";
    return c;
  }

  function drawCode(view, code, row, col) {
    var frag = document.createDocumentFragment();
    var current = null;
    splitLines(tokens(code)).forEach(function (parts, index) {
      var line = document.createElement("div");
      line.className = "l";
      var n = document.createElement("span");
      n.className = "n";
      n.textContent = String(index + 1);
      var text = document.createElement("span");
      text.className = "t";
      var rest = index === row ? col : -1;
      parts.forEach(function (p) {
        if (rest >= 0 && rest <= p.t.length) {
          addText(text, p.t.slice(0, rest), p.c);
          text.appendChild(cursorNode());
          addText(text, p.t.slice(rest), p.c);
          rest = -1;
        } else {
          addText(text, p.t, p.c);
          if (rest >= 0) rest -= p.t.length;
        }
      });
      if (rest >= 0) text.appendChild(cursorNode());
      if (index === row) { line.className += " atual"; current = line; }
      line.appendChild(n);
      line.appendChild(text);
      frag.appendChild(line);
    });
    view.lines.replaceChildren(frag);

    // Mantém a linha do cursor à vista, como no monitor do competidor.
    var box = view.box;
    var target = current || view.lines.lastElementChild;
    if (!target) return;
    var top = target.offsetTop;
    var height = box.clientHeight;
    if (top < box.scrollTop + height * .12 || top > box.scrollTop + height * .8) {
      box.scrollTop = Math.max(0, top - height * .4);
    }
  }

  function fmtBytes(n) {
    return n < 1024 ? n + " B" : (n / 1024).toFixed(1).replace(".", ",") + " KB";
  }

  function fmtHour(iso) {
    return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  // Quantos caracteres a tela ganhou (ou perdeu) nos últimos segundos.
  function burst(device, size) {
    var now = Date.now();
    var list = history[device] || (history[device] = []);
    if (!list.length || list[list.length - 1].size !== size) list.push({ at: now, size: size });
    while (list.length > 1 && now - list[1].at > POWER_JANELA_MS) list.shift();
    return Math.abs(size - list[0].size);
  }

  function waitText() {
    if (semTelasAte) return "Telas ao vivo desligadas";
    var phase = phaseNow();
    if (phase === "valendo" || phase === "pausada") return "Aguardando competidor";
    if (phase === "encerrada") return "Sem código nesta tela";
    return "Aguardando a rodada";
  }

  function drawScreens() {
    var phase = phaseNow();
    views.forEach(function (view, index) {
      var s = screens[index];
      var cached = s && cache[s.device];
      if (!s || !cached) {
        view.root.className = "tela vazia";
        view.name.textContent = "---";
        view.wait.textContent = waitText();
        view.lines.replaceChildren();
        view.size.textContent = "";
        view.activity.textContent = "";
        view.shown = "";
        hidePreview(view);
        return;
      }
      if (resultados) showPreview(view, s.device + "|" + cached.seq, cached.code, s.nome);
      else hidePreview(view);
      var code = cached.code;
      var key = s.device + "|" + cached.seq;
      if (view.shown !== key) {
        drawCode(view, code, s.linha, s.coluna);
        view.shown = key;
      }
      var recent = Date.now() + offsetMs - Date.parse(s.atualizado) < DIGITANDO_MS;
      var power = phase === "valendo" && burst(s.device, code.length) >= POWER_CARACTERES;
      var typing = phase === "valendo" && recent;
      view.root.className = "tela" + (typing ? " digitando" : "") + (power ? " power" : "") +
        (s.entregue ? " entregue" : "");
      view.name.textContent = s.nome;
      view.seal.textContent = s.entregue ? "ENTREGUE " + fmtHour(s.entregue) : "";
      view.size.textContent = cached.lines + (cached.lines === 1 ? " LINHA" : " LINHAS") + " · " + fmtBytes(cached.bytes);
      view.activity.textContent = power ? "POWER MODE!" : typing ? "DIGITANDO..." : "";
    });
  }

  // ------------------------------------------------------ resultados
  var resultsButton = $("ver-resultados");
  var compare = $("comparar");
  var compareBox = $("comparar-janela");
  var compareRef = $("comparar-ref");
  var compareFrame = null;

  // Faz os caminhos relativos (ex.: cupcake-monstro.svg) apontarem para os
  // assets do editor. Só acrescenta uma tag <base>; não interpreta o código.
  function withAssetBase(code) {
    var base = '<base href="' + new URL("../editor/assets/", window.location.href).href + '">';
    var head = /<head(\s[^>]*)?>/i.exec(code);
    if (head) return code.slice(0, head.index + head[0].length) + base + code.slice(head.index + head[0].length);
    var doctype = /^\s*<!doctype[^>]*>/i.exec(code);
    if (doctype) return doctype[0] + base + code.slice(doctype[0].length);
    return base + code;
  }

  // sandbox="": sem scripts, sem formulários, sem acesso a esta página.
  function newFrame(title) {
    var frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("tabindex", "-1");
    frame.title = title;
    return frame;
  }

  // Desenha a página na largura da referência e reduz até caber na caixa:
  // referência e resultado ficam na mesma escala.
  function fit(frame, box) {
    var scale = box.clientWidth / reference.width;
    if (!scale) return;
    frame.style.width = reference.width + "px";
    frame.style.height = Math.ceil(box.clientHeight / scale) + "px";
    frame.style.transform = "scale(" + scale + ")";
  }

  function showPreview(view, key, code, name) {
    if (!view.frame) {
      view.frame = newFrame("Prévia de " + name);
      view.preview.appendChild(view.frame);
    }
    if (view.previewShown !== key) {
      view.frame.srcdoc = withAssetBase(code);
      view.previewShown = key;
    }
    fit(view.frame, view.preview);
  }

  function hidePreview(view) {
    if (!view.frame) return;
    view.frame.remove();
    view.frame = null;
    view.previewShown = "";
  }

  // Prévias só depois do fim: durante a rodada os competidores veem o telão.
  function canShowResults() {
    return phaseNow() === "encerrada";
  }

  function setResults(on) {
    resultados = !!on && canShowResults();
    if (resultados) loadReference();
    else closeCompare();
    document.body.classList.toggle("resultados", resultados);
    resultsButton.textContent = resultados ? "Voltar ao código" : "Mostrar resultados";
    drawScreens();
  }

  // A referência da rodada (liberada pelo servidor depois do play).
  function loadReference() {
    if (!state || reference.run === run || reference.loading === run) return;
    var forRun = run;
    reference.loading = forRun;
    rpc("materiais_rodada", { p_round: state.round }).then(function (m) {
      if (forRun !== run) return;
      reference.run = forRun;
      compareRef.onload = function () {
        reference.width = compareRef.naturalWidth || LARGURA_PADRAO;
        drawScreens();
        fitCompare();
      };
      compareRef.src = m.reference_image;
    }, function () {
      // Sem conexão: tenta de novo no próximo "Mostrar resultados".
    }).then(function () {
      if (reference.loading === forRun) reference.loading = "";
    });
  }

  // Telas com código, na ordem do telão.
  function filledScreens() {
    var list = [];
    screens.forEach(function (s, i) { if (i < TELAS && cache[s.device]) list.push(i); });
    return list;
  }

  function openCompare(index) {
    var s = resultados && screens[index];
    var cached = s && cache[s.device];
    if (!cached) return;
    comparing = index;
    $("comparar-numero").textContent = String(index + 1);
    $("comparar-nome").textContent = s.nome;
    $("comparar-legenda").textContent = "Resultado de " + s.nome;
    if (compareFrame) compareFrame.remove();
    compareFrame = newFrame("Resultado de " + s.nome);
    compareFrame.srcdoc = withAssetBase(cached.code);
    compareBox.appendChild(compareFrame);
    compare.hidden = false;
    fitCompare();
    compare.focus();
    // Ainda dentro do clique: o navegador só libera a tela cheia assim.
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(function () {});
    }
  }

  function fitCompare() {
    if (compareFrame && !compare.hidden) fit(compareFrame, compareBox);
  }

  function moveCompare(delta) {
    var list = filledScreens();
    if (!list.length) return closeCompare();
    var at = list.indexOf(comparing);
    openCompare(list[(at + delta + list.length) % list.length]);
  }

  function closeCompare() {
    comparing = -1;
    compare.hidden = true;
    if (compareFrame) {
      compareFrame.remove();
      compareFrame = null;
    }
  }

  resultsButton.addEventListener("click", function () { setResults(!resultados); });
  $("comparar-anterior").addEventListener("click", function () { moveCompare(-1); });
  $("comparar-proximo").addEventListener("click", function () { moveCompare(1); });
  $("comparar-fechar").addEventListener("click", closeCompare);
  window.addEventListener("resize", function () {
    drawScreens();
    fitCompare();
  });
  // Rolar a prévia com o mouse passa o foco para o iframe, que engoliria as
  // setas; devolve o foco à comparação.
  window.addEventListener("blur", function () {
    if (comparing >= 0) setTimeout(function () { compare.focus(); }, 0);
  });

  // ------------------------------------------------ voto do público
  // QR code para a página votar/ e, por baixo dele, o resultado do público.
  var VOTACAO_POLL_MS = 1500;
  var VOTAR_URL = new URL("../votar/", window.location.href).href;
  var votingButton = $("abrir-votacao");
  var voting = $("votacao");
  var votingData = null;
  var votingProblem = "";
  var votingTimer = null;
  var showingScore = false;
  var barsReady = false;
  var scoreRows = {};      // device -> linha do placar (as barras crescem animadas)

  function drawQr() {
    if ($("qr").firstChild) return;
    var qr = window.qrcode(0, "M");
    qr.addData(VOTAR_URL);
    qr.make();
    var size = qr.getModuleCount();
    var d = "";
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) if (qr.isDark(r, c)) d += "M" + (c + 4) + " " + (r + 4) + "h1v1h-1z";
    }
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 " + (size + 8) + " " + (size + 8));
    svg.setAttribute("shape-rendering", "crispEdges");
    var path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "#000");
    svg.appendChild(path);
    $("qr").appendChild(svg);
    $("votacao-url").textContent = VOTAR_URL.replace(/^https?:\/\//, "");
  }

  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  function drawVoting() {
    var d = votingData;
    var status = d ? d.status : "";
    var cands = d ? d.candidatos : [];
    var total = d ? d.total : 0;
    voting.classList.toggle("fechada", status === "encerrada");
    $("votacao-rodada").textContent = d && d.title ? d.title : "";
    $("placar-titulo").textContent = d && d.title ? d.title : "";
    $("votacao-qr-tela").hidden = showingScore;
    $("placar").hidden = !showingScore;

    var text = votingProblem || {
      aberta: "Votação aberta · " + plural(total, "voto", "votos"),
      encerrada: "Votação encerrada · " + plural(total, "voto", "votos"),
      aguardando: "A votação abre quando a rodada terminar",
    }[status] || "Carregando...";
    $("votacao-estado").textContent = text;
    $("placar-total").textContent = votingProblem || (status === "aberta"
      ? "Votação ainda aberta · " + plural(total, "voto", "votos")
      : plural(total, "voto", "votos") + " no total");

    // Ao lado do QR: só os nomes (sem placar, para não influenciar o voto).
    var list = $("votacao-candidatos");
    list.replaceChildren();
    cands.forEach(function (c) {
      var li = document.createElement("li");
      var num = document.createElement("span");
      num.className = "numero";
      num.textContent = String(c.tela);
      var name = document.createElement("span");
      name.className = "nome";
      name.textContent = c.nome;
      li.appendChild(num);
      li.appendChild(name);
      list.appendChild(li);
    });
    if (!cands.length) {
      var empty = document.createElement("li");
      var msg = document.createElement("span");
      msg.className = "vazio";
      msg.textContent = "Nenhum competidor nesta rodada.";
      empty.appendChild(msg);
      list.appendChild(empty);
    }
    drawScore(cands, total);
  }

  function drawScore(cands, total) {
    var best = 0;
    cands.forEach(function (c) { best = Math.max(best, c.votos); });
    var leaders = cands.filter(function (c) { return best > 0 && c.votos === best; }).length;
    var list = $("placar-lista");
    var keep = {};
    cands.forEach(function (c) {
      var row = scoreRows[c.device];
      if (!row) {
        row = { li: document.createElement("li") };
        row.num = document.createElement("span");
        row.num.className = "numero";
        row.name = document.createElement("span");
        row.name.className = "placar-nome";
        var bar = document.createElement("div");
        bar.className = "barra";
        row.fill = document.createElement("i");
        bar.appendChild(row.fill);
        row.votes = document.createElement("span");
        row.votes.className = "placar-votos";
        row.li.appendChild(row.num);
        row.li.appendChild(row.name);
        row.li.appendChild(bar);
        row.li.appendChild(row.votes);
        scoreRows[c.device] = row;
      }
      keep[c.device] = true;
      var leader = best > 0 && c.votos === best;
      row.li.className = leader ? "vencedor" : "";
      row.num.textContent = String(c.tela);
      row.name.textContent = c.nome;
      if (leader) {
        var seal = document.createElement("span");
        seal.className = "selo-voto";
        seal.textContent = leaders > 1 ? "EMPATE" : "VENCEDOR";
        row.name.appendChild(seal);
      }
      // As barras começam em zero e crescem quando o placar aparece.
      row.fill.style.width = barsReady && best ? (c.votos / best * 100) + "%" : "0";
      var pct = total ? Math.round(c.votos * 100 / total) : 0;
      row.votes.textContent = plural(c.votos, "VOTO", "VOTOS") + " · " + pct + "%";
      list.appendChild(row.li); // reordena pela tela
    });
    Object.keys(scoreRows).forEach(function (device) {
      if (keep[device]) return;
      scoreRows[device].li.remove();
      delete scoreRows[device];
    });
  }

  function pollVoting() {
    clearTimeout(votingTimer);
    if (voting.hidden) return;
    rpc("votacao", {}).then(function (d) {
      votingData = d;
      votingProblem = "";
    }, function (err) {
      votingProblem = err.status === 404
        ? "Votação desligada: falta rodar a migration da votação no Supabase"
        : "Sem conexão: tentando de novo...";
    }).then(function () {
      if (voting.hidden) return;
      drawVoting();
      votingTimer = setTimeout(pollVoting, VOTACAO_POLL_MS);
    });
  }

  function openVoting() {
    if (!canShowResults()) return;
    closeCompare();
    showingScore = false;
    drawQr();
    voting.hidden = false;
    drawVoting();
    voting.focus();
    pollVoting();
  }

  function closeVoting() {
    voting.hidden = true;
    showingScore = false;
    barsReady = false;
    clearTimeout(votingTimer);
  }

  function showScore(on) {
    showingScore = on;
    barsReady = false;
    drawVoting();
    // Desenha o placar com as barras em zero e só depois põe a largura certa.
    if (on) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          barsReady = showingScore;
          drawVoting();
        });
      });
    }
  }

  votingButton.addEventListener("click", openVoting);
  $("votacao-fechar").addEventListener("click", closeVoting);
  $("mostrar-placar").addEventListener("click", function () { showScore(true); });
  $("voltar-qr").addEventListener("click", function () { showScore(false); });

  // ---------------------------------------------------------- rodada
  function phaseNow() {
    if (!state) return null;
    if (state.status === "valendo" && Date.now() + offsetMs >= Date.parse(state.ends_at)) return "encerrada";
    return state.status;
  }

  function isFinal() {
    return !!info && info.total > 1 && info.ordem === info.total;
  }

  function drawTrail() {
    trilha.replaceChildren();
    if (!info || !state || !info.total) return;
    for (var i = 1; i <= info.total; i++) {
      var li = document.createElement("li");
      var last = i === info.total && info.total > 1;
      li.textContent = last ? "FINAL" : String(i);
      li.className = (i < info.ordem ? "feita" : i === info.ordem ? "atual" : "") + (last ? " final" : "");
      trilha.appendChild(li);
    }
  }

  function render() {
    var phase = phaseNow();
    var remaining = 0;
    if (phase === "valendo") remaining = Math.max(0, Math.ceil((Date.parse(state.ends_at) - Date.now() - offsetMs) / 1000));
    else if (phase === "pausada") remaining = state.remaining_seconds;
    else if (phase === "pronta") remaining = state.duration_seconds;

    var display = state
      ? String(Math.floor(remaining / 60)).padStart(2, "0") + ":" + String(remaining % 60).padStart(2, "0")
      : "--:--";
    clock.textContent = display;
    clock.setAttribute("aria-label", state ? display + " restantes" : "sem rodada");
    title.textContent = state ? state.title : "Code in the Dark";

    var body = document.body.classList;
    body.toggle("running", phase === "valendo");
    body.toggle("urgente", phase === "valendo" && remaining <= 60);
    body.toggle("pausada", phase === "pausada");
    body.toggle("finished", phase === "encerrada");
    body.toggle("final", isFinal());

    var text = {
      pronta: ["Próxima rodada", "Aguardando o início"],
      valendo: ["Rodada em andamento", "Competidores, podem começar"],
      pausada: ["Rodada pausada", "Rodada pausada"],
      encerrada: ["Rodada encerrada", "Tempo esgotado: parem de digitar"],
    }[phase] || ["Aguardando", "Aguardando a próxima rodada"];
    label.textContent = isFinal() ? text[0].replace("Próxima rodada", "Agora é a final").replace("Rodada", "Final") : text[0];
    status.textContent = offline ? "Sem conexão: tentando de novo..." : text[1];

    // Rodada nova (ou reiniciada): volta para o código ao vivo.
    if (resultados && !canShowResults()) setResults(false);
    if (!voting.hidden && !canShowResults()) closeVoting();
    resultsButton.hidden = !canShowResults();
    votingButton.hidden = !canShowResults();
    drawScreens();
  }

  function rpc(name, args) {
    var key = cfg.supabasePublishableKey;
    return fetch(cfg.supabaseUrl + "/rest/v1/rpc/" + name, {
      method: "POST",
      cache: "no-store",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(args || {}),
    }).then(function (res) {
      if (!res.ok) {
        var err = new Error("HTTP " + res.status);
        err.status = res.status;
        throw err;
      }
      return res.json();
    });
  }

  function runOf(s) { return s && s.started_at ? s.round + "@" + s.started_at : ""; }

  function applyState(s) {
    state = s;
    if (runOf(s) !== run) {
      run = runOf(s);
      cache = {};
      history = {};
    }
  }

  // Pede só o código das telas que mudaram desde a última vez.
  function pollTelas() {
    var known = {};
    screens.forEach(function (s) { if (cache[s.device]) known[s.device] = cache[s.device].seq; });
    return rpc("telao_ao_vivo", { p_conhecidos: known }).then(function (data) {
      applyState(data.estado);
      info = { ordem: data.ordem, total: data.total };
      screens = data.telas || [];
      screens.forEach(function (s) {
        if (s.codigo === null || s.codigo === undefined) return;
        cache[s.device] = {
          seq: s.seq,
          code: s.codigo,
          lines: s.codigo ? s.codigo.split("\n").length : 0,
          bytes: new Blob([s.codigo]).size,
        };
      });
      semTelasAte = 0;
    });
  }

  // Sem a migration do telão no Supabase: só o cronômetro.
  function pollEstado() {
    return rpc("estado_atual").then(function (s) {
      applyState(s);
      info = null;
      screens = [];
    });
  }

  function poll() {
    var sentAt = Date.now();
    var request = semTelasAte > Date.now() ? pollEstado() : pollTelas().catch(function (err) {
      if (err.status !== 404) throw err;
      semTelasAte = Date.now() + SEM_TELAS_RETRY_MS;
      return pollEstado();
    });
    request.then(function () {
      if (state && state.server_now) offsetMs = Date.parse(state.server_now) - (sentAt + Date.now()) / 2;
      offline = false;
    }, function () {
      offline = true;
    }).then(function () {
      drawTrail();
      render();
      setTimeout(poll, POLL_MS);
    });
  }

  // ------------------------------------------------------ tela cheia
  fullscreen.addEventListener("click", function () {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  });
  document.addEventListener("keydown", function (event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    var key = event.key;
    var back = key === "Escape" || key === "Backspace";
    if (!voting.hidden) {
      if (back) {
        event.preventDefault();
        if (showingScore) showScore(false);
        else closeVoting();
      } else if (key.toLowerCase() === "v") {
        closeVoting();
      }
    } else if (comparing >= 0) {
      if (key === "ArrowRight" || key === "PageDown") { event.preventDefault(); moveCompare(1); }
      else if (key === "ArrowLeft" || key === "PageUp") { event.preventDefault(); moveCompare(-1); }
      else if (back) { event.preventDefault(); closeCompare(); }
    } else if (resultados && /^[1-3]$/.test(key)) {
      openCompare(Number(key) - 1);
    } else if (resultados && back) {
      event.preventDefault();
      setResults(false);
    } else if (key.toLowerCase() === "r" && canShowResults()) {
      setResults(!resultados);
    } else if (key.toLowerCase() === "v" && canShowResults()) {
      openVoting();
    }
    if (key.toLowerCase() === "f") fullscreen.click();
  });
  document.addEventListener("fullscreenchange", function () {
    fullscreen.textContent = document.fullscreenElement ? "Sair da tela cheia" : "Tela cheia";
    document.body.classList.toggle("cheia", !!document.fullscreenElement);
    // Em tela cheia, um toque no Esc volta da comparação e segurar o Esc sai
    // da tela cheia (Chrome e Edge; nos outros, o Esc sai da tela cheia).
    if (document.fullscreenElement && navigator.keyboard && navigator.keyboard.lock) {
      navigator.keyboard.lock(["Escape"]).catch(function () {});
    }
  });

  // Mouse parado: some o cursor e o botão, para não sujar a projeção.
  var idle = null;
  document.addEventListener("mousemove", function () {
    document.body.classList.remove("parado");
    clearTimeout(idle);
    idle = setTimeout(function () { document.body.classList.add("parado"); }, 3000);
  });

  drawScreens();
  if (window.location.protocol === "file:" || !cfg.supabaseUrl || !cfg.supabasePublishableKey) {
    status.textContent = "Abra pelo endereço publicado do site para acompanhar a rodada.";
    return;
  }
  setInterval(render, 250);
  poll();
})();
