// Configuração pública do site (editor, telão e painel).
// Tudo aqui é PÚBLICO: vai para o GitHub Pages e qualquer pessoa pode ler.
// NUNCA coloque aqui a chave service_role / secret key nem senhas.
window.CITD_CONFIG = {
  // URL do projeto Supabase (Project Settings > API > Project URL).
  supabaseUrl: "https://chcmtotuohtoyybvljrd.supabase.co",
  // Chave pública "anon" ou "publishable" (Project Settings > API Keys).
  // É segura para o navegador porque o banco usa RLS e só libera as RPCs
  // estado_atual, materiais_rodada e entregar para visitantes.
  supabasePublishableKey: "sb_publishable_m7Ef4IRlm6w_qvty9bgumQ_fV3KFiGg",
};
