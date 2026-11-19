// Voto do público: o celular lê o QR code do telão, escolhe quem levou a
// rodada e pode trocar o voto enquanto a votação estiver aberta. Os nomes
// vêm de quem digitou no editor: entram na página só como texto.
(function () {
  "use strict";

  var POLL_MS = 3000;
  var POLL_OCULTA_MS = 15000; // aba em segundo plano: pergunta menos
  var ELEITOR_KEY = "citd_eleitor";

  var cfg = window.CITD_CONFIG || {};
  var titulo = document.getElementById("titulo");
  var mensagem = document.getElementById("mensagem");
  var lista = document.getElementById("candidatos");

  var data = null;      // votacao()
  var sending = null;   // máquina do voto em andamento
  var notice = null;    // { text, kind, until? } da última ação
  var drawn = "";
  var timer = null;

  function newId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, function () {
      return Math.floor(Math.random() * 16).toString(16);
    });
  }

  // Um identificador por celular. Sem armazenamento (aba anônima bloqueada),
  // vale só enquanto a página está aberta.
  var eleitor = (function () {
    try {
      var id = window.localStorage.getItem(ELEITOR_KEY) || "";
      if (!/^[0-9a-f-]{36}$/.test(id)) {
        id = newId();
        window.localStorage.setItem(ELEITOR_KEY, id);
      }
      return id;
    } catch (e) {
      return newId();
    }
  })();

  function rpc(name, args) {
    var key = cfg.supabasePublishableKey;
    return fetch(cfg.supabaseUrl + "/rest/v1/rpc/" + name, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(args || {}),
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!res.ok) throw new Error((body && body.message) || "HTTP " + res.status);
        return body;
      });
    });
  }

  var ERRORS = {
    CITD_VOTING_CLOSED: "A votação já fechou.",
    CITD_INVALID_VOTE: "Esse competidor não está mais na votação.",
    CITD_RATE_LIMIT: "Limite de votos da rodada atingido.",
  };

  function statusText() {
    if (!data) return { text: "Conectando...", kind: "" };
    var mine = data.meu_voto;
    if (data.status === "aberta") {
      if (!data.candidatos.length) return { text: "Nenhum competidor nesta rodada.", kind: "" };
      return mine
        ? { text: "Voto registrado! Você pode trocar até a votação fechar.", kind: "ok" }
        : { text: "Toque em quem mandou melhor nesta rodada.", kind: "" };
    }
    if (data.status === "encerrada") {
      return { text: "Votação encerrada." + (mine ? " Obrigado pelo voto!" : ""), kind: "" };
    }
    return { text: "A votação abre quando a rodada terminar. Deixe esta página aberta.", kind: "" };
  }

  function render() {
    titulo.textContent = data && data.title ? data.title : "Code in the Dark";
    var info = notice || statusText();
    mensagem.textContent = info.text;
    mensagem.className = "mensagem" + (info.kind ? " " + info.kind : "");

    var open = !!data && data.status === "aberta";
    var cands = data ? data.candidatos : [];
    var chosen = sending || (data && data.meu_voto);
    // Só redesenha quando algo muda, para não trocar o botão no meio do toque.
    var key = JSON.stringify([open, !!sending, chosen, cands.map(function (c) { return [c.device, c.nome]; })]);
    if (key === drawn) return;
    drawn = key;

    lista.replaceChildren();
    cands.forEach(function (c) {
      var button = document.createElement("button");
      button.type = "button";
      button.disabled = !open || !!sending;
      button.setAttribute("aria-pressed", String(c.device === chosen));
      var num = document.createElement("span");
      num.className = "numero";
      num.textContent = String(c.tela);
      var name = document.createElement("span");
      name.className = "nome";
      name.textContent = c.nome;
      var mark = document.createElement("span");
      mark.className = "escolha";
      mark.textContent = "SEU VOTO";
      button.appendChild(num);
      button.appendChild(name);
      button.appendChild(mark);
      button.addEventListener("click", function () { vote(c.device); });
      var li = document.createElement("li");
      li.appendChild(button);
      lista.appendChild(li);
    });
  }

  function vote(device) {
    if (sending || !data || data.status !== "aberta") return;
    sending = device;
    notice = { text: "Registrando seu voto...", kind: "" };
    render();
    rpc("votar", { p_eleitor: eleitor, p_device: device }).then(function () {
      data.meu_voto = device;
      notice = null;
    }, function (err) {
      notice = { text: ERRORS[err.message] || "Sem conexão. Tente de novo.", kind: "erro", until: Date.now() + 5000 };
    }).then(function () {
      sending = null;
      render();
      poll();
    });
  }

  function poll() {
    clearTimeout(timer);
    rpc("votacao", { p_eleitor: eleitor }).then(function (d) {
      data = d;
      // Avisos somem na próxima resposta; o erro de um voto fica alguns segundos.
      if (!sending && !(notice && notice.until > Date.now())) notice = null;
    }, function () {
      if (!sending) notice = { text: "Sem conexão: tentando de novo...", kind: "erro" };
    }).then(function () {
      render();
      timer = setTimeout(poll, document.hidden ? POLL_OCULTA_MS : POLL_MS);
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) poll();
  });

  if (window.location.protocol === "file:" || !cfg.supabaseUrl || !cfg.supabasePublishableKey) {
    mensagem.textContent = "Abra pelo endereço publicado do site para votar.";
    return;
  }
  poll();
})();
