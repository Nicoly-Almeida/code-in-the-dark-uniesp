// Painel da organização — Code in the Dark UNIESP.
// Regra de ouro: o código entregue é NÃO CONFIÁVEL. Ele só entra no DOM via
// textContent ou dentro de <iframe sandbox="" srcdoc>. Nunca via innerHTML.
(function () {
  "use strict";

  var POLL_MS = 2000;
  var SUBMISSIONS_POLL_MS = 5000;

  var cfg = window.CITD_CONFIG || {};
  var $ = function (sel) { return document.querySelector(sel); };
  var notice = $("#notice");

  function say(text, kind) {
    notice.textContent = text || "";
    notice.className = "notice" + (kind ? " " + kind : "");
  }

  if (!window.supabase || !cfg.supabaseUrl || !cfg.supabasePublishableKey) {
    say("Configure supabaseUrl e supabasePublishableKey em citd-config.js.", "error");
    return;
  }

  var db = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "citd-admin-auth" },
  });

  function emptyState() {
    return {
      rounds: [], roundId: null, submissions: [], current: null,
      live: null, offsetMs: 0, stage: null, references: {}, timers: [],
    };
  }
  var state = emptyState();

  var ERRORS = {
    CITD_FORBIDDEN: "Sua conta não tem acesso de organizador.",
    CITD_UNKNOWN_ROUND: "Rodada não encontrada.",
    CITD_INVALID_STATE: "Essa ação não vale no estado atual da rodada. Atualize a página.",
    CITD_OTHER_ROUND_ACTIVE: "Encerre a rodada em andamento antes de iniciar outra.",
    CITD_NO_MATERIALS: "Esta rodada não tem referência e instruções. Rode o SQL das rodadas (veja SUPABASE.md).",
    CITD_INVALID_ACTION: "Ação inválida.",
  };
  function errText(error) {
    if (!error) return "";
    if (ERRORS[error.message]) return ERRORS[error.message];
    if (error.code === "23514") return "Valor fora do permitido.";
    if (error.code === "42501") return "Sem permissão para esta ação.";
    return error.message || "Erro inesperado.";
  }

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === "text") node.textContent = props[k];
      else if (k === "className") node.className = props[k];
      else if (k === "disabled") node.disabled = !!props[k];
      else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), props[k]);
      else node.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  // form.id / form.title / form.name são propriedades do <form>; use isto.
  function field(form, name) { return form.elements.namedItem(name); }

  function fmtTime(iso) {
    return iso ? new Date(iso).toLocaleTimeString("pt-BR") : "";
  }
  function fmtBytes(n) { return n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB"; }
  function fmtClock(secs) {
    return String(Math.floor(secs / 60)).padStart(2, "0") + ":" + String(secs % 60).padStart(2, "0");
  }

  function fillTable(table, rows, emptyText, cols) {
    var body = table.querySelector("tbody");
    body.replaceChildren();
    if (!rows.length) {
      body.appendChild(el("tr", { className: "empty" }, [el("td", { colspan: String(cols), text: emptyText })]));
      return;
    }
    rows.forEach(function (r) { body.appendChild(r); });
  }

  var STATUS = {
    pronta: ["Pronta", "closed"],
    valendo: ["Valendo", "open"],
    pausada: ["Pausada", "paused"],
    encerrada: ["Encerrada", "closed"],
  };
  function badge(status) {
    var s = STATUS[status] || [status, "closed"];
    return el("span", { className: "badge " + s[1], text: s[0] });
  }

  // "valendo" com o fim no passado (relógio do servidor) já está encerrada.
  function liveStatus(r) {
    if (r && r.status === "valendo" && Date.now() + state.offsetMs >= Date.parse(r.ends_at)) return "encerrada";
    return r ? r.status : null;
  }

  // ---------------------------------------------------------------- sessão
  async function refreshSession() {
    var res = await db.auth.getSession();
    var session = res.data && res.data.session;
    $(".session").hidden = !session;
    $("#login-section").hidden = !!session;
    $("#app").hidden = true;
    stopTimers();
    if (!session) return;
    $(".session-email").textContent = session.user.email || "";

    var check = await db.rpc("is_organizer");
    if (check.error || check.data !== true) {
      say("Esta conta não está cadastrada como organizadora. Peça para incluí-la em public.organizers.", "error");
      return;
    }
    say("");
    $("#app").hidden = false;
    await loadRounds();
    await pollLive();
    state.timers.push(setInterval(pollLive, POLL_MS));
    state.timers.push(setInterval(renderLive, 250));
    state.timers.push(setInterval(function () {
      if (state.roundId) loadSubmissions();
    }, SUBMISSIONS_POLL_MS));
  }

  function stopTimers() {
    state.timers.forEach(clearInterval);
    state.timers = [];
  }

  $("#login-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var form = e.currentTarget;
    var btn = form.querySelector("button");
    btn.disabled = true;
    say("Entrando...");
    var res = await db.auth.signInWithPassword({ email: field(form, "email").value.trim(), password: field(form, "password").value });
    btn.disabled = false;
    field(form, "password").value = "";
    if (res.error) return say("Não foi possível entrar: verifique e-mail e senha.", "error");
    await refreshSession();
  });

  $("#logout").addEventListener("click", async function () {
    await db.auth.signOut();
    stopTimers();
    closeViewer();
    state = emptyState();
    say("Sessão encerrada.");
    await refreshSession();
  });

  // ------------------------------------------------- rodada ao vivo (topo)
  async function pollLive() {
    var sentAt = Date.now();
    var res = await db.rpc("estado_atual");
    if (res.error) return;
    var live = res.data;
    if (live && live.server_now) state.offsetMs = Date.parse(live.server_now) - (sentAt + Date.now()) / 2;
    var changed = JSON.stringify(live && [live.round, live.status, live.ends_at, live.remaining_seconds]) !==
      JSON.stringify(state.live && [state.live.round, state.live.status, state.live.ends_at, state.live.remaining_seconds]);
    state.live = live;
    renderLive();
    if (changed) await loadRounds();
  }

  function renderLive() {
    var live = state.live;
    var status = liveStatus(live);
    var secs = 0;
    if (status === "valendo") secs = Math.max(0, Math.ceil((Date.parse(live.ends_at) - Date.now() - state.offsetMs) / 1000));
    if (status === "pausada") secs = live.remaining_seconds;
    if (status === "pronta") secs = live.duration_seconds;

    var b = $("#live-status");
    var s = STATUS[status] || ["Aguardando", "closed"];
    b.textContent = s[0];
    b.className = "badge " + s[1];
    $("#live-title").textContent = live ? live.title : "Nenhuma rodada iniciada";
    $("#live-clock").textContent = live ? fmtClock(secs) : "--:--";
    $("#live").classList.toggle("urgent", status === "valendo" && secs <= 60);

    var active = status === "valendo" || status === "pausada";
    $("#live-start").hidden = status !== "pronta";
    $("#live-pause").hidden = !active;
    $("#live-pause").textContent = status === "pausada" ? "Retomar" : "Pausar";
    $("#live-end").hidden = !active;
    $("#live-restart").hidden = !live || status === "pronta";
  }

  function confirmStart(roundId, title, button) {
    if (window.confirm("Iniciar " + title + "? A referência é liberada e o tempo começa a contar para todos.")) {
      control(roundId, "iniciar", button);
    }
  }

  // Vale em qualquer momento (também no meio da rodada, se algo der errado).
  function confirmRestart(roundId, title, button) {
    if (window.confirm("Reiniciar " + title + "?\n\nO tempo para, os editores voltam a aguardar e TODAS as " +
        "entregas desta rodada são apagadas. Depois é só dar ▶ Iniciar de novo.")) {
      control(roundId, "reiniciar", button);
    }
  }

  async function control(roundId, acao, button) {
    if (button) button.disabled = true;
    var res = await db.rpc("admin_controlar_rodada", { p_round: roundId, p_acao: acao });
    if (button) button.disabled = false;
    if (res.error) {
      say(errText(res.error), "error");
    } else {
      say({
        iniciar: "Rodada iniciada: a referência foi liberada para os participantes.",
        pausar: "Rodada pausada: os editores estão travados.",
        retomar: "Rodada retomada.",
        encerrar: "Rodada encerrada: os editores entregaram e travaram.",
        reiniciar: "Rodada reiniciada: voltou para pronta e as entregas foram apagadas.",
      }[acao], "success");
    }
    await pollLive();
    await loadRounds();
    if (acao === "iniciar" && !res.error) await selectRound(roundId);
  }

  $("#live-start").addEventListener("click", function () {
    if (state.live) confirmStart(state.live.round, state.live.title, this);
  });
  $("#live-restart").addEventListener("click", function () {
    if (state.live) confirmRestart(state.live.round, state.live.title, this);
  });
  $("#live-pause").addEventListener("click", function () {
    var live = state.live;
    if (!live) return;
    control(live.round, liveStatus(live) === "pausada" ? "retomar" : "pausar", this);
  });
  $("#live-end").addEventListener("click", function () {
    var live = state.live;
    if (!live) return;
    if (!window.confirm("Encerrar a rodada agora? Os editores entregam o código e travam.")) return;
    control(live.round, "encerrar", this);
  });

  // ---------------------------------------------------------------- rodadas
  async function loadRounds() {
    var res = await db.from("rounds")
      .select("id, title, position, status, duration_seconds, started_at, ends_at, remaining_seconds")
      .order("position", { ascending: true })
      .order("id", { ascending: true });
    if (res.error) return say(errText(res.error), "error");
    state.rounds = res.data;
    renderRounds();
    if (state.roundId && !currentRound()) {
      state.roundId = null;
      $("#round-detail").hidden = true;
      closeViewer();
    }
  }

  function currentRound() {
    return state.rounds.find(function (r) { return r.id === state.roundId; });
  }

  function renderRounds() {
    var anyActive = state.rounds.some(function (r) {
      var s = liveStatus(r);
      return s === "valendo" || s === "pausada";
    });
    fillTable($("#rounds-table"), state.rounds.map(function (r) {
      var status = liveStatus(r);
      var minutes = el("input", {
        type: "number", min: "1", max: "120", value: String(Math.round(r.duration_seconds / 60)),
        "aria-label": "Minutos de " + r.title, className: "minutes", disabled: status !== "pronta",
        onchange: function () { setDuration(r, this); },
      });
      var actions = [];
      if (status === "pronta") {
        actions.push(el("button", {
          type: "button", text: "▶ Iniciar", disabled: anyActive,
          title: anyActive ? "Encerre a rodada em andamento primeiro" : "",
          onclick: function () { confirmStart(r.id, r.title, this); },
        }));
      } else {
        actions.push(el("button", {
          type: "button", className: "secondary", text: "Reiniciar",
          onclick: function () { confirmRestart(r.id, r.title, this); },
        }));
      }
      actions.push(el("button", {
        type: "button", className: "secondary", text: "Entregas",
        onclick: function () { selectRound(r.id); },
      }));
      return el("tr", { className: r.id === state.roundId ? "selected" : "" }, [
        el("td", {}, [el("strong", { text: r.title }), el("br"), el("span", { className: "hint", text: r.id })]),
        el("td", {}, [badge(status)]),
        el("td", { className: "time" }, [minutes, el("span", { className: "hint", text: " min" })]),
        el("td", { className: "actions" }, actions),
      ]);
    }), "Nenhuma rodada. Rode o SQL das rodadas no Supabase (veja SUPABASE.md).", 4);
  }

  async function setDuration(r, input) {
    var minutes = Math.round(Number(input.value));
    if (!(minutes >= 1 && minutes <= 120)) {
      input.value = String(Math.round(r.duration_seconds / 60));
      return say("A duração deve ser de 1 a 120 minutos.", "error");
    }
    var res = await db.from("rounds").update({ duration_seconds: minutes * 60 }).eq("id", r.id);
    if (res.error) return say(errText(res.error), "error");
    say("Duração de " + r.title + ": " + minutes + " min.", "success");
    await loadRounds();
  }

  async function selectRound(id) {
    state.roundId = id;
    closeViewer();
    renderRounds();
    var round = currentRound();
    $("#round-detail").hidden = false;
    $("#round-title").textContent = round ? round.title : id;
    state.submissions = [];
    await loadSubmissions();
  }

  // --------------------------------------------------------- importação
  // Lê de cada pasta rodada-N-nome/assets/ o instructions.html e o page.png.
  // As cópias em pacotes/ (pendrive) e o referencia.html são ignorados.
  var IMPORT_RE = /(?:^|\/)(rodada-(\d+)-[a-z0-9-]+)\/assets\/(instructions\.html|page\.png)$/;

  function readFile(file, asDataUrl) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error); };
      if (asDataUrl) reader.readAsDataURL(file); else reader.readAsText(file, "utf-8");
    });
  }

  $("#import-input").addEventListener("change", async function () {
    var input = this;
    var found = {};
    Array.prototype.forEach.call(input.files, function (file) {
      var path = file.webkitRelativePath || file.name;
      if (/(^|\/)pacotes\//.test(path)) return;
      var m = IMPORT_RE.exec(path);
      if (!m) return;
      var r = found[m[1]] || (found[m[1]] = { id: m[1], position: Number(m[2]) });
      if (m[3] === "page.png") r.png = file; else r.instructions = file;
    });
    var rounds = Object.keys(found).map(function (k) { return found[k]; })
      .sort(function (a, b) { return a.position - b.position; });
    input.value = "";
    if (!rounds.length) {
      return say("Nenhuma pasta rodada-N-nome/assets/ encontrada. Escolha a pasta desafios/halloween.", "error");
    }
    var done = [];
    var failed = [];
    for (var i = 0; i < rounds.length; i++) {
      var r = rounds[i];
      if (!r.png || !r.instructions) { failed.push(r.id + " (falta page.png ou instructions.html)"); continue; }
      say("Importando " + r.id + "...");
      try {
        var html = await readFile(r.instructions, false);
        var reference = await readFile(r.png, true);
        var header = /===\s*([^=\n]+?)\s*===/.exec(html);
        var res = await db.rpc("admin_importar_rodada", {
          p_round: r.id,
          p_title: header ? header[1] : r.id,
          p_position: r.position,
          p_instructions: html,
          p_reference: reference,
        });
        if (res.error) failed.push(r.id + " (" + errText(res.error) + ")"); else done.push(r.id);
      } catch (err) {
        failed.push(r.id + " (" + (err && err.message || "erro ao ler") + ")");
      }
    }
    say(done.length + " rodada(s) importada(s)" + (done.length ? ": " + done.join(", ") : "") +
      (failed.length ? ". Falharam: " + failed.join("; ") : "."), failed.length ? "error" : "success");
    $("#import-box").open = false;
    await loadRounds();
  });

  // ------------------------------------------------------------- entregas
  async function loadSubmissions() {
    var roundId = state.roundId;
    if (!roundId) return;
    var res = await db.from("submissions")
      .select("id, device_id, submitted_name, code_bytes, submitted_at")
      .eq("round_id", roundId)
      .order("submitted_at", { ascending: false });
    if (roundId !== state.roundId) return;
    if (res.error) return say(errText(res.error), "error");
    state.submissions = res.data;
    renderSubmissions();
  }

  function countsByDevice() {
    var counts = {};
    state.submissions.forEach(function (s) { counts[s.device_id] = (counts[s.device_id] || 0) + 1; });
    return counts;
  }

  // Última entrega de cada máquina, em ordem alfabética de nome (para apresentar).
  function latestPerDevice() {
    var seen = {};
    return state.submissions.filter(function (s) {
      if (seen[s.device_id]) return false;
      seen[s.device_id] = true;
      return true;
    }).sort(function (a, b) { return a.submitted_name.localeCompare(b.submitted_name, "pt-BR"); });
  }

  function visibleSubmissions() {
    return $("#only-latest").checked ? latestPerDevice() : state.submissions;
  }

  function renderSubmissions() {
    var counts = countsByDevice();
    fillTable($("#submissions-table"), visibleSubmissions().map(function (s) {
      return el("tr", { className: state.current && state.current.id === s.id ? "selected" : "" }, [
        el("td", { text: fmtTime(s.submitted_at) }),
        el("td", { text: s.submitted_name }),
        el("td", { text: String(counts[s.device_id] || 1) }),
        el("td", { text: fmtBytes(s.code_bytes) }),
        el("td", { className: "actions" }, [
          el("button", { type: "button", className: "secondary", text: "Ver código", onclick: function () { openSubmission(s); } }),
          el("button", { type: "button", text: "Tela cheia", onclick: function () { openStage(s.id); } }),
        ]),
      ]);
    }), "Nenhuma entrega ainda.", 5);
  }
  $("#only-latest").addEventListener("change", renderSubmissions);

  var codeCache = {};
  async function fetchSubmission(id) {
    if (codeCache[id]) return codeCache[id];
    var res = await db.from("submissions").select("id, round_id, submitted_name, code, submitted_at")
      .eq("id", id).single();
    if (res.error) throw res.error;
    codeCache[id] = res.data;
    return res.data;
  }

  // ------------------------------------------------------- visualização
  async function openSubmission(s) {
    var data;
    try { data = await fetchSubmission(s.id); } catch (err) { return say(errText(err), "error"); }
    state.current = data;
    $("#viewer").hidden = false;
    $("#viewer-title").textContent = data.submitted_name + " · " + fmtTime(data.submitted_at);
    $("#code").textContent = data.code; // texto puro, nunca HTML
    hidePreview();
    renderSubmissions();
    $("#viewer").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function closeViewer() {
    state.current = null;
    hidePreview();
    $("#viewer").hidden = true;
    $("#code").textContent = "";
  }
  $("#close-viewer").addEventListener("click", function () { closeViewer(); renderSubmissions(); });

  function hidePreview() {
    var frame = $("#preview");
    frame.hidden = true;
    frame.removeAttribute("srcdoc");
    $("#preview-toggle").textContent = "Mostrar prévia isolada";
  }

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

  $("#preview-toggle").addEventListener("click", function () {
    var frame = $("#preview");
    if (!state.current) return;
    if (!frame.hidden) return hidePreview();
    // sandbox="" (definido no HTML): sem scripts, sem same-origin, sem forms,
    // sem popups, sem navegação do topo. A CSP do painel também é herdada.
    frame.setAttribute("sandbox", "");
    frame.srcdoc = withAssetBase(state.current.code);
    frame.hidden = false;
    this.textContent = "Ocultar prévia";
  });

  $("#viewer-fullscreen").addEventListener("click", function () {
    if (state.current) openStage(state.current.id);
  });

  $("#download").addEventListener("click", function () {
    var s = state.current;
    if (!s) return;
    var safe = function (v) {
      return String(v).normalize("NFD").replace(/[̀-ͯ]/g, "")
        .replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "entrega";
    };
    var stamp = new Date(s.submitted_at).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    // octet-stream: o navegador baixa o arquivo em vez de abri-lo aqui.
    var blob = new Blob([s.code], { type: "application/octet-stream" });
    var url = URL.createObjectURL(blob);
    var a = el("a", { href: url, download: safe(s.round_id) + "_" + safe(s.submitted_name) + "_" + stamp + ".html" });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  // ------------------------------------------- apresentação em tela cheia
  // Navega pela última entrega de cada participante da rodada escolhida.
  var stage = $("#stage");
  var stageFrame = $("#stage-frame");
  var stageReference = $("#stage-reference");
  var idleTimer = null;

  async function openStage(startId) {
    if (!state.submissions.length) return say("Nenhuma entrega para apresentar.", "error");
    stage.hidden = false;
    // Pedido ainda dentro do clique (exigência do navegador) e sem esperar:
    // se a tela cheia for negada, o palco ocupa a janela mesmo assim.
    if (stage.requestFullscreen) stage.requestFullscreen().catch(function () {});
    stage.focus();
    wakeStageBar();
    // A lista do painel pode estar alguns segundos atrasada (ex.: entregas
    // automáticas logo depois do fim): busca de novo antes de apresentar.
    await loadSubmissions();
    if (stage.hidden) return;
    var list = latestPerDevice();
    var index = list.findIndex(function (s) { return s.id === startId; });
    if (index < 0 && startId) {
      // Entrega antiga (não é a última da máquina): mostra ela primeiro.
      var older = state.submissions.find(function (s) { return s.id === startId; });
      if (older) list = [older].concat(list);
    }
    state.stage = { list: list, index: Math.max(0, index) };
    await showStage();
  }

  async function showStage() {
    var st = state.stage;
    if (!st) return;
    var item = st.list[st.index];
    $("#stage-name").textContent = item.submitted_name;
    $("#stage-count").textContent = (st.index + 1) + " de " + st.list.length + " · entregue às " + fmtTime(item.submitted_at);
    try {
      var data = await fetchSubmission(item.id);
      if (state.stage !== st || st.list[st.index] !== item) return;
      stageFrame.setAttribute("sandbox", "");
      stageFrame.srcdoc = withAssetBase(data.code);
    } catch (err) {
      say(errText(err), "error");
    }
  }

  function moveStage(delta) {
    var st = state.stage;
    if (!st) return;
    st.index = (st.index + delta + st.list.length) % st.list.length;
    stageReference.hidden = true;
    showStage();
  }

  async function toggleReference() {
    if (!stageReference.hidden) { stageReference.hidden = true; return; }
    var roundId = state.roundId;
    if (!state.references[roundId]) {
      var res = await db.rpc("materiais_rodada", { p_round: roundId });
      if (res.error) return say(errText(res.error), "error");
      state.references[roundId] = res.data.reference_image;
    }
    stageReference.src = state.references[roundId];
    stageReference.hidden = false;
  }

  function closeStage() {
    state.stage = null;
    stage.hidden = true;
    stageReference.hidden = true;
    stageFrame.removeAttribute("srcdoc");
    if (document.fullscreenElement) document.exitFullscreen();
  }

  // A barra some depois de alguns segundos parada para não cobrir o trabalho.
  function wakeStageBar() {
    stage.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { stage.classList.add("idle"); }, 2500);
  }

  $("#present").addEventListener("click", function () { openStage(null); });
  $("#stage-prev").addEventListener("click", function () { moveStage(-1); });
  $("#stage-next").addEventListener("click", function () { moveStage(1); });
  $("#stage-ref").addEventListener("click", toggleReference);
  $("#stage-close").addEventListener("click", closeStage);
  stage.addEventListener("mousemove", wakeStageBar);
  // Clicar na prévia passa o foco para o iframe, que engoliria as setas;
  // devolve o foco ao palco (a rolagem com o mouse continua funcionando).
  window.addEventListener("blur", function () {
    if (state.stage) setTimeout(function () { stage.focus(); }, 0);
  });
  document.addEventListener("fullscreenchange", function () {
    if (!document.fullscreenElement && state.stage) closeStage();
  });
  document.addEventListener("keydown", function (e) {
    if (!state.stage) return;
    wakeStageBar();
    if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); moveStage(1); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); moveStage(-1); }
    else if (e.key === "r" || e.key === "R") toggleReference();
    else if (e.key === "Escape") closeStage();
  });

  db.auth.onAuthStateChange(function (event) {
    if (event === "SIGNED_OUT") { $("#app").hidden = true; stopTimers(); }
  });

  refreshSession();
})();
