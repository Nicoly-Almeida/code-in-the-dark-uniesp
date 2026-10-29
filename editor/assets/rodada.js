// Rodada ao vivo no editor: acompanha o estado da rodada no Supabase, libera
// referência e instruções no play, mostra o tempo, entrega o código (botão
// "Entregar" e sozinho quando o tempo acaba) e trava o editor fora do tempo.
// Não altera o editor legado: usa o Ace já existente e o localStorage
// (content/name). Depende de ../citd-config.js.
(function () {
  "use strict";

  var POLL_MS = 2000;
  var GRACE_MS = 60000; // a entrega é aceita até 60 s depois do fim
  var RUN_KEY = "citd_run";
  var DEVICE_KEY = "citd_device";

  var cfg = window.CITD_CONFIG || {};
  var button = document.querySelector(".deliver-button");
  var reference = document.querySelector(".reference-screenshot-container");
  var referenceImage = document.querySelector(".reference-screenshot");
  var instructions = document.querySelector(".instructions");
  if (!button) return;

  // A referência padrão do editor não vale para nenhuma rodada.
  if (reference) reference.style.display = "none";
  if (referenceImage) referenceImage.style.backgroundImage = "none";

  var style = document.createElement("style");
  style.textContent = [
    // A etiqueta de nome (z-index 40) pode cobrir os botões com nomes longos.
    // Depois do Finish, volta ao z-index original para não cobrir a prévia.
    "body:not(.citd-finished) .button-bar{z-index:41}",
    ".deliver-button{float:right;margin-left:10px;background-color:#E94D35}",
    ".deliver-button[disabled]{opacity:.5;cursor:not-allowed}",
    ".deliver-button.is-success{background-color:#3A9364}",
    ".citd-bar{position:absolute;z-index:60;top:12px;left:50%;transform:translateX(-50%);max-width:calc(100% - 40px);",
    "box-sizing:border-box;padding:8px 16px;background:rgba(0,0,0,.8);border:2px solid #444;color:#fff;",
    "font-size:12px;line-height:1.6;text-align:center;pointer-events:none;white-space:nowrap}",
    ".citd-bar .clock{font-size:22px;font-weight:700;margin:0 12px;font-variant-numeric:tabular-nums}",
    ".citd-bar.urgent{border-color:#E94D35}.citd-bar.urgent .clock{color:#FF8A7A}",
    ".citd-bar .msg{display:block;white-space:normal;color:#ccc}",
    ".citd-bar .msg.error{color:#FF8A7A}.citd-bar .msg.success{color:#4EFFA1}",
    "body.citd-finished .citd-bar,body.citd-finished .citd-lock{display:none}",
    // Depois do Finish a barra some; o aviso da entrega aparece por cima do resultado.
    ".citd-toast{position:absolute;z-index:70;top:12px;left:50%;transform:translateX(-50%);max-width:calc(100% - 40px);",
    "box-sizing:border-box;padding:8px 16px;background:rgba(0,0,0,.85);color:#4EFFA1;font-size:12px;line-height:1.6;",
    "text-align:center;pointer-events:none}",
    ".citd-toast.error{color:#FF8A7A}.citd-toast[hidden]{display:none}",
    // Confirmação do Finish (substitui o prompt em inglês do editor original).
    ".citd-modal{position:absolute;z-index:120;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.75)}",
    ".citd-modal[hidden]{display:none}",
    ".citd-modal form{width:480px;max-width:calc(100% - 40px);box-sizing:border-box;padding:20px;background:#111;",
    "border:2px solid #E94D35;color:#fff;font-size:12px;line-height:1.7}",
    ".citd-modal h2{font-size:14px;margin:0 0 12px}.citd-modal p{margin:0 0 12px;color:#ccc}",
    ".citd-modal input{width:100%;box-sizing:border-box;margin-top:6px;padding:8px;font:16px monospace;background:#000;color:#fff;border:1px solid #555}",
    ".citd-modal input:focus{outline:2px solid #4EFFA1}",
    ".citd-modal .actions{margin-top:14px;text-align:right}.citd-modal .actions button{margin-left:8px}",
    ".citd-modal .cancel{background:#444}.citd-modal .confirm{background:#E94D35}",
    ".citd-modal .confirm[disabled]{opacity:.35;cursor:not-allowed}",
    ".citd-lock{position:absolute;z-index:30;inset:0;display:flex;align-items:center;justify-content:center;",
    "background:rgba(0,0,0,.6);color:#fff;font-size:20px;text-align:center;padding:40px;box-sizing:border-box}",
    ".citd-lock[hidden]{display:none}",
  ].join("");
  document.head.appendChild(style);

  var bar = document.createElement("div");
  bar.className = "citd-bar";
  bar.setAttribute("role", "status");
  bar.innerHTML = '<span class="title"></span><span class="clock"></span><span class="msg" aria-live="polite"></span>';
  document.body.appendChild(bar);
  var barTitle = bar.querySelector(".title");
  var barClock = bar.querySelector(".clock");
  var barMsg = bar.querySelector(".msg");

  var lock = document.createElement("div");
  lock.className = "citd-lock";
  document.body.appendChild(lock);

  var toast = document.createElement("div");
  toast.className = "citd-toast";
  toast.setAttribute("role", "status");
  toast.hidden = true;
  document.body.appendChild(toast);
  var toastTimer = null;

  var CONFIRM_WORD = "sim";
  var modal = document.createElement("div");
  modal.className = "citd-modal";
  modal.hidden = true;
  modal.innerHTML =
    '<form novalidate role="dialog" aria-modal="true" aria-labelledby="citd-finish-title">' +
    '<h2 id="citd-finish-title">Finalizar e mostrar o resultado?</h2>' +
    '<p class="warning"></p>' +
    '<label for="citd-finish-input">Digite "<strong>' + CONFIRM_WORD + '</strong>" para confirmar:</label>' +
    '<input id="citd-finish-input" autocomplete="off" autocapitalize="off" spellcheck="false">' +
    '<div class="actions"><button type="button" class="cancel">Cancelar</button>' +
    '<button type="submit" class="confirm" disabled>Confirmar</button></div></form>';
  document.body.appendChild(modal);
  var modalForm = modal.querySelector("form");
  var modalWarning = modal.querySelector(".warning");
  var modalInput = modal.querySelector("input");
  var modalConfirm = modal.querySelector(".confirm");

  var state = null;       // último estado lido do servidor
  var offsetMs = 0;       // relógio do servidor - relógio local
  var loadedRun = null;   // rodada cujos materiais estão na tela
  var loadingRun = null;
  var sending = false;
  var finalRun = null;    // rodada com a entrega final (Finish ou fim do tempo) em andamento

  function read(key) {
    try { return window.localStorage.getItem(key) || ""; } catch (e) { return ""; }
  }
  function write(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* ignora */ }
  }

  function deviceId() {
    var id = read(DEVICE_KEY);
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      id = window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID()
        : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, function () {
          return Math.floor(Math.random() * 16).toString(16);
        });
      write(DEVICE_KEY, id);
    }
    return id;
  }

  // Só usa o Ace que o editor legado já criou (este script roda antes dele).
  function getAce() {
    var el = document.getElementById("editor");
    return el && el.env && el.env.editor ? el.env.editor : null;
  }

  function currentCode() {
    var ace = getAce();
    return ace ? ace.getValue() : read("content");
  }

  function finished() { return document.body.classList.contains("citd-finished"); }

  function setMessage(text, kind) {
    barMsg.textContent = text || "";
    barMsg.className = "msg" + (kind ? " " + kind : "");
    // Com o resultado na tela a barra fica escondida: avisa por cima dele.
    clearTimeout(toastTimer);
    toast.hidden = !text || !finished();
    toast.textContent = text || "";
    toast.className = "citd-toast" + (kind === "error" ? " error" : "");
    if (kind === "success") toastTimer = setTimeout(function () { toast.hidden = true; }, 6000);
  }

  // Depois do Finish o editor fica travado até a próxima rodada.
  function setLocked(text) {
    var ace = getAce();
    if (ace) ace.setReadOnly(!!text || finished());
    lock.textContent = text || "";
    lock.hidden = !text;
  }

  function runId(s) { return s ? s.round + "@" + s.started_at : ""; }
  function now() { return Date.now() + offsetMs; }
  function fmtTime(date) { return date.toLocaleTimeString("pt-BR"); }

  // "valendo" cujo fim já passou no relógio do servidor conta como encerrada.
  function effectiveStatus() {
    if (!state) return null;
    if (state.status === "valendo" && now() >= Date.parse(state.ends_at)) return "encerrada";
    return state.status;
  }

  function remainingMs() {
    var status = effectiveStatus();
    if (status === "valendo") return Math.max(0, Date.parse(state.ends_at) - now());
    if (status === "pausada") return state.remaining_seconds * 1000;
    if (status === "pronta") return state.duration_seconds * 1000;
    return 0;
  }

  function withinGrace() {
    return state && state.ends_at && now() <= Date.parse(state.ends_at) + GRACE_MS;
  }

  function rpc(name, args) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, 15000);
    var key = cfg.supabasePublishableKey;
    return fetch(cfg.supabaseUrl + "/rest/v1/rpc/" + name, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(args || {}),
      signal: controller ? controller.signal : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!res.ok) throw new Error((body && body.message) || "HTTP " + res.status);
        return body;
      });
    }).then(function (body) {
      clearTimeout(timer);
      return body;
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  var ERRORS = {
    CITD_ROUND_CLOSED: "A rodada já foi encerrada. Não é mais possível entregar.",
    CITD_INVALID_NAME: "Nome inválido. Clique no seu nome (canto inferior esquerdo) para corrigir.",
    CITD_EMPTY_CODE: "O editor está vazio: nada para entregar.",
    CITD_CODE_TOO_LARGE: "O código é grande demais para entregar.",
    CITD_RATE_LIMIT: "Limite de entregas atingido para esta máquina.",
    CITD_UNKNOWN_ROUND: "Rodada não encontrada.",
  };
  function errorText(err) {
    if (err && ERRORS[err.message]) return ERRORS[err.message];
    if (err && err.name === "AbortError") return "O servidor demorou demais. Seu código continua salvo aqui; tente de novo.";
    return "Sem conexão com o servidor. Seu código continua salvo aqui; tente de novo.";
  }

  // ------------------------------------------------------------- entrega
  function deliver(isAuto) {
    if (sending || !state) return Promise.resolve(false);
    var name = (read("name") || "").trim();
    if (!name && !isAuto) {
      name = (window.prompt("Seu nome ou equipe:") || "").trim();
      if (name) {
        write("name", name);
        var tag = document.querySelector(".name-tag");
        if (tag) tag.textContent = name;
      }
    }
    // Na entrega automática, sem nome ainda é melhor entregar do que perder o código.
    if (!name && isAuto) name = "Sem nome " + deviceId().slice(0, 4);
    if (!name) {
      setMessage("Informe seu nome: clique na etiqueta de nome no canto inferior esquerdo.", "error");
      return Promise.resolve(false);
    }
    var code = currentCode();
    if (!code.trim()) {
      setMessage(ERRORS.CITD_EMPTY_CODE, "error");
      return Promise.resolve(false);
    }

    sending = true;
    button.disabled = true;
    button.textContent = "Entregando...";
    setMessage(isAuto && effectiveStatus() === "encerrada" ? "Tempo esgotado: entregando seu código..." : "Entregando...", "");
    return rpc("entregar", { p_round: state.round, p_device: deviceId(), p_name: name, p_code: code })
      .then(function (at) {
        var time = fmtTime(new Date(at));
        button.classList.add("is-success");
        button.textContent = "Entregue " + time;
        setMessage("Entregue às " + time + "." + (finished() ? ""
          : effectiveStatus() === "encerrada" ? " Agora clique em Finish para ver seu resultado."
          : " Pode entregar de novo até o fim; vale a última entrega."), "success");
        return true;
      }, function (err) {
        button.classList.remove("is-success");
        button.textContent = "Entregar";
        setMessage(errorText(err), "error");
        return false;
      })
      .then(function (ok) {
        sending = false;
        render();
        return ok;
      });
  }

  function canDeliverNow() {
    var status = effectiveStatus();
    var run = runId(state);
    return !!run && read(RUN_KEY) === run && (status === "valendo" || status === "pausada" ||
      (status === "encerrada" && withinGrace()));
  }

  // Entrega final, uma vez por rodada: no Finish ou quando o tempo acaba (o
  // que vier primeiro), com novas tentativas enquanto o servidor aceitar.
  function finalDeliver() {
    var run = runId(state);
    if (!run || finalRun === run || read("citd_auto_" + run) || read(RUN_KEY) !== run) return;
    finalRun = run;
    var attempt = function () {
      if (runId(state) !== run) return;
      if (!currentCode().trim()) {
        write("citd_auto_" + run, "1");
        setMessage("O editor estava vazio: nada foi entregue.", "");
        return;
      }
      deliver(true).then(function (ok) {
        if (ok || !canDeliverNow()) write("citd_auto_" + run, "1");
        else setTimeout(attempt, 3000);
      });
    };
    attempt();
  }

  // ------------------------------------------------------------ rodada
  function startRunOnThisMachine(run) {
    var previous = read(RUN_KEY);
    if (previous === run) return;
    var ace = getAce();
    var content = ace ? ace.getValue() : read("content");
    if (previous && content.trim()) write("citd_backup_" + previous, content);
    if (ace) ace.setValue("", -1);
    write("content", "");
    write(RUN_KEY, run);

    // Se o Finish da rodada anterior estava na tela, volta para o editor.
    var result = document.querySelector(".result");
    if (result) result.style.display = "none";
    document.body.classList.remove("citd-finished");
    button.classList.remove("is-success");
    button.textContent = "Entregar";
    setMessage("", "");
  }

  function loadMaterials() {
    var run = runId(state);
    if (!state || loadedRun === run || loadingRun === run) return;
    loadingRun = run;
    rpc("materiais_rodada", { p_round: state.round }).then(function (m) {
      if (runId(state) !== run) return;
      loadedRun = run;
      if (referenceImage) referenceImage.style.backgroundImage = 'url("' + m.reference_image + '")';
      if (reference && !document.body.classList.contains("citd-finished")) reference.style.display = "";
      if (instructions) {
        // Conteúdo vindo do banco: sem scripts nem acesso ao editor.
        instructions.setAttribute("sandbox", "");
        instructions.srcdoc = m.instructions_html;
      }
    }, function () {
      setMessage("Não foi possível carregar a referência. Tentando de novo...", "error");
    }).then(function () {
      if (loadingRun === run) loadingRun = null;
    });
  }

  function render() {
    var status = effectiveStatus();
    var run = runId(state);
    var mine = run && read(RUN_KEY) === run;

    barTitle.textContent = state ? state.title : "Code in the Dark";
    var ms = remainingMs();
    var secs = Math.ceil(ms / 1000);
    barClock.textContent = state
      ? String(Math.floor(secs / 60)).padStart(2, "0") + ":" + String(secs % 60).padStart(2, "0")
      : "";
    bar.classList.toggle("urgent", status === "valendo" && ms <= 60000);

    if (!state || status === "pronta") {
      setLocked("Aguardando a rodada começar.");
    } else if (status === "valendo") {
      setLocked("");
    } else if (status === "pausada") {
      setLocked("Rodada pausada. Aguarde.");
    } else if (mine) {
      setLocked("Tempo esgotado! Clique em Finish para ver o resultado.");
    } else {
      setLocked("Rodada encerrada. Aguarde a próxima.");
    }

    if (!sending) button.disabled = !canDeliverNow();
  }

  // Sem rodada ou rodada reiniciada ("pronta"): volta para a tela de espera.
  function hideMaterials() {
    loadedRun = null;
    if (reference) reference.style.display = "none";
    if (instructions && instructions.hasAttribute("srcdoc")) instructions.removeAttribute("srcdoc");
  }

  function apply(next) {
    state = next;
    var status = state && state.status;
    if (status === "valendo" || status === "pausada") startRunOnThisMachine(runId(state));
    if (state && status !== "pronta") loadMaterials();
    else hideMaterials();
    render();
    if (effectiveStatus() === "encerrada") finalDeliver();
  }

  function poll() {
    var sentAt = Date.now();
    rpc("estado_atual").then(function (s) {
      var receivedAt = Date.now();
      if (s && s.server_now) offsetMs = Date.parse(s.server_now) - (sentAt + receivedAt) / 2;
      apply(s);
      if (/conexão|demorou/.test(barMsg.textContent)) setMessage("", "");
    }, function () {
      setMessage("Sem conexão com o servidor. Continue programando; tentando de novo...", "error");
    }).then(function () {
      setTimeout(poll, POLL_MS);
    });
  }

  function configError() {
    if (window.location.protocol === "file:") {
      return "Abra o editor pelo endereço publicado do site. Arquivos abertos do computador (file://) não acompanham a rodada.";
    }
    if (!cfg.supabaseUrl || !cfg.supabasePublishableKey) return "Configuração do Supabase ausente (citd-config.js).";
    return "";
  }

  // ------------------------------------------------------------- Finish
  // O clique é interceptado antes do editor original, que pediria "yes" num
  // prompt em inglês. Aqui o Confirmar só libera com a palavra certa.
  function openFinish() {
    var status = effectiveStatus();
    modalWarning.textContent = !canDeliverNow()
      ? "O resultado do seu código aparece na tela e o editor trava."
      : status === "valendo" || status === "pausada"
        ? "A rodada ainda está valendo. Ao finalizar, seu código é entregue, o editor trava e o resultado aparece na tela. Finalizar antes do fim pode desclassificar você."
        : "Seu código é entregue (se ainda não foi), o editor trava e o resultado aparece na tela.";
    modalInput.value = "";
    modalConfirm.disabled = true;
    modal.hidden = false;
    modalInput.focus();
  }

  function closeFinish() {
    modal.hidden = true;
    var ace = getAce();
    if (ace && !finished()) ace.focus();
  }

  // O mesmo que o Finish original fazia, mais a entrega e a trava do editor.
  function showResult() {
    // .result vem depois deste script no HTML: só existe no DOM depois.
    var result = document.querySelector(".result");
    if (!result) return;
    result.contentWindow.postMessage(currentCode(), window.location.protocol === "file:" ? "*" : window.location.origin);
    result.style.display = "block";
    if (reference) reference.style.display = "none";
    document.body.classList.add("citd-finished");
    render(); // trava o editor
    // Quem termina antes do tempo não depende do botão Entregar.
    if (canDeliverNow()) finalDeliver();
  }

  document.addEventListener("click", function (e) {
    if (!e.target.closest || !e.target.closest(".finish-button")) return;
    e.stopPropagation(); // o handler original (prompt "yes") não roda
    e.preventDefault();
    openFinish();
  }, true);
  modalInput.addEventListener("input", function () {
    modalConfirm.disabled = modalInput.value.trim().toLowerCase() !== CONFIRM_WORD;
  });
  modalForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (modalConfirm.disabled) return;
    closeFinish();
    showResult();
  });
  modal.querySelector(".cancel").addEventListener("click", closeFinish);
  modal.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeFinish();
  });

  button.addEventListener("click", function () { deliver(false); });
  button.disabled = true;

  var problem = configError();
  if (problem) {
    setLocked("");
    barTitle.textContent = "Code in the Dark";
    setMessage(problem, "error");
    return;
  }
  setLocked("Conectando...");
  setInterval(function () {
    var before = effectiveStatus();
    render();
    if (before === "encerrada" && state) finalDeliver();
  }, 250);
  poll();
})();
