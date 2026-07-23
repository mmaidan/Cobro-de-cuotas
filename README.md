# Gestión de Cuotas — Escuela

Control y cobro de cuotas escolares (efectivo / transferencia), con recargo automático por mora,
alertas de alumnos con más de un mes de atraso, y dos roles: **superusuario** y **cobrador/a**.

## Stack

- Frontend: HTML + JavaScript plano (sin build), Tailwind (CDN), Lucide Icons, PapaParse para CSV.
- Backend: [Supabase](https://supabase.com) (Postgres + Auth + RLS).
- 1 función serverless en `/api` (para crear usuarios cobradores sin exponer claves).
- Hosting: [Vercel](https://vercel.com).

## Estructura del proyecto

```
├── index.html                  → página única de la app
├── app.js                      → toda la lógica (UI, cálculo de mora, llamadas a Supabase)
├── config.js                   → URL y anon key de Supabase (públicas a propósito)
├── api/
│   └── crear-usuario.js        → función serverless: crea usuarios cobradores (usa service key)
├── supabase/
│   └── migrations/0001_init.sql→ tablas + políticas de seguridad (RLS)
├── package.json                → dependencia de la función serverless
├── .env.example                → variables de entorno que necesita Vercel
└── .gitignore
```

## 1. Crear el proyecto en Supabase

1. Entrá a [supabase.com](https://supabase.com) → **New project**.
2. Cuando esté listo, andá a **Settings → API** y copiá:
   - **Project URL**
   - **anon public key**
   - **service_role key** (la vas a necesitar más adelante, es secreta)

## 2. Crear las tablas

1. En el panel de Supabase, abrí **SQL Editor → New query**.
2. Pegá **todo** el contenido de `supabase/migrations/0001_init.sql` y ejecutalo.
   Esto crea las tablas `profiles`, `alumnos`, `configuracion`, `pagos` y las políticas
   de seguridad (RLS) que hacen que solo el superusuario pueda importar alumnos, cambiar
   la configuración o borrar pagos.

## 3. Crear el primer superusuario

Como todavía no hay nadie con rol `super`, este paso se hace a mano una sola vez:

1. **Authentication → Users → Add user**. Cargá tu email y una contraseña. Copiá el **UID** que te muestra.
2. Volvé al **SQL Editor** y ejecutá (reemplazando los valores):
   ```sql
   insert into public.profiles (id, email, nombre, rol)
   values ('EL-UID-QUE-COPIASTE', 'tu@email.com', 'Tu Nombre', 'super');
   ```
3. Con ese usuario vas a poder loguearte en la app y, desde **Configuración → Usuarios**,
   crear a los cobradores sin volver a tocar SQL.

## 4. Completar `config.js`

Editá `config.js` con los valores de tu proyecto:

```js
window.CONFIG = {
  SUPABASE_URL: 'https://tu-proyecto.supabase.co',
  SUPABASE_ANON_KEY: 'tu-anon-key-publica'
};
```

Esto es seguro de subir a GitHub: la `anon key` está diseñada para ser pública, la protección
real la dan las políticas de RLS que ya quedaron creadas en el paso 2. Lo que **nunca** va acá
ni al repositorio es la `service_role key`.

## 5. Subir a GitHub

```bash
git init
git add .
git commit -m "Primera versión: gestión de cuotas"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/TU-REPO.git
git push -u origin main
```

## 6. Desplegar en Vercel

1. En [vercel.com](https://vercel.com) → **Add New → Project → Import Git Repository** y elegí el repo.
2. Framework preset: **Other** (no hay build, es HTML plano). Dejá el Build Command vacío y el
   Output Directory como la raíz del proyecto (`.`).
3. Antes de darle a Deploy, andá a **Environment Variables** y agregá:
   - `SUPABASE_URL` → la Project URL de Supabase
   - `SUPABASE_SERVICE_ROLE_KEY` → la service_role key (la secreta, del paso 1)

   Estas dos solo las usa `api/crear-usuario.js`, que corre en el servidor de Vercel; nunca
   llegan al navegador.
4. Deploy. Vercel te da una URL (`tu-proyecto.vercel.app`) que ya es tu app en producción.

## Cómo se maneja cada cosa

- **Importar alumnos por Excel/CSV:** solo lo ve el superusuario, en la pestaña Alumnos. Soporta
  el formato del reporte de matriculación (columnas APELLIDOS, NOMBRES, DU, GRADO/AÑO, SECCION,
  TURNO, tutor, teléfono, email, ESTADO). Si los acentos se ven mal al importar, cambiá el
  selector de codificación a "Latin-1".
- **Cálculo de mora:** configurable en Configuración → Regla de mora. Por defecto: 10% cada 10
  días dentro del primer mes de atraso (hasta 30%), y +5% por cada mes adicional después de eso.
- **Roles:**
  - *Superusuario*: importa alumnos, configura cuota y mora, crea/elimina usuarios.
  - *Cobrador/a*: ve alumnos, registra cobros (efectivo/transferencia), ve alertas de mora.
- **Agregar un cobrador nuevo:** como superusuario, en Configuración → Usuarios, completar el
  formulario. Esto llama a `/api/crear-usuario`, que crea el usuario en Supabase Auth usando la
  service key (nunca expuesta al navegador) y le asigna el rol elegido.

## Probarlo en tu máquina antes de subirlo

Como no hay build, alcanza con abrir `index.html` en el navegador, pero para que `/api` funcione
localmente necesitás el [Vercel CLI](https://vercel.com/docs/cli):

```bash
npm install
npx vercel dev
```

Vercel te va a pedir las mismas variables de entorno (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`)
la primera vez, o podés crear un `.env` local a partir de `.env.example` (no se sube a git).

## Sugerencias para seguir mejorando

- Comprobante de pago en PDF con folio numerado.
- Recordatorio automático por WhatsApp (`wa.me`) al tutor cuando entra en mora.
- Convenios de pago para deudas de varios meses.
- Exportar el estado de deuda mensual a Excel.
- Becas / exenciones por alumno (cuota reducida o $0).
