// Edge Function `submit` — recebe trabalhos do editor Code in the Dark.
//
// Variáveis de ambiente:
//   SUPABASE_URL e SUPABASE_SECRET_KEYS ou SUPABASE_SERVICE_ROLE_KEY
//                                             -> injetadas pelo Supabase
//   ALLOWED_ORIGINS                           -> secret definido por você
//   MAX_CODE_BYTES (opcional, padrão 200000)  -> teto global do código
//
// A chave de serviço só existe aqui, no servidor. Nunca a coloque no site.

import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import {
  createSubmitHandler,
  parseAllowedOrigins,
  type SubmitEntryResult,
  type SubmitErrorCode,
} from "./handler.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");

// Projetos novos expõem as chaves secretas (sb_secret_...) em
// SUPABASE_SECRET_KEYS (JSON); projetos com chaves legadas usam
// SUPABASE_SERVICE_ROLE_KEY. Ambas são injetadas pelo Supabase.
function resolveServerKey(): string | undefined {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, string>;
    const key = keys.default ?? Object.values(keys)[0];
    if (key) return key;
  } catch {
    // formato inesperado: tenta a chave legada
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? undefined;
}
const serviceRoleKey = resolveServerKey();
const allowedOrigins = parseAllowedOrigins(Deno.env.get("ALLOWED_ORIGINS"));
const maxCodeBytes = Number(Deno.env.get("MAX_CODE_BYTES") ?? "200000");

if (!supabaseUrl || !serviceRoleKey) {
  console.error("SUPABASE_URL ou chave secreta do servidor ausentes.");
}
if (allowedOrigins.length === 0) {
  console.error("ALLOWED_ORIGINS vazio: todas as origens serão recusadas.");
}

const admin = createClient(supabaseUrl ?? "", serviceRoleKey ?? "", {
  auth: { persistSession: false, autoRefreshToken: false },
});

const KNOWN_ERRORS: SubmitErrorCode[] = [
  "CITD_INVALID_TOKEN",
  "CITD_ROUND_CLOSED",
  "CITD_CODE_TOO_LARGE",
  "CITD_RATE_LIMIT",
];

const handler = createSubmitHandler({
  allowedOrigins,
  maxCodeBytes: Number.isFinite(maxCodeBytes) && maxCodeBytes > 0 ? maxCodeBytes : 200000,
  async submitEntry(args): Promise<SubmitEntryResult> {
    const { data, error } = await admin.rpc("submit_entry", args);
    if (error) {
      const code = KNOWN_ERRORS.find((c) => error.message === c);
      return code ? { ok: false, errorCode: code } : { ok: false, errorCode: "UNKNOWN", detail: error };
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.submission_id) return { ok: false, errorCode: "UNKNOWN", detail: data };
    return { ok: true, submissionId: row.submission_id, submittedAt: row.submitted_at };
  },
});

Deno.serve(handler);
