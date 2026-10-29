// "Enviar trabalho" — envia o código atual do editor para a Edge Function.
// Não altera o editor legado: lê o Ace já existente e o localStorage
// (content/name) sem apagar nada. Depende de ../citd-config.js.
(function () {
  "use strict";

  var ROUND_KEY = "citd_round";
  var TOKEN_KEY = "citd_token"; // sessionStorage: some ao fechar a aba
  var TIMEOUT_MS = 20000;

  var config = window.CITD_CONFIG || {};
  var button = document.querySelector(".submit-button");
  if (!button) return;

  var style = document.createElement("style");
  style.textContent = [
    // A etiqueta de nome (z-index 40) pode cobrir os botões com nomes longos.
    // Depois do Finish, volta ao z-index original para não cobrir a prévia.
    "body:not(.citd-finished) .button-bar{z-index:41}",
    ".submit-button{float:right;margin-left:10px;background-color:#E94D35}",
    ".submit-button[disabled]{opacity:.7;cursor:progress}",
    ".submit-button.is-success{background-color:#3A9364}",
    ".submit-panel{position:absolute;z-index:200;right:20px;bottom:70px;width:380px;max-width:calc(100% - 40px);",
    "box-sizing:border-box;padding:18px;background:#111;border:2px solid #E94D35;color:#fff;font-size:11px;line-height:1.6}",
    ".submit-panel[hidden]{display:none}",
    ".submit-panel h2{font-size:13px;margin:0 0 12px}",
    ".submit-panel label{display:block;margin:10px 0 4px}",
    ".submit-panel input{width:100%;box-sizing:border-box;padding:8px;font:14px monospace;background:#000;color:#fff;border:1px solid #555}",
    ".submit-panel input:focus{outline:2px solid #4EFFA1}",
    ".submit-panel .actions{margin-top:14px;text-align:right}",
    ".submit-panel .actions button{margin-left:8px}",
    ".submit-panel .cancel{background:#444}",
    ".submit-status{margin-top:12px;min-height:1.6em;word-wrap:break-word}",
    ".submit-status.error{color:#FF8A7A}.submit-status.success{color:#4EFFA1}",
  ].join("");
  document.head.appendChild(style);

  var panel = document.createElement("form");
  panel.className = "submit-panel";
  panel.hidden = true;
  panel.setAttribute("novalidate", "");
  panel.innerHTML =
    '<h2>Enviar trabalho</h2>' +
    '<label for="citd-name">Nome ou equipe</label>' +
    '<input id="citd-name" name="name" maxlength="80" autocomplete="off" required>' +
    '<label for="citd-round">Rodada</label>' +
    '<input id="citd-round" name="round" maxlength="40" autocomplete="off" required placeholder="ex.: rodada-1">' +
    '<label for="citd-token">Token de participação</label>' +
    '<input id="citd-token" name="token" type="password" maxlength="128" autocomplete="off" required>' +
    '<div class="submit-status" role="status" aria-live="polite"></div>' +
    '<div class="actions"><button type="button" class="cancel">Fechar</button>' +
    '<button type="submit" class="confirm">Enviar</button></div>';
  document.body.appendChild(panel);

  var nameInput = panel.querySelector("#citd-name");
  var roundInput = panel.querySelector("#citd-round");
  var tokenInput = panel.querySelector("#citd-token");
  var statusEl = panel.querySelector(".submit-status");
  var confirmBtn = panel.querySelector(".confirm");
  var defaultLabel = button.textContent;
  var sending = false;

  function store(kind) {
    try { return window[kind]; } catch (e) { return null; }
  }
  function read(kind, key) {
    try { var s = store(kind); return (s && s.getItem(key)) || ""; } catch (e) { return ""; }
  }
  function write(kind, key, value) {
    try { var s = store(kind); if (s) s.setItem(key, value); } catch (e) { /* ignora */ }
  }

  function getAce() {
    var el = document.getElementById("editor");
    if (el && el.env && el.env.editor) return el.env.editor;
    if (window.ace && typeof window.ace.edit === "function") return window.ace.edit("editor");
    return null;
  }

  function getCode() {
    var ace = getAce();
    if (ace) return ace.getValue();
    return read("localStorage", "content");
  }

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = "submit-status" + (kind ? " " + kind : "");
  }

  function setButton(state, label) {
    button.disabled = state === "loading";
    button.classList.toggle("is-success", state === "success");
    button.textContent = label || defaultLabel;
  }

  function roundFromUrl() {
    var m = /[?&]rodada=([a-z0-9-]{1,40})(?:&|$)/i.exec(window.location.search);
    return m ? m[1].toLowerCase() : "";
  }

  function openPanel() {
    nameInput.value = read("localStorage", "name");
    roundInput.value = roundFromUrl() || read("localStorage", ROUND_KEY);
    tokenInput.value = read("sessionStorage", TOKEN_KEY);
    if (!sending) setStatus("", "");
    panel.hidden = false;
    (nameInput.value ? (roundInput.value ? (tokenInput.value ? confirmBtn : tokenInput) : roundInput) : nameInput).focus();
  }

  function closePanel() {
    panel.hidden = true;
    var ace = getAce();
    if (ace) ace.focus();
  }

  function configError() {
    if (window.location.protocol === "file:") {
      return "Abra o editor pelo endereço publicado do site para enviar. Arquivos abertos do computador (file://) não podem enviar.";
    }
    // http só é aceito para testes locais (localhost).
    if (!config.submitUrl || !/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)/.test(config.submitUrl)) {
      return "Envio ainda não configurado pela organização.";
    }
    return "";
  }

  function submit(event) {
    if (event) event.preventDefault();
    if (sending) return;

    var name = nameInput.value.trim();
    var round = roundInput.value.trim().toLowerCase();
    var token = tokenInput.value.trim();
    var code = getCode();

    if (!name || name.length > 80) return setStatus("Informe seu nome ou equipe (até 80 caracteres).", "error");
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(round)) return setStatus("Informe a rodada indicada pela organização.", "error");
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return setStatus("Token inválido. Confira o token recebido.", "error");
    if (!code || !code.trim()) return setStatus("O editor está vazio.", "error");
    var problem = configError();
    if (problem) return setStatus(problem, "error");

    // Guarda identificação sem tocar no rascunho (localStorage.content).
    write("localStorage", "name", name);
    write("localStorage", ROUND_KEY, round);
    write("sessionStorage", TOKEN_KEY, token);
    var tag = document.querySelector(".name-tag");
    if (tag) tag.textContent = name;

    sending = true;
    confirmBtn.disabled = true;
    setButton("loading", "Enviando...");
    setStatus("Enviando seu trabalho...", "");

    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, TIMEOUT_MS);

    fetch(config.submitUrl, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, round: round, token: token, code: code }),
      signal: controller ? controller.signal : undefined,
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (res.ok && body && body.ok) {
            var when = body.submittedAt ? new Date(body.submittedAt) : new Date();
            var time = when.toLocaleTimeString("pt-BR");
            setButton("success", "Enviado " + time);
            setStatus("Trabalho enviado às " + time + ". Você pode reenviar enquanto a rodada estiver aberta; vale o último envio.", "success");
          } else {
            throw new Error((body && body.message) || "Não foi possível enviar (erro " + res.status + ").");
          }
        });
      })
      .catch(function (err) {
        var msg = err && err.name === "AbortError"
          ? "O envio demorou demais. Verifique a internet e tente de novo."
          : err && err.message && !/Failed to fetch|NetworkError|Load failed/i.test(err.message)
            ? err.message
            : "Sem conexão com o servidor. Verifique a internet e tente de novo.";
        setButton("error", "Tentar enviar de novo");
        setStatus(msg, "error");
        if (panel.hidden) openPanel();
      })
      .then(function () {
        clearTimeout(timer);
        sending = false;
        confirmBtn.disabled = false;
      });
  }

  var finish = document.querySelector(".finish-button");
  var result = document.querySelector(".result");
  if (finish && result) finish.addEventListener("click", function () {
    // O handler original (prompt síncrono) termina antes deste setTimeout.
    setTimeout(function () {
      if (result.style.display && result.style.display !== "none") {
        document.body.classList.add("citd-finished");
        closePanel();
      }
    }, 0);
  });

  button.addEventListener("click", function () {
    if (panel.hidden) openPanel(); else closePanel();
  });
  panel.addEventListener("submit", submit);
  panel.querySelector(".cancel").addEventListener("click", closePanel);
  panel.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closePanel();
  });
})();
