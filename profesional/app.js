(() => {
  const app = document.getElementById('professional-portal');
  const dayLabels = [
    [1, 'Lunes'],
    [2, 'Martes'],
    [3, 'Miércoles'],
    [4, 'Jueves'],
    [5, 'Viernes'],
    [6, 'Sábado'],
    [7, 'Domingo'],
  ];
  const modules = [
    ['overview', 'Inicio'],
    ['appointments', 'Turnos'],
    ['patients', 'Pacientes'],
    ['availability', 'Horarios'],
    ['blocks', 'Bloqueos'],
    ['profile', 'Mi perfil'],
  ];
  const state = {
    loading: true,
    user: null,
    profile: null,
    active: 'overview',
    csrf: '',
    appointments: [],
    patients: [],
    availability: [],
    blocks: [],
    google: { available: false, connected: false, status: 'not_configured' },
    patientSearch: '',
    status: '',
    statusType: '',
  };

  const escapeHtml = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');

  const formatDate = (value) => {
    if (!value) return '';
    const [year, month, day] = String(value).slice(0, 10).split('-');
    return `${day}/${month}/${year}`;
  };

  const today = () => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Argentina/Buenos_Aires',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .formatToParts(new Date())
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  };

  async function api(path, options = {}) {
    const method = options.method || 'GET';
    const headers = { ...(options.headers || {}) };
    if (state.csrf && !['GET', 'HEAD'].includes(method)) {
      headers['X-CSRF-Token'] = state.csrf;
    }
    const request = {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
    };
    if (options.body instanceof FormData) {
      request.body = options.body;
    } else if (options.body) {
      headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(options.body);
    }
    const response = await fetch(path, request);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || 'No se pudo completar la acción.');
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function setStatus(message, type = '') {
    state.status = message;
    state.statusType = type;
    render();
  }

  async function loadData() {
    const [profile, availability, blocks, patients, appointments, google] = await Promise.all([
      api('/api/professional/profile'),
      api('/api/professional/availability'),
      api('/api/professional/blocks'),
      api('/api/professional/patients'),
      api('/api/professional/appointments'),
      api('/api/professional/integrations/google'),
    ]);
    state.profile = profile.profile;
    state.availability = availability.availability || [];
    state.blocks = blocks.schedule_blocks || [];
    state.patients = patients.patients || [];
    state.appointments = appointments.appointments || [];
    state.google = google.google || state.google;
  }

  async function loadSession() {
    try {
      const payload = await api('/api/professional/auth/me');
      state.user = payload.user;
      state.profile = payload.professional;
      state.csrf = payload.csrf_token;
      await loadData();
    } catch {
      state.user = null;
      state.csrf = '';
    } finally {
      state.loading = false;
      render();
    }
  }

  function renderStatus() {
    return state.status
      ? `<div class="status-message ${escapeHtml(state.statusType)}">${escapeHtml(state.status)}</div>`
      : '';
  }

  function renderLogin() {
    app.className = '';
    app.innerHTML = `
      <main class="login-shell">
        <section class="login-story">
          <img src="/images/logo-reku.svg" alt="Reku" />
          <div>
            <h1>Tu práctica, en un solo lugar.</h1>
            <p>Organizá tus horarios, pacientes y próximos turnos desde el portal profesional de Reku.</p>
          </div>
        </section>
        <section class="login-panel">
          <form id="login-form" class="login-form form-stack">
            <div>
              <h2>Ingresar</h2>
              <p>Usá las credenciales de tu cuenta profesional.</p>
            </div>
            <label>
              Email
              <input name="email" type="email" autocomplete="email" required />
            </label>
            <label>
              Contraseña
              <input name="password" type="password" autocomplete="current-password" required />
            </label>
            <button class="primary-button" type="submit">Entrar al portal</button>
            ${renderStatus()}
          </form>
        </section>
      </main>
    `;
    document.getElementById('login-form').addEventListener('submit', handleLogin);
  }

  function renderSidebar() {
    return `
      <aside class="portal-sidebar">
        <div class="portal-brand"><img src="/images/logo-reku.svg" alt="Reku" /></div>
        <nav class="portal-nav" aria-label="Portal profesional">
          ${modules
            .map(
              ([id, label]) => `
                <button class="nav-button ${state.active === id ? 'active' : ''}" data-module="${id}" type="button">
                  ${escapeHtml(label)}
                </button>
              `,
            )
            .join('')}
        </nav>
        <div class="sidebar-account">
          <strong>${escapeHtml(state.profile?.name || state.user?.name || 'Profesional')}</strong>
          <span>${escapeHtml(state.user?.email || '')}</span>
          <button id="logout-button" class="logout-button" type="button">Cerrar sesión</button>
        </div>
      </aside>
    `;
  }

  function pageHeader(title, description) {
    return `
      <header class="page-header">
        <div>
          <span class="eyebrow">Portal profesional</span>
          <h1>${escapeHtml(title)}</h1>
          ${description ? `<p>${escapeHtml(description)}</p>` : ''}
        </div>
      </header>
    `;
  }

  function upcomingAppointments() {
    return state.appointments
      .filter((item) => item.date >= today() && item.status === 'confirmed')
      .sort((a, b) => `${a.date}${a.start_time}`.localeCompare(`${b.date}${b.start_time}`));
  }

  function renderOverview() {
    const upcoming = upcomingAppointments();
    const google = state.google || {};
    const googleDescription = !google.available
      ? 'Reku debe cargar las credenciales de la aplicación de Google antes de habilitar esta conexión.'
      : google.connected
        ? `Calendario principal conectado${google.google_email ? ` con ${google.google_email}` : ''}. Los nuevos turnos generan una sala de Meet y bloquean ese horario.`
        : google.status === 'error'
          ? 'La autorización venció o fue revocada. Volvé a conectar Google para validar tu agenda.'
          : 'Autorizá el calendario principal de tu cuenta personal. Reku sólo solicita acceso a eventos propios y disponibilidad.';
    const googleAction = !google.available
      ? '<span class="badge">Configuración pendiente</span>'
      : google.connected
        ? '<button id="google-disconnect-button" class="secondary-button" type="button">Desconectar</button>'
        : '<button id="google-connect-button" class="primary-button" type="button">Conectar Google Calendar</button>';
    return `
      ${pageHeader(`Hola, ${state.profile?.name || 'Profesional'}`, 'Este es el estado actual de tu agenda.')}
      <section class="grid-cards">
        <article class="card metric-card"><span>Próximos turnos</span><strong>${upcoming.length}</strong></article>
        <article class="card metric-card"><span>Pacientes disponibles</span><strong>${state.patients.length}</strong></article>
        <article class="card metric-card"><span>Bloqueos próximos</span><strong>${state.blocks.length}</strong></article>
      </section>
      <section class="panel">
        <div class="integration-card">
          <div>
            <h2>Google Calendar y Meet</h2>
            <p class="muted">${escapeHtml(googleDescription)}</p>
          </div>
          ${googleAction}
        </div>
      </section>
      <section class="panel">
        <div class="panel-header"><h2>Próximos turnos</h2></div>
        ${renderAppointmentsTable(upcoming.slice(0, 8))}
      </section>
    `;
  }

  function renderAppointmentsTable(items) {
    if (!items.length) return '<div class="empty-state">No hay turnos para mostrar.</div>';
    return `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Fecha</th><th>Horario</th><th>Paciente</th><th>Servicio</th><th>Contacto</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            ${items
              .map(
                (item) => `
                  <tr>
                    <td><strong>${escapeHtml(formatDate(item.date))}</strong></td>
                    <td>${escapeHtml(item.start_time)}–${escapeHtml(item.end_time)}</td>
                    <td>${escapeHtml(item.patient_name || 'Paciente')}</td>
                    <td>${escapeHtml(item.service_name)}</td>
                    <td>
                      ${item.patient_email ? `<a href="mailto:${escapeHtml(item.patient_email)}">${escapeHtml(item.patient_email)}</a><br />` : ''}
                      ${item.patient_phone ? `<a href="tel:${escapeHtml(item.patient_phone)}">${escapeHtml(item.patient_phone)}</a>` : ''}
                    </td>
                    <td>
                      ${item.google_meet_url ? `<a href="${escapeHtml(item.google_meet_url)}" target="_blank" rel="noopener">Abrir Meet</a><br />` : ''}
                      ${
                      item.status === 'confirmed'
                        ? `Confirmado${item.google_sync_status === 'failed' ? ' · Google pendiente' : ''}${item.triage_status === 'failed' ? ' · Cuestionario no disponible' : ''}`
                        : item.status === 'cancelled'
                          ? `Cancelado${item.refund_status === 'approved' ? ' · reembolsado' : item.refund_status === 'failed' ? ' · devolución pendiente' : ''}`
                          : 'Pendiente de pago'
                    }</td>
                    <td>${
                      item.status === 'confirmed' && item.date >= today()
                        ? `<button class="danger-button" data-action="cancel-appointment" data-id="${item.id}" type="button">Cancelar</button>`
                        : item.status === 'cancelled' && item.refund_status === 'failed'
                          ? `<button class="secondary-button" data-action="retry-refund" data-id="${item.id}" data-reason="${escapeHtml(item.cancellation_reason || 'Cancelado por el profesional')}" type="button">Reintentar devolución</button>`
                          : ''
                    }</td>
                  </tr>
                `,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderAppointments() {
    const items = [...state.appointments].sort((a, b) =>
      `${b.date}${b.start_time}`.localeCompare(`${a.date}${a.start_time}`),
    );
    return `
      ${pageHeader('Turnos', 'Próximos e históricos vinculados a tu ficha profesional.')}
      <section class="panel">
        <div class="panel-header">
          <h2>Agenda</h2>
          <span class="badge">Reembolso automático para pagos aprobados</span>
        </div>
        ${renderAppointmentsTable(items)}
      </section>
    `;
  }

  function renderPatients() {
    return `
      ${pageHeader('Pacientes', 'Directorio global de contacto. No incluye datos clínicos, de pago o nómina.')}
      <section class="panel">
        <div class="panel-header">
          <h2>Directorio</h2>
          <form id="patient-search-form" class="search-form">
            <input name="q" value="${escapeHtml(state.patientSearch)}" placeholder="Buscar por nombre, email o teléfono" />
            <button class="secondary-button" type="submit">Buscar</button>
          </form>
        </div>
        ${
          state.patients.length
            ? `
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Paciente</th><th>Email</th><th>Teléfono</th></tr></thead>
                  <tbody>
                    ${state.patients
                      .map(
                        (patient) => `
                          <tr>
                            <td><strong>${escapeHtml(patient.name || 'Sin nombre')}</strong></td>
                            <td>${patient.email ? `<a href="mailto:${escapeHtml(patient.email)}">${escapeHtml(patient.email)}</a>` : '—'}</td>
                            <td>${patient.phone ? `<a href="tel:${escapeHtml(patient.phone)}">${escapeHtml(patient.phone)}</a>` : '—'}</td>
                          </tr>
                        `,
                      )
                      .join('')}
                  </tbody>
                </table>
              </div>
            `
            : '<div class="empty-state">No encontramos pacientes.</div>'
        }
      </section>
    `;
  }

  function rangesForDay(day) {
    const ranges = state.availability.filter((range) => Number(range.day_of_week) === day);
    return ranges.length ? ranges : [{ start_time: '09:00', end_time: '18:00' }];
  }

  function availabilityRange(range) {
    return `
      <div class="availability-range">
        <input data-field="start_time" type="time" value="${escapeHtml(range.start_time)}" />
        <span>a</span>
        <input data-field="end_time" type="time" value="${escapeHtml(range.end_time)}" />
        <button class="icon-button" data-action="remove-range" type="button" aria-label="Quitar horario">−</button>
      </div>
    `;
  }

  function renderAvailability() {
    return `
      ${pageHeader('Horarios', 'Definí tus franjas habituales de atención.')}
      <form id="availability-form" class="panel">
        <div class="availability-list">
          ${dayLabels
            .map(([day, label]) => {
              const enabled = state.availability.some((range) => Number(range.day_of_week) === day);
              return `
                <div class="availability-day" data-day="${day}">
                  <label class="check-row"><input data-field="enabled" type="checkbox" ${enabled ? 'checked' : ''} /> ${escapeHtml(label)}</label>
                  <div class="availability-ranges">${rangesForDay(day).map(availabilityRange).join('')}</div>
                  <button class="link-button" data-action="add-range" type="button">+ Horario</button>
                </div>
              `;
            })
            .join('')}
        </div>
        <div class="form-actions"><button class="primary-button" type="submit">Guardar horarios</button></div>
      </form>
    `;
  }

  function renderBlocks() {
    return `
      ${pageHeader('Bloqueos', 'Cargá excepciones puntuales sobre tu horario habitual.')}
      <section class="two-columns">
        <form id="block-form" class="panel form-stack">
          <h2>Nuevo bloqueo</h2>
          <label>Fecha<input name="block_date" type="date" min="${today()}" required /></label>
          <div class="form-grid">
            <label>Desde<input name="start_time" type="time" required /></label>
            <label>Hasta<input name="end_time" type="time" required /></label>
          </div>
          <label>Motivo<textarea name="reason" rows="3" maxlength="300"></textarea></label>
          <button class="primary-button" type="submit">Crear bloqueo</button>
        </form>
        <section class="panel">
          <div class="panel-header"><h2>Próximos bloqueos</h2></div>
          <div class="block-list">
            ${
              state.blocks.length
                ? state.blocks
                    .map(
                      (block) => `
                        <article class="block-row">
                          <div>
                            <strong>${escapeHtml(formatDate(block.block_date))} · ${escapeHtml(block.start_time)}–${escapeHtml(block.end_time)}</strong>
                            <span class="muted">${escapeHtml(block.reason || 'Sin motivo')}</span>
                          </div>
                          <button class="danger-button" data-action="delete-block" data-id="${block.id}" type="button">Quitar</button>
                        </article>
                      `,
                    )
                    .join('')
                : '<div class="empty-state">No hay bloqueos próximos.</div>'
            }
          </div>
        </section>
      </section>
    `;
  }

  function renderProfile() {
    const profile = state.profile || {};
    return `
      ${pageHeader('Mi perfil', 'Estos datos identifican tu ficha pública y profesional.')}
      <form id="profile-form" class="panel form-grid">
        <div class="photo-row span-two">
          ${profile.photo_url ? `<img class="profile-photo" src="${escapeHtml(profile.photo_url)}" alt="" />` : '<div class="profile-photo"></div>'}
          <label>Foto<input name="photo" type="file" accept="image/png,image/jpeg,image/webp" /></label>
        </div>
        ${
          profile.photo_url
            ? '<label class="check-row span-two"><input name="remove_photo" type="checkbox" /> Quitar foto actual</label>'
            : ''
        }
        <label>Nombre visible<input name="name" value="${escapeHtml(profile.name || '')}" required /></label>
        <label>Email<input value="${escapeHtml(profile.email || '')}" disabled /></label>
        <label>Matrícula<input name="license_number" value="${escapeHtml(profile.license_number || '')}" maxlength="120" /></label>
        <label>Especialidad<input name="specialty" value="${escapeHtml(profile.specialty || '')}" maxlength="160" /></label>
        <label>Teléfono<input name="phone" value="${escapeHtml(profile.phone || '')}" maxlength="80" autocomplete="tel" /></label>
        <label class="span-two">Bio<textarea name="bio" rows="5" maxlength="2000">${escapeHtml(profile.bio || '')}</textarea></label>
        <div class="form-actions span-two"><button class="primary-button" type="submit">Guardar perfil</button></div>
      </form>
      <form id="password-form" class="panel form-grid">
        <div class="span-two"><h2>Cambiar contraseña</h2></div>
        <label>Contraseña actual<input name="current_password" type="password" autocomplete="current-password" required /></label>
        <label>Nueva contraseña<input name="new_password" type="password" minlength="10" autocomplete="new-password" required /></label>
        <div class="form-actions span-two"><button class="secondary-button" type="submit">Actualizar contraseña</button></div>
      </form>
    `;
  }

  function renderContent() {
    if (state.active === 'appointments') return renderAppointments();
    if (state.active === 'patients') return renderPatients();
    if (state.active === 'availability') return renderAvailability();
    if (state.active === 'blocks') return renderBlocks();
    if (state.active === 'profile') return renderProfile();
    return renderOverview();
  }

  function renderPortal() {
    app.className = 'portal-shell';
    app.innerHTML = `
      ${renderSidebar()}
      <main class="portal-main">
        ${renderStatus()}
        ${renderContent()}
      </main>
    `;
    bindEvents();
  }

  function render() {
    if (state.loading) return;
    if (!state.user) renderLogin();
    else renderPortal();
  }

  function bindEvents() {
    app.querySelectorAll('[data-module]').forEach((button) => {
      button.addEventListener('click', () => {
        state.active = button.dataset.module;
        state.status = '';
        render();
      });
    });
    document.getElementById('logout-button')?.addEventListener('click', handleLogout);
    document.getElementById('profile-form')?.addEventListener('submit', handleProfile);
    document.getElementById('availability-form')?.addEventListener('submit', handleAvailability);
    document.getElementById('block-form')?.addEventListener('submit', handleBlock);
    document.getElementById('password-form')?.addEventListener('submit', handlePassword);
    document.getElementById('patient-search-form')?.addEventListener('submit', handlePatientSearch);
    document.getElementById('google-connect-button')?.addEventListener('click', handleGoogleConnect);
    document.getElementById('google-disconnect-button')?.addEventListener('click', handleGoogleDisconnect);
    app.querySelectorAll('[data-action="add-range"]').forEach((button) => {
      button.addEventListener('click', () => {
        const day = button.closest('.availability-day');
        const ranges = day.querySelector('.availability-ranges');
        ranges.insertAdjacentHTML(
          'beforeend',
          availabilityRange({ start_time: '09:00', end_time: '18:00' }),
        );
        day.querySelector('[data-field="enabled"]').checked = true;
        ranges
          .lastElementChild
          .querySelector('[data-action="remove-range"]')
          .addEventListener('click', (event) =>
            event.currentTarget.closest('.availability-range').remove(),
          );
      });
    });
    app.querySelectorAll('[data-action="remove-range"]').forEach((button) => {
      button.addEventListener('click', () => button.closest('.availability-range').remove());
    });
    app.querySelectorAll('[data-action="delete-block"]').forEach((button) => {
      button.addEventListener('click', () => handleDeleteBlock(button.dataset.id));
    });
    app.querySelectorAll('[data-action="cancel-appointment"]').forEach((button) => {
      button.addEventListener('click', () => handleCancelAppointment(button.dataset.id));
    });
    app.querySelectorAll('[data-action="retry-refund"]').forEach((button) => {
      button.addEventListener('click', () =>
        handleCancelAppointment(button.dataset.id, button.dataset.reason),
      );
    });
  }

  async function handleLogin(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const payload = await api('/api/professional/auth/login', {
        method: 'POST',
        body: { email: form.email.value, password: form.password.value },
      });
      state.user = payload.user;
      state.csrf = payload.csrf_token;
      state.status = '';
      await loadData();
      render();
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function handleLogout() {
    try {
      await api('/api/professional/auth/logout', { method: 'POST' });
    } finally {
      state.user = null;
      state.csrf = '';
      state.status = '';
      render();
    }
  }

  async function handleProfile(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    data.set('remove_photo', event.currentTarget.remove_photo?.checked ? 'true' : 'false');
    try {
      const payload = await api('/api/professional/profile', { method: 'PUT', body: data });
      state.profile = payload.profile;
      setStatus('Perfil actualizado.', 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function handleAvailability(event) {
    event.preventDefault();
    const availability = Array.from(event.currentTarget.querySelectorAll('.availability-day'))
      .filter((day) => day.querySelector('[data-field="enabled"]').checked)
      .flatMap((day) =>
        Array.from(day.querySelectorAll('.availability-range')).map((range) => ({
          day_of_week: Number(day.dataset.day),
          start_time: range.querySelector('[data-field="start_time"]').value,
          end_time: range.querySelector('[data-field="end_time"]').value,
        })),
      );
    try {
      const payload = await api('/api/professional/availability', {
        method: 'PUT',
        body: { availability },
      });
      state.availability = payload.availability;
      setStatus('Horarios actualizados.', 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function handleBlock(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api('/api/professional/blocks', {
        method: 'POST',
        body: {
          block_date: form.block_date.value,
          start_time: form.start_time.value,
          end_time: form.end_time.value,
          reason: form.reason.value,
        },
      });
      state.blocks = (await api('/api/professional/blocks')).schedule_blocks;
      setStatus('Bloqueo creado.', 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function handleDeleteBlock(id) {
    if (!window.confirm('¿Querés quitar este bloqueo?')) return;
    try {
      await api(`/api/professional/blocks/${id}`, { method: 'DELETE' });
      state.blocks = (await api('/api/professional/blocks')).schedule_blocks;
      setStatus('Bloqueo eliminado.', 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function handleCancelAppointment(id, existingReason = '') {
    const reason =
      existingReason ||
      window.prompt(
        'Indicá el motivo. El paciente recibirá un aviso y, si pagó por Mercado Pago, se solicitará el reembolso total.',
      );
    if (reason === null) return;
    if (!reason.trim()) {
      setStatus('Indicá el motivo de la cancelación.', 'error');
      return;
    }
    try {
      const result = await api(`/api/professional/appointments/${id}/cancel`, {
        method: 'POST',
        body: { reason },
      });
      state.appointments = (await api('/api/professional/appointments')).appointments;
      const messages = [];
      if (result.appointment.refund_status === 'approved') {
        messages.push('El reembolso fue solicitado.');
      } else if (result.appointment.refund_status === 'failed') {
        messages.push('La devolución requiere revisión.');
      }
      if (result.google_calendar?.ok === false) {
        messages.push('La baja en Google Calendar requiere revisión.');
      }
      const hasWarning =
        result.appointment.refund_status === 'failed' ||
        result.google_calendar?.ok === false;
      setStatus(
        `Turno cancelado.${messages.length ? ` ${messages.join(' ')}` : ''}`,
        hasWarning ? 'error' : 'ok',
      );
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function handlePatientSearch(event) {
    event.preventDefault();
    state.patientSearch = event.currentTarget.q.value.trim();
    try {
      const payload = await api(
        `/api/professional/patients?q=${encodeURIComponent(state.patientSearch)}`,
      );
      state.patients = payload.patients;
      render();
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function handleGoogleConnect() {
    try {
      const payload = await api('/api/professional/integrations/google/connect', {
        method: 'POST',
      });
      window.location.assign(payload.authorization_url);
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function handleGoogleDisconnect() {
    if (!window.confirm('¿Querés desconectar Google Calendar?')) return;
    try {
      await api('/api/professional/integrations/google/disconnect', { method: 'POST' });
      state.google = (await api('/api/professional/integrations/google')).google;
      setStatus('Google Calendar fue desconectado.', 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function handlePassword(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api('/api/professional/auth/change-password', {
        method: 'POST',
        body: {
          current_password: form.current_password.value,
          new_password: form.new_password.value,
        },
      });
      state.user = null;
      state.csrf = '';
      setStatus('Contraseña actualizada. Volvé a ingresar.', 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  const googleReturn = new URLSearchParams(window.location.search).get('google');
  if (googleReturn) {
    const messages = {
      connected: ['Google Calendar quedó conectado.', 'ok'],
      cancelled: ['La autorización de Google fue cancelada.', 'error'],
      account_change_blocked: [
        'No se puede cambiar la cuenta de Google mientras haya turnos futuros sincronizados.',
        'error',
      ],
      error: ['No se pudo conectar Google Calendar. Probá nuevamente.', 'error'],
    };
    [state.status, state.statusType] = messages[googleReturn] || messages.error;
    window.history.replaceState({}, '', '/profesional/');
  }
  loadSession();
})();
