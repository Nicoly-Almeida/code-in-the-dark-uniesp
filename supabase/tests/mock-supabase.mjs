// Servidor local: arquivos do site + um "Supabase" mínimo (auth por senha,
// RPCs e GET/PATCH/DELETE simples do PostgREST) sobre o PGlite.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { as, ORG } from "./db.mjs";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const IDENT = /^[a-z_][a-z0-9_]*$/;

export async function startServer(repo, db) {
  const tokens = new Map();
  const log = [];
  let origin = "";

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(body === undefined ? "" : JSON.stringify(body));
  }
  function pgError(res, e, role) {
    const status = e.code === "42501" ? (role === "anon" ? 401 : 403) : e.code === "P0001" || e.code?.startsWith("22") || e.code?.startsWith("23") ? 400 : 500;
    send(res, status, { code: e.code, message: e.message, details: null, hint: null });
  }

  function filters(url) {
    const where = [];
    const params = [];
    for (const [k, v] of url.searchParams) {
      if (["select", "order", "columns"].includes(k)) continue;
      if (!IDENT.test(k) || !v.startsWith("eq.")) throw new Error("filtro não suportado: " + k + "=" + v);
      params.push(v.slice(3));
      where.push(`${k} = $${params.length}`);
    }
    return { where: where.length ? " where " + where.join(" and ") : "", params };
  }

  async function rest(req, res, url, body, user) {
    const role = user ? "authenticated" : "anon";
    const sub = user ? user.id : null;
    const rel = url.pathname.slice("/rest/v1/".length);
    try {
      if (rel.startsWith("rpc/")) {
        const fn = rel.slice(4);
        if (!IDENT.test(fn)) return send(res, 404, { message: "no fn" });
        const args = body ? JSON.parse(body) : {};
        const keys = Object.keys(args).filter((k) => IDENT.test(k));
        const call = `public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
        const info = await db.query(`select t.typtype, t.typname from pg_proc p join pg_type t on t.oid = p.prorettype
          where p.proname = $1 and p.pronamespace = 'public'::regnamespace`, [fn]);
        if (!info.rows.length) return send(res, 404, { code: "PGRST202", message: "function not found" });
        log.push({ fn, role, args: Object.fromEntries(keys.map((k) => [k, typeof args[k] === "string" && args[k].length > 60 ? args[k].slice(0, 60) + "…" : args[k]])) });
        const r = await as(db, role, sub, `select * from ${call}`, keys.map((k) => args[k]));
        if (info.rows[0].typname === "void") return send(res, 204);
        if (info.rows[0].typtype === "c") return send(res, 200, r.rows[0] ?? null);
        const row = r.rows[0];
        return send(res, 200, row ? row[Object.keys(row)[0]] : null);
      }
      const table = rel;
      if (!IDENT.test(table)) return send(res, 404, {});
      const f = filters(url);
      if (req.method === "GET") {
        const cols = (url.searchParams.get("select") || "*").split(",").map((c) => c.trim());
        if (!cols.every((c) => c === "*" || IDENT.test(c))) throw new Error("select não suportado");
        const order = (url.searchParams.get("order") || "").split(",").filter(Boolean).map((o) => {
          const [c, dir] = o.split(".");
          if (!IDENT.test(c)) throw new Error("order");
          return `${c} ${dir === "desc" ? "desc" : "asc"}`;
        });
        const r = await as(db, role, sub, `select ${cols.join(", ")} from public.${table}${f.where}${order.length ? " order by " + order.join(", ") : ""}`, f.params);
        log.push({ get: table, query: url.search, rows: r.rows.map((x) => [x.id, x.submitted_at, x.code_bytes]) });
        if ((req.headers.accept || "").includes("vnd.pgrst.object")) {
          if (r.rows.length !== 1) return send(res, 406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" });
          return send(res, 200, r.rows[0]);
        }
        return send(res, 200, r.rows);
      }
      if (req.method === "PATCH") {
        const data = JSON.parse(body);
        const keys = Object.keys(data).filter((k) => IDENT.test(k));
        const params = [...f.params, ...keys.map((k) => data[k])];
        const set = keys.map((k, i) => `${k} = $${f.params.length + i + 1}`).join(", ");
        await as(db, role, sub, `update public.${table} set ${set}${f.where}`, params);
        return send(res, 204);
      }
      if (req.method === "DELETE") {
        await as(db, role, sub, `delete from public.${table}${f.where}`, f.params);
        return send(res, 204);
      }
      return send(res, 405, {});
    } catch (e) {
      if (e.code) return pgError(res, e, role);
      return send(res, 500, { message: String(e.message) });
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      const auth = (req.headers.authorization || "").replace(/^Bearer /, "");
      const user = tokens.get(auth) || null;

      if (url.pathname === "/auth/v1/token") {
        const { email, password } = JSON.parse(body || "{}");
        if (email !== "org@example.com" || password !== "senha-forte") {
          return send(res, 400, { code: "invalid_credentials", error_code: "invalid_credentials", msg: "Invalid login credentials" });
        }
        const exp = Math.floor(Date.now() / 1000) + 3600;
        const access = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: ORG, role: "authenticated", exp, email })}.c2ln`;
        const u = { id: ORG, email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
        tokens.set(access, u);
        return send(res, 200, { access_token: access, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "r-" + exp, user: u });
      }
      if (url.pathname === "/auth/v1/logout") return send(res, 204);
      if (url.pathname === "/auth/v1/user") return user ? send(res, 200, user) : send(res, 401, { msg: "no" });
      if (url.pathname.startsWith("/rest/v1/")) return rest(req, res, url, body, user);

      // Arquivos do site
      let p = decodeURIComponent(url.pathname);
      if (p.endsWith("/")) p += "index.html";
      if (p === "/citd-config.js") {
        res.writeHead(200, { "Content-Type": TYPES[".js"] });
        return res.end(`window.CITD_CONFIG = { supabaseUrl: ${JSON.stringify(origin)}, supabasePublishableKey: "sb_publishable_teste" };`);
      }
      const file = path.join(repo, p);
      if (!file.startsWith(repo) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
      let data = fs.readFileSync(file);
      if (p === "/admin/index.html") {
        // A CSP real só libera *.supabase.co; aqui o "Supabase" é este servidor.
        data = Buffer.from(data.toString("utf8").replace("connect-src https://*.supabase.co", "connect-src 'self'"));
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, server, log };
}
