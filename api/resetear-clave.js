// Función serverless (corre en Vercel, nunca en el navegador).
// Le permite al superusuario cambiarle la contraseña a otro usuario sin necesitar
// su email (los usuarios se manejan por "usuario", no por correo).
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
    return res.status(403).json({ error: 'Solo el superusuario puede cambiar contraseñas' });
  }

  // 3) Cambiar la contraseña del usuario indicado
  const { uid, password } = req.body || {};
  if (!uid || !password) {
    return res.status(400).json({ error: 'Faltan datos (uid o password)' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'La contraseña tiene que tener al menos 6 caracteres' });
  }

  try {
    await auth.updateUser(uid, { password });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  return res.status(200).json({ ok: true });
}
