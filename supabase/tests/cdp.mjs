// Chrome headless via DevTools Protocol, sem dependências.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export async function launch(chromePath) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "citd-e2e-"));
  const proc = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--window-size=1440,900", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    proc.stderr.on("data", (d) => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) resolve(m[1]); });
    setTimeout(() => reject(new Error("Chrome não iniciou")), 15000);
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const pending = new Map();
  const handlers = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else handlers.forEach((h) => h(msg));
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, (msg) => msg.error ? reject(new Error(method + ": " + msg.error.message)) : resolve(msg.result));
    ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });

  async function page(url, { isolated = false, dialog = () => ({ accept: true }) } = {}) {
    let browserContextId;
    if (isolated) ({ browserContextId } = await send("Target.createBrowserContext"));
    const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const dialogs = [];
    const errors = [];
    handlers.push((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === "Page.javascriptDialogOpening") {
        dialogs.push(msg.params.message);
        const answer = dialog(msg.params);
        send("Page.handleJavaScriptDialog", answer, sessionId);
      }
      if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") errors.push(msg.params.entry.text + " " + (msg.params.entry.url || ""));
    });
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Log.enable", {}, sessionId);
    await send("Page.navigate", { url }, sessionId);
    const p = {
      dialogs, errors, sessionId,
      send: (m, params) => send(m, params, sessionId),
      async eval(expr) {
        const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
        if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
        return r.result.value;
      },
      async waitFor(expr, what, timeout = 8000) {
        const end = Date.now() + timeout;
        let last;
        while (Date.now() < end) {
          try { last = await p.eval(expr); if (last) return last; } catch (e) { last = e.message; }
          await new Promise((r) => setTimeout(r, 150));
        }
        throw new Error(`timeout esperando: ${what} (último valor: ${JSON.stringify(last)})`);
      },
      async objectId(selector) {
        const r = await send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})` }, sessionId);
        return r.result.objectId;
      },
    };
    return p;
  }

  const pages = [];
  async function trackedPage(url, opts = {}) {
    const p = await page(url, opts);
    p.label = url.replace(/^https?:\/\/[^/]+/, "") + (opts.label ? " " + opts.label : "");
    pages.push(p);
    return p;
  }
  return { page: trackedPage, pages, close() { ws.close(); proc.kill(); } };
}
