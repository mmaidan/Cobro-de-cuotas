/* ======================= CLIENTE SUPABASE ======================= */
const supabase = window.supabase.createClient(window.CONFIG.SUPABASE_URL, window.CONFIG.SUPABASE_ANON_KEY);

/* ======================= ESTADO EN MEMORIA ======================= */
let STATE = { config: null, alumnos: [], pagos: [], perfiles: [] };
let SESSION = null; // { id, email, rol, nombre, access_token }
let TAB = 'dashboard';
let UI = { alertaMsg:null, importPreview:null, importEncoding:'utf-8', cargando:true, busqueda:'', _modalPago:null };

/* ======================= UTILIDADES ======================= */
function uid(){ return Math.random().toString(36).slice(2,10); }
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
function mapConfigDesdeDB(c){
  if(!c) return { montoCuota:15000, diaVencimiento:10, periodoInicio:periodoActual(), mora:{porcentajePor10Dias:10, topeBloques:3, porcentajeMensualExtra:5} };
  return {
    montoCuota: Number(c.monto_cuota),
    diaVencimiento: Number(c.dia_vencimiento),
    periodoInicio: c.periodo_inicio,
    mora: { porcentajePor10Dias: Number(c.mora_pct_10dias), topeBloques: Number(c.mora_tope_bloques), porcentajeMensualExtra: Number(c.mora_pct_mensual_extra) }
  };
}
function mapAlumnoDesdeDB(a){
  return {
    id: a.id, apellidos: a.apellidos, nombres: a.nombres, dni: a.dni, curso: a.curso, turno: a.turno,
    telefono: a.telefono, email: a.email, tutorApellido: a.tutor_apellido, tutorNombre: a.tutor_nombre,
    telefonoTutor: a.telefono_tutor, emailTutor: a.email_tutor, activo: a.activo
  };
}
function mapPagoDesdeDB(p){
  return {
    id: p.id, alumnoId: p.alumno_id, periodo: p.periodo, montoBase: Number(p.monto_base),
    recargoPct: Number(p.recargo_pct), montoTotal: Number(p.monto_total), montoPagado: Number(p.monto_pagado),
    metodo: p.metodo, fecha: p.fecha, diasAtrasoAlPagar: p.dias_atraso_al_pagar, registradoPor: p.registrado_por
  };
}

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
async function initApp(){
  const { data: { session } } = await supabase.auth.getSession();
  if(session){ await establecerSesion(session); }
  UI.cargando = false;
  render();
}
async function establecerSesion(session){
  const { data: perfil, error } = await supabase.from('profiles').select('*').eq('id', session.user.id).single();
  if(error || !perfil){
    await supabase.auth.signOut();
    SESSION = null;
    return;
  }
  SESSION = { id: session.user.id, email: session.user.email, rol: perfil.rol, nombre: perfil.nombre, access_token: session.access_token };
  await cargarDatos();
}
async function cargarDatos(){
  const [{data: cfg}, {data: alumnos}, {data: pagos}] = await Promise.all([
    supabase.from('configuracion').select('*').eq('id',1).single(),
    supabase.from('alumnos').select('*').order('apellidos'),
    supabase.from('pagos').select('*')
  ]);
  STATE.config = mapConfigDesdeDB(cfg);
  STATE.alumnos = (alumnos||[]).map(mapAlumnoDesdeDB);
  STATE.pagos = (pagos||[]).map(mapPagoDesdeDB);
  if(SESSION.rol==='super'){ await cargarPerfiles(); }
}
async function cargarPerfiles(){
  const { data } = await supabase.from('profiles').select('*').order('nombre');
  STATE.perfiles = data||[];
}
async function login(email, clave){
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: clave });
  if(error || !data.session) return false;
  await establecerSesion(data.session);
  return !!SESSION;
}
async function logout(){
  await supabase.auth.signOut();
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
async function confirmarImportacion(){
  const dnisExistentes = new Set(STATE.alumnos.map(a=>a.dni).filter(Boolean));
  const candidatos = UI.importPreview.filter(f=> !f.dni || !dnisExistentes.has(f.dni));
  const omitidos = UI.importPreview.length - candidatos.length;
  const nuevos = candidatos.map(f=>({
    apellidos: f.apellidos, nombres: f.nombres, dni: f.dni || null, curso: f.curso, turno: f.turno,
    telefono: f.telefono || null, email: f.email || null,
    tutor_apellido: f.tutorApellido || null, tutor_nombre: f.tutorNombre || null,
    telefono_tutor: f.telefonoTutor || null, email_tutor: f.emailTutor || null,
    activo: !f.estadoOriginal || f.estadoOriginal.toLowerCase().includes('activ')
  }));
  const { data, error } = await supabase.from('alumnos').insert(nuevos).select();
  if(error){ UI.alertaMsg = 'Error al importar: '+error.message; render(); return; }
  STATE.alumnos = STATE.alumnos.concat((data||[]).map(mapAlumnoDesdeDB))
    .sort((a,b)=> (a.apellidos||'').localeCompare(b.apellidos||''));
  UI.importPreview = null;
  UI.alertaMsg = `Se importaron ${data.length} alumnos (${omitidos} omitidos por DNI duplicado).`;
  render();
}

/* ======================= PAGOS ======================= */
async function registrarPago({alumnoId, periodo, metodo, montoPagado}){
  const cuota = cuotasDeAlumno(alumnoId).find(c=>c.periodo===periodo);
  const registro = {
    alumno_id: alumnoId, periodo,
    monto_base: STATE.config.montoCuota,
    recargo_pct: cuota.pct,
    monto_total: cuota.montoConMora,
    monto_pagado: montoPagado || cuota.montoConMora,
    metodo, fecha: nuevaFechaISO(),
    dias_atraso_al_pagar: cuota.diasAtraso,
    registrado_por: SESSION.id
  };
  const { data, error } = await supabase.from('pagos').upsert(registro, { onConflict: 'alumno_id,periodo' }).select().single();
  UI._modalPago = null;
  if(error){ UI.alertaMsg = 'Error al registrar el cobro: '+error.message; render(); return; }
  STATE.pagos.push(mapPagoDesdeDB(data));
  UI.alertaMsg = 'Cobro registrado correctamente.';
  render();
}
async function anularPago(pagoId){
  const { error } = await supabase.from('pagos').delete().eq('id', pagoId);
  if(!error) STATE.pagos = STATE.pagos.filter(p=>p.id!==pagoId);
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
  <div class="h-full w-full flex items-center justify-center" style="background:linear-gradient(135deg,#0f172a,#0d9488);">
    <div class="card w-full max-w-sm p-8 mx-4">
      <div class="flex items-center gap-2 mb-1">
        ${icon('graduation-cap','w-7 h-7')}
        <h1 class="text-xl font-display font-bold">Gestión de Cuotas</h1>
      </div>
      <p class="text-sm text-gray-500 mb-6">Control y cobro de cuotas escolares</p>
      <form id="loginForm">
        <label class="lbl">Email</label>
        <input id="lu" type="text" class="mb-3" placeholder="tu@email.com" autofocus>
        <label class="lbl">Contraseña</label>
        <input id="lc" type="password" class="mb-1" placeholder="••••••••">
        <p id="lerr" class="hidden text-xs text-rose-600 mt-1 mb-2">Usuario o contraseña incorrectos.</p>
        <button type="submit" id="loginBtn" class="btn-primary w-full mt-4 py-2.5 rounded-lg font-semibold text-sm">Ingresar</button>
      </form>
    </div>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async function(e){
      e.preventDefault();
      const btn = document.getElementById('loginBtn');
      btn.disabled = true; btn.textContent = 'Ingresando...';
      const ok = await login(document.getElementById('lu').value.trim(), document.getElementById('lc').value);
      if(ok){ render(); } else { document.getElementById('lerr').classList.remove('hidden'); btn.disabled=false; btn.textContent='Ingresar'; }
    });
  </script>`;
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
    <button onclick="TAB='${i.id}'; render();" class="nav-item ${TAB===i.id?'active':''} w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium">
      ${icon(i.icono,'w-4 h-4')} ${i.label}
    </button>`).join('');

  return `
  <div class="flex h-full w-full">
    <aside class="sidebar w-64 shrink-0 flex flex-col p-4">
      <div class="flex items-center gap-2 px-2 mb-6 mt-1">
        ${icon('graduation-cap','w-6 h-6 text-teal-400')}
        <span class="font-display font-bold text-white text-lg">Cuotas</span>
      </div>
      <nav class="space-y-1 flex-1">${nav}</nav>
      <div class="border-t border-white/10 pt-3 px-2">
        <p class="text-xs text-slate-400">${SESSION.nombre}</p>
        <p class="text-xs text-teal-400 font-semibold mb-2">${SESSION.rol==='super'?'Superusuario':'Cobrador/a'}</p>
        <button onclick="logout()" class="text-xs text-slate-300 hover:text-white flex items-center gap-1">${icon('log-out','w-3.5 h-3.5')} Cerrar sesión</button>
      </div>
    </aside>
    <main class="flex-1 overflow-y-auto p-8">
      ${UI.alertaMsg ? `<div class="card border-teal-200 bg-teal-50 px-4 py-3 mb-5 flex items-center justify-between text-sm text-teal-800"><span>${UI.alertaMsg}</span><button onclick="UI.alertaMsg=null; render();" class="text-teal-600">${icon('x','w-4 h-4')}</button></div>` : ''}
      ${ TAB==='dashboard' ? vistaDashboard() :
         TAB==='alumnos' ? vistaAlumnos() :
         TAB==='cobros' ? vistaCobros() :
         TAB==='alertas' ? vistaAlertas() :
         TAB==='config' ? vistaConfig() : '' }
    </main>
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
      ${kpi('Recaudado este mes', fmtMoney(recaudadoMes), 'banknote', 'bg-teal-50 text-teal-600')}
      ${kpi('Alumnos al día', alDia, 'check-circle-2', 'bg-emerald-50 text-emerald-600')}
      ${kpi('En mora (≤ 1 mes)', enMora, 'clock', 'bg-amber-50 text-amber-600')}
      ${kpi('Mora +1 mes', masDeUnMes, 'alert-triangle', 'bg-rose-50 text-rose-600')}
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
            <td class="text-right ${r.totalAdeudado>0?'text-rose-600 font-semibold':'text-gray-400'}">${r.totalAdeudado>0?fmtMoney(r.totalAdeudado):'—'}</td>
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
            <p class="text-sm font-semibold text-rose-600">${fmtMoney(r.totalAdeudado)} adeudado</p>
          </div>
          <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            ${r.pendientes.map(c=>`
              <div class="border rounded-lg p-3 flex items-center justify-between text-xs" style="border-color:var(--border)">
                <div>
                  <p class="font-semibold text-sm">${mesNombre(c.periodo)}</p>
                  <p class="text-gray-500">Vence ${fmtFecha(c.vencimiento)}${c.diasAtraso>0?` · ${c.diasAtraso} días de atraso`:''}</p>
                  <p class="mt-1">${c.pct>0?`<span class="text-rose-600 font-medium">+${c.pct}% mora</span> · `:''}<span class="font-semibold">${fmtMoney(c.montoConMora)}</span></p>
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
    ${conAlerta.length===0 ? `<div class="card p-8 text-center text-gray-400">${icon('check-circle-2','w-8 h-8 mx-auto mb-2 text-emerald-400')}<p>No hay alumnos con más de un mes de mora.</p></div>` : `
    <div class="space-y-3">
      ${conAlerta.sort((x,y)=>y.r.maxAtraso-x.r.maxAtraso).map(({a,r})=>`
        <div class="card p-4 border-l-4" style="border-left-color:var(--danger)">
          <div class="flex items-center justify-between">
            <div>
              <p class="font-semibold text-sm">${a.apellidos}, ${a.nombres} <span class="text-gray-400 font-normal">· ${a.curso||''}</span></p>
              <p class="text-xs text-gray-500 mt-0.5">Tutor: ${a.tutorApellido||''} ${a.tutorNombre||''} · Tel: ${a.telefonoTutor||a.telefono||'sin dato'}</p>
            </div>
            <div class="text-right">
              <p class="text-rose-600 font-bold">${fmtMoney(r.totalAdeudado)}</p>
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
          <td class="text-right">${u.id!==SESSION.id?`<button onclick="eliminarUsuario('${u.id}')" class="text-rose-500 text-xs">Eliminar</button>`:''}</td></tr>
        `).join('')}</tbody>
      </table>
      <div class="grid sm:grid-cols-4 gap-2">
        <input type="text" id="nuUsuario" placeholder="email">
        <input type="text" id="nuNombre" placeholder="nombre completo">
        <input type="password" id="nuClave" placeholder="contraseña">
        <select id="nuRol"><option value="cobrador">Cobrador/a</option><option value="super">Superusuario</option></select>
      </div>
      <button onclick="agregarUsuario()" class="btn-primary px-4 py-2 rounded-lg text-sm font-semibold mt-3">Agregar usuario</button>
      <p class="text-xs text-gray-400 mt-2">Eliminar un usuario acá quita su acceso a la app. Para borrarlo por completo de Authentication, hacelo desde el panel de Supabase.</p>
    </div>
  `;
}
async function guardarCuota(){
  const montoCuota = Number(document.getElementById('cfgMonto').value)||0;
  const diaVencimiento = Number(document.getElementById('cfgDia').value)||10;
  const periodoInicio = document.getElementById('cfgPeriodo').value || STATE.config.periodoInicio;
  const { error } = await supabase.from('configuracion').update({
    monto_cuota: montoCuota, dia_vencimiento: diaVencimiento, periodo_inicio: periodoInicio
  }).eq('id',1);
  if(error){ UI.alertaMsg='Error: '+error.message; render(); return; }
  STATE.config.montoCuota = montoCuota; STATE.config.diaVencimiento = diaVencimiento; STATE.config.periodoInicio = periodoInicio;
  UI.alertaMsg='Configuración de cuota guardada.'; render();
}
async function guardarMora(){
  const p10 = Number(document.getElementById('cfgPct10').value)||0;
  const tope = Number(document.getElementById('cfgTope').value)||3;
  const pMes = Number(document.getElementById('cfgPctMes').value)||0;
  const { error } = await supabase.from('configuracion').update({
    mora_pct_10dias: p10, mora_tope_bloques: tope, mora_pct_mensual_extra: pMes
  }).eq('id',1);
  if(error){ UI.alertaMsg='Error: '+error.message; render(); return; }
  STATE.config.mora = { porcentajePor10Dias:p10, topeBloques:tope, porcentajeMensualExtra:pMes };
  UI.alertaMsg='Regla de mora actualizada.'; render();
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
  const { error } = await supabase.from('profiles').delete().eq('id', id);
  if(!error) STATE.perfiles = STATE.perfiles.filter(p=>p.id!==id);
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
initApp();
