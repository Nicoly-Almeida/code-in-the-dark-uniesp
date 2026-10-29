// Lógica da Edge Function `submit`, sem dependências do Supabase para
// poder ser testada isoladamente (ver supabase/functions/tests/).

export type SubmitErrorCode =
  | "CITD_INVALID_TOKEN"
  | "CITD_ROUND_CLOSED"
  | "CITD_CODE_TOO_LARGE"
  | "CITD_RATE_LIMIT";

export interface SubmitEntryArgs {
  p_round: string;
  p_token_hash: string;
  p_name: string;
  p_code: string;
}

export type SubmitEntryResult =
  | { ok: true; submissionId: string; submittedAt: string }
  | { ok: false; errorCode: SubmitErrorCode | "UNKNOWN"; detail?: unknown };

export interface SubmitDeps {
  /** Origens exatas aceitas, ex.: ["https://usuario.github.io"]. */
  allowedOrigins: string[];
  /** Teto global do código em bytes (cada rodada pode ter limite menor). */
  maxCodeBytes: number;
  submitEntry: (args: SubmitEntryArgs) => Promise<SubmitEntryResult>;
  log?: (message: string, detail?: unknown) => void;
}

const ROUND_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
// Caracteres de controle não são aceitos no nome (inclui quebras de linha).
// deno-lint-ignore no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const NAME_MAX = 80;

const MESSAGES: Record<string, string> = {
  forbidden_origin: "Origem não autorizada.",
  method_not_allowed: "Método não permitido.",
  unsupported_media_type: "Envie JSON (Content-Type: application/json).",
  payload_too_large: "O envio é grande demais.",
  invalid_json: "Corpo da requisição inválido.",
  invalid_name: "Informe um nome ou equipe com 1 a 80 caracteres.",
  invalid_round: "Identificador da rodada inválido.",
  invalid_credentials: "Token de participação ou rodada inválidos.",
  empty_code: "O código está vazio.",
  invalid_code: "O código contém caracteres inválidos.",
  code_too_large: "O código passou do tamanho máximo permitido.",
  round_closed: "A rodada está encerrada. Não é mais possível enviar.",
  rate_limited: "Limite de envios atingido para este participante.",
  internal_error: "Não foi possível salvar agora. Tente novamente.",
};

export function parseAllowedOrigins(raw: string | undefined | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter((o) => /^https?:\/\/[^/\s]+$/i.test(o));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}

function json(status: number, body: Record<string, unknown>, cors: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function fail(status: number, error: string, cors: Record<string, string>) {
  return json(status, { ok: false, error, message: MESSAGES[error] ?? error }, cors);
}

const encoder = new TextEncoder();

export function createSubmitHandler(deps: SubmitDeps) {
  const allowed = new Set(deps.allowedOrigins);
  // JSON pode escapar caracteres (\n, \", \\), então o corpo pode passar do
  // tamanho do código; damos folga e conferimos o código em bytes depois.
  const maxBodyBytes = deps.maxCodeBytes * 2 + 8192;
  const log = deps.log ?? ((m: string, d?: unknown) => console.error(m, d ?? ""));

  return async function handle(req: Request): Promise<Response> {
    const origin = req.headers.get("origin") ?? "";
    const originOk = origin !== "" && allowed.has(origin);
    const cors = originOk ? corsHeaders(origin) : {};

    if (req.method === "OPTIONS") {
      return originOk
        ? new Response(null, { status: 204, headers: cors })
        : new Response(null, { status: 403, headers: { "Vary": "Origin" } });
    }
    if (!originOk) return fail(403, "forbidden_origin", {});
    if (req.method !== "POST") return fail(405, "method_not_allowed", cors);

    const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      return fail(415, "unsupported_media_type", cors);
    }

    const declaredLength = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      return fail(413, "payload_too_large", cors);
    }

    let raw: string;
    try {
      raw = await req.text();
    } catch {
      return fail(400, "invalid_json", cors);
    }
    if (encoder.encode(raw).byteLength > maxBodyBytes) {
      return fail(413, "payload_too_large", cors);
    }

    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      return fail(400, "invalid_json", cors);
    }

    const name = typeof body.name === "string" ? body.name.normalize("NFC").trim() : "";
    const nameLength = Array.from(name).length;
    if (nameLength < 1 || nameLength > NAME_MAX || CONTROL_RE.test(name)) {
      return fail(422, "invalid_name", cors);
    }

    const round = typeof body.round === "string" ? body.round.trim().toLowerCase() : "";
    if (!ROUND_RE.test(round)) return fail(422, "invalid_round", cors);

    const token = typeof body.token === "string" ? body.token.trim() : "";
    // Formato inválido recebe a mesma resposta que token desconhecido.
    if (!TOKEN_RE.test(token)) return fail(401, "invalid_credentials", cors);

    const code = body.code;
    if (typeof code !== "string") return fail(422, "invalid_code", cors);
    if (code.trim() === "") return fail(422, "empty_code", cors);
    if (code.includes("\u0000")) return fail(422, "invalid_code", cors);
    if (encoder.encode(code).byteLength > deps.maxCodeBytes) {
      return fail(413, "code_too_large", cors);
    }

    let result: SubmitEntryResult;
    try {
      result = await deps.submitEntry({
        p_round: round,
        p_token_hash: await sha256Hex(token),
        p_name: name,
        p_code: code,
      });
    } catch (error) {
      log("submit_entry lançou exceção", error);
      return fail(500, "internal_error", cors);
    }

    if (result.ok) {
      return json(201, { ok: true, id: result.submissionId, submittedAt: result.submittedAt }, cors);
    }

    switch (result.errorCode) {
      case "CITD_INVALID_TOKEN":
        return fail(401, "invalid_credentials", cors);
      case "CITD_ROUND_CLOSED":
        return fail(409, "round_closed", cors);
      case "CITD_CODE_TOO_LARGE":
        return fail(413, "code_too_large", cors);
      case "CITD_RATE_LIMIT":
        return fail(429, "rate_limited", cors);
      default:
        log("submit_entry falhou", result.detail);
        return fail(500, "internal_error", cors);
    }
  };
}
