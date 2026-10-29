// Painel da organização — Code in the Dark UNIESP.
// Regra de ouro: o código enviado é NÃO CONFIÁVEL. Ele só entra no DOM via
// textContent ou dentro de <iframe sandbox="" srcdoc>. Nunca via innerHTML.
(function () {
  "use strict";

  var cfg = window.CITD_CONFIG || {};
  var $ = function (sel) { return document.querySelector(sel); };
  var notice = $("#notice");

  function say(text, kind) {
    notice.textContent = text || "";
    notice.className = "notice" + (kind ? " " + kind : "");
  }

  if (!window.supabase || !cfg.supabaseUrl || !cfg.supabasePublishableKey ||
      /COLE_AQUI/.test(cfg.supabasePublishableKey)) {
    say("Configure supabaseUrl e supabasePublishableKey em citd-config.js.", "error");
    return;
  }

  var db = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "citd-admin-auth" },
  });

  var state = { rounds: [], roundId: null, participants: [], submissions: [], current: null };

  var ERRORS = {
    CITD_FORBIDDEN: "Sua conta não tem acesso de organizador.",
    CITD_UNKNOWN_ROUND: "Rodada não encontrada.",
    CITD_INVALID_NAME: "Nome inválido (1 a 80 caracteres).",
  };
  function errText(error) {
    if (!error) return "";
    if (ERRORS[error.message]) return ERRORS[error.message];
    if (error.code === "23505") return "Já existe um registro com esse identificador.";
    if (error.code === "42501") return "Sem permissão para esta ação.";
    return error.message || "Erro inesperado.";
  }

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === "text") node.textContent = props[k];
      else if (k === "className") node.className = props[k];
      else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), props[k]);
      else node.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  // form.id / form.title / form.name são propriedades do <form>; use isto.
  function field(form, name) { return form.elements.namedItem(name); }

  function fmtTime(iso) {
    return iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "medium" }) : "";
  }
  function fmtBytes(n) { return n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB"; }

  function fillTable(table, rows, emptyText, cols) {
    var body = table.querySelector("tbody");
    body.replaceChildren();
    if (!rows.length) {
      body.appendChild(el("tr", { className: "empty" }, [el("td", { colspan: String(cols), text: emptyText })]));
      return;
    }
    rows.forEach(function (r) { body.appendChild(r); });
  }

  // ---------------------------------------------------------------- sessão
  async function refreshSession() {
    var res = await db.auth.getSession();
    var session = res.data && res.data.session;
    $(".session").hidden = !session;
    $("#login-section").hidden = !!session;
    $("#app").hidden = true;
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
    state = { rounds: [], roundId: null, participants: [], submissions: [], current: null };
    closeViewer();
    say("Sessão encerrada.");
    await refreshSession();
  });

  // ---------------------------------------------------------------- rodadas
  async function loadRounds() {
    var res = await db.from("rounds")
      .select("id, title, is_open, max_code_bytes, opened_at, closed_at, created_at")
      .order("created_at", { ascending: true });
    if (res.error) return say(errText(res.error), "error");
    state.rounds = res.data;
    renderRounds();
    if (state.roundId && state.rounds.some(function (r) { return r.id === state.roundId; })) {
      await loadRound();
    } else {
      state.roundId = null;
      $("#round-detail").hidden = true;
    }
  }

  function renderRounds() {
    fillTable($("#rounds-table"), state.rounds.map(function (r) {
      return el("tr", { className: r.id === state.roundId ? "selected" : "" }, [
        el("td", {}, [el("strong", { text: r.id }), el("br"), el("span", { text: r.title })]),
        el("td", {}, [el("span", { className: "badge " + (r.is_open ? "open" : "closed"), text: r.is_open ? "Aberta" : "Fechada" })]),
        el("td", { text: Math.round(r.max_code_bytes / 1000) + " KB" }),
        el("td", { className: "actions" }, [
          el("button", { type: "button", className: "secondary", text: "Abrir painel", onclick: function () { selectRound(r.id); } }),
        ]),
      ]);
    }), "Nenhuma rodada criada.", 4);
  }

  async function selectRound(id) {
    state.roundId = id;
    closeViewer();
    $("#new-token").hidden = true;
    renderRounds();
    await loadRound();
  }

  $("#round-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var f = e.currentTarget;
    var id = field(f, "id").value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return say("Identificador: letras minúsculas, números e hífen.", "error");
    var res = await db.from("rounds").insert({
      id: id,
      title: field(f, "title").value.trim(),
      max_code_bytes: Math.max(1, Math.min(500, Number(field(f, "kb").value) || 100)) * 1000,
    });
    if (res.error) return say(errText(res.error), "error");
    f.reset();
    say("Rodada criada (fechada). Abra quando o cronômetro começar.", "success");
    state.roundId = id;
    await loadRounds();
  });

  $("#toggle-round").addEventListener("click", async function () {
    var round = currentRound();
    if (!round) return;
    var open = !round.is_open;
    if (!open && !window.confirm("Encerrar a rodada " + round.id + "? Novos envios serão recusados.")) return;
    this.disabled = true;
    var res = await db.rpc("admin_set_round_open", { p_round: round.id, p_open: open });
    this.disabled = false;
    if (res.error) return say(errText(res.error), "error");
    say(open ? "Rodada aberta para envios." : "Rodada encerrada. Envios recusados a partir de agora.", "success");
    await loadRounds();
  });

  $("#refresh").addEventListener("click", function () { loadRounds(); });

  function currentRound() {
    return state.rounds.find(function (r) { return r.id === state.roundId; });
  }

  // ------------------------------------------------- participantes e envios
  async function loadRound() {
    var round = currentRound();
    if (!round) return;
    $("#round-detail").hidden = false;
    $("#round-title").textContent = round.title + " (" + round.id + ")";
    var badge = $("#round-status");
    badge.textContent = round.is_open ? "Aberta" : "Fechada";
    badge.className = "badge " + (round.is_open ? "open" : "closed");
    $("#toggle-round").textContent = round.is_open ? "Encerrar rodada" : "Abrir rodada";
    $("#toggle-round").className = round.is_open ? "danger" : "";

    var results = await Promise.all([
      db.from("participants").select("id, display_name, created_at")
        .eq("round_id", round.id).order("created_at", { ascending: true }),
      db.from("submissions").select("id, participant_id, submitted_name, code_bytes, submitted_at")
        .eq("round_id", round.id).order("submitted_at", { ascending: false }),
    ]);
    var err = results[0].error || results[1].error;
    if (err) return say(errText(err), "error");
    state.participants = results[0].data;
    state.submissions = results[1].data;
    renderParticipants();
    renderSubmissions();
  }

  function participantName(id) {
    var p = state.participants.find(function (x) { return x.id === id; });
    return p ? p.display_name : "(removido)";
  }

  function renderParticipants() {
    fillTable($("#participants-table"), state.participants.map(function (p) {
      var count = state.submissions.filter(function (s) { return s.participant_id === p.id; }).length;
      return el("tr", {}, [
        el("td", { text: p.display_name }),
        el("td", { text: String(count) }),
        el("td", { className: "actions" }, [
          el("button", { type: "button", className: "secondary", text: "Remover", onclick: function () { removeParticipant(p); } }),
        ]),
      ]);
    }), "Nenhum participante nesta rodada.", 3);
  }

  function renderSubmissions() {
    var rows = state.submissions;
    if ($("#only-latest").checked) {
      var seen = {};
      rows = rows.filter(function (s) {
        if (seen[s.participant_id]) return false;
        seen[s.participant_id] = true;
        return true;
      });
    }
    fillTable($("#submissions-table"), rows.map(function (s) {
      return el("tr", { className: state.current && state.current.id === s.id ? "selected" : "" }, [
        el("td", { text: fmtTime(s.submitted_at) }),
        el("td", { text: s.submitted_name }),
        el("td", { text: participantName(s.participant_id) }),
        el("td", { text: fmtBytes(s.code_bytes) }),
        el("td", { className: "actions" }, [
          el("button", { type: "button", text: "Ver código", onclick: function () { openSubmission(s); } }),
        ]),
      ]);
    }), "Nenhum envio ainda.", 5);
  }
  $("#only-latest").addEventListener("change", renderSubmissions);

  $("#participant-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var f = e.currentTarget;
    var name = field(f, "name").value.trim();
    if (!name) return;
    var res = await db.rpc("admin_create_participant", { p_round: state.roundId, p_name: name });
    if (res.error) return say(errText(res.error), "error");
    f.reset();
    $("#new-token").hidden = false;
    $("#new-token .token-name").textContent = name;
    $("#new-token .token-value").textContent = res.data;
    say("Token gerado. Ele não será exibido novamente.", "success");
    await loadRound();
  });

  $("#copy-token").addEventListener("click", function () {
    var value = $("#new-token .token-value").textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(value).then(function () { say("Token copiado.", "success"); });
  });

  async function removeParticipant(p) {
    if (!window.confirm("Remover " + p.display_name + "? Os envios dessa pessoa também serão apagados.")) return;
    var res = await db.from("participants").delete().eq("id", p.id);
    if (res.error) return say(errText(res.error), "error");
    say("Participante removido.", "success");
    await loadRound();
  }

  // ------------------------------------------------------- visualização
  async function openSubmission(s) {
    var res = await db.from("submissions").select("id, round_id, submitted_name, code, submitted_at")
      .eq("id", s.id).single();
    if (res.error) return say(errText(res.error), "error");
    state.current = res.data;
    $("#viewer").hidden = false;
    $("#viewer-title").textContent = res.data.submitted_name + " · " + fmtTime(res.data.submitted_at);
    $("#code").textContent = res.data.code; // texto puro, nunca HTML
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

  // Faz os caminhos relativos (ex.: shopify-logo.svg) apontarem para os
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

  $("#download").addEventListener("click", function () {
    var s = state.current;
    if (!s) return;
    var safe = function (v) {
      return String(v).normalize("NFD").replace(/[̀-ͯ]/g, "")
        .replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "envio";
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

  db.auth.onAuthStateChange(function (event) {
    if (event === "SIGNED_OUT") { $("#app").hidden = true; }
  });

  refreshSession();
})();
