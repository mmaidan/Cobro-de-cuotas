// Función serverless que Vercel Cron ejecuta automáticamente una vez por semana
// (ver vercel.json). Junta alumnos, pagos, configuración y usuarios, y los guarda
// como un documento en la colección "respaldos" de Firestore.
import admin from 'firebase-admin';

function getAdminApp() {
  if (admin.apps.length) return admin.app();
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  return admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

// Cuántos respaldos semanales conservar (8 = poco más de dos meses de historial).
const RESPALDOS_A_CONSERVAR = 8;

export default async function handler(req, res) {
  // Vercel firma automáticamente las peticiones de sus Cron Jobs con este header
  // cuando existe la variable de entorno CRON_SECRET. Cualquier otro pedido se rechaza.
  const authHeader = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
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
  const db = app.firestore();

  try {
    const [alumnosSnap, pagosSnap, configSnap, usuariosSnap] = await Promise.all([
      db.collection('alumnos').get(),
      db.collection('pagos').get(),
      db.collection('configuracion').doc('general').get(),
      db.collection('usuarios').get(),
    ]);

    const respaldo = {
      generado: new Date().toISOString(),
      alumnos: alumnosSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      pagos: pagosSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      config: configSnap.exists ? configSnap.data() : null,
      usuarios: usuariosSnap.docs.map((d) => {
        const u = d.data();
        return { id: d.id, usuario: u.usuario || null, email: u.email, nombre: u.nombre, rol: u.rol };
      }),
    };

    const fecha = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, usado como ID del documento
    await db.collection('respaldos').doc(fecha).set(respaldo);

    // Limpieza: borrar respaldos viejos para no acumular de más.
    const todos = await db.collection('respaldos').orderBy('generado', 'desc').get();
    const sobrantes = todos.docs.slice(RESPALDOS_A_CONSERVAR);
    if (sobrantes.length) {
      const batch = db.batch();
      sobrantes.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }

    return res.status(200).json({
      ok: true,
      fecha,
      alumnos: respaldo.alumnos.length,
      pagos: respaldo.pagos.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
