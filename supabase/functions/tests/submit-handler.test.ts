// Testes da lógica da Edge Function `submit` (sem rede, sem Supabase).
// Rode com: deno test supabase/functions/tests/

import { deepStrictEqual as assertEquals } from "node:assert";
import {
  createSubmitHandler,
  parseAllowedOrigins,
  sha256Hex,
  type SubmitEntryArgs,
  type SubmitEntryResult,
} from "../submit/handler.ts";

const ORIGIN = "https://site-de-teste.example";
const TOKEN = "token-ficticio-alfa-0000000001";

function setup(result: SubmitEntryResult = { ok: true, submissionId: "id-1", submittedAt: "2026-01-01T00:00:00Z" }) {
  const calls: SubmitEntryArgs[] = [];
  const handle = createSubmitHandler({
    allowedOrigins: [ORIGIN],
    maxCodeBytes: 1000,
    submitEntry: (args) => {
      calls.push(args);
      return Promise.resolve(result);
    },
    log: () => {},
  });
  return { handle, calls };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/submit", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const valid = { name: "Equipe Fictícia Alfa", round: "teste", token: TOKEN, code: "<h1>oi</h1>" };

Deno.test("parseAllowedOrigins aceita só origens completas", () => {
  assertEquals(parseAllowedOrigins(" https://a.example/ , foo, http://localhost:5500,"), [
    "https://a.example",
    "http://localhost:5500",
  ]);
  assertEquals(parseAllowedOrigins(undefined), []);
});

Deno.test("preflight da origem permitida", async () => {
  const { handle } = setup();
  const res = await handle(new Request("http://x", { method: "OPTIONS", headers: { origin: ORIGIN } }));
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-origin"), ORIGIN);
});

Deno.test("preflight e POST de outra origem são recusados sem CORS", async () => {
  const { handle, calls } = setup();
  const pre = await handle(new Request("http://x", { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
  assertEquals(pre.status, 403);
  assertEquals(pre.headers.get("access-control-allow-origin"), null);
  const res = await handle(post(valid, { origin: "https://evil.example" }));
  assertEquals(res.status, 403);
  assertEquals(res.headers.get("access-control-allow-origin"), null);
  const noOrigin = await handle(new Request("http://x", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(valid),
  }));
  assertEquals(noOrigin.status, 403);
  const fileOrigin = await handle(post(valid, { origin: "null" }));
  assertEquals(fileOrigin.status, 403);
  assertEquals(calls.length, 0);
});

Deno.test("envio válido chama a RPC com hash do token", async () => {
  const { handle, calls } = setup();
  const res = await handle(post({ ...valid, round: " Teste ", name: "  Equipe Fictícia Alfa " }));
  assertEquals(res.status, 201);
  assertEquals(res.headers.get("access-control-allow-origin"), ORIGIN);
  assertEquals((await res.json()).ok, true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].p_round, "teste");
  assertEquals(calls[0].p_name, "Equipe Fictícia Alfa");
  assertEquals(calls[0].p_token_hash, await sha256Hex(TOKEN));
  assertEquals(calls[0].p_code, "<h1>oi</h1>");
});

Deno.test("validações de entrada", async () => {
  const cases: [unknown, number, string][] = [
    ["{nao-json", 400, "invalid_json"],
    [[1, 2], 400, "invalid_json"],
    [{ ...valid, name: "" }, 422, "invalid_name"],
    [{ ...valid, name: "a".repeat(81) }, 422, "invalid_name"],
    [{ ...valid, name: "linha\nquebrada" }, 422, "invalid_name"],
    [{ ...valid, round: "../x" }, 422, "invalid_round"],
    [{ ...valid, round: "" }, 422, "invalid_round"],
    [{ ...valid, token: "curto" }, 401, "invalid_credentials"],
    [{ ...valid, token: 'x" or 1=1 --aaaaaaaaaaaa' }, 401, "invalid_credentials"],
    [{ ...valid, code: "   " }, 422, "empty_code"],
    [{ ...valid, code: 42 }, 422, "invalid_code"],
    [{ ...valid, code: "a\u0000b" }, 422, "invalid_code"],
    [{ ...valid, code: "é".repeat(501) }, 413, "code_too_large"], // 1002 bytes
  ];
  for (const [body, status, error] of cases) {
    const { handle, calls } = setup();
    const res = await handle(post(body));
    assertEquals([res.status, (await res.json()).error], [status, error], JSON.stringify(body).slice(0, 60));
    assertEquals(calls.length, 0);
  }
});

Deno.test("método, content-type e corpo grande", async () => {
  const { handle } = setup();
  assertEquals((await handle(new Request("http://x", { method: "GET", headers: { origin: ORIGIN } }))).status, 405);
  assertEquals((await handle(post(valid, { "content-type": "text/plain" }))).status, 415);
  assertEquals((await handle(post({ ...valid, code: "a".repeat(20000) }))).status, 413);
});

Deno.test("erros da RPC viram respostas claras", async () => {
  const map: [SubmitEntryResult, number, string][] = [
    [{ ok: false, errorCode: "CITD_INVALID_TOKEN" }, 401, "invalid_credentials"],
    [{ ok: false, errorCode: "CITD_ROUND_CLOSED" }, 409, "round_closed"],
    [{ ok: false, errorCode: "CITD_CODE_TOO_LARGE" }, 413, "code_too_large"],
    [{ ok: false, errorCode: "CITD_RATE_LIMIT" }, 429, "rate_limited"],
    [{ ok: false, errorCode: "UNKNOWN", detail: "boom" }, 500, "internal_error"],
  ];
  for (const [result, status, error] of map) {
    const { handle } = setup(result);
    const res = await handle(post(valid));
    const body = await res.json();
    assertEquals([res.status, body.error], [status, error]);
    assertEquals(JSON.stringify(body).includes("boom"), false);
  }
});
