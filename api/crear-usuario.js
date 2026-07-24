// Función serverless (corre en Vercel, nunca en el navegador).
// Usa la cuenta de servicio de Firebase, guardada como variable de entorno secreta,
// para crear usuarios de Authentication y su perfil en Firestore.
import admin from 'firebase-admin';

function getAdminApp() {
  if (admin.apps.length) return admin.app();
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  return admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    return res.status(500).json({ error: 'Falta la variable de entorno FIREBASE_SERVICE_ACCOUNT en el servidor' });
  }

  let app;
  try {
    app = getAdminApp();
  } catch (e) {
    // Esto pasa casi siempre porque el valor de FIREBASE_SERVICE_ACCOUNT en Vercel
    // no es un JSON válido (se pegó dos veces, quedó texto de más, o se cortó).
    return res.status(500).json({ error: 'FIREBASE_SERVICE_ACCOUNT no es un JSON válido: ' + e.message });
  }
  const auth = app.auth();
  const db = app.firestore();

  // 1) Verificar que el token pertenece a un usuario real de Firebase Auth
  let decoded;
  try {
    decoded = await auth.verifyIdToken(token);
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  // 2) Verificar que ese usuario es superusuario
  const perfilSnap = await db.collection('usuarios').doc(decoded.uid).get();
  if (!perfilSnap.exists || perfilSnap.data().rol !== 'super') {
    return res.status(403).json({ error: 'Solo el superusuario puede crear usuarios' });
  }

  // 3) Crear el usuario nuevo
  const { email, usuario, password, nombre, rol } = req.body || {};
  if (!email || !password || !rol) {
    return res.status(400).json({ error: 'Faltan datos (email, password o rol)' });
  }
  if (!['super', 'cobrador'].includes(rol)) {
    return res.status(400).json({ error: 'Rol inválido' });
  }

  let nuevoUsuario;
  try {
    nuevoUsuario = await auth.createUser({ email, password });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    await db.collection('usuarios').doc(nuevoUsuario.uid).set({
      email, usuario: usuario || null, nombre: nombre || usuario || email, rol
    });
  } catch (e) {
    // si falla la creación del perfil, deshacemos el usuario de Auth para no dejarlo huérfano
    await auth.deleteUser(nuevoUsuario.uid);
    return res.status(400).json({ error: e.message });
  }

  return res.status(200).json({ ok: true });
}
