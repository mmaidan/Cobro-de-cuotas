# PASOS A SEGUIR — Firebase + GitHub + Vercel

Guía paso a paso, en orden, para poner en marcha la app. No hace falta saber programar,
son todo clics y copiar/pegar.

---

## PARTE 1 — Crear el proyecto en Firebase

1. Entrá a **https://console.firebase.google.com** con tu cuenta de Google.
2. **Agregar proyecto** → ponele un nombre (ej. "cuotas-escuela") → seguí los pasos → **Crear proyecto**.

### 1.1 Activar Authentication
1. En el menú izquierdo: **Compilación → Authentication → Comenzar**.
2. Pestaña **Sign-in method** → activá **Correo electrónico/contraseña** → Guardar.

### 1.2 Activar Firestore (la base de datos)
1. Menú izquierdo: **Compilación → Firestore Database → Crear base de datos**.
2. Elegí **modo producción** (ya vamos a poner nuestras propias reglas de seguridad).
3. Elegí la ubicación más cercana (ej. `southamerica-east1`) → Habilitar.

### 1.3 Cargar las reglas de seguridad
1. Adentro de Firestore Database, pestaña **Reglas**.
2. Borrá lo que hay y pegá **todo** el contenido del archivo `firestore.rules` de este proyecto.
3. **Publicar**.

   Estas reglas son las que garantizan que un cobrador no pueda, aunque lo intente,
   importar alumnos, cambiar la cuota o borrar pagos: solo puede leer datos y registrar cobros.

### 1.4 Obtener las credenciales web (públicas)
1. Ícono de tuerca (arriba a la izquierda) → **Configuración del proyecto**.
2. Pestaña **General** → bajá hasta "Tus apps" → ícono `</>` (Web) → registrá una app
   (nombre libre, ej. "app-cuotas") → **Registrar app**.
3. Te va a mostrar un objeto `firebaseConfig` con `apiKey`, `authDomain`, `projectId`, etc.
   **Copiá esos valores**, los vas a necesitar en la Parte 3.

### 1.5 Generar la clave secreta del servidor (para crear usuarios cobradores)
1. Mismo lugar (Configuración del proyecto) → pestaña **Cuentas de servicio**.
2. **Generar nueva clave privada** → confirmá → se descarga un archivo `.json`.
3. **Guardalo, pero NO lo subas nunca a GitHub.** Lo vas a pegar como variable de entorno
   en Vercel (Parte 4). Es la clave que le da permisos de administrador a la función que
   crea usuarios nuevos.

### 1.6 Crear tu propio usuario (superusuario)
1. Volvé a **Authentication → Users → Add user**.
2. Cargá tu email y una contraseña → Add user.
3. Copiá el **User UID** que te queda listado (es un código largo).
4. Andá a **Firestore Database → Datos → Iniciar colección**.
   - ID de la colección: `usuarios`
   - ID del documento: pegá ahí el UID que copiaste
   - Agregá estos 3 campos:
     - `email` (string) → tu email
     - `nombre` (string) → tu nombre
     - `rol` (string) → `super`
   - Guardar.

Con esto ya existe tu usuario superusuario. El resto de los usuarios (cobradores) los vas
a poder crear directamente desde la app, sin tocar Firebase de nuevo.

---

## PARTE 2 — Subir el proyecto a GitHub

1. Si no tenés Git instalado: **https://git-scm.com/downloads**.
2. Creá un repositorio nuevo y vacío en **https://github.com/new** (no lo inicialices con README).
3. Desde la carpeta del proyecto, en una terminal:
   ```bash
   git init
   git add .
   git commit -m "Primera versión: gestión de cuotas con Firebase"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/TU-REPO.git
   git push -u origin main
   ```
   (Reemplazá la URL por la de tu repositorio.)

---

## PARTE 3 — Completar `config.js` con tus datos de Firebase

Antes o después de subir a GitHub, abrí el archivo `config.js` del proyecto y completá
con los valores que copiaste en el paso 1.4:

```js
window.CONFIG = {
  firebaseConfig: {
    apiKey: "AIza...",
    authDomain: "tu-proyecto.firebaseapp.com",
    projectId: "tu-proyecto",
    storageBucket: "tu-proyecto.appspot.com",
    messagingSenderId: "123456789",
    appId: "1:123456789:web:abcdef123456"
  }
};
```

Esto es seguro de subir a GitHub tal cual: esos valores están hechos para ser públicos
(así funciona el SDK de Firebase en cualquier navegador). Lo que protege los datos de
verdad son las reglas de Firestore que ya cargaste en el paso 1.3.

Si ya habías hecho el `git push`, después de editar `config.js` corré:
```bash
git add config.js
git commit -m "Completar credenciales de Firebase"
git push
```

---

## PARTE 4 — Desplegar en Vercel

1. Entrá a **https://vercel.com** e iniciá sesión con tu cuenta de GitHub.
2. **Add New → Project** → elegí el repositorio que acabás de subir → **Import**.
3. Framework Preset: **Other** (es HTML simple, no necesita build). Dejá el resto
   como está.
4. Antes de darle a **Deploy**, abrí **Environment Variables** y agregá una sola:
   - **Name:** `FIREBASE_SERVICE_ACCOUNT`
   - **Value:** el contenido completo del archivo `.json` que descargaste en el paso 1.5,
     pegado como una sola línea de texto (abrí el archivo con el Bloc de notas, seleccioná
     todo, copiá, y pegalo tal cual en el campo de Vercel).
5. **Deploy.** Cuando termina, Vercel te da una URL (`tu-proyecto.vercel.app`): esa es tu
   app funcionando.

---

## PARTE 5 — Probarla

1. Entrá a la URL que te dio Vercel.
2. Iniciá sesión con el email y contraseña que creaste en el paso 1.6.
3. Deberías ver el Panel. Andá a **Alumnos → Importar CSV** y probá con tu archivo
   de matriculación.
4. Desde **Configuración → Usuarios**, creá a tu primer cobrador/a: ese formulario ya
   usa la función serverless con la clave que cargaste en la Parte 4, así que no hace
   falta volver a entrar a Firebase.

---

## Si algo falla

- **"Falta la variable de entorno FIREBASE_SERVICE_ACCOUNT"** → no se cargó bien en Vercel
  (Parte 4, paso 4) o el JSON quedó mal pegado (revisar que no falten `{ }` o comillas).
- **No podés iniciar sesión** → revisá que el usuario exista en Authentication Y que tenga
  su documento correspondiente en la colección `usuarios` de Firestore con el campo `rol`.
- **La app queda en "Cargando..." para siempre** → revisá la consola del navegador (F12);
  casi siempre es un dato mal copiado en `config.js`.
- **Al importar el CSV los acentos salen mal** → cambiá el selector de codificación a
  "Latin-1" antes de elegir el archivo.

---

## Qué diferencia hay con la versión de Supabase

Nada para vos como usuario: la app se ve y se usa exactamente igual. Lo que cambió por
dentro es dónde vive la información:

| | Supabase | Firebase |
|---|---|---|
| Base de datos | Postgres (tablas, SQL) | Firestore (documentos) |
| Login | Supabase Auth | Firebase Authentication |
| Seguridad | Políticas RLS en SQL | Reglas en `firestore.rules` |
| Crear cobradores | función en `/api` con Supabase Admin | función en `/api` con Firebase Admin |

El hosting sigue siendo Vercel en los dos casos.
