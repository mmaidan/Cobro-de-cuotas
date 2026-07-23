/* ======================= FIREBASE ======================= */
firebase.initializeApp(window.CONFIG.firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

/* ======================= ESTADO EN MEMORIA ======================= */
let STATE = { config: null, alumnos: [], pagos: [], perfiles: [] };
let SESSION = null; // { id, email, rol, nombre, access_token }
let TAB = 'dashboard';
let UI = { alertaMsg:null, alertaLogin:null, importPreview:null, importEncoding:'utf-8', cargando:true, busqueda:'', _modalPago:null, sidebarAbierto:false };

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
  if(!c) return { montoCuota:15000, diaVencimiento:10, periodoInicio:periodoActual(), mora:{porcentajePor10Dias:10, topeBloques:3, porcentajeMensualExtra:5} };
  return {
    montoCuota: Number(c.montoCuota),
    diaVencimiento: Number(c.diaVencimiento),
    periodoInicio: c.periodoInicio,
    mora: {
      porcentajePor10Dias: Number(c.mora?.porcentajePor10Dias ?? 10),
      topeBloques: Number(c.mora?.topeBloques ?? 3),
      porcentajeMensualExtra: Number(c.mora?.porcentajeMensualExtra ?? 5)
    }
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
    SESSION = { id: user.uid, email: user.email, rol: perfil.rol, nombre: perfil.nombre, access_token: token };
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
async function login(email, clave){
  try{
    const cred = await auth.signInWithEmailAndPassword(email, clave);
    await establecerSesion(cred.user);
    return !!SESSION;
  }catch(e){ return false; }
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
function procesarCSV(file){
  const reader = new FileReader();
  reader.onload = function(e){
    Papa.parse(e.target.result, {
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
  };
  if(UI.importEncoding==='latin1'){ reader.readAsText(file, 'ISO-8859-1'); }
  else{ reader.readAsText(file, 'UTF-8'); }
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
    UI.alertaMsg = `Se importaron ${creados.length} alumnos (${omitidos} omitidos por DNI duplicado).`;
  }catch(e){
    UI.alertaMsg = 'Error al importar: '+e.message;
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
    UI.alertaMsg = 'Cobro registrado correctamente.';
  }catch(e){
    UI.alertaMsg = 'Error al registrar el cobro: '+e.message;
  }
  render();
}
async function anularPago(pagoId){
  try{
    await db.collection('pagos').doc(pagoId).delete();
    STATE.pagos = STATE.pagos.filter(p=>p.id!==pagoId);
  }catch(e){ UI.alertaMsg = 'Error: '+e.message; }
  render();
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
  <div class="h-full w-full flex items-center justify-center px-4" style="background:radial-gradient(circle at 30% 20%, #7695bb 0%, #1e293f 70%);">
    <div class="card w-full max-w-sm p-6 sm:p-8">
      <div class="flex items-center gap-3 mb-1">
        <img src="${window.LOGO_DATA_URL||''}" alt="Instituto San José" class="logo-img" style="background:transparent; padding:0;">
        <div>
          <h1 class="text-lg sm:text-xl font-display font-bold leading-tight">Gestión de Cuotas</h1>
          <p class="text-xs text-gray-400">Instituto San José · Quines, San Luis</p>
        </div>
      </div>
      <p class="text-sm text-gray-500 mt-3 mb-6">Control y cobro de cuotas escolares</p>
      ${UI.alertaLogin ? `<div class="badge-danger text-xs rounded-lg p-3 mb-4">${UI.alertaLogin}</div>` : ''}
      <form id="loginForm" onsubmit="manejarLogin(event)">
        <label class="lbl">Email</label>
        <input id="lu" type="text" class="mb-3" placeholder="tu@email.com" autofocus>
        <label class="lbl">Contraseña</label>
        <input id="lc" type="password" class="mb-1" placeholder="••••••••">
        <button type="submit" id="loginBtn" class="btn-primary w-full mt-4 py-2.5 rounded-lg font-semibold text-sm">Ingresar</button>
      </form>
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
    {id:'cobros', label:'Cobros', icono:'wallet', solo:false},
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
          <span class="font-display font-bold text-white text-base leading-tight block">Cuotas</span>
          <span class="text-[10px] text-slate-400 leading-tight block">Instituto San José</span>
        </div>
        <button onclick="UI.sidebarAbierto=false; render();" class="ml-auto md:hidden text-slate-400">${icon('x','w-5 h-5')}</button>
      </div>
      <nav class="space-y-1 flex-1">${nav}</nav>
      <div class="border-t border-white/10 pt-3 px-2">
        <p class="text-xs text-slate-400">${SESSION.nombre}</p>
        <p class="text-xs font-semibold mb-2" style="color:#8fb0d6">${SESSION.rol==='super'?'Superusuario':'Cobrador/a'}</p>
        <button onclick="logout()" class="text-xs text-slate-300 hover:text-white flex items-center gap-1">${icon('log-out','w-3.5 h-3.5')} Cerrar sesión</button>
      </div>
    </aside>
    <div class="flex-1 flex flex-col min-w-0">
      <header class="md:hidden safe-top flex items-center gap-3 px-4 py-3 border-b bg-white sticky top-0 z-30" style="border-color:var(--border)">
        <button onclick="UI.sidebarAbierto=true; render();" class="text-gray-600">${icon('menu','w-6 h-6')}</button>
        <img src="${window.LOGO_DATA_URL||''}" alt="" class="logo-img" style="width:28px;height:30px;">
        <span class="font-display font-bold text-sm">Gestión de Cuotas</span>
      </header>
      <main class="flex-1 overflow-y-auto p-4 md:p-8">
        ${UI.alertaMsg ? `<div class="card px-4 py-3 mb-5 flex items-center justify-between text-sm" style="border-color:#cfe0d4; background:#f0f6f0; color:var(--ok)"><span>${UI.alertaMsg}</span><button onclick="UI.alertaMsg=null; render();" style="color:var(--ok)">${icon('x','w-4 h-4')}</button></div>` : ''}
        ${ TAB==='dashboard' ? vistaDashboard() :
           TAB==='alumnos' ? vistaAlumnos() :
           TAB==='cobros' ? vistaCobros() :
           TAB==='alertas' ? vistaAlertas() :
           TAB==='config' ? vistaConfig() : '' }
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

  const kpi = (label, valor, iconoNombre, colorClass)=>`
    <div class="card p-5 flex items-center gap-4">
      <div class="w-11 h-11 rounded-xl flex items-center justify-center ${colorClass}">${icon(iconoNombre,'w-5 h-5')}</div>
      <div><p class="text-xs text-gray-500 font-medium">${label}</p><p class="text-xl font-display font-bold">${valor}</p></div>
    </div>`;

  return `
    <h2 class="text-2xl font-display font-bold mb-1">Panel general</h2>
    <p class="text-sm text-gray-500 mb-6">${mesNombre(periodoAct)}</p>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
      ${kpi('Recaudado este mes', fmtMoney(recaudadoMes), 'banknote', 'bg-[#eaf1f7] text-[#46658a]')}
      ${kpi('Alumnos al día', alDia, 'check-circle-2', 'bg-[#eef5ec] text-[#5b8a53]')}
      ${kpi('En mora (≤ 1 mes)', enMora, 'clock', 'bg-[#faf1de] text-[#b17d2e]')}
      ${kpi('Mora +1 mes', masDeUnMes, 'alert-triangle', 'bg-[#fbe9e5] text-[#a8493a]')}
    </div>
    <div class="card p-5">
      <h3 class="font-display font-bold mb-4">Últimos cobros registrados</h3>
      ${tablaUltimosPagos()}
    </div>
  `;
}
function tablaUltimosPagos(){
  const pagos = [...STATE.pagos].sort((a,b)=> (b.fecha).localeCompare(a.fecha)).slice(0,8);
  if(pagos.length===0) return `<p class="text-sm text-gray-400">Todavía no hay cobros registrados.</p>`;
  return `<table class="tbl w-full text-sm"><thead><tr><th class="text-left">Alumno</th><th class="text-left">Período</th><th class="text-left">Método</th><th class="text-right">Monto</th><th class="text-left">Fecha</th></tr></thead><tbody>
    ${pagos.map(p=>{
      const a = STATE.alumnos.find(x=>x.id===p.alumnoId);
      return `<tr><td>${a?a.apellidos+', '+a.nombres:'—'}</td><td>${mesNombre(p.periodo)}</td><td><span class="badge-${p.metodo==='efectivo'?'ok':'muted'} text-xs px-2 py-0.5 rounded-full">${p.metodo==='efectivo'?'Efectivo':'Transferencia'}</span></td><td class="text-right font-medium">${fmtMoney(p.montoPagado)}</td><td>${fmtFecha(p.fecha)}</td></tr>`;
    }).join('')}
  </tbody></table>`;
}

/* ---------- ALUMNOS ---------- */
function vistaAlumnos(){
  return `
    <div class="flex items-center justify-between mb-6">
      <div><h2 class="text-2xl font-display font-bold">Alumnos</h2><p class="text-sm text-gray-500">${STATE.alumnos.length} registrados · ${STATE.alumnos.filter(a=>a.activo).length} activos</p></div>
      ${esSuper() ? `
      <div>
        <input type="file" id="fileCsv" accept=".csv" class="hidden" onchange="procesarCSV(this.files[0])">
        <div class="flex items-center gap-2">
          <select id="encSelect" onchange="UI.importEncoding=this.value" class="!w-auto text-xs">
            <option value="utf-8" ${UI.importEncoding==='utf-8'?'selected':''}>Codificación: UTF-8</option>
            <option value="latin1" ${UI.importEncoding==='latin1'?'selected':''}>Codificación: Latin-1 (Excel/Windows)</option>
          </select>
          <button onclick="document.getElementById('fileCsv').click()" class="btn-primary px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2">${icon('upload','w-4 h-4')} Importar CSV</button>
        </div>
      </div>` : ''}
    </div>
    <div class="card overflow-x-auto">
      <table class="tbl w-full text-sm">
        <thead><tr><th class="text-left">Apellido y Nombre</th><th class="text-left">DNI</th><th class="text-left">Curso</th><th class="text-left">Turno</th><th class="text-left">Tutor</th><th class="text-right">Deuda</th><th class="text-center">Estado</th></tr></thead>
        <tbody>
        ${STATE.alumnos.length===0 ? `<tr><td colspan="7" class="text-center text-gray-400 py-8">No hay alumnos cargados todavía. ${esSuper()?'Importá el CSV para comenzar.':'Pedile al superusuario que importe el listado.'}</td></tr>` :
        STATE.alumnos.map(a=>{
          const r = resumenAlumno(a.id);
          const badge = r.cantidadPendiente===0 ? `<span class="badge-ok text-xs px-2 py-0.5 rounded-full">Al día</span>`
            : r.maxAtraso>30 ? `<span class="badge-danger text-xs px-2 py-0.5 rounded-full">Mora +1 mes</span>`
            : `<span class="badge-warn text-xs px-2 py-0.5 rounded-full">En mora</span>`;
          return `<tr>
            <td class="font-medium">${a.apellidos}, ${a.nombres}</td>
            <td>${a.dni||'-'}</td>
            <td>${a.curso||'-'}</td>
            <td>${a.turno||'-'}</td>
            <td class="text-xs text-gray-500">${a.tutorApellido||''} ${a.tutorNombre||''}<br>${a.telefonoTutor||a.telefono||''}</td>
            <td class="text-right ${r.totalAdeudado>0?'text-[#a8493a] font-semibold':'text-gray-400'}">${r.totalAdeudado>0?fmtMoney(r.totalAdeudado):'—'}</td>
            <td class="text-center">${badge}</td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

/* ---------- COBROS ---------- */
function vistaCobros(){
  const q = (UI.busqueda||'').toLowerCase();
  const lista = STATE.alumnos.filter(a=> !q || (a.apellidos+' '+a.nombres+' '+(a.dni||'')).toLowerCase().includes(q));
  return `
    <h2 class="text-2xl font-display font-bold mb-1">Cobros</h2>
    <p class="text-sm text-gray-500 mb-6">Registrá pagos en efectivo o transferencia por alumno y período.</p>
    <input type="text" placeholder="Buscar alumno por nombre o DNI..." value="${UI.busqueda||''}" oninput="UI.busqueda=this.value; render();" class="max-w-sm mb-5">
    <div class="space-y-3">
      ${lista.map(a=>{
        const r = resumenAlumno(a.id);
        if(r.cantidadPendiente===0){
          return `<div class="card p-4 flex items-center justify-between opacity-70">
            <div><p class="font-medium text-sm">${a.apellidos}, ${a.nombres}</p><p class="text-xs text-gray-400">${a.curso||''}</p></div>
            <span class="badge-ok text-xs px-2 py-0.5 rounded-full">Sin cuotas pendientes</span>
          </div>`;
        }
        return `<div class="card p-4">
          <div class="flex items-center justify-between mb-3">
            <div><p class="font-medium text-sm">${a.apellidos}, ${a.nombres}</p><p class="text-xs text-gray-400">${a.curso||''} · DNI ${a.dni||'-'}</p></div>
            <p class="text-sm font-semibold text-[#a8493a]">${fmtMoney(r.totalAdeudado)} adeudado</p>
          </div>
          <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            ${r.pendientes.map(c=>`
              <div class="border rounded-lg p-3 flex items-center justify-between text-xs" style="border-color:var(--border)">
                <div>
                  <p class="font-semibold text-sm">${mesNombre(c.periodo)}</p>
                  <p class="text-gray-500">Vence ${fmtFecha(c.vencimiento)}${c.diasAtraso>0?` · ${c.diasAtraso} días de atraso`:''}</p>
                  <p class="mt-1">${c.pct>0?`<span class="text-[#a8493a] font-medium">+${c.pct}% mora</span> · `:''}<span class="font-semibold">${fmtMoney(c.montoConMora)}</span></p>
                </div>
                <button onclick='abrirModalPago("${a.id}","${c.periodo}")' class="btn-primary px-3 py-1.5 rounded-md font-semibold">Cobrar</button>
              </div>
            `).join('')}
          </div>
        </div>`;
      }).join('') || `<p class="text-gray-400 text-sm">No se encontraron alumnos.</p>`}
    </div>
  `;
}
function abrirModalPago(alumnoId, periodo){ UI._modalPago = { alumnoId, periodo, metodo:'efectivo' }; render(); }
function cerrarModalPago(){ UI._modalPago=null; render(); }
function modalPago(){
  const {alumnoId, periodo, metodo} = UI._modalPago;
  const a = STATE.alumnos.find(x=>x.id===alumnoId);
  const c = cuotasDeAlumno(alumnoId).find(x=>x.periodo===periodo);
  return `
  <div class="fixed inset-0 modal-bg flex items-center justify-center z-50" onclick="if(event.target===this) cerrarModalPago()">
    <div class="card w-full max-w-md p-6">
      <h3 class="font-display font-bold text-lg mb-1">Registrar cobro</h3>
      <p class="text-sm text-gray-500 mb-4">${a.apellidos}, ${a.nombres} — ${mesNombre(periodo)}</p>
      <div class="bg-gray-50 rounded-lg p-3 mb-4 text-sm space-y-1">
        <div class="flex justify-between"><span class="text-gray-500">Cuota base</span><span>${fmtMoney(c.montoBase)}</span></div>
        <div class="flex justify-between"><span class="text-gray-500">Recargo por mora (${c.pct}%)</span><span>${fmtMoney(c.montoConMora-c.montoBase)}</span></div>
        <div class="flex justify-between font-semibold border-t pt-1 mt-1" style="border-color:var(--border)"><span>Total a cobrar</span><span>${fmtMoney(c.montoConMora)}</span></div>
      </div>
      <label class="lbl">Método de pago</label>
      <div class="grid grid-cols-2 gap-2 mb-4">
        <button onclick="UI._modalPago.metodo='efectivo'; render();" class="py-2 rounded-lg text-sm font-semibold border ${metodo==='efectivo'?'btn-primary':''}" style="${metodo!=='efectivo'?'border-color:var(--border)':''}">Efectivo</button>
        <button onclick="UI._modalPago.metodo='transferencia'; render();" class="py-2 rounded-lg text-sm font-semibold border ${metodo==='transferencia'?'btn-primary':''}" style="${metodo!=='transferencia'?'border-color:var(--border)':''}">Transferencia</button>
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
    <h2 class="text-2xl font-display font-bold mb-1">Alertas de mora</h2>
    <p class="text-sm text-gray-500 mb-6">Alumnos con cuotas pendientes hace más de un mes (30+ días de atraso).</p>
    ${conAlerta.length===0 ? `<div class="card p-8 text-center text-gray-400">${icon('check-circle-2','w-8 h-8 mx-auto mb-2 text-[#6b9a63]')}<p>No hay alumnos con más de un mes de mora.</p></div>` : `
    <div class="space-y-3">
      ${conAlerta.sort((x,y)=>y.r.maxAtraso-x.r.maxAtraso).map(({a,r})=>`
        <div class="card p-4 border-l-4" style="border-left-color:var(--danger)">
          <div class="flex items-center justify-between">
            <div>
              <p class="font-semibold text-sm">${a.apellidos}, ${a.nombres} <span class="text-gray-400 font-normal">· ${a.curso||''}</span></p>
              <p class="text-xs text-gray-500 mt-0.5">Tutor: ${a.tutorApellido||''} ${a.tutorNombre||''} · Tel: ${a.telefonoTutor||a.telefono||'sin dato'}</p>
            </div>
            <div class="text-right">
              <p class="text-[#a8493a] font-bold">${fmtMoney(r.totalAdeudado)}</p>
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
      <h3 class="font-display font-bold mb-4">Usuarios</h3>
      <table class="tbl w-full text-sm mb-4">
        <thead><tr><th class="text-left">Email</th><th class="text-left">Nombre</th><th class="text-left">Rol</th><th></th></tr></thead>
        <tbody>${(STATE.perfiles||[]).map(u=>`
          <tr><td>${u.email}</td><td>${u.nombre}</td><td>${u.rol==='super'?'Superusuario':'Cobrador/a'}</td>
          <td class="text-right">${u.id!==SESSION.id?`<button onclick="eliminarUsuario('${u.id}')" class="text-[#a8493a] text-xs">Eliminar</button>`:''}</td></tr>
        `).join('')}</tbody>
      </table>
      <div class="grid sm:grid-cols-4 gap-2">
        <input type="text" id="nuUsuario" placeholder="email">
        <input type="text" id="nuNombre" placeholder="nombre completo">
        <input type="password" id="nuClave" placeholder="contraseña">
        <select id="nuRol"><option value="cobrador">Cobrador/a</option><option value="super">Superusuario</option></select>
      </div>
      <button onclick="agregarUsuario()" class="btn-primary px-4 py-2 rounded-lg text-sm font-semibold mt-3">Agregar usuario</button>
      <p class="text-xs text-gray-400 mt-2">Eliminar un usuario acá quita su acceso a la app. Para borrarlo por completo de Authentication, hacelo desde la consola de Firebase.</p>
    </div>
  `;
}
async function guardarCuota(){
  const montoCuota = Number(document.getElementById('cfgMonto').value)||0;
  const diaVencimiento = Number(document.getElementById('cfgDia').value)||10;
  const periodoInicio = document.getElementById('cfgPeriodo').value || STATE.config.periodoInicio;
  try{
    await db.collection('configuracion').doc('general').set({ montoCuota, diaVencimiento, periodoInicio }, {merge:true});
    STATE.config.montoCuota = montoCuota; STATE.config.diaVencimiento = diaVencimiento; STATE.config.periodoInicio = periodoInicio;
    UI.alertaMsg='Configuración de cuota guardada.';
  }catch(e){ UI.alertaMsg='Error: '+e.message; }
  render();
}
async function guardarMora(){
  const porcentajePor10Dias = Number(document.getElementById('cfgPct10').value)||0;
  const topeBloques = Number(document.getElementById('cfgTope').value)||3;
  const porcentajeMensualExtra = Number(document.getElementById('cfgPctMes').value)||0;
  try{
    await db.collection('configuracion').doc('general').set({ mora: { porcentajePor10Dias, topeBloques, porcentajeMensualExtra } }, {merge:true});
    STATE.config.mora = { porcentajePor10Dias, topeBloques, porcentajeMensualExtra };
    UI.alertaMsg='Regla de mora actualizada.';
  }catch(e){ UI.alertaMsg='Error: '+e.message; }
  render();
}
async function agregarUsuario(){
  const email=document.getElementById('nuUsuario').value.trim();
  const nombre=document.getElementById('nuNombre').value.trim();
  const clave=document.getElementById('nuClave').value;
  const rol=document.getElementById('nuRol').value;
  if(!email||!clave) return;
  try{
    const resp = await fetch('/api/crear-usuario', {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Authorization': 'Bearer '+SESSION.access_token},
      body: JSON.stringify({email, password:clave, nombre, rol})
    });
    const data = await resp.json();
    if(!resp.ok) throw new Error(data.error||'No se pudo crear el usuario');
    await cargarPerfiles();
    UI.alertaMsg = 'Usuario creado correctamente.';
  }catch(e){
    UI.alertaMsg = 'Error: '+e.message;
  }
  render();
}
async function eliminarUsuario(id){
  if(id === SESSION.id){ UI.alertaMsg='No podés eliminar tu propio usuario.'; render(); return; }
  try{
    await db.collection('usuarios').doc(id).delete();
    STATE.perfiles = STATE.perfiles.filter(p=>p.id!==id);
  }catch(e){ UI.alertaMsg = 'Error: '+e.message; }
  render();
}

/* ---------- MODAL IMPORTACIÓN ---------- */
function modalImportPreview(){
  const filas = UI.importPreview;
  return `
  <div class="fixed inset-0 modal-bg flex items-center justify-center z-50">
    <div class="card w-full max-w-3xl max-h-[85vh] flex flex-col p-6">
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
