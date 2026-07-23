// Reemplazá estos dos valores por los de TU proyecto de Supabase.
// Los encontrás en: Supabase > Settings > API > Project URL / anon public key.
// La "anon key" está pensada para ser pública: la seguridad real la dan
// las políticas de RLS definidas en supabase/migrations/0001_init.sql,
// no el secreto de esta clave. NUNCA pongas acá la "service_role key".
window.CONFIG = {
  SUPABASE_URL: 'https://TU-PROYECTO.supabase.co',
  SUPABASE_ANON_KEY: 'TU-ANON-KEY-PUBLICA'
};
