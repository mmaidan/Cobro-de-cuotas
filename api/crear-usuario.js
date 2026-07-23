// Función serverless (se ejecuta en Vercel, nunca en el navegador).
// Usa la SUPABASE_SERVICE_ROLE_KEY, que solo vive como variable de entorno
// en Vercel. Verifica que quien llama sea superusuario antes de crear nada.
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Faltan variables de entorno en el servidor' });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  // 1) Verificar que el token pertenece a un usuario real
  const { data: tokenData, error: tokenError } = await admin.auth.getUser(token);
  if (tokenError || !tokenData?.user) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  // 2) Verificar que ese usuario es superusuario
  const { data: perfil, error: perfilError } = await admin
    .from('profiles')
    .select('rol')
    .eq('id', tokenData.user.id)
    .single();

  if (perfilError || !perfil || perfil.rol !== 'super') {
    return res.status(403).json({ error: 'Solo el superusuario puede crear usuarios' });
  }

  // 3) Crear el usuario nuevo
  const { email, password, nombre, rol } = req.body || {};
  if (!email || !password || !rol) {
    return res.status(400).json({ error: 'Faltan datos (email, password o rol)' });
  }
  if (!['super', 'cobrador'].includes(rol)) {
    return res.status(400).json({ error: 'Rol inválido' });
  }

  const { data: nuevoUsuario, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });
  if (createError) {
    return res.status(400).json({ error: createError.message });
  }

  const { error: profileError } = await admin.from('profiles').insert({
    id: nuevoUsuario.user.id,
    email,
    nombre: nombre || email,
    rol
  });
  if (profileError) {
    // si falla la creación del perfil, deshacemos el usuario de auth para no dejarlo huérfano
    await admin.auth.admin.deleteUser(nuevoUsuario.user.id);
    return res.status(400).json({ error: profileError.message });
  }

  return res.status(200).json({ ok: true });
}
