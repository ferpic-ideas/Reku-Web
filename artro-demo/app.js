const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const state = { csrf: '', agreement: null, services: [], professionals: [], service: null, week: 0, days: [], day: '', slot: null, hold: null, stage: 1, appointments: [], moving: null, keys: {}, patient: { first_name: 'Paciente', last_name: 'Demo', email: '', phone: '' }, busy: false, revision: 0 };
const operationKey = name => state.keys[name] ||= crypto.randomUUID();
const clearError = () => { $('#flow-error').hidden = true; $('#flow-error').textContent = ''; };
const showError = error => { $('#flow-error').textContent = error.message; $('#flow-error').hidden = false; $('#flow-error').focus(); };
const formatDate = (date, options = { weekday: 'long', day: 'numeric', month: 'long' }) => new Intl.DateTimeFormat('es-AR', { ...options, timeZone: 'UTC' }).format(new Date(`${date.slice(0, 10)}T12:00:00Z`));
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: state.agreement?.timezone || 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (date, days) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

function trace(method, path, status) {
  const item = document.createElement('li');
  item.textContent = `${method} /api/partners/v1${path.split('?')[0]} → ${status}`;
  if (Number(status) >= 400) item.className = 'trace-failed';
  $('#api-log').prepend(item);
  while ($('#api-log').children.length > 35) $('#api-log').lastChild.remove();
}

async function api(path, { method = 'GET', body, key, internal = false } = {}) {
  const headers = { 'X-Demo-Request': '1', 'X-CSRF-Token': state.csrf };
  if (key) headers['Idempotency-Key'] = key;
  if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  let response;
  try { response = await fetch(`/test/api${path}`, { method, headers, body, credentials: 'same-origin' }); }
  catch { if (!internal) trace(method, path, 'sin respuesta'); throw new Error('Se interrumpió la conexión. Reintentá; la misma operación no creará un turno duplicado.'); }
  if (!internal) trace(method, path, response.status);
  const json = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !internal) { $('#access-card').hidden = false; $('#booking-app').hidden = true; }
    throw Object.assign(new Error(json.error?.message || 'No pudimos completar la solicitud.'), { status: response.status, code: json.error?.code });
  }
  return json;
}

async function action(callback) {
  if (state.busy) return;
  state.busy = true; clearError();
  const content = $('#step-content'); content.classList.add('busy'); content.setAttribute('aria-busy', 'true');
  try { await callback(); } catch (error) { showError(error); }
  finally { state.busy = false; content.classList.remove('busy'); content.removeAttribute('aria-busy'); }
}

function stage(number) {
  state.stage = number;
  document.querySelectorAll('.progress li').forEach((el, i) => {
    if (i + 1 === number) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
  });
}

function renderServices() {
  stage(1); state.moving = null; state.hold = null; state.receipt = null;
  $('#step-content').innerHTML = `<h3 class="step-title">¿Qué práctica necesitás?</h3><p class="step-description">Empezá por una consulta. Si tu profesional ya te indicó tratamiento, podés elegir esa opción.</p><div class="services">${state.services.map(s => `<button type="button" class="service-option" data-service="${s.id}"><span><strong>${escape(s.name)}</strong><small>${s.duration_minutes} minutos · Videollamada</small></span><span aria-hidden="true">↗</span></button>`).join('') || '<p>No hay prácticas disponibles para este acuerdo.</p>'}</div>`;
}

async function startService(id) {
  state.service = state.services.find(s => s.id === Number(id));
  if (!state.service) throw new Error('Práctica no disponible.');
  state.week = 0; state.day = ''; state.slot = null; state.professionalId = ''; state.hold = null;
  state.professionals = state.agreement.direct_treatment ? [] : (await api(`/professionals?service_id=${id}`)).data;
  await loadAvailability();
}

async function loadAvailability() {
  const revision = ++state.revision;
  state.day = ''; state.slot = null; state.receipt = null; stage(2);
  $('#step-content').innerHTML = '<p class="loading">Buscando disponibilidad en tiempo real…</p>';
  const from = addDays(today(), state.week * 7);
  const query = new URLSearchParams({ service_id: state.service.id, from, to: addDays(from, 6) });
  if (state.professionalId && !state.agreement.direct_treatment) query.set('professional_id', state.professionalId);
  try {
    const result = await api(`/availability?${query}`);
    if (revision !== state.revision) return;
    state.days = result.data.days; renderAvailability();
  } catch (error) {
    $('#step-content').innerHTML = '<h3 class="step-title">No pudimos cargar la agenda.</h3><button class="button outline" data-action="retry-availability">Reintentar</button>';
    throw error;
  }
}

function renderAvailability() {
  stage(2);
  const slots = state.days.find(d => d.date === state.day)?.slots || [];
  const visibleSlots = state.agreement.direct_treatment ? slots.filter((s, i, all) => all.findIndex(v => v.start_time === s.start_time) === i) : slots;
  state.visibleSlots = visibleSlots;
  $('#step-content').innerHTML = `<h3 class="step-title">${state.moving ? 'Elegí un nuevo horario.' : 'Un día y un horario para vos.'}</h3><p class="step-description">${escape(state.service.name)} · Horarios de Argentina</p>
    ${!state.agreement.direct_treatment ? `<label for="professional">Profesional</label><select id="professional"><option value="">Primero disponible</option>${state.professionals.map(p => `<option value="${p.id}" ${String(p.id) === state.professionalId ? 'selected' : ''}>${escape(p.name)}</option>`).join('')}</select>` : '<p class="form-hint">El profesional se asigna automáticamente según disponibilidad.</p>'}
    <div class="week-controls"><button data-week="-1" type="button" aria-label="Semana anterior" ${state.week === 0 ? 'disabled' : ''}>←</button><span>${formatDate(state.days[0]?.date || today(), { day: 'numeric', month: 'short' })} — ${formatDate(state.days.at(-1)?.date || today(), { day: 'numeric', month: 'short' })}</span><button data-week="1" type="button" aria-label="Semana siguiente" ${state.week >= 12 ? 'disabled' : ''}>→</button></div>
    <div class="days">${state.days.map(d => `<button type="button" class="day ${state.day === d.date ? 'selected' : ''}" data-day="${d.date}" aria-pressed="${state.day === d.date}" ${!d.slots.length ? 'disabled' : ''}><span>${formatDate(d.date, { weekday: 'short' })}</span><strong>${Number(d.date.slice(8, 10))}</strong><span>${d.slots.length ? 'Disponible' : 'Sin turnos'}</span></button>`).join('')}</div>
    <div class="slots">${visibleSlots.map((s, i) => `<button type="button" class="slot ${state.slot === s ? 'selected' : ''}" data-slot="${i}" aria-pressed="${state.slot === s}">${s.start_time}${!state.agreement.direct_treatment ? `<small>${escape(s.professional.name)}</small>` : ''}</button>`).join('')}</div>
    ${!state.day ? `<p class="form-hint">${state.days.some(d => d.slots.length) ? 'Seleccioná un día para ver sus horarios.' : 'No hay horarios esta semana. Probá con la siguiente.'}</p>` : ''}
    <div class="form-actions"><button type="button" class="text-button" data-action="back">${state.moving ? 'No mover el turno' : 'Volver'}</button><button type="button" class="button primary" data-action="reserve" ${!state.slot ? 'disabled' : ''}>${state.moving ? 'Confirmar cambio de horario' : 'Continuar'} →</button></div>`;
}

function summary(data) {
  return `<div class="booking-summary"><strong>${escape(data.service.name)}</strong><p>${escape(formatDate(data.schedule.date))} · ${escape(data.schedule.start_time)} a ${escape(data.schedule.end_time)}</p><p>${escape(data.professional.name)} · Videollamada</p></div>`;
}

function renderPatient() {
  stage(3);
  $('#step-content').innerHTML = `<div class="hold-banner"><strong>Guardamos este horario por unos minutos.</strong><span id="hold-timer" class="hold-timer"></span></div><h3 class="step-title">Todo listo para confirmar.</h3>${summary(state.hold)}
    <p class="step-description">Datos de la cuenta registrada que enviaría tu sitio. Podés cambiarlos para esta prueba; no se envía un código de validación.</p>
    <form id="patient-form"><div class="form-row"><div class="form-field"><label for="first-name">Nombre</label><input id="first-name" name="first_name" autocomplete="given-name" maxlength="100" value="${escape(state.patient.first_name)}" required></div><div class="form-field"><label for="last-name">Apellido</label><input id="last-name" name="last_name" autocomplete="family-name" maxlength="100" value="${escape(state.patient.last_name)}" required></div></div>
    <div class="form-row"><div class="form-field"><label for="patient-email">Email de tu cuenta de prueba</label><input id="patient-email" name="email" type="email" autocomplete="email" maxlength="254" placeholder="tu@email.com" value="${escape(state.patient.email)}" required><p class="form-hint">Usá un correo propio si querés recibir los mails de la reserva.</p></div><div class="form-field"><label for="phone">Teléfono</label><input id="phone" name="phone" type="tel" autocomplete="tel" maxlength="50" value="${escape(state.patient.phone)}" placeholder="+54 9…" required></div></div>
    ${state.agreement.type === 'Nomina' ? `<div class="form-field"><label for="identifier">${escape(state.agreement.identifier_label || 'Identificador de nómina')}</label><input id="identifier" name="identifier" required maxlength="200" value="${escape(state.patient.identifier || '')}"></div>` : ''}
    <div class="form-field"><label for="medical-order">Orden médica (${state.agreement.medical_order_required ? 'obligatoria' : 'opcional'})</label><input id="medical-order" name="medical_order" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" ${state.agreement.medical_order_required ? 'required' : ''}><p class="form-hint">PDF, JPG, PNG o WebP. Hasta 10 MB. Para la demo, adjuntá únicamente archivos de prueba sin información clínica real.</p></div>
    <p class="notice">${state.agreement.type === 'Pago' ? 'Pago externo simulado: no se realizará ningún cobro. ' : ''}Al confirmar se crea un turno real de prueba en la agenda de Reku.</p>
    <div class="form-actions"><button type="button" class="text-button" data-action="change-slot">Cambiar horario</button><button type="submit" class="button primary" id="confirm-booking">Confirmar turno de prueba →</button></div></form>`;
  tick();
}

function safeLink(url) {
  try { const u = new URL(url); return u.origin === window.location.origin || u.protocol === 'https:' && (u.hostname === 'reku.io' || u.hostname.endsWith('.reku.io')) ? escape(u.href) : ''; } catch { return ''; }
}
function links(data) {
  if (data.status !== 'confirmed') return '';
  const waiting = safeLink(data.links?.waiting_room_url), manage = safeLink(data.links?.manage_url);
  return `${waiting ? `<a class="button primary small" href="${waiting}" target="_blank" rel="noopener noreferrer">Ingresar a la sala ↗</a>` : ''}${manage ? `<a class="button outline small" href="${manage}" target="_blank" rel="noopener noreferrer">Gestionar mi turno ↗</a>` : ''}`;
}

function renderSuccess(data, moved = false) {
  state.hold = null; state.moving = null; state.receipt = data.id; stage(3);
  $('#step-content').innerHTML = `<div class="success-mark" aria-hidden="true">✓</div><h3 class="step-title">${moved ? 'Tu turno fue reprogramado.' : 'Tu turno está confirmado.'}</h3><p class="step-description">La reserva ya está guardada en Reku.</p>${summary(data)}<div class="success-links">${links(data)}</div><p class="form-hint">La sala de espera se habilita según el horario del turno. Estos enlaces son privados: no los compartas públicamente.</p><div class="form-actions"><button type="button" class="text-button" data-action="new">Reservar otro turno de prueba</button></div>`;
}

async function refreshAppointments() {
  const result = await api('/appointments'); state.appointments = result.data; renderAppointments();
  const receipt = state.appointments.find(a => a.id === state.receipt);
  if (receipt?.status === 'cancelled') $('#step-content').innerHTML = `<h3 class="step-title">El turno fue cancelado.</h3>${summary(receipt)}<button class="button outline" data-action="new" type="button">Reservar otro turno de prueba</button>`;
}
function renderAppointments() {
  $('#appointments').innerHTML = state.appointments.map(a => `<article class="appointment"><div class="appointment-top"><div><h3>${escape(a.service.name)}</h3><p>${escape(formatDate(a.schedule.date))} · ${escape(a.schedule.start_time)} · ${escape(a.professional.name)}</p><p>${escape(a.patient.first_name)} ${escape(a.patient.last_name)}</p></div><span class="status ${a.status === 'cancelled' ? 'cancelled' : ''}">${a.status === 'confirmed' ? 'Confirmado' : a.status === 'cancelled' ? 'Cancelado' : escape(a.status)}</span></div><div class="appointment-actions">${links(a)}${a.status === 'confirmed' ? `<button class="text-button" type="button" data-move="${a.id}">Mover turno</button><button class="text-button danger" type="button" data-cancel="${a.id}">Cancelar turno</button>` : ''}</div><div id="cancel-${a.id}" hidden class="cancel-confirm"><span>¿Cancelamos este turno de prueba?</span><button class="text-button danger" type="button" data-confirm-cancel="${a.id}">Sí, cancelar</button><button class="text-button" type="button" data-dismiss-cancel="${a.id}">Conservar turno</button></div></article>`).join('') || '<p class="muted">Todavía no creaste turnos en esta sesión.</p>';
}

async function boot() {
  $('#access-card').hidden = true; $('#booking-app').hidden = false; $('#my-nav').hidden = false;
  $('#step-content').innerHTML = '<p class="loading">Conectando con Reku…</p>';
  try {
    state.agreement = (await api('/agreement')).data;
    state.services = (await api('/services')).data;
    $('#communication-note').textContent = state.agreement.access_mode === 'api' && state.agreement.communication_sender === 'integrator' ? 'Comunicaciones: a cargo del integrador. Reku no enviará mails al paciente.' : 'Comunicaciones: a cargo de Reku. Los mails habituales pueden llegar al correo que uses en la reserva.';
    if (state.agreement.direct_treatment && state.services[0]) await startService(state.services[0].id); else renderServices();
    await refreshAppointments();
  } catch (error) { showError(error); $('#step-content').innerHTML = '<button class="button outline" data-action="retry-boot">Reintentar conexión</button>'; }
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true; $('#login-error').textContent = '';
  try { const result = await api('/login', { method: 'POST', body: { password: $('#access-password').value }, internal: true }); state.csrf = result.csrf; $('#access-password').value = ''; await boot(); }
  catch (error) { $('#login-error').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#logout').addEventListener('click', () => action(async () => {
  await api('/logout', { method: 'POST', body: {}, internal: true }); window.location.reload();
}));
$('#refresh-appointments').addEventListener('click', () => action(refreshAppointments));

$('#booking-app').addEventListener('change', event => {
  if (event.target.id === 'professional') action(async () => { state.professionalId = event.target.value; await loadAvailability(); });
});
$('#booking-app').addEventListener('input', event => {
  if (event.target.closest('#patient-form')) {
    if (['first_name', 'last_name', 'email', 'phone', 'identifier'].includes(event.target.name)) state.patient[event.target.name] = event.target.value;
    // A changed payload is a new attempt; retries of an unchanged payload keep the same key.
    delete state.keys.confirm;
  }
});

$('#booking-app').addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  const d = button.dataset;
  if (d.service) action(() => startService(d.service));
  if (d.week) action(async () => { state.week = Math.max(0, Math.min(12, state.week + Number(d.week))); await loadAvailability(); });
  if (d.day && !state.busy) { state.day = d.day; state.slot = null; renderAvailability(); }
  if (d.slot !== undefined && !state.busy) { state.slot = state.visibleSlots[Number(d.slot)]; renderAvailability(); }
  if (d.action === 'retry-availability') action(loadAvailability);
  if (d.action === 'retry-boot') action(boot);
  if (d.action === 'back' || d.action === 'new') action(async () => {
    state.moving = null;
    if (state.agreement.direct_treatment) await startService(state.services[0].id); else renderServices();
  });
  if (d.action === 'change-slot') action(async () => { state.hold = null; await loadAvailability(); });
  if (d.action === 'reserve') action(async () => {
    if (!state.slot) return;
    const payload = { service_id: state.service.id, date: state.day, start_time: state.slot.start_time, ...(state.moving || !state.agreement.direct_treatment ? { professional_id: state.slot.professional.id } : {}) };
    const keyName = JSON.stringify({ ...payload, moving: state.moving });
    if (state.moving) {
      const result = await api(`/appointments/${state.moving}`, { method: 'PATCH', body: payload, key: operationKey(keyName) }); delete state.keys[keyName]; renderSuccess(result.data, true); await refreshAppointments();
    } else {
      const result = await api('/holds', { method: 'POST', body: payload, key: operationKey(keyName) }); state.hold = result.data;
      if (Date.parse(state.hold.expires_at) <= Date.now()) { delete state.keys[keyName]; throw new Error('Esa pre-reserva venció. Elegí el horario de nuevo.'); }
      delete state.keys.confirm; renderPatient();
    }
  });
  if (d.move) action(async () => {
    const appt = state.appointments.find(a => a.id === d.move); state.moving = appt.id; await startService(appt.service.id);
    $('#reserva').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  if (d.cancel) $(`#cancel-${d.cancel}`).hidden = false;
  if (d.dismissCancel) $(`#cancel-${d.dismissCancel}`).hidden = true;
  if (d.confirmCancel) action(async () => { await api(`/appointments/${d.confirmCancel}/cancel`, { method: 'POST', body: {}, key: operationKey(`cancel:${d.confirmCancel}`) }); await refreshAppointments(); });
});

$('#booking-app').addEventListener('submit', event => {
  if (event.target.id !== 'patient-form') return;
  event.preventDefault();
  action(async () => {
    const form = event.target; const file = form.elements.medical_order.files[0];
    if (file?.size > 10 * 1024 * 1024) throw new Error('El archivo debe pesar hasta 10 MB.');
    const patient = Object.fromEntries(['first_name', 'last_name', 'email', 'phone', 'identifier'].filter(k => form.elements[k]).map(k => [k, form.elements[k].value.trim()]));
    state.patient = patient;
    const payload = { hold_id: state.hold.id, patient };
    let body = payload;
    if (file) { body = new FormData(); body.set('payload', JSON.stringify(payload)); body.set('medical_order', file); }
    try {
      const result = await api('/appointments', { method: 'POST', body, key: operationKey('confirm') }); renderSuccess(result.data); await refreshAppointments();
    } catch (error) {
      if (['hold_expired', 'slot_unavailable', 'hold_not_available'].includes(error.code)) { state.hold = null; await loadAvailability(); }
      throw error;
    }
  });
});

function tick() {
  if (!state.hold || !$('#hold-timer')) return;
  const seconds = Math.max(0, Math.ceil((Date.parse(state.hold.expires_at) - Date.now()) / 1000));
  $('#hold-timer').textContent = seconds ? `Tiempo restante: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'El tiempo venció. Elegí un horario nuevamente.';
  if ($('#confirm-booking')) $('#confirm-booking').disabled = seconds === 0;
}
setInterval(tick, 1000);
api('/session', { internal: true }).then(result => { state.csrf = result.csrf; return boot(); }).catch(() => {});
