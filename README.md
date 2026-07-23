# Gestión de Cuotas — Escuela

Control y cobro de cuotas escolares (efectivo / transferencia), con recargo automático por mora,
alertas de alumnos con más de un mes de atraso, y dos roles: **superusuario** y **cobrador/a**.

**Para los pasos de puesta en marcha, ver `PASOS.md`.** Este archivo es la referencia técnica.

## Stack

- Frontend: HTML + JavaScript plano (sin build), Tailwind (CDN), Lucide Icons, PapaParse para CSV.
- Backend: [Firebase](https://firebase.google.com) — Firestore (base de datos) + Authentication.
- 1 función serverless en `/api` (crea usuarios cobradores sin exponer claves al navegador).
- Hosting: [Vercel](https://vercel.com).

## Estructura del proyecto

```
├── index.html                  → página única de la app
├── app.js                      → toda la lógica (UI, cálculo de mora, llamadas a Firebase)
├── config.js                   → credenciales web de Firebase (públicas a propósito)
├── firestore.rules             → reglas de seguridad (quién puede leer/escribir qué)
├── firebase.json               → config opcional para desplegar reglas con Firebase CLI
├── api/
│   └── crear-usuario.js        → función serverless: crea usuarios cobradores (usa la cuenta de servicio)
├── package.json                → dependencia de la función serverless (firebase-admin)
├── .env.example                → variable de entorno que necesita Vercel
├── PASOS.md                    → guía paso a paso para poner todo en marcha
└── .gitignore
```

## Colecciones de Firestore

- `usuarios/{uid}` → `{ email, nombre, rol }` — rol es `'super'` o `'cobrador'`.
- `alumnos/{id}` → datos del alumno importados desde el CSV de matriculación.
- `configuracion/general` → `{ montoCuota, diaVencimiento, periodoInicio, mora: {...} }` (documento único).
- `pagos/{alumnoId_periodo}` → un pago por alumno y mes; el ID del documento es determinístico
  (`{alumnoId}_{periodo}`) para que cobrar dos veces el mismo mes actualice en vez de duplicar.

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
  formulario. Esto llama a `/api/crear-usuario`, que usa la cuenta de servicio de Firebase
  (nunca expuesta al navegador) para crear el usuario y asignarle el rol elegido.
- **Seguridad:** todas las reglas están en `firestore.rules`. Un cobrador que intente escribir
  directamente en `alumnos` o `configuracion` desde la consola del navegador es rechazado por
  Firestore, no solo escondido en la interfaz.

## Sugerencias para seguir mejorando

- Comprobante de pago en PDF con folio numerado.
- Recordatorio automático por WhatsApp (`wa.me`) al tutor cuando entra en mora.
- Convenios de pago para deudas de varios meses.
- Exportar el estado de deuda mensual a Excel.
- Becas / exenciones por alumno (cuota reducida o $0).
