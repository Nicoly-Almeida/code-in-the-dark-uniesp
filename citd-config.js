// Configuração pública do site (editor e painel).
// Tudo aqui é PÚBLICO: vai para o GitHub Pages e qualquer pessoa pode ler.
// NUNCA coloque aqui a chave service_role / secret key nem senhas.
window.CITD_CONFIG = {
  // URL do projeto Supabase (Project Settings > API > Project URL).
  supabaseUrl: "https://chcmtotuohtoyybvljrd.supabase.co",
  // Chave pública "anon" ou "publishable" (Project Settings > API Keys).
  // É segura para o navegador porque o banco usa RLS.
  supabasePublishableKey: "sb_publishable_m7Ef4IRlm6w_qvty9bgumQ_fV3KFiGg",
  // Endpoint da Edge Function de envio.
  submitUrl: "https://chcmtotuohtoyybvljrd.supabase.co/functions/v1/submit",
};
