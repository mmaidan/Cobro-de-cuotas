/* ======================= FIREBASE ======================= */
firebase.initializeApp(window.CONFIG.firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

/* ======================= ESTADO EN MEMORIA ======================= */
let STATE = { config: null, alumnos: [], pagos: [], perfiles: [] };
let SESSION = null; // { id, email, rol, nombre, access_token, loginTime }
// Cuenta del dueño del sistema: no se muestra en la lista de usuarios ni se puede borrar desde ahí.
const EMAIL_PROTEGIDO = 'memmarcos1987@gmail.com';
// Firebase Authentication necesita internamente un "email" para identificar la cuenta,
// pero de cara al usuario evitamos pedirlo: los usuarios nuevos se crean con un simple
// "usuario" (sin @), y acá se lo convierte en un email interno que nadie ve ni recibe correos.
const DOMINIO_INTERNO = 'cuotas-isj.local';
function esFormatoEmail(texto){ return texto.includes('@'); }
// Si lo que se tipeó ya es un email (caso de cuentas viejas, como la del dueño del sistema)
// se usa tal cual. Si es un usuario simple, se arma el email interno.
function resolverEmailDeLogin(entrada){
  const valor = entrada.trim().toLowerCase();
  return esFormatoEmail(valor) ? valor : valor.replace(/\s+/g,'') + '@' + DOMINIO_INTERNO;
}

/* ======================= SEGURIDAD DE SESIÓN ======================= */
// Por ser un sistema de cobro de dinero, la sesión se cierra sola por
// inactividad y también tiene una duración máxima, aunque haya actividad.
// Los valores por defecto (abajo) se pueden ajustar desde Configuración.
const SESION_INACTIVIDAD_MIN_DEFAULT = 15;
const SESION_MAXIMA_HORAS_DEFAULT = 8;
let ultimaActividad = Date.now();
function registrarActividad(){ ultimaActividad = Date.now(); }
['mousemove','keydown','click','touchstart'].forEach(evt=>{
  document.addEventListener(evt, registrarActividad, { passive: true });
});
setInterval(async ()=>{
  if(!SESSION) return;
  const minInactividad = (STATE.config && STATE.config.sesionInactividadMin) || SESION_INACTIVIDAD_MIN_DEFAULT;
  const horasMaximo = (STATE.config && STATE.config.sesionMaximaHoras) || SESION_MAXIMA_HORAS_DEFAULT;
  const ahora = Date.now();
  const inactivo = (ahora - ultimaActividad) > minInactividad*60*1000;
  const sesionVencida = SESSION.loginTime && (ahora - SESSION.loginTime) > horasMaximo*60*60*1000;
  if(inactivo || sesionVencida){
    await auth.signOut();
    SESSION = null;
    STATE = { config:null, alumnos:[], pagos:[], perfiles:[] };
    UI.alertaLogin = inactivo
      ? 'Cerramos tu sesión por inactividad, para proteger la información de cobros. Volvé a ingresar.'
      : 'Por seguridad, tu sesión venció y hay que volver a iniciarla.';
    render();
  }
}, 30000);

let TAB = 'dashboard';
let UI = { alertaMsg:null, alertaTipo:'ok', alertaLogin:null, alertaLoginOk:null, importPreview:null, importEncoding:'utf-8', cargando:true, busqueda:'', busquedaAlumnos:'', _modalPago:null, sidebarAbierto:false, soloDeudores:true, cajaPreset:'hoy', cajaDesde:nuevaFechaISO(), cajaHasta:nuevaFechaISO(), statsAnio:null, cursosAbiertos:{}, aniosAbiertos:{}, dashboardFiltro:null };

/* ======================= UTILIDADES ======================= */
function fmtMoney(n){ return '$ ' + Number(n||0).toLocaleString('es-AR', {minimumFractionDigits:0, maximumFractionDigits:0}); }
function fmtFecha(iso){ if(!iso) return '-'; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }
function nuevaFechaISO(){ return new Date().toISOString().slice(0,10); }
function mesNombre(periodo){
  const meses=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const [y,m]=periodo.split('-'); return `${meses[parseInt(m,10)-1]} ${y}`;
}
function periodosEntre(inicio, fin){
  const out=[];
  let [ay,am]=inicio.split('-').map(Number);
  const [by,bm]=fin.split('-').map(Number);
  while(ay<by || (ay===by && am<=bm)){
    out.push(`${ay}-${String(am).padStart(2,'0')}`);
    am++; if(am>12){am=1; ay++;}
  }
  return out;
}
function periodoActual(){ return nuevaFechaISO().slice(0,7); }
function vencimientoDe(periodo, diaVenc){
  const [y,m]=periodo.split('-').map(Number);
  const ultimoDia = new Date(y, m, 0).getDate();
  const dia = Math.min(diaVenc, ultimoDia);
  return `${y}-${String(m).padStart(2,'0')}-${String(dia).padStart(2,'0')}`;
}
function diasEntre(fechaA, fechaB){
  const a=new Date(fechaA+'T00:00:00'), b=new Date(fechaB+'T00:00:00');
  return Math.round((b-a)/86400000);
}

/* ======================= MAPEO DB <-> APP ======================= */
// Firestore ya guarda los campos en camelCase, así que el mapeo es casi directo.
function mapConfigDesdeDB(c){
  if(!c) return { montoCuota:15000, diaVencimiento:10, periodoInicio:periodoActual(), mora:{porcentajePor10Dias:10, topeBloques:3, porcentajeMensualExtra:5}, sesionInactividadMin:SESION_INACTIVIDAD_MIN_DEFAULT, sesionMaximaHoras:SESION_MAXIMA_HORAS_DEFAULT };
  return {
    montoCuota: Number(c.montoCuota),
    diaVencimiento: Number(c.diaVencimiento),
    periodoInicio: c.periodoInicio,
    mora: {
      porcentajePor10Dias: Number(c.mora?.porcentajePor10Dias ?? 10),
      topeBloques: Number(c.mora?.topeBloques ?? 3),
      porcentajeMensualExtra: Number(c.mora?.porcentajeMensualExtra ?? 5)
    },
    sesionInactividadMin: Number(c.sesionInactividadMin ?? SESION_INACTIVIDAD_MIN_DEFAULT),
    sesionMaximaHoras: Number(c.sesionMaximaHoras ?? SESION_MAXIMA_HORAS_DEFAULT)
  };
}
function mapAlumnoDesdeDB(id, a){ return { id, ...a }; }
function mapPagoDesdeDB(id, p){ return { id, ...p }; }

/* ======================= LÓGICA DE MORA (igual que antes) ======================= */
function calcularRecargoPorcentaje(diasAtraso){
  const cfg = STATE.config.mora;
  if(diasAtraso <= 0) return 0;
  const bloques10 = Math.min(Math.floor(diasAtraso/10), cfg.topeBloques);
  let pct = bloques10 * cfg.porcentajePor10Dias;
  const topeDias = cfg.topeBloques*10;
  if(diasAtraso > topeDias){
    const mesesExtra = Math.floor((diasAtraso - topeDias)/30) + 1;
    pct += mesesExtra * cfg.porcentajeMensualExtra;
  }
  return pct;
}
function cuotasDeAlumno(alumnoId){
  const hoy = nuevaFechaISO();
  const periodos = periodosEntre(STATE.config.periodoInicio, periodoActual());
  return periodos.map(periodo=>{
    const pago = STATE.pagos.find(p=>p.alumnoId===alumnoId && p.periodo===periodo);
    const vencimiento = vencimientoDe(periodo, STATE.config.diaVencimiento);
    const diasAtraso = pago ? diasEntre(vencimiento, pago.fecha) : Math.max(0, diasEntre(vencimiento, hoy));
    const pct = pago ? (pago.recargoPct||0) : calcularRecargoPorcentaje(diasAtraso);
    const montoBase = STATE.config.montoCuota;
    const montoConMora = Math.round(montoBase * (1 + pct/100));
    return {
      periodo, vencimiento, montoBase, pct, montoConMora,
      pagado: !!pago, pago: pago||null,
      diasAtraso: pago ? (pago.diasAtrasoAlPagar||0) : diasAtraso
    };
  });
}
function resumenAlumno(alumnoId){
  const cuotas = cuotasDeAlumno(alumnoId);
  const pendientes = cuotas.filter(c=>!c.pagado);
  const totalAdeudado = pendientes.reduce((s,c)=>s+c.montoConMora,0);
  const maxAtraso = pendientes.reduce((m,c)=>Math.max(m,c.diasAtraso),0);
  return { cuotas, pendientes, totalAdeudado, maxAtraso, cantidadPendiente: pendientes.length };
}

/* ======================= AUTENTICACIÓN ======================= */
function initApp(){
  auth.onAuthStateChanged(async (user)=>{
    if(user){ await establecerSesion(user); }
    else{ SESSION = null; }
    UI.cargando = false;
    render();
  });
}
async function establecerSesion(user){
  try{
    const perfilSnap = await db.collection('usuarios').doc(user.uid).get();
    if(!perfilSnap.exists){
      await auth.signOut();
      SESSION = null;
      UI.alertaLogin = `No existe un perfil en la colección "usuarios" para el UID ${user.uid}. Revisá que el documento tenga exactamente ese ID.`;
      return;
    }
    const perfil = perfilSnap.data();
    const token = await user.getIdToken();
    const loginTime = (user.metadata && user.metadata.lastSignInTime) ? new Date(user.metadata.lastSignInTime).getTime() : Date.now();
    SESSION = { id: user.uid, email: user.email, rol: perfil.rol, nombre: perfil.nombre, access_token: token, loginTime };
    ultimaActividad = Date.now();
    await cargarDatos();
  }catch(e){
    console.error('[gestion-cuotas] Error al establecer sesión:', e);
    await auth.signOut();
    SESSION = null;
    UI.alertaLogin = 'Error de Firestore: ' + (e && e.message ? e.message : e);
  }
}
async function cargarDatos(){
  const [cfgSnap, alumnosSnap, pagosSnap] = await Promise.all([
    db.collection('configuracion').doc('general').get(),
    db.collection('alumnos').orderBy('apellidos').get(),
    db.collection('pagos').get()
  ]);
  STATE.config = mapConfigDesdeDB(cfgSnap.exists ? cfgSnap.data() : null);
  STATE.alumnos = alumnosSnap.docs.map(d=>mapAlumnoDesdeDB(d.id, d.data()));
  STATE.pagos = pagosSnap.docs.map(d=>mapPagoDesdeDB(d.id, d.data()));
  if(SESSION.rol==='super'){ await cargarPerfiles(); }
}
async function cargarPerfiles(){
  const snap = await db.collection('usuarios').orderBy('nombre').get();
  STATE.perfiles = snap.docs.map(d=>({id:d.id, ...d.data()}));
}
async function login(usuarioOEmail, clave){
  try{
    const email = resolverEmailDeLogin(usuarioOEmail);
    const cred = await auth.signInWithEmailAndPassword(email, clave);
    await establecerSesion(cred.user);
    return !!SESSION;
  }catch(e){ return false; }
}
async function recuperarContrasena(){
  const valor = (document.getElementById('lu').value||'').trim();
  UI.alertaLoginOk = null;
  if(!valor){
    UI.alertaLogin = 'Escribí tu usuario en el campo de arriba y volvé a tocar "¿Olvidaste tu contraseña?".';
    render(); return;
  }
  if(!esFormatoEmail(valor)){
    UI.alertaLogin = 'Los usuarios sin email no pueden recuperar la contraseña solos: pedile al superusuario que te la cambie desde Configuración → Usuarios.';
    render(); return;
  }
  try{
    await auth.sendPasswordResetEmail(valor);
    UI.alertaLogin = null;
    UI.alertaLoginOk = `Te enviamos un email a ${valor} con un link para crear una nueva contraseña. Revisá también la carpeta de spam.`;
  }catch(e){
    UI.alertaLoginOk = null;
    UI.alertaLogin = e.code==='auth/user-not-found'
      ? 'No hay ninguna cuenta registrada con ese email.'
      : 'No pudimos enviar el email: ' + (e.message||e);
  }
  render();
}
async function logout(){
  await auth.signOut();
  SESSION = null;
  STATE = { config:null, alumnos:[], pagos:[], perfiles:[] };
  render();
}
function esSuper(){ return SESSION && SESSION.rol==='super'; }

/* ======================= IMPORTACIÓN CSV ======================= */
const MAPEO_COLUMNAS = {
  apellidos: ['APELLIDOS'], nombres: ['NOMBRES'], dni: ['DU','DNI'],
  grado: ['GRADO/AÑO'], seccion: ['SECCION'], turno: ['TURNO'],
  telefono: ['TELEFONO'], email: ['EMAIL'],
  tutorApellido: ['APELLIDOS TUTOR'], tutorNombre: ['NOMBRE TUTOR'],
  telefonoTutor: ['TELEFONO TUTOR'], emailTutor: ['EMAIL TUTOR'], estado: ['ESTADO']
};
function normalizarHeader(h){ return h.replace(/\uFFFD/g,'').replace(/"/g,'').trim().toUpperCase(); }
function buscarCampo(row, claves){
  const keys = Object.keys(row);
  for(const clave of claves){
    const found = keys.find(k=> normalizarHeader(k)===clave || normalizarHeader(k).startsWith(clave));
    if(found) return (row[found]||'').toString().trim();
  }
  return '';
}
// Antes esto dependía de que el usuario eligiera bien la codificación en un selector.
// Si elegía "UTF-8" para un CSV que en realidad era Latin-1 (el caso típico al
// exportar desde sistemas de gestión escolar/Excel), los caracteres con acentos
// y ñ se perdían de forma IRREVERSIBLE (quedaban como el símbolo "�"), porque
// el navegador ya descarta esos bytes al decodificar. Ahora se detecta solo:
// probamos UTF-8 en modo estricto; si el archivo no es UTF-8 válido, usamos Latin-1.
function leerArchivoConDeteccionAutomatica(file, callback){
  const reader = new FileReader();
  reader.onload = function(e){
    const bytes = new Uint8Array(e.target.result);
    let texto;
    try{
      texto = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }catch(err){
      texto = new TextDecoder('iso-8859-1').decode(bytes);
    }
    callback(texto);
  };
  reader.readAsArrayBuffer(file);
}
function procesarCSV(file){
  leerArchivoConDeteccionAutomatica(file, function(texto){
    Papa.parse(texto, {
      header: true, skipEmptyLines: true,
      complete: function(results){
        const filas = results.data.map(row=>{
          const grado = buscarCampo(row, MAPEO_COLUMNAS.grado);
          const seccion = buscarCampo(row, MAPEO_COLUMNAS.seccion);
          return {
            apellidos: buscarCampo(row, MAPEO_COLUMNAS.apellidos),
            nombres: buscarCampo(row, MAPEO_COLUMNAS.nombres),
            dni: buscarCampo(row, MAPEO_COLUMNAS.dni),
            curso: [grado, seccion].filter(Boolean).join(' - '),
            turno: buscarCampo(row, MAPEO_COLUMNAS.turno),
            telefono: buscarCampo(row, MAPEO_COLUMNAS.telefono),
            email: buscarCampo(row, MAPEO_COLUMNAS.email),
            tutorApellido: buscarCampo(row, MAPEO_COLUMNAS.tutorApellido),
            tutorNombre: buscarCampo(row, MAPEO_COLUMNAS.tutorNombre),
            telefonoTutor: buscarCampo(row, MAPEO_COLUMNAS.telefonoTutor),
            emailTutor: buscarCampo(row, MAPEO_COLUMNAS.emailTutor),
            estadoOriginal: buscarCampo(row, MAPEO_COLUMNAS.estado)
          };
        }).filter(f=>f.apellidos || f.nombres);
        UI.importPreview = filas;
        render();
      }
    });
  });
}
// Firestore permite hasta 500 operaciones por batch; lo troceamos por las dudas.
async function insertarEnLotes(coleccion, items){
  const creados = [];
  for(let i=0;i<items.length;i+=400){
    const chunk = items.slice(i, i+400);
    const batch = db.batch();
    const refs = chunk.map(data=>{
      const ref = db.collection(coleccion).doc();
      batch.set(ref, data);
      return { ref, data };
    });
    await batch.commit();
    refs.forEach(r=>creados.push({ id: r.ref.id, ...r.data }));
  }
  return creados;
}
async function eliminarAlumno(id){
  const a = STATE.alumnos.find(x=>x.id===id);
  const ok = confirm(`¿Eliminar a ${a?a.apellidos+', '+a.nombres:'este alumno'}? También se borran sus pagos registrados. No se puede deshacer.`);
  if(!ok) return;
  try{
    const pagosDelAlumno = STATE.pagos.filter(p=>p.alumnoId===id).map(p=>p.id);
    const batch = db.batch();
    batch.delete(db.collection('alumnos').doc(id));
    pagosDelAlumno.forEach(pid=> batch.delete(db.collection('pagos').doc(pid)));
    await batch.commit();
    STATE.alumnos = STATE.alumnos.filter(a=>a.id!==id);
    STATE.pagos = STATE.pagos.filter(p=>p.alumnoId!==id);
    UI.alertaMsg = 'Alumno eliminado.'; UI.alertaTipo='ok';
  }catch(e){
    UI.alertaMsg = 'Error al eliminar: '+e.message; UI.alertaTipo='error';
  }
  render();
}
async function confirmarBorrarAlumnos(){
  const cantidad = STATE.alumnos.length;
  const ok = confirm(`Esto borra los ${cantidad} alumnos cargados y todos los pagos registrados. No se puede deshacer. ¿Continuar?`);
  if(!ok) return;
  UI.alertaMsg = 'Borrando...'; UI.alertaTipo='ok'; render();
  try{
    // Borramos alumnos y sus pagos asociados, en lotes de 400 (límite de Firestore).
    const idsAlumnos = STATE.alumnos.map(a=>a.id);
    const idsPagos = STATE.pagos.map(p=>p.id);
    const todos = [
      ...idsAlumnos.map(id=>({coleccion:'alumnos', id})),
      ...idsPagos.map(id=>({coleccion:'pagos', id}))
    ];
    for(let i=0;i<todos.length;i+=400){
      const batch = db.batch();
      todos.slice(i,i+400).forEach(({coleccion,id})=> batch.delete(db.collection(coleccion).doc(id)));
      await batch.commit();
    }
    STATE.alumnos = [];
    STATE.pagos = [];
    UI.alertaMsg = `Se borraron ${cantidad} alumnos. Ya podés reimportar el CSV.`; UI.alertaTipo='ok';
  }catch(e){
    UI.alertaMsg = 'Error al borrar: '+e.message; UI.alertaTipo='error';
  }
  render();
}
async function confirmarImportacion(){
  const dnisExistentes = new Set(STATE.alumnos.map(a=>a.dni).filter(Boolean));
  const candidatos = UI.importPreview.filter(f=> !f.dni || !dnisExistentes.has(f.dni));
  const omitidos = UI.importPreview.length - candidatos.length;
  const nuevos = candidatos.map(f=>({
    apellidos: f.apellidos, nombres: f.nombres, dni: f.dni || null, curso: f.curso, turno: f.turno,
    telefono: f.telefono || null, email: f.email || null,
    tutorApellido: f.tutorApellido || null, tutorNombre: f.tutorNombre || null,
    telefonoTutor: f.telefonoTutor || null, emailTutor: f.emailTutor || null,
    activo: !f.estadoOriginal || f.estadoOriginal.toLowerCase().includes('activ')
  }));
  try{
    const creados = await insertarEnLotes('alumnos', nuevos);
    STATE.alumnos = STATE.alumnos.concat(creados).sort((a,b)=> (a.apellidos||'').localeCompare(b.apellidos||''));
    UI.importPreview = null;
    UI.alertaMsg = `Se importaron ${creados.length} alumnos (${omitidos} omitidos por DNI duplicado).`; UI.alertaTipo='ok';
  }catch(e){
    UI.alertaMsg = 'Error al importar: '+e.message; UI.alertaTipo='error';
  }
  render();
}

/* ======================= PAGOS ======================= */
// docId determinístico (alumno+período) para que registrar dos veces el mismo mes actualice, no duplique.
async function registrarPago({alumnoId, periodo, metodo, montoPagado}){
  const cuota = cuotasDeAlumno(alumnoId).find(c=>c.periodo===periodo);
  const docId = alumnoId+'_'+periodo;
  const registro = {
    alumnoId, periodo,
    montoBase: STATE.config.montoCuota,
    recargoPct: cuota.pct,
    montoTotal: cuota.montoConMora,
    montoPagado: montoPagado || cuota.montoConMora,
    metodo, fecha: nuevaFechaISO(),
    diasAtrasoAlPagar: cuota.diasAtraso,
    registradoPor: SESSION.id
  };
  UI._modalPago = null;
  try{
    await db.collection('pagos').doc(docId).set(registro);
    STATE.pagos = STATE.pagos.filter(p=>p.id!==docId).concat([{ id: docId, ...registro }]);
    UI.alertaMsg = `Cobro registrado correctamente. <button onclick="generarComprobantePDF('${docId}')" class="underline font-semibold ml-1">Imprimir comprobante</button>`; UI.alertaTipo='ok';
  }catch(e){
    UI.alertaMsg = 'Error al registrar el cobro: '+e.message; UI.alertaTipo='error';
  }
  render();
}
async function anularPago(pagoId){
  try{
    await db.collection('pagos').doc(pagoId).delete();
    STATE.pagos = STATE.pagos.filter(p=>p.id!==pagoId);
  }catch(e){ UI.alertaMsg = 'Error: '+e.message; UI.alertaTipo='error'; }
  render();
}

/* ======================= PDF: comprobante y deudores ======================= */
function encabezadoPDF(doc, titulo){
  try{ if(window.LOGO_DATA_URL) doc.addImage(window.LOGO_DATA_URL, 'PNG', 14, 10, 16, 18); }catch(e){}
  doc.setFont('helvetica','bold'); doc.setFontSize(13);
  doc.text('Instituto San José', 34, 18);
  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(120);
  doc.text('Quines, San Luis', 34, 23);
  doc.setTextColor(30); doc.setFont('helvetica','bold'); doc.setFontSize(12);
  doc.text(titulo, 14, 36);
  doc.setDrawColor(225,220,208); doc.line(14, 40, 196, 40);
}
function generarComprobantePDF(pagoId){
  const p = STATE.pagos.find(x=>x.id===pagoId);
  if(!p){ UI.alertaMsg = 'No se encontró el pago.'; UI.alertaTipo='error'; render(); return; }
  const a = STATE.alumnos.find(x=>x.id===p.alumnoId);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  encabezadoPDF(doc, 'Comprobante de pago');
  doc.setFontSize(10); doc.setFont('helvetica','normal'); doc.setTextColor(40);
  let y = 50;
  const fila = (label, valor)=>{ doc.setFont('helvetica','bold'); doc.text(label, 14, y); doc.setFont('helvetica','normal'); doc.text(String(valor), 60, y); y += 8; };
  fila('Recibo N°:', p.id.slice(0,8).toUpperCase());
  fila('Fecha de pago:', fmtFecha(p.fecha));
  fila('Alumno:', a ? `${a.apellidos}, ${a.nombres}` : '—');
  fila('Curso:', a ? (a.curso||'-') : '-');
  fila('DNI:', a ? (a.dni||'-') : '-');
  fila('Concepto:', 'Cuota ' + mesNombre(p.periodo));
  fila('Método de pago:', p.metodo==='efectivo' ? 'Efectivo' : 'Transferencia');
  if(p.recargoPct>0) fila('Recargo por mora:', `${p.recargoPct}%`);
  y += 2;
  doc.setDrawColor(225,220,208); doc.line(14, y, 196, y); y += 10;
  doc.setFont('helvetica','bold'); doc.setFontSize(13);
  doc.text('Total pagado:', 14, y);
  doc.text(fmtMoney(p.montoPagado), 60, y);
  y += 16;
  doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(140);
  doc.text('Comprobante generado por el sistema de gestión de cuotas.', 14, y);
  doc.autoPrint();
  doc.output('dataurlnewwindow');
}
function exportarDeudoresPDF(){
  const deudores = STATE.alumnos.filter(a=>a.activo).map(a=>({a, r:resumenAlumno(a.id)})).filter(x=>x.r.cantidadPendiente>0)
    .sort((x,y)=>y.r.maxAtraso-x.r.maxAtraso);
  if(deudores.length===0){ UI.alertaMsg='No hay deudores para exportar.'; UI.alertaTipo='error'; render(); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  encabezadoPDF(doc, 'Listado de alumnos con cuotas pendientes');
  doc.setFontSize(9); doc.setTextColor(90);
  doc.text(`Generado el ${fmtFecha(nuevaFechaISO())} · ${deudores.length} alumnos`, 14, 46);
  doc.autoTable({
    startY: 50,
    head: [['Alumno','Curso','DNI','Tutor / Teléfono','Días atraso','Deuda']],
    body: deudores.map(({a,r})=>[
      `${a.apellidos}, ${a.nombres}`,
      a.curso||'-',
      a.dni||'-',
      `${a.tutorApellido||''} ${a.tutorNombre||''}\n${a.telefonoTutor||a.telefono||''}`.trim(),
      r.maxAtraso>0 ? `${r.maxAtraso} días` : '-',
      fmtMoney(r.totalAdeudado)
    ]),
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [161,72,58] },
    columnStyles: { 5: { halign:'right', fontStyle:'bold' } }
  });
  doc.save(`deudores_${nuevaFechaISO()}.pdf`);
}

/* ======================= RENDER ======================= */
function icon(name, cls){ return `<i data-lucide="${name}" class="${cls||''}"></i>`; }
function render(){
  const app = document.getElementById('app');
  if(UI.cargando){ app.innerHTML = `<div class="h-full w-full flex items-center justify-center text-gray-400 text-sm">Cargando...</div>`; return; }
  if(!SESSION){ app.innerHTML = vistaLogin(); post(); return; }
  app.innerHTML = vistaPrincipal();
  post();
}
function post(){ lucide.createIcons(); }

function vistaLogin(){
  return `
  <div class="h-full w-full flex flex-col md:flex-row overflow-y-auto">
    <div class="login-hero md:w-[42%] md:min-h-full flex flex-col justify-between px-8 py-10 md:py-14 shrink-0" style="background-image:radial-gradient(circle at 25% 15%, #c98979 0%, var(--sidebar-2) 65%);">
      <div class="flex items-center gap-3 anim-fade-slide">
        <img src="${window.LOGO_DATA_URL||''}" alt="Instituto San José" class="logo-img" style="width:48px;height:52px;">
        <div>
          <p class="font-display font-bold text-white text-lg leading-tight">Instituto San José</p>
          <p class="text-xs" style="color:#d9b8ab">Quines, San Luis</p>
        </div>
      </div>
      <div class="hidden md:block mt-10 anim-fade-slide stagger-2">
        <h1 class="font-display font-bold text-3xl text-white leading-tight mb-3">Gestión de<br>Cuotas</h1>
        <p class="text-sm max-w-xs" style="color:#e3d3ca">Control y cobro de cuotas escolares en efectivo o transferencia, con alertas de mora y estadísticas al día.</p>
      </div>
      <p class="text-[11px] hidden md:block anim-fade stagger-4" style="color:#a08e83">Desarrollado por Prof. Maidan Marcos Exequiel</p>
    </div>
    <div class="flex-1 flex items-center justify-center px-4 py-10 md:py-4">
      <div class="w-full max-w-sm anim-fade-slide stagger-2">
        <h2 class="font-display font-bold text-xl mb-1">Iniciar sesión</h2>
        <p class="text-sm text-gray-500 mb-6">Ingresá con tu cuenta para continuar.</p>
        ${UI.alertaLogin ? `<div class="badge-danger text-xs rounded-lg p-3 mb-4 anim-slide-down">${UI.alertaLogin}</div>` : ''}
        ${UI.alertaLoginOk ? `<div class="badge-ok text-xs rounded-lg p-3 mb-4 anim-slide-down">${UI.alertaLoginOk}</div>` : ''}
        <form id="loginForm" onsubmit="manejarLogin(event)">
          <label class="lbl">Usuario</label>
          <input id="lu" type="text" class="mb-3" placeholder="tu usuario" autocapitalize="none" autofocus>
          <label class="lbl">Contraseña</label>
          <input id="lc" type="password" class="mb-1" placeholder="••••••••">
          <div class="text-right mb-1">
            <button type="button" onclick="recuperarContrasena()" class="text-xs font-medium" style="color:var(--accent)">¿Olvidaste tu contraseña?</button>
          </div>
          <button type="submit" id="loginBtn" class="btn-primary w-full mt-3 py-2.5 rounded-lg font-semibold text-sm">Ingresar</button>
        </form>
        <p class="text-[11px] text-gray-400 mt-8 md:hidden text-center">Desarrollado por Prof. Maidan Marcos Exequiel</p>
      </div>
    </div>
  </div>`;
}
// Los atributos inline (onsubmit="...") sí se ejecutan cuando el HTML se inserta
// via innerHTML; un <script> embebido en ese mismo HTML, en cambio, NO se ejecuta
// nunca (los navegadores lo ignoran por seguridad). Por eso el login se maneja acá.
async function manejarLogin(e){
  e.preventDefault();
  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.textContent = 'Ingresando...';
  UI.alertaLogin = null;
  UI.alertaLoginOk = null;
  const email = document.getElementById('lu').value.trim();
  const clave = document.getElementById('lc').value;
  const ok = await login(email, clave);
  if(!ok && !UI.alertaLogin){
    UI.alertaLogin = 'Usuario o contraseña incorrectos.';
  }
  render();
}

function vistaPrincipal(){
  const items = [
    {id:'dashboard', label:'Panel', icono:'layout-dashboard', solo:false},
    {id:'alumnos', label:'Alumnos', icono:'users', solo:false},
    {id:'cobros', label:'Cobranza', icono:'wallet', solo:false},
    {id:'caja', label:'Caja', icono:'archive', solo:false},
    {id:'estadisticas', label:'Estadísticas', icono:'bar-chart-3', solo:false},
    {id:'alertas', label:'Alertas de mora', icono:'alert-triangle', solo:false},
    {id:'config', label:'Configuración', icono:'settings', solo:true},
  ];
  const nav = items.filter(i=>!i.solo || esSuper()).map(i=>`
    <button onclick="TAB='${i.id}'; UI.sidebarAbierto=false; render();" class="nav-item ${TAB===i.id?'active':''} w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium">
      ${icon(i.icono,'w-4 h-4')} ${i.label}
    </button>`).join('');

  return `
  <div class="flex h-full w-full relative">
    ${UI.sidebarAbierto ? `<div class="fixed inset-0 bg-black/40 z-40 md:hidden" onclick="UI.sidebarAbierto=false; render();"></div>` : ''}
    <aside class="sidebar safe-top safe-bottom w-64 shrink-0 flex flex-col p-4 fixed md:static inset-y-0 left-0 z-50 transform transition-transform duration-200 ease-out ${UI.sidebarAbierto ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0">
      <div class="flex items-center gap-2 px-2 mb-6 mt-1">
        <img src="${window.LOGO_DATA_URL||''}" alt="Instituto San José" class="logo-img">
        <div>
          <span class="font-display font-bold text-white text-sm leading-tight block">Gestión de Cuotas</span>
          <span class="text-[10px] text-slate-400 leading-tight block">Instituto San José</span>
        </div>
        <button onclick="UI.sidebarAbierto=false; render();" class="ml-auto md:hidden text-slate-400">${icon('x','w-5 h-5')}</button>
      </div>
      <nav class="space-y-1 flex-1">${nav}</nav>
      <div class="border-t border-white/10 pt-3 px-2">
        <p class="text-xs text-slate-400">${SESSION.nombre}</p>
        <p class="text-xs font-semibold mb-2" style="color:#d9a99a">${SESSION.rol==='super'?'Superusuario':'Cobrador/a'}</p>
        <button onclick="logout()" class="text-xs text-slate-300 hover:text-white flex items-center gap-1 mb-3">${icon('log-out','w-3.5 h-3.5')} Cerrar sesión</button>
        <p class="text-[10px] text-slate-500 leading-tight border-t border-white/5 pt-2">Desarrollado por<br><span class="text-slate-400">Prof. Maidan Marcos Exequiel</span></p>
      </div>
    </aside>
    <div class="flex-1 flex flex-col min-w-0">
      <header class="md:hidden safe-top flex items-center gap-3 px-4 py-3 border-b bg-white sticky top-0 z-30" style="border-color:var(--border)">
        <button onclick="UI.sidebarAbierto=true; render();" class="text-gray-600">${icon('menu','w-6 h-6')}</button>
        <img src="${window.LOGO_DATA_URL||''}" alt="" class="logo-img" style="width:28px;height:30px;">
        <span class="font-display font-bold text-sm">Gestión de Cuotas</span>
      </header>
      <main class="flex-1 overflow-y-auto p-4 md:p-8">
        ${UI.alertaMsg ? `<div class="card px-4 py-3 mb-5 flex items-center justify-between text-sm anim-slide-down" style="${UI.alertaTipo==='error' ? 'border-color:#e8cec8; background:#fbeeea; color:var(--danger)' : 'border-color:#cfe0d4; background:#f0f6f0; color:var(--ok)'}"><span>${UI.alertaMsg}</span><button onclick="UI.alertaMsg=null; render();" style="color:${UI.alertaTipo==='error'?'var(--danger)':'var(--ok)'}">${icon('x','w-4 h-4')}</button></div>` : ''}
        <div class="anim-fade-slide" data-tab="${TAB}">
        ${ TAB==='dashboard' ? vistaDashboard() :
           TAB==='alumnos' ? vistaAlumnos() :
           TAB==='cobros' ? vistaCobros() :
           TAB==='caja' ? vistaCaja() :
           TAB==='estadisticas' ? vistaEstadisticas() :
           TAB==='alertas' ? vistaAlertas() :
           TAB==='config' ? vistaConfig() : '' }
        </div>
      </main>
    </div>
  </div>
  ${UI.importPreview ? modalImportPreview() : ''}
  ${UI._modalPago ? modalPago() : ''}
  `;
}

/* ---------- DASHBOARD ---------- */
function vistaDashboard(){
  const activos = STATE.alumnos.filter(a=>a.activo);
  let alDia=0, enMora=0, masDeUnMes=0;
  const periodoAct = periodoActual();
  activos.forEach(a=>{
    const r = resumenAlumno(a.id);
    if(r.cantidadPendiente===0) alDia++;
    else if(r.maxAtraso>30) masDeUnMes++;
    else enMora++;
  });
  const recaudadoMes = STATE.pagos.filter(p=>p.fecha.slice(0,7)===periodoAct).reduce((s,p)=>s+p.montoPagado,0);

  const kpi = (label, valor, iconoNombre, colorClass, filtro, accentColor, stagger)=>`
    <div class="card kpi-card anim-fade-slide ${stagger} p-5 flex items-center gap-4 ${filtro?'cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition':''}" style="--kpi-color:${accentColor}; ${UI.dashboardFiltro===filtro && filtro?'box-shadow:0 0 0 2px var(--accent);':''}" ${filtro?`onclick="UI.dashboardFiltro=(UI.dashboardFiltro==='${filtro}'?null:'${filtro}'); render();"`:''}>
      <div class="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${colorClass}">${icon(iconoNombre,'w-5 h-5')}</div>
      <div><p class="text-xs text-gray-500 font-medium">${label}</p><p class="text-xl font-display font-bold">${valor}</p></div>
    </div>`;

  return `
    <h2 class="text-2xl font-display font-bold mb-1">Panel general</h2>
    <p class="text-sm text-gray-500 mb-6">${mesNombre(periodoAct)} · hacé clic en una tarjeta para filtrar</p>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
      ${kpi('Recaudado este mes', fmtMoney(recaudadoMes), 'banknote', 'bg-[#f6ece9] text-[#8a3c30]', null, '#8a3c30', 'stagger-1')}
      ${kpi('Alumnos al día', alDia, 'check-circle-2', 'bg-[#eef5ec] text-[#5b8a53]', 'alDia', '#6b9a63', 'stagger-2')}
      ${kpi('En mora (≤ 1 mes)', enMora, 'clock', 'bg-[#faf1de] text-[#b17d2e]', 'enMora', '#c98f35', 'stagger-3')}
      ${kpi('Mora +1 mes', masDeUnMes, 'alert-triangle', 'bg-[#fbe9e5] text-[#a8493a]', 'mora1mes', '#a1483a', 'stagger-4')}
    </div>
    ${UI.dashboardFiltro ? panelFiltroDashboard() : `
    <div class="card p-5">
      <h3 class="font-display font-bold mb-4">Últimos cobros registrados</h3>
      ${tablaUltimosPagos()}
    </div>`}
  `;
}
function panelFiltroDashboard(){
  const activos = STATE.alumnos.filter(a=>a.activo);
  let lista = [], titulo = '';
  if(UI.dashboardFiltro==='alDia'){ lista = activos.filter(a=>resumenAlumno(a.id).cantidadPendiente===0); titulo = 'Alumnos al día'; }
  else if(UI.dashboardFiltro==='enMora'){ lista = activos.filter(a=>{ const r=resumenAlumno(a.id); return r.cantidadPendiente>0 && r.maxAtraso<=30; }); titulo = 'Alumnos en mora (≤ 1 mes)'; }
  else if(UI.dashboardFiltro==='mora1mes'){ lista = activos.filter(a=>resumenAlumno(a.id).maxAtraso>30); titulo = 'Alumnos con mora +1 mes'; }
  return `
    <div class="card p-5">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-display font-bold">${titulo} <span class="text-gray-400 font-normal text-sm">(${lista.length})</span></h3>
        <button onclick="UI.dashboardFiltro=null; render();" class="text-xs text-gray-500 flex items-center gap-1">${icon('x','w-3.5 h-3.5')} Cerrar</button>
      </div>
      ${lista.length===0 ? `<p class="text-sm text-gray-400">No hay alumnos en esta categoría.</p>` : `
      <div class="divide-y" style="border-color:var(--border)">
        ${lista.map(a=>{
          const r = resumenAlumno(a.id);
          return `<div class="flex items-center justify-between py-2.5 text-sm">
            <span>${a.apellidos}, ${a.nombres} <span class="text-gray-400 text-xs">· ${a.curso||''}</span></span>
            ${r.totalAdeudado>0 ? `<span class="font-semibold text-[#a1483a]">${fmtMoney(r.totalAdeudado)}</span>` : `<span class="badge-ok text-xs px-2 py-0.5 rounded-full">Al día</span>`}
          </div>`;
        }).join('')}
      </div>`}
    </div>`;
}
function tablaUltimosPagos(){
  const pagos = [...STATE.pagos].sort((a,b)=> (b.fecha).localeCompare(a.fecha)).slice(0,8);
  if(pagos.length===0) return `<p class="text-sm text-gray-400">Todavía no hay cobros registrados.</p>`;
  return `<div class="overflow-x-auto"><table class="tbl w-full text-sm"><thead><tr><th class="text-left">Alumno</th><th class="text-left">Período</th><th class="text-left">Método</th><th class="text-right">Monto</th><th class="text-left">Fecha</th><th></th></tr></thead><tbody>
    ${pagos.map(p=>{
      const a = STATE.alumnos.find(x=>x.id===p.alumnoId);
      return `<tr><td>${a?a.apellidos+', '+a.nombres:'—'}</td><td>${mesNombre(p.periodo)}</td><td>${badgeMetodo(p.metodo)}</td><td class="text-right font-medium">${fmtMoney(p.montoPagado)}</td><td>${fmtFecha(p.fecha)}</td><td class="text-right"><button onclick="generarComprobantePDF('${p.id}')" class="text-xs text-[#a1483a] font-medium whitespace-nowrap">Comprobante</button></td></tr>`;
    }).join('')}
  </tbody></table></div>`;
}

/* ---------- ALUMNOS ---------- */
function extraerAnio(curso){
  if(!curso) return 'Sin año asignado';
  const partes = curso.split(' - ');
  return partes[0].trim();
}
function agruparPorAnio(alumnos){
  const grupos = {};
  alumnos.forEach(a=>{
    const anio = extraerAnio(a.curso);
    if(!grupos[anio]) grupos[anio] = [];
    grupos[anio].push(a);
  });
  return Object.keys(grupos).sort((a,b)=>{
    const na = claveOrdenCurso(a), nb = claveOrdenCurso(b);
    return na!==nb ? na-nb : a.localeCompare(b,'es');
  }).map(anio=>({anio, alumnos:grupos[anio]}));
}
function filaAlumnoInfo(a){
  const r = resumenAlumno(a.id);
  const badge = r.cantidadPendiente===0 ? `<span class="badge-ok text-xs px-2 py-0.5 rounded-full">Al día</span>`
    : r.maxAtraso>30 ? `<span class="badge-danger text-xs px-2 py-0.5 rounded-full">Mora +1 mes</span>`
    : `<span class="badge-warn text-xs px-2 py-0.5 rounded-full">En mora</span>`;
  return `<div class="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm">
    <div class="min-w-0">
      <p class="font-medium truncate">${a.apellidos}, ${a.nombres}</p>
      <p class="text-xs text-gray-400 truncate">DNI ${a.dni||'-'}${a.tutorApellido?` · Tutor: ${a.tutorApellido} ${a.tutorNombre||''}`:''}</p>
    </div>
    <div class="flex items-center gap-3 shrink-0">
      ${r.totalAdeudado>0?`<span class="text-xs font-semibold text-[#a1483a]">${fmtMoney(r.totalAdeudado)}</span>`:''}
      ${badge}
      ${esSuper()?`<button onclick="eliminarAlumno('${a.id}')" title="Eliminar alumno" class="text-gray-400 hover:text-[#a1483a] transition">${icon('trash-2','w-4 h-4')}</button>`:''}
    </div>
  </div>`;
}
function vistaAlumnos(){
  const q = (UI.busquedaAlumnos||'').toLowerCase();
  const filtrados = STATE.alumnos.filter(a=> !q || (a.apellidos+' '+a.nombres+' '+(a.dni||'')).toLowerCase().includes(q));
  const grupos = agruparPorAnio(filtrados);
  return `
    <div class="flex items-center justify-between mb-4 flex-wrap gap-3">
      <div><h2 class="text-2xl font-display font-bold">Alumnos</h2><p class="text-sm text-gray-500">${STATE.alumnos.length} registrados · ${STATE.alumnos.filter(a=>a.activo).length} activos</p></div>
      ${esSuper() ? `
      <div class="flex items-center gap-2">
        <input type="file" id="fileCsv" accept=".csv" class="hidden" onchange="procesarCSV(this.files[0])">
        ${STATE.alumnos.length>0 ? `<button onclick="confirmarBorrarAlumnos()" class="px-3 py-2 rounded-lg text-xs font-semibold border text-[#a8493a]" style="border-color:var(--border)">Borrar todos</button>` : ''}
        <button onclick="document.getElementById('fileCsv').click()" class="btn-primary px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2">${icon('upload','w-4 h-4')} Importar CSV</button>
      </div>` : ''}
    </div>
    <input type="text" placeholder="Buscar alumno por nombre o DNI..." value="${UI.busquedaAlumnos||''}" oninput="UI.busquedaAlumnos=this.value; render();" class="max-w-sm mb-5">
    ${grupos.length===0 ? `<p class="text-gray-400 text-sm">${STATE.alumnos.length===0 ? (esSuper()?'No hay alumnos cargados todavía. Importá el CSV para comenzar.':'Pedile al superusuario que importe el listado.') : 'No se encontraron alumnos.'}</p>` :
    grupos.map(g=>{
      const abierto = !!UI.aniosAbiertos[g.anio];
      const divisiones = agruparPorCurso(g.alumnos);
      return `
      <div class="mb-4">
        <button onclick="UI.aniosAbiertos['${g.anio}']=!UI.aniosAbiertos['${g.anio}']; render();" class="w-full flex items-center justify-between text-left font-display font-bold text-sm text-gray-600 mb-2 px-1">
          <span class="flex items-center gap-2">${icon('graduation-cap','w-4 h-4 text-gray-400')} ${g.anio} <span class="text-gray-400 font-normal">(${g.alumnos.length} alumnos)</span></span>
          <span style="display:inline-flex; transition:transform .2s ease; transform:rotate(${abierto?'180deg':'0deg'});">${icon('chevron-down','w-4 h-4 text-gray-400')}</span>
        </button>
        ${abierto ? divisiones.map((d,i)=>{
          const nombreDivision = d.curso.includes(' - ') ? 'División '+d.curso.split(' - ')[1] : d.curso;
          return `
          <div class="mb-3 anim-fade-slide" style="animation-delay:${i*0.04}s">
            <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1 px-1">${nombreDivision}</p>
            <div class="card divide-y" style="border-color:var(--border)">
              ${d.alumnos.map(a=>filaAlumnoInfo(a)).join('')}
            </div>
          </div>`;
        }).join('') : ''}
      </div>`;
    }).join('')}
  `;
}

/* ---------- COBROS ---------- */
function normalizarTexto(s){ return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
function claveOrdenCurso(curso){
  const mapaOrdinal = {primer:1, primero:1, segundo:2, tercer:3, tercero:3, cuarto:4, quinto:5, sexto:6, septimo:7, octavo:8, noveno:9};
  const match = normalizarTexto(curso).match(/^(primer|primero|segundo|tercer|tercero|cuarto|quinto|sexto|septimo|octavo|noveno)/);
  return match ? (mapaOrdinal[match[1]]||99) : 99;
}
function agruparPorCurso(alumnos){
  const grupos = {};
  alumnos.forEach(a=>{
    const clave = a.curso || 'Sin curso asignado';
    if(!grupos[clave]) grupos[clave] = [];
    grupos[clave].push(a);
  });
  return Object.keys(grupos).sort((a,b)=>{
    const na = claveOrdenCurso(a), nb = claveOrdenCurso(b);
    return na!==nb ? na-nb : a.localeCompare(b,'es');
  }).map(curso=>({curso, alumnos:grupos[curso]}));
}
function badgeMetodo(metodo){
  const esEf = metodo==='efectivo';
  return `<span class="badge-${esEf?'ok':'muted'} text-xs px-2 py-0.5 rounded-full inline-flex items-center gap-1">${icon(esEf?'banknote':'landmark','w-3 h-3')}${esEf?'Efectivo':'Transferencia'}</span>`;
}
function filaCobroAlumno(a){
  const r = resumenAlumno(a.id);
  if(r.cantidadPendiente===0){
    return `<div class="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
      <span class="font-medium truncate">${a.apellidos}, ${a.nombres} <span class="text-gray-400 font-normal text-xs">· DNI ${a.dni||'-'}</span></span>
      <span class="badge-ok text-xs px-2 py-0.5 rounded-full shrink-0">Al día</span>
    </div>`;
  }
  return r.pendientes.map(c=>`
    <div class="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
      <span class="font-medium truncate">${a.apellidos}, ${a.nombres} <span class="text-gray-400 font-normal text-xs">· DNI ${a.dni||'-'}</span></span>
      <span class="flex items-center gap-2 text-xs text-gray-500 shrink-0">
        <span class="font-semibold text-gray-700">${mesNombre(c.periodo)}</span>
        ${c.diasAtraso>0?`<span>${c.diasAtraso}d atraso</span>`:''}
        ${c.pct>0?`<span class="text-[#a1483a] font-medium">+${c.pct}%</span>`:''}
        <span class="font-semibold text-gray-800">${fmtMoney(c.montoConMora)}</span>
      </span>
      <button onclick='abrirModalPago("${a.id}","${c.periodo}")' class="btn-primary px-3 py-1.5 rounded-md font-semibold flex items-center gap-1.5 shrink-0">${icon('hand-coins','w-3.5 h-3.5')} Cobrar</button>
    </div>
  `).join('');
}
function vistaCobros(){
  const q = (UI.busqueda||'').toLowerCase();
  const candidatos = STATE.alumnos.filter(a=> !q || (a.apellidos+' '+a.nombres+' '+(a.dni||'')).toLowerCase().includes(q));
  const grupos = agruparPorCurso(candidatos).map(g=>({
    curso: g.curso,
    todos: g.alumnos,
    deudores: g.alumnos.filter(a=>resumenAlumno(a.id).cantidadPendiente>0)
  }));
  return `
    <h2 class="text-2xl font-display font-bold mb-1">Cobranza de cuotas</h2>
    <p class="text-sm text-gray-500 mb-4">Agrupados por curso. Por defecto se muestran los que tienen deuda; hacé clic en un curso para ver la división completa.</p>
    <input type="text" placeholder="Buscar alumno por nombre o DNI..." value="${UI.busqueda||''}" oninput="UI.busqueda=this.value; render();" class="max-w-sm mb-5">
    ${grupos.length===0 ? `<p class="text-gray-400 text-sm">No se encontraron alumnos.</p>` :
    grupos.map(g=>{
      const abierto = !!UI.cursosAbiertos[g.curso];
      const lista = abierto ? g.todos : g.deudores;
      return `
      <div class="mb-4">
        <button onclick="UI.cursosAbiertos['${g.curso}']=!UI.cursosAbiertos['${g.curso}']; render();" class="w-full flex items-center justify-between text-left font-display font-bold text-sm text-gray-600 mb-2 px-1 group">
          <span class="flex items-center gap-2">${icon('layers','w-4 h-4 text-gray-400')} ${g.curso} <span class="text-gray-400 font-normal">(${g.deudores.length} con deuda · ${g.todos.length} en total)</span></span>
          <span style="display:inline-flex; transition:transform .2s ease; transform:rotate(${abierto?'180deg':'0deg'});">${icon('chevron-down','w-4 h-4 text-gray-400')}</span>
        </button>
        <div class="card divide-y anim-fade-slide" style="border-color:var(--border)">
          ${lista.length===0 ? `<p class="text-xs text-gray-400 p-4">${abierto?'No hay alumnos en este curso.':'Nadie debe en este curso. Hacé clic arriba para ver la división completa.'}</p>` :
            lista.map(a=>filaCobroAlumno(a)).join('')}
        </div>
      </div>`;
    }).join('')}
  `;
}
/* ---------- CAJA ---------- */
function rangoDeCaja(){
  const hoy = nuevaFechaISO();
  if(UI.cajaPreset==='hoy') return { desde:hoy, hasta:hoy };
  if(UI.cajaPreset==='semana'){
    const d = new Date(hoy+'T00:00:00');
    const diaSemana = d.getDay();
    const lunes = new Date(d); lunes.setDate(d.getDate() - ((diaSemana+6)%7));
    return { desde: lunes.toISOString().slice(0,10), hasta: hoy };
  }
  if(UI.cajaPreset==='mes') return { desde: hoy.slice(0,7)+'-01', hasta: hoy };
  return { desde: UI.cajaDesde, hasta: UI.cajaHasta };
}
function vistaCaja(){
  const { desde, hasta } = rangoDeCaja();
  const movimientos = STATE.pagos.filter(p=> p.fecha>=desde && p.fecha<=hasta).sort((a,b)=> b.fecha.localeCompare(a.fecha));
  const totalEfectivo = movimientos.filter(p=>p.metodo==='efectivo').reduce((s,p)=>s+p.montoPagado,0);
  const totalTransferencia = movimientos.filter(p=>p.metodo==='transferencia').reduce((s,p)=>s+p.montoPagado,0);
  const total = totalEfectivo + totalTransferencia;
  const presets = [ {id:'hoy', label:'Hoy'}, {id:'semana', label:'Esta semana'}, {id:'mes', label:'Este mes'}, {id:'custom', label:'Personalizado'} ];
  return `
    <div class="flex flex-wrap items-center justify-between gap-3 mb-1">
      <h2 class="text-2xl font-display font-bold">Caja</h2>
      ${movimientos.length>0 ? `<button onclick="exportarCajaPDF()" class="btn-primary px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2">${icon('file-down','w-4 h-4')} Exportar (PDF)</button>` : ''}
    </div>
    <p class="text-sm text-gray-500 mb-4">Movimientos de efectivo y transferencia del período seleccionado.</p>
    <div class="flex flex-wrap items-center gap-2 mb-5">
      ${presets.map(p=>`<button onclick="UI.cajaPreset='${p.id}'; render();" class="px-3 py-1.5 rounded-lg text-xs font-semibold border ${UI.cajaPreset===p.id?'btn-primary':''}" style="${UI.cajaPreset!==p.id?'border-color:var(--border)':''}">${p.label}</button>`).join('')}
      ${UI.cajaPreset==='custom' ? `
        <input type="date" value="${UI.cajaDesde}" onchange="UI.cajaDesde=this.value; render();" class="!w-auto">
        <span class="text-gray-400 text-xs">a</span>
        <input type="date" value="${UI.cajaHasta}" onchange="UI.cajaHasta=this.value; render();" class="!w-auto">
      ` : ''}
    </div>
    <div class="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
      <div class="card p-5"><p class="text-xs text-gray-500 font-medium mb-1">Efectivo</p><p class="text-xl font-display font-bold">${fmtMoney(totalEfectivo)}</p></div>
      <div class="card p-5"><p class="text-xs text-gray-500 font-medium mb-1">Transferencia</p><p class="text-xl font-display font-bold">${fmtMoney(totalTransferencia)}</p></div>
      <div class="card p-5 col-span-2 md:col-span-1" style="background:#faf3ee; border-color:#e8d6cd;"><p class="text-xs font-medium mb-1" style="color:#a1483a">Total del período</p><p class="text-xl font-display font-bold" style="color:#a1483a">${fmtMoney(total)}</p></div>
    </div>
    <div class="card overflow-x-auto">
      <table class="tbl w-full text-sm">
        <thead><tr><th class="text-left">Fecha</th><th class="text-left">Alumno</th><th class="text-left">Curso</th><th class="text-left">Período cuota</th><th class="text-left">Método</th><th class="text-right">Monto</th><th></th></tr></thead>
        <tbody>
        ${movimientos.length===0 ? `<tr><td colspan="7" class="text-center text-gray-400 py-8">No hay movimientos en este período.</td></tr>` :
        movimientos.map(p=>{
          const a = STATE.alumnos.find(x=>x.id===p.alumnoId);
          return `<tr>
            <td>${fmtFecha(p.fecha)}</td>
            <td>${a?a.apellidos+', '+a.nombres:'—'}</td>
            <td>${a?a.curso||'-':'-'}</td>
            <td>${mesNombre(p.periodo)}</td>
            <td>${badgeMetodo(p.metodo)}</td>
            <td class="text-right font-medium">${fmtMoney(p.montoPagado)}</td>
            <td class="text-right"><button onclick="generarComprobantePDF('${p.id}')" class="text-xs text-[#a1483a] font-medium whitespace-nowrap">Comprobante</button></td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    </div>
  `;
}
function exportarCajaPDF(){
  const { desde, hasta } = rangoDeCaja();
  const movimientos = STATE.pagos.filter(p=> p.fecha>=desde && p.fecha<=hasta).sort((a,b)=> a.fecha.localeCompare(b.fecha));
  const totalEfectivo = movimientos.filter(p=>p.metodo==='efectivo').reduce((s,p)=>s+p.montoPagado,0);
  const totalTransferencia = movimientos.filter(p=>p.metodo==='transferencia').reduce((s,p)=>s+p.montoPagado,0);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  encabezadoPDF(doc, 'Caja — ' + (desde===hasta ? fmtFecha(desde) : `${fmtFecha(desde)} al ${fmtFecha(hasta)}`));
  doc.setFontSize(10);
  doc.text(`Total efectivo: ${fmtMoney(totalEfectivo)}   ·   Total transferencia: ${fmtMoney(totalTransferencia)}   ·   Total general: ${fmtMoney(totalEfectivo+totalTransferencia)}`, 14, 46);
  doc.autoTable({
    startY: 52,
    head: [['Fecha','Alumno','Curso','Período','Método','Monto']],
    body: movimientos.map(p=>{
      const a = STATE.alumnos.find(x=>x.id===p.alumnoId);
      return [fmtFecha(p.fecha), a?`${a.apellidos}, ${a.nombres}`:'—', a?a.curso||'-':'-', mesNombre(p.periodo), p.metodo==='efectivo'?'Efectivo':'Transferencia', fmtMoney(p.montoPagado)];
    }),
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [161,72,58] },
    columnStyles: { 5: { halign:'right', fontStyle:'bold' } }
  });
  doc.save(`caja_${desde}_a_${hasta}.pdf`);
}

/* ---------- ESTADÍSTICAS ---------- */
function aniosDisponibles(){
  const anios = new Set(STATE.pagos.map(p=>p.fecha.slice(0,4)));
  anios.add(nuevaFechaISO().slice(0,4));
  return Array.from(anios).sort().reverse();
}
function statsMensuales(anio){
  const meses = Array.from({length:12}, (_,i)=>({mes:i+1, efectivo:0, transferencia:0, total:0}));
  STATE.pagos.filter(p=>p.fecha.slice(0,4)===anio).forEach(p=>{
    const idx = parseInt(p.fecha.slice(5,7),10)-1;
    meses[idx][p.metodo] = (meses[idx][p.metodo]||0) + p.montoPagado;
    meses[idx].total += p.montoPagado;
  });
  return meses;
}
function statsTrimestrales(anio){
  const mensual = statsMensuales(anio);
  const trims = [0,1,2,3].map(t=>({trimestre:t+1, efectivo:0, transferencia:0, total:0}));
  mensual.forEach((m,i)=>{
    const t = Math.floor(i/3);
    trims[t].efectivo += m.efectivo; trims[t].transferencia += m.transferencia; trims[t].total += m.total;
  });
  return trims;
}
function statsAnuales(){
  const porAnio = {};
  STATE.pagos.forEach(p=>{
    const y = p.fecha.slice(0,4);
    if(!porAnio[y]) porAnio[y] = {anio:y, efectivo:0, transferencia:0, total:0};
    porAnio[y][p.metodo] += p.montoPagado; porAnio[y].total += p.montoPagado;
  });
  return Object.values(porAnio).sort((a,b)=>b.anio.localeCompare(a.anio));
}
function barraComparativa(label, item, max){
  const pctEf = max>0 ? (item.efectivo/max*100) : 0;
  const pctTr = max>0 ? (item.transferencia/max*100) : 0;
  return `
    <div class="mb-3">
      <div class="flex items-center justify-between text-xs mb-1">
        <span class="font-medium text-gray-600">${label}</span>
        <span class="font-semibold">${fmtMoney(item.total)}</span>
      </div>
      <div class="w-full h-2.5 rounded-full overflow-hidden flex bg-[#f1eee6]">
        <div style="width:${pctEf}%; background:#6b9a63;" title="Efectivo: ${fmtMoney(item.efectivo)}"></div>
        <div style="width:${pctTr}%; background:#a1483a;" title="Transferencia: ${fmtMoney(item.transferencia)}"></div>
      </div>
    </div>`;
}
function distribucionAlumnos(){
  const activos = STATE.alumnos.filter(a=>a.activo);
  let alDia=0, debenSinInteres=0, debenConInteres=0;
  activos.forEach(a=>{
    const r = resumenAlumno(a.id);
    if(r.cantidadPendiente===0){ alDia++; return; }
    const conInteres = r.pendientes.some(c=>c.pct>0);
    if(conInteres) debenConInteres++; else debenSinInteres++;
  });
  return { alDia, debenSinInteres, debenConInteres, total: activos.length };
}
function graficoTortaAlumnos(){
  const d = distribucionAlumnos();
  const total = Math.max(1, d.total);
  const p1 = d.alDia/total*100;
  const p2 = d.debenSinInteres/total*100;
  const gradiente = `conic-gradient(#6b9a63 0% ${p1}%, #c98f35 ${p1}% ${p1+p2}%, #a1483a ${p1+p2}% 100%)`;
  return `
    <div class="card p-5 mb-6">
      <h3 class="font-display font-bold mb-4">Distribución de alumnos</h3>
      <div class="flex flex-wrap items-center gap-8">
        <div class="shrink-0 anim-fade-scale" style="width:140px;height:140px;position:relative;">
          <div style="position:absolute; top:0; left:0; right:0; bottom:0; border-radius:9999px; background:${gradiente};"></div>
          <div style="position:absolute; top:24px; left:24px; right:24px; bottom:24px; border-radius:9999px; background:var(--panel); display:flex; align-items:center; justify-content:center; text-align:center;">
            <div><p class="text-lg font-display font-bold">${d.total}</p><p class="text-[10px] text-gray-400">alumnos activos</p></div>
          </div>
        </div>
        <div class="space-y-2.5 text-sm">
          <p class="flex items-center gap-2"><span class="w-3 h-3 rounded-full inline-block shrink-0" style="background:#6b9a63"></span>Al día — <span class="font-semibold">${d.alDia}</span></p>
          <p class="flex items-center gap-2"><span class="w-3 h-3 rounded-full inline-block shrink-0" style="background:#c98f35"></span>Deben, sin mora todavía — <span class="font-semibold">${d.debenSinInteres}</span></p>
          <p class="flex items-center gap-2"><span class="w-3 h-3 rounded-full inline-block shrink-0" style="background:#a1483a"></span>Deben con interés aplicado — <span class="font-semibold">${d.debenConInteres}</span></p>
        </div>
      </div>
    </div>`;
}
function vistaEstadisticas(){
  const anios = aniosDisponibles();
  const anio = UI.statsAnio || anios[0];
  const mensual = statsMensuales(anio);
  const trimestral = statsTrimestrales(anio);
  const anual = statsAnuales();
  const nombresMes = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const maxMensual = Math.max(1, ...mensual.map(m=>m.total));
  const maxTrimestral = Math.max(1, ...trimestral.map(t=>t.total));
  const maxAnual = Math.max(1, ...anual.map(a=>a.total));
  const totalAnioSel = mensual.reduce((s,m)=>s+m.total,0);
  return `
    <div class="flex flex-wrap items-center justify-between gap-3 mb-1">
      <h2 class="text-2xl font-display font-bold">Estadísticas</h2>
      <select onchange="UI.statsAnio=this.value; render();" class="!w-auto text-sm">
        ${anios.map(a=>`<option value="${a}" ${a===anio?'selected':''}>${a}</option>`).join('')}
      </select>
    </div>
    <p class="text-sm text-gray-500 mb-6">Total recaudado en ${anio}: <span class="font-semibold" style="color:#a1483a">${fmtMoney(totalAnioSel)}</span></p>

    ${graficoTortaAlumnos()}

    <div class="flex items-center gap-4 text-xs text-gray-500 mb-3">
      <span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full inline-block" style="background:#6b9a63"></span> Efectivo</span>
      <span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full inline-block" style="background:#a1483a"></span> Transferencia</span>
    </div>

    <div class="card p-5 mb-6">
      <h3 class="font-display font-bold mb-4">Mensual</h3>
      ${mensual.map((m,i)=> barraComparativa(nombresMes[i], m, maxMensual)).join('')}
    </div>

    <div class="card p-5 mb-6">
      <h3 class="font-display font-bold mb-4">Trimestral</h3>
      ${trimestral.map(t=> barraComparativa('T'+t.trimestre, t, maxTrimestral)).join('')}
    </div>

    <div class="card p-5">
      <h3 class="font-display font-bold mb-4">Anual</h3>
      ${anual.length===0 ? `<p class="text-sm text-gray-400">Todavía no hay cobros registrados.</p>` :
        anual.map(a=> barraComparativa(a.anio, a, maxAnual)).join('')}
    </div>
  `;
}

function abrirModalPago(alumnoId, periodo){ UI._modalPago = { alumnoId, periodo, metodo:'efectivo' }; render(); }
function cerrarModalPago(){ UI._modalPago=null; render(); }
// A propósito NO llama a render(): si volviera a dibujar el modal entero, la animación
// de entrada se repetiría en cada clic y se vería como un destello molesto.
function seleccionarMetodoPago(metodo){
  UI._modalPago.metodo = metodo;
  const btnEf = document.getElementById('btnMetodoEfectivo');
  const btnTr = document.getElementById('btnMetodoTransferencia');
  const activar = (btn)=>{ btn.classList.add('btn-primary'); btn.style.borderColor = ''; };
  const desactivar = (btn)=>{ btn.classList.remove('btn-primary'); btn.style.borderColor = 'var(--border)'; };
  if(metodo==='efectivo'){ activar(btnEf); desactivar(btnTr); }
  else{ activar(btnTr); desactivar(btnEf); }
}
function modalPago(){
  const {alumnoId, periodo, metodo} = UI._modalPago;
  const a = STATE.alumnos.find(x=>x.id===alumnoId);
  const c = cuotasDeAlumno(alumnoId).find(x=>x.periodo===periodo);
  return `
  <div class="fixed inset-0 modal-bg anim-fade flex items-center justify-center z-50" onclick="if(event.target===this) cerrarModalPago()">
    <div class="card anim-pop w-full max-w-md p-6">
      <h3 class="font-display font-bold text-lg mb-1">Registrar cobro</h3>
      <p class="text-sm text-gray-500 mb-4">${a.apellidos}, ${a.nombres} — ${mesNombre(periodo)}</p>
      <div class="bg-gray-50 rounded-lg p-3 mb-4 text-sm space-y-1">
        <div class="flex justify-between"><span class="text-gray-500">Cuota base</span><span>${fmtMoney(c.montoBase)}</span></div>
        <div class="flex justify-between"><span class="text-gray-500">Recargo por mora (${c.pct}%)</span><span>${fmtMoney(c.montoConMora-c.montoBase)}</span></div>
        <div class="flex justify-between font-semibold border-t pt-1 mt-1" style="border-color:var(--border)"><span>Total a cobrar</span><span>${fmtMoney(c.montoConMora)}</span></div>
      </div>
      <label class="lbl">Método de pago</label>
      <div class="grid grid-cols-2 gap-2 mb-4">
        <button id="btnMetodoEfectivo" onclick="seleccionarMetodoPago('efectivo')" class="py-2 rounded-lg text-sm font-semibold border flex items-center justify-center gap-2 ${metodo==='efectivo'?'btn-primary':''}" style="${metodo!=='efectivo'?'border-color:var(--border)':''}">${icon('banknote','w-4 h-4')} Efectivo</button>
        <button id="btnMetodoTransferencia" onclick="seleccionarMetodoPago('transferencia')" class="py-2 rounded-lg text-sm font-semibold border flex items-center justify-center gap-2 ${metodo==='transferencia'?'btn-primary':''}" style="${metodo!=='transferencia'?'border-color:var(--border)':''}">${icon('landmark','w-4 h-4')} Transferencia</button>
      </div>
      <div class="flex gap-2 mt-5">
        <button onclick="cerrarModalPago()" class="flex-1 py-2 rounded-lg text-sm font-semibold border" style="border-color:var(--border)">Cancelar</button>
        <button onclick='registrarPago({alumnoId:"${alumnoId}", periodo:"${periodo}", metodo: UI._modalPago.metodo, montoPagado:${c.montoConMora}})' class="flex-1 btn-primary py-2 rounded-lg text-sm font-semibold">Confirmar cobro</button>
      </div>
    </div>
  </div>`;
}

/* ---------- ALERTAS ---------- */
function vistaAlertas(){
  const conAlerta = STATE.alumnos.filter(a=>a.activo).map(a=>({a, r:resumenAlumno(a.id)})).filter(x=>x.r.maxAtraso>30);
  return `
    <div class="flex flex-wrap items-center justify-between gap-3 mb-1">
      <h2 class="text-2xl font-display font-bold">Alertas de mora</h2>
      <button onclick="exportarDeudoresPDF()" class="btn-primary px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2">${icon('file-down','w-4 h-4')} Exportar deudores (PDF)</button>
    </div>
    <p class="text-sm text-gray-500 mb-6">Alumnos con cuotas pendientes hace más de un mes (30+ días de atraso). El PDF exporta a todos los que tienen alguna deuda, no solo estos.</p>
    ${conAlerta.length===0 ? `<div class="card p-8 text-center text-gray-400 anim-fade-slide"><span class="inline-block anim-check">${icon('check-circle-2','w-8 h-8 mx-auto mb-2 text-[#6b9a63]')}</span><p>No hay alumnos con más de un mes de mora.</p></div>` : `
    <div class="space-y-3">
      ${conAlerta.sort((x,y)=>y.r.maxAtraso-x.r.maxAtraso).map(({a,r})=>`
        <div class="card p-4 border-l-4" style="border-left-color:var(--danger)">
          <div class="flex items-center justify-between">
            <div>
              <p class="font-semibold text-sm">${a.apellidos}, ${a.nombres} <span class="text-gray-400 font-normal">· ${a.curso||''}</span></p>
              <p class="text-xs text-gray-500 mt-0.5">Tutor: ${a.tutorApellido||''} ${a.tutorNombre||''} · Tel: ${a.telefonoTutor||a.telefono||'sin dato'}</p>
            </div>
            <div class="text-right">
              <p class="text-[#a1483a] font-bold">${fmtMoney(r.totalAdeudado)}</p>
              <p class="text-xs text-gray-500">${r.maxAtraso} días de atraso · ${r.cantidadPendiente} cuota(s)</p>
            </div>
          </div>
        </div>
      `).join('')}
    </div>`}
  `;
}

/* ---------- CONFIGURACIÓN ---------- */
function vistaConfig(){
  if(!esSuper()) return `<p class="text-gray-400">No tenés permisos para ver esta sección.</p>`;
  const c = STATE.config;
  return `
    <h2 class="text-2xl font-display font-bold mb-6">Configuración</h2>
    <div class="grid md:grid-cols-2 gap-6">
      <div class="card p-5">
        <h3 class="font-display font-bold mb-4">Cuota mensual</h3>
        <label class="lbl">Monto de la cuota</label>
        <input type="number" id="cfgMonto" value="${c.montoCuota}" class="mb-3">
        <label class="lbl">Día de vencimiento (del mes)</label>
        <input type="number" min="1" max="28" id="cfgDia" value="${c.diaVencimiento}" class="mb-3">
        <label class="lbl">Mes desde el que se cobra</label>
        <input type="month" id="cfgPeriodo" value="${c.periodoInicio}" class="mb-4">
        <button onclick="guardarCuota()" class="btn-primary px-4 py-2 rounded-lg text-sm font-semibold">Guardar</button>
      </div>
      <div class="card p-5">
        <h3 class="font-display font-bold mb-4">Regla de mora</h3>
        <label class="lbl">% por cada bloque de 10 días (dentro del primer mes)</label>
        <input type="number" id="cfgPct10" value="${c.mora.porcentajePor10Dias}" class="mb-3">
        <label class="lbl">Bloques de 10 días dentro del mes (tope)</label>
        <input type="number" id="cfgTope" value="${c.mora.topeBloques}" class="mb-3">
        <label class="lbl">% mensual adicional después del primer mes</label>
        <input type="number" id="cfgPctMes" value="${c.mora.porcentajeMensualExtra}" class="mb-4">
        <button onclick="guardarMora()" class="btn-primary px-4 py-2 rounded-lg text-sm font-semibold">Guardar</button>
      </div>
    </div>
    <div class="card p-5 mt-6">
      <h3 class="font-display font-bold mb-4 flex items-center gap-2">${icon('shield','w-4 h-4 text-gray-400')} Seguridad de sesión</h3>
      <div class="grid sm:grid-cols-2 gap-4">
        <div>
          <label class="lbl">Cerrar sesión sola tras inactividad (minutos)</label>
          <input type="number" min="1" id="cfgInactividad" value="${c.sesionInactividadMin}">
        </div>
        <div>
          <label class="lbl">Duración máxima de la sesión (horas)</label>
          <input type="number" min="1" id="cfgSesionMax" value="${c.sesionMaximaHoras}">
        </div>
      </div>
      <p class="text-xs text-gray-400 mt-2 mb-3">Por manejar cobros de dinero, la app pide las credenciales de nuevo pasado este tiempo, aunque el celular o la compu queden abiertos.</p>
      <button onclick="guardarSeguridad()" class="btn-primary px-4 py-2 rounded-lg text-sm font-semibold">Guardar</button>
    </div>
    <div class="card p-5 mt-6">
      <h3 class="font-display font-bold mb-4 flex items-center gap-2">${icon('download','w-4 h-4 text-gray-400')} Respaldo</h3>
      <p class="text-sm text-gray-500 mb-3">Descarga un archivo con todos los alumnos, pagos, configuración y usuarios tal como están en este momento.</p>
      <button onclick="descargarRespaldo()" class="btn-primary px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2">${icon('download','w-4 h-4')} Descargar respaldo ahora</button>
      <p class="text-xs text-gray-400 mt-3">Guardalo en Google Drive, en tu PC, o donde te resulte más cómodo. Como no es automático, conviene hacerlo con alguna frecuencia (por ejemplo, una vez por semana) para no perder registros importantes.</p>
    </div>
    <div class="card p-5 mt-6">
      <h3 class="font-display font-bold mb-4">Usuarios</h3>
      <table class="tbl w-full text-sm mb-4">
        <thead><tr><th class="text-left">Usuario</th><th class="text-left">Nombre</th><th class="text-left">Rol</th><th></th></tr></thead>
        <tbody>${(STATE.perfiles||[]).filter(u=>u.email!==EMAIL_PROTEGIDO).map(u=>`
          <tr><td>${u.usuario||u.email}</td><td>${u.nombre}</td><td>${u.rol==='super'?'Superusuario':'Cobrador/a'}</td>
          <td class="text-right whitespace-nowrap">
            <button onclick="resetearClaveUsuario('${u.id}','${(u.usuario||u.email||'').replace(/'/g,"\\'")}')" class="text-xs mr-3" style="color:var(--accent)">Cambiar contraseña</button>
            ${u.id!==SESSION.id?`<button onclick="eliminarUsuario('${u.id}')" class="text-[#a8493a] text-xs">Eliminar</button>`:''}
          </td></tr>
        `).join('')}</tbody>
      </table>
      <div class="grid sm:grid-cols-4 gap-2">
        <input type="text" id="nuUsuario" placeholder="usuario (ej: jperez)" autocapitalize="none">
        <input type="text" id="nuNombre" placeholder="nombre completo">
        <input type="password" id="nuClave" placeholder="contraseña">
        <select id="nuRol"><option value="cobrador">Cobrador/a</option><option value="super">Superusuario</option></select>
      </div>
      <button onclick="agregarUsuario()" class="btn-primary px-4 py-2 rounded-lg text-sm font-semibold mt-3">Agregar usuario</button>
      <p class="text-xs text-gray-400 mt-2">No hace falta email: elegís un usuario simple (sin espacios ni "@") y una contraseña, y esa persona ya puede entrar con eso. Si alguien se olvida la contraseña, usá "Cambiar contraseña" en su fila. Eliminar un usuario acá quita su acceso a la app; para borrarlo por completo de Authentication, hacelo desde la consola de Firebase.</p>
    </div>
  `;
}
async function guardarSeguridad(){
  const sesionInactividadMin = Number(document.getElementById('cfgInactividad').value)||15;
  const sesionMaximaHoras = Number(document.getElementById('cfgSesionMax').value)||8;
  try{
    await db.collection('configuracion').doc('general').set({ sesionInactividadMin, sesionMaximaHoras }, {merge:true});
    STATE.config.sesionInactividadMin = sesionInactividadMin;
    STATE.config.sesionMaximaHoras = sesionMaximaHoras;
    UI.alertaMsg = 'Configuración de seguridad guardada.'; UI.alertaTipo='ok';
  }catch(e){ UI.alertaMsg = 'Error: '+e.message; UI.alertaTipo='error'; }
  render();
}
function descargarRespaldo(){
  try{
    const respaldo = {
      generado: new Date().toISOString(),
      institucion: 'Instituto San José - Quines, San Luis',
      config: STATE.config,
      alumnos: STATE.alumnos,
      pagos: STATE.pagos,
      usuarios: (STATE.perfiles||[]).map(u=>({ id:u.id, usuario:u.usuario||null, email:u.email, nombre:u.nombre, rol:u.rol }))
    };
    const blob = new Blob([JSON.stringify(respaldo, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `respaldo-cuotas-${nuevaFechaISO()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    UI.alertaMsg = 'Respaldo descargado. Guardalo en Google Drive, tu PC o donde prefieras.'; UI.alertaTipo='ok';
  }catch(e){
    UI.alertaMsg = 'Error al generar el respaldo: '+e.message; UI.alertaTipo='error';
  }
  render();
}
async function guardarCuota(){
  const montoCuota = Number(document.getElementById('cfgMonto').value)||0;
  const diaVencimiento = Number(document.getElementById('cfgDia').value)||10;
  const periodoInicio = document.getElementById('cfgPeriodo').value || STATE.config.periodoInicio;
  try{
    await db.collection('configuracion').doc('general').set({ montoCuota, diaVencimiento, periodoInicio }, {merge:true});
    STATE.config.montoCuota = montoCuota; STATE.config.diaVencimiento = diaVencimiento; STATE.config.periodoInicio = periodoInicio;
    UI.alertaMsg='Configuración de cuota guardada.'; UI.alertaTipo='ok';
  }catch(e){ UI.alertaMsg='Error: '+e.message; UI.alertaTipo='error'; }
  render();
}
async function guardarMora(){
  const porcentajePor10Dias = Number(document.getElementById('cfgPct10').value)||0;
  const topeBloques = Number(document.getElementById('cfgTope').value)||3;
  const porcentajeMensualExtra = Number(document.getElementById('cfgPctMes').value)||0;
  try{
    await db.collection('configuracion').doc('general').set({ mora: { porcentajePor10Dias, topeBloques, porcentajeMensualExtra } }, {merge:true});
    STATE.config.mora = { porcentajePor10Dias, topeBloques, porcentajeMensualExtra };
    UI.alertaMsg='Regla de mora actualizada.'; UI.alertaTipo='ok';
  }catch(e){ UI.alertaMsg='Error: '+e.message; UI.alertaTipo='error'; }
  render();
}
async function agregarUsuario(){
  const usuarioInput=document.getElementById('nuUsuario').value.trim();
  const nombre=document.getElementById('nuNombre').value.trim();
  const clave=document.getElementById('nuClave').value;
  const rol=document.getElementById('nuRol').value;
  if(!usuarioInput||!clave) return;
  if(/[@\s]/.test(usuarioInput)){
    UI.alertaMsg = 'El usuario no puede tener espacios ni "@". Elegí algo simple, como "jperez".';
    UI.alertaTipo='error'; render(); return;
  }
  if(clave.length<6){
    UI.alertaMsg = 'La contraseña tiene que tener al menos 6 caracteres.';
    UI.alertaTipo='error'; render(); return;
  }
  const usuario = usuarioInput.toLowerCase();
  const email = usuario + '@' + DOMINIO_INTERNO;
  try{
    const resp = await fetch('/api/crear-usuario', {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Authorization': 'Bearer '+SESSION.access_token},
      body: JSON.stringify({email, usuario, password:clave, nombre, rol})
    });
    let data;
    try{
      data = await resp.json();
    }catch(parseErr){
      throw new Error(`La función del servidor falló (código ${resp.status}) y no devolvió una respuesta válida. Revisá en Vercel: Deployments → el último deploy → Runtime Logs, ahí debería verse el motivo exacto.`);
    }
    if(!resp.ok) throw new Error(data.error||'No se pudo crear el usuario');
    await cargarPerfiles();
    UI.alertaMsg = `Usuario "${usuario}" creado. Ya puede ingresar con ese usuario y la contraseña que definiste.`; UI.alertaTipo='ok';
  }catch(e){
    UI.alertaMsg = 'Error: '+e.message; UI.alertaTipo='error';
  }
  render();
}
async function resetearClaveUsuario(id, nombreUsuario){
  const nueva = window.prompt(`Nueva contraseña para "${nombreUsuario}" (mínimo 6 caracteres):`);
  if(!nueva) return;
  if(nueva.length<6){
    UI.alertaMsg = 'La contraseña tiene que tener al menos 6 caracteres.'; UI.alertaTipo='error'; render(); return;
  }
  try{
    const resp = await fetch('/api/resetear-clave', {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Authorization': 'Bearer '+SESSION.access_token},
      body: JSON.stringify({ uid:id, password:nueva })
    });
    let data;
    try{
      data = await resp.json();
    }catch(parseErr){
      throw new Error(`La función del servidor falló (código ${resp.status}) y no devolvió una respuesta válida. Revisá los Runtime Logs en Vercel.`);
    }
    if(!resp.ok) throw new Error(data.error||'No se pudo cambiar la contraseña');
    UI.alertaMsg = `Contraseña actualizada para "${nombreUsuario}".`; UI.alertaTipo='ok';
  }catch(e){
    UI.alertaMsg = 'Error: '+e.message; UI.alertaTipo='error';
  }
  render();
}
async function eliminarUsuario(id){
  if(id === SESSION.id){ UI.alertaMsg='No podés eliminar tu propio usuario.'; UI.alertaTipo='error'; render(); return; }
  const perfil = (STATE.perfiles||[]).find(p=>p.id===id);
  if(perfil && perfil.email===EMAIL_PROTEGIDO){ UI.alertaMsg='Esa cuenta no se puede eliminar desde acá.'; UI.alertaTipo='error'; render(); return; }
  try{
    await db.collection('usuarios').doc(id).delete();
    STATE.perfiles = STATE.perfiles.filter(p=>p.id!==id);
  }catch(e){ UI.alertaMsg = 'Error: '+e.message; UI.alertaTipo='error'; }
  render();
}

/* ---------- MODAL IMPORTACIÓN ---------- */
function modalImportPreview(){
  const filas = UI.importPreview;
  return `
  <div class="fixed inset-0 modal-bg anim-fade flex items-center justify-center z-50">
    <div class="card anim-pop w-full max-w-3xl max-h-[85vh] flex flex-col p-6">
      <h3 class="font-display font-bold text-lg mb-1">Previsualización de importación</h3>
      <p class="text-sm text-gray-500 mb-4">${filas.length} filas detectadas. Revisá antes de confirmar.</p>
      <div class="overflow-auto border rounded-lg flex-1" style="border-color:var(--border)">
        <table class="tbl w-full text-xs">
          <thead><tr><th class="text-left">Apellido</th><th class="text-left">Nombre</th><th class="text-left">DNI</th><th class="text-left">Curso</th><th class="text-left">Turno</th><th class="text-left">Tutor/Contacto</th></tr></thead>
          <tbody>${filas.slice(0,50).map(f=>`<tr><td>${f.apellidos}</td><td>${f.nombres}</td><td>${f.dni}</td><td>${f.curso}</td><td>${f.turno}</td><td>${f.tutorApellido} ${f.tutorNombre} · ${f.telefonoTutor||f.telefono}</td></tr>`).join('')}</tbody>
        </table>
      </div>
      ${filas.length>50?`<p class="text-xs text-gray-400 mt-2">Mostrando las primeras 50 de ${filas.length} filas.</p>`:''}
      <div class="flex gap-2 mt-5">
        <button onclick="UI.importPreview=null; render();" class="flex-1 py-2 rounded-lg text-sm font-semibold border" style="border-color:var(--border)">Cancelar</button>
        <button onclick="confirmarImportacion()" class="flex-1 btn-primary py-2 rounded-lg text-sm font-semibold">Confirmar importación</button>
      </div>
    </div>
  </div>`;
}

/* ======================= ARRANQUE ======================= */
render(); // muestra "Cargando..." mientras Firebase resuelve la sesión
initApp();
