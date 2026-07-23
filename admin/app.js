(() => {
  const app = document.getElementById('app');
  const publicBaseUrl = 'https://www.reku.io';
  let csrfToken = '';
  const state = {
    user: null,
    loading: true,
    active: 'dashboard',
    userMenuOpen: false,
    editingAgreementId: null,
    editingServiceId: null,
    editingProfessionalId: null,
    agreements: [],
    patientIntakes: [],
    contacts: [],
    nominaEntries: [],
    dashboard: null,
    services: [],
    professionals: [],
    appointments: [],
    scheduleBlocks: [],
    auditEvents: [],
    mercadoPagoSettings: null,
    testBookingUrl: '',
    agreementTypeFilter: '',
    agreementCobrandFilter: '',
    agreementTextFilter: '',
    patientAgreementFilter: '',
    patientTextFilter: '',
    nominaAgreementFilter: '',
    nominaFormFilter: '',
    status: '',
    statusType: '',
    dialog: null,
  };

  const modules = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'agreements', label: 'Acuerdos' },
    { id: 'nomina', label: 'Nóminas' },
    { id: 'patient-intakes', label: 'Altas Pacientes' },
    { id: 'contacts', label: 'Contactos' },
    { id: 'services', label: 'Servicios' },
    { id: 'professionals', label: 'Profesionales' },
    { id: 'appointments', label: 'Turnos' },
    { id: 'blocks', label: 'Bloquear horario' },
    { id: 'booking-test', label: 'Probar Agenda' },
  ];

  const dayLabels = [
    { id: 1, label: 'Lunes' },
    { id: 2, label: 'Martes' },
    { id: 3, label: 'Miércoles' },
    { id: 4, label: 'Jueves' },
    { id: 5, label: 'Viernes' },
    { id: 6, label: 'Sábado' },
    { id: 7, label: 'Domingo' },
  ];

  const escapeHtml = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');

  const formatDate = (value) => {
    if (!value) return '';
    return new Intl.DateTimeFormat('es-AR', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(value));
  };

  const formatMoney = (value) =>
    new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      maximumFractionDigits: 0,
    }).format(Number(value || 0));

  const paymentStatusLabel = (value) =>
    ({
      approved: 'Aprobado',
      pending: 'Pendiente',
      in_process: 'En proceso',
      authorized: 'Autorizado',
      rejected: 'Rechazado',
      cancelled: 'Cancelado',
      refunded: 'Devuelto',
      charged_back: 'Contracargo',
      paid_simulated: 'Pago simulado',
      free: 'Sin costo',
      preference_error: 'Error al crear pago',
    })[value] || value || '';

  const todayInput = () => new Date().toISOString().slice(0, 10);

  const dayLabel = (dayOfWeek) =>
    dayLabels.find((day) => day.id === Number(dayOfWeek))?.label || '';

  const setStatus = (message, type = '') => {
    state.status = message;
    state.statusType = type;
    render();
  };

  const clearStatus = () => {
    state.status = '';
    state.statusType = '';
  };

  async function api(path, options = {}) {
    const method = options.method || 'GET';
    const headers = { ...(options.headers || {}) };
    const request = { method, headers, credentials: 'same-origin' };

    if (csrfToken && !['GET', 'HEAD'].includes(method)) {
      headers['X-CSRF-Token'] = csrfToken;
    }

    if (options.body instanceof FormData) {
      request.body = options.body;
    } else if (options.body) {
      headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(options.body);
    }

    const response = await fetch(path, request);
    const payload = await response.json().catch(() => ({}));

    if (response.status === 401) {
      csrfToken = '';
      state.user = null;
      render();
    }

    if (!response.ok) {
      const error = new Error(payload.error || 'No se pudo completar la acción.');
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  async function loadSession() {
    try {
      const payload = await api('/api/admin/auth/me');
      csrfToken = payload.csrf_token;
      state.user = payload.user;
      await loadData();
    } catch {
      state.user = null;
    } finally {
      state.loading = false;
      render();
    }
  }

  async function loadData() {
    const [
      dashboardData,
      agreementData,
      patientData,
      contactData,
      nominaData,
      serviceData,
      professionalData,
      appointmentData,
      blockData,
    ] = await Promise.all([
      api('/api/admin/dashboard'),
      api('/api/admin/agreements'),
      api(`/api/admin/patient-intakes${state.patientAgreementFilter ? `?agreement_id=${state.patientAgreementFilter}` : ''}`),
      api('/api/admin/contacts'),
      api(`/api/admin/nomina${state.nominaAgreementFilter ? `?agreement_id=${state.nominaAgreementFilter}` : ''}`),
      api('/api/admin/services'),
      api('/api/admin/professionals'),
      api('/api/admin/appointments'),
      api('/api/admin/schedule-blocks'),
    ]);
    state.dashboard = dashboardData.dashboard || null;
    state.agreements = agreementData.agreements || [];
    state.patientIntakes = patientData.patient_intakes || [];
    state.contacts = contactData.contacts || [];
    state.nominaEntries = nominaData.nomina_entries || [];
    state.services = serviceData.services || [];
    state.professionals = professionalData.professionals || [];
    state.appointments = appointmentData.appointments || [];
    state.scheduleBlocks = blockData.schedule_blocks || [];
  }

  function render() {
    if (state.loading) {
      app.className = 'app-loading';
      app.textContent = 'Cargando admin...';
      return;
    }

    if (!state.user) {
      renderLogin();
      return;
    }

    app.className = 'app-shell';
    app.innerHTML = `
      <aside class="sidebar">
        <div class="side-brand">
          <img src="/images/logo-reku.svg" alt="Reku" />
        </div>
        <nav class="side-nav">
          ${modules
            .map(
              (module) => `
                <button
                  type="button"
                  class="nav-button${state.active === module.id ? ' active' : ''}"
                  data-module="${module.id}"
                >
                  <span>${escapeHtml(module.label)}</span>
                </button>
              `,
            )
            .join('')}
        </nav>
        <a class="sidebar-foot" href="https://ferpic-ideas.tech" target="_blank" rel="noreferrer">Hecho x Ferpic</a>
      </aside>
      <main class="content">
        <header class="topbar">
          <div class="brand-row">
            <div>
              <h1>${escapeHtml(activeModuleLabel())}</h1>
            </div>
          </div>
          <div class="topbar-actions">
            <button type="button" class="icon-button refresh-button" data-action="refresh" aria-label="Actualizar" title="Actualizar">
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M21 12a9 9 0 0 1-15.4 6.4L3 16" />
                <path d="M3 21v-5h5" />
                <path d="M3 12A9 9 0 0 1 18.4 5.6L21 8" />
                <path d="M21 3v5h-5" />
              </svg>
            </button>
            <div class="user-menu">
              <button type="button" class="user-menu-trigger" data-action="toggle-user-menu">
                ${escapeHtml(state.user.email)} ▾
              </button>
              <div class="user-menu-popover" ${state.userMenuOpen ? '' : 'hidden'}>
                ${
                  state.user.can_manage_system
                    ? `
                      <button type="button" class="dropdown-button" data-action="open-config">Configurar</button>
                      <button type="button" class="dropdown-button" data-action="open-audit">Auditoría</button>
                    `
                    : ''
                }
                <button type="button" class="dropdown-button" data-action="change-password">Cambiar clave</button>
                <button type="button" class="dropdown-button" data-action="logout">Salir</button>
              </div>
            </div>
          </div>
        </header>
        ${state.status ? `<div class="status-box ${escapeHtml(state.statusType)}">${escapeHtml(state.status)}</div>` : ''}
        ${renderActiveModule()}
        ${renderDialog()}
      </main>
    `;
    bindEvents();
  }

  function renderLogin() {
    app.className = 'login-shell';
    app.innerHTML = `
      <form class="login-panel" id="login-form">
        <div class="brand-row">
          <img src="/images/logo-reku.svg" alt="Reku" />
        </div>
        <div>
          <h1>Admin</h1>
          <p>Ingresá con tu usuario para gestionar acuerdos y registros.</p>
        </div>
        <label>
          Email
          <input name="email" type="email" autocomplete="email" required />
        </label>
        <label>
          Clave
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <button class="primary-button" type="submit">Ingresar</button>
        ${state.status ? `<div class="status-box error">${escapeHtml(state.status)}</div>` : ''}
      </form>
    `;
    document.getElementById('login-form').addEventListener('submit', handleLogin);
  }

  function activeModuleLabel() {
    if (state.active === 'config') return 'Configurar';
    if (state.active === 'audit') return 'Auditoría';
    return modules.find((module) => module.id === state.active)?.label || 'Admin';
  }

  function renderActiveModule() {
    if (state.active === 'dashboard') return renderDashboard();
    if (state.active === 'agreements') return renderAgreements();
    if (state.active === 'patient-intakes') return renderPatientIntakes();
    if (state.active === 'contacts') return renderContacts();
    if (state.active === 'nomina') return renderNomina();
    if (state.active === 'services') return renderServices();
    if (state.active === 'professionals') return renderProfessionals();
    if (state.active === 'appointments') return renderAppointments();
    if (state.active === 'blocks') return renderScheduleBlocks();
    if (state.active === 'booking-test') return renderBookingTest();
    if (state.active === 'config') return renderConfig();
    if (state.active === 'audit') return renderAudit();
    return '';
  }

  function renderDialog() {
    if (!state.dialog) return '';

    if (state.dialog.type === 'change-password') {
      return `
        <div class="modal-backdrop">
          <form class="modal-panel" id="change-password-form">
            <h2>Cambiar clave</h2>
            <label>
              Clave actual
              <input name="current_password" type="password" autocomplete="current-password" required />
            </label>
            <label>
              Nueva clave
              <input name="new_password" type="password" autocomplete="new-password" minlength="10" required />
            </label>
            <div class="modal-actions">
              <button type="button" class="secondary-button" data-action="close-dialog">Cancelar</button>
              <button type="submit" class="primary-button">Guardar</button>
            </div>
          </form>
        </div>
      `;
    }

    if (state.dialog.type === 'confirm-delete') {
      return `
        <div class="modal-backdrop">
          <div class="modal-panel" role="dialog" aria-modal="true">
            <h2>${escapeHtml(state.dialog.title)}</h2>
            <p class="muted">${escapeHtml(state.dialog.message)}</p>
            <div class="modal-actions">
              <button type="button" class="secondary-button" data-action="close-dialog">Cancelar</button>
              <button type="button" class="danger-button" data-action="confirm-delete">Eliminar</button>
            </div>
          </div>
        </div>
      `;
    }

    if (state.dialog.type === 'agreement-form') {
      return `
        <div class="modal-backdrop">
          <form class="modal-panel modal-panel-wide" id="agreement-form">
            <div class="modal-header">
              <h2>${state.editingAgreementId ? 'Editar acuerdo' : 'Nuevo acuerdo'}</h2>
              <button type="button" class="icon-button" data-action="close-dialog" aria-label="Cerrar">×</button>
            </div>
            ${renderAgreementFormFields()}
          </form>
        </div>
      `;
    }

    if (state.dialog.type === 'nomina-form') {
      return `
        <div class="modal-backdrop">
          <form class="modal-panel" id="nomina-form">
            <div class="modal-header">
              <h2>Agregar nómina</h2>
              <button type="button" class="icon-button" data-action="close-dialog" aria-label="Cerrar">×</button>
            </div>
            ${renderNominaFormFields()}
          </form>
        </div>
      `;
    }

    if (state.dialog.type === 'nomina-csv-form') {
      return `
        <div class="modal-backdrop">
          <form class="modal-panel" id="nomina-csv-form">
            <div class="modal-header">
              <h2>Subir CSV de nómina</h2>
              <button type="button" class="icon-button" data-action="close-dialog" aria-label="Cerrar">×</button>
            </div>
            ${renderNominaCsvFormFields()}
          </form>
        </div>
      `;
    }

    if (state.dialog.type === 'service-form') {
      return `
        <div class="modal-backdrop">
          <form class="modal-panel" id="service-form">
            <div class="modal-header">
              <h2>${state.editingServiceId ? 'Editar servicio' : 'Nuevo servicio'}</h2>
              <button type="button" class="icon-button" data-action="close-dialog" aria-label="Cerrar">×</button>
            </div>
            ${renderServiceFormFields()}
          </form>
        </div>
      `;
    }

    if (state.dialog.type === 'professional-form') {
      return `
        <div class="modal-backdrop">
          <form class="modal-panel modal-panel-wide" id="professional-form">
            <div class="modal-header">
              <h2>${state.editingProfessionalId ? 'Editar profesional' : 'Nuevo profesional'}</h2>
              <button type="button" class="icon-button" data-action="close-dialog" aria-label="Cerrar">×</button>
            </div>
            ${renderProfessionalFormFields()}
          </form>
        </div>
      `;
    }

    if (state.dialog.type === 'schedule-block-form') {
      return `
        <div class="modal-backdrop">
          <form class="modal-panel" id="schedule-block-form">
            <div class="modal-header">
              <h2>Bloquear horario</h2>
              <button type="button" class="icon-button" data-action="close-dialog" aria-label="Cerrar">×</button>
            </div>
            ${renderScheduleBlockFormFields()}
          </form>
        </div>
      `;
    }

    return '';
  }

  function renderDashboard() {
    const data = state.dashboard || {};
    const cards = [
      ['Contactos', data.contacts || 0],
      ['Altas Pacientes', data.patient_intakes || 0],
      ['Turnos', data.appointments || 0],
      ['Facturado', formatMoney(data.revenue || 0)],
      ['Servicios activos', data.services || 0],
      ['Profesionales activos', data.professionals || 0],
      ['Bloqueos próximos', data.upcoming_blocks || 0],
    ];

    return `
      <section class="dashboard-grid">
        ${cards
          .map(
            ([label, value]) => `
              <article class="metric-card">
                <span>${escapeHtml(label)}</span>
                <strong>${escapeHtml(value)}</strong>
              </article>
            `,
          )
          .join('')}
      </section>
      <section class="panel">
        <div class="panel-header">
          <h2>Próximos turnos</h2>
        </div>
        ${renderAppointmentsTable(state.appointments.slice(0, 8))}
      </section>
    `;
  }

  function serviceFormValues() {
    return (
      state.services.find((service) => service.id === state.editingServiceId) || {
        name: '',
        duration_minutes: 30,
        cost_amount: '',
        payment_url: '',
        active: true,
      }
    );
  }

  function renderServiceFormFields() {
    const item = serviceFormValues();
    return `
      <div class="grid-two">
        <label class="span-two">
          Nombre
          <input name="name" value="${escapeHtml(item.name)}" required />
        </label>
        <label>
          Duración en minutos
          <input name="duration_minutes" type="number" min="5" step="5" value="${escapeHtml(item.duration_minutes)}" required />
        </label>
        <label>
          Costo
          <input name="cost_amount" type="number" min="0" step="0.01" value="${escapeHtml(item.cost_amount)}" required />
        </label>
        <label class="span-two">
          Link de pago fallback
          <input name="payment_url" type="url" value="${escapeHtml(item.payment_url)}" placeholder="Opcional" />
        </label>
        <label class="check-row span-two">
          <input type="checkbox" name="active" ${item.active ? 'checked' : ''} />
          Activo
        </label>
        <div class="form-actions span-two">
          <button type="button" class="secondary-button" data-action="close-dialog">Cancelar</button>
          <button type="submit" class="primary-button">Guardar servicio</button>
        </div>
      </div>
    `;
  }

  function renderServices() {
    return `
      <section class="panel">
        <div class="panel-header">
          <h2>Servicios</h2>
          <button type="button" class="primary-button" data-action="new-service">Nuevo</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Duración</th>
                <th>Costo</th>
                <th>Pago</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${
                state.services.length
                  ? state.services.map(renderServiceRow).join('')
                  : '<tr><td colspan="6">No hay servicios cargados.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderServiceRow(service) {
    return `
      <tr>
        <td><strong>${escapeHtml(service.name)}</strong></td>
        <td>${escapeHtml(service.duration_minutes)} min</td>
        <td>${escapeHtml(formatMoney(service.cost_amount))}</td>
        <td>
          ${
            service.payment_url
              ? `<a href="${escapeHtml(service.payment_url)}" target="_blank" rel="noreferrer">Fallback</a>`
              : 'Checkout Pro'
          }
        </td>
        <td>${service.active ? 'Activo' : 'Inactivo'}</td>
        <td>
          <div class="table-actions">
            <button type="button" class="secondary-button" data-action="edit-service" data-id="${service.id}">Editar</button>
            <button type="button" class="danger-button" data-action="delete-service" data-id="${service.id}">Eliminar</button>
          </div>
        </td>
      </tr>
    `;
  }

  function professionalFormValues() {
    return (
      state.professionals.find((professional) => professional.id === state.editingProfessionalId) || {
        name: '',
        email: '',
        photo_url: '',
        active: true,
        services: [],
        availability: [],
      }
    );
  }

  function servicesForProfessional(item) {
    const selected = new Set((item.services || []).map((service) => Number(service.id)));
    return state.services
      .filter((service) => service.active)
      .map(
        (service) => `
          <label class="check-row compact-check">
            <input type="checkbox" name="service_ids" value="${service.id}" ${selected.has(service.id) ? 'checked' : ''} />
            ${escapeHtml(service.name)}
          </label>
        `,
      )
      .join('');
  }

  function availabilityByDay(item, dayId) {
    return (item.availability || []).filter((range) => Number(range.day_of_week) === dayId);
  }

  function renderAvailabilityEditor(item) {
    return `
      <div class="availability-editor span-two">
        <h3>Horario de trabajo</h3>
        ${dayLabels
          .map((day) => {
            const ranges = availabilityByDay(item, day.id);
            const dayRanges = ranges.length
              ? ranges
              : [{ start_time: '09:00', end_time: '18:00' }];
            return `
              <div class="availability-day" data-day="${day.id}">
                <label class="check-row availability-day-toggle">
                  <input type="checkbox" ${ranges.length ? 'checked' : ''} />
                  ${escapeHtml(day.label)}
                </label>
                <div class="availability-ranges">
                  ${dayRanges.map(renderAvailabilityRange).join('')}
                </div>
                <button type="button" class="link-button" data-action="add-availability-range" data-day="${day.id}">+ Agregar horario</button>
              </div>
            `;
          })
          .join('')}
      </div>
    `;
  }

  function renderAvailabilityRange(range) {
    return `
      <div class="availability-range">
        <input type="time" data-field="start_time" value="${escapeHtml(String(range.start_time || '09:00').slice(0, 5))}" />
        <span>a</span>
        <input type="time" data-field="end_time" value="${escapeHtml(String(range.end_time || '18:00').slice(0, 5))}" />
        <button type="button" class="icon-button mini-button" data-action="remove-availability-range" aria-label="Quitar horario">−</button>
      </div>
    `;
  }

  function renderProfessionalFormFields() {
    const item = professionalFormValues();
    return `
      <div class="grid-two">
        <label>
          Nombre
          <input name="name" value="${escapeHtml(item.name)}" required />
        </label>
        <label>
          Mail
          <input name="email" type="email" value="${escapeHtml(item.email)}" required />
        </label>
        <label>
          Foto
          <input class="file-input" name="photo" type="file" accept="image/*" />
        </label>
        <label class="check-row">
          <input type="checkbox" name="active" ${item.active ? 'checked' : ''} />
          Activo
        </label>
        ${
          item.photo_url
            ? `
              <label class="check-row span-two">
                <input type="checkbox" name="remove_photo" />
                Quitar foto actual
              </label>
            `
            : ''
        }
        <div class="span-two checkbox-grid">
          <strong>Servicios que atiende</strong>
          ${servicesForProfessional(item) || '<p class="muted">Primero cargá servicios activos.</p>'}
        </div>
        ${renderAvailabilityEditor(item)}
        <div class="form-actions span-two">
          <button type="button" class="secondary-button" data-action="close-dialog">Cancelar</button>
          <button type="submit" class="primary-button">Guardar profesional</button>
        </div>
      </div>
    `;
  }

  function renderProfessionals() {
    return `
      <section class="panel">
        <div class="panel-header">
          <h2>Profesionales</h2>
          <button type="button" class="primary-button" data-action="new-professional">Nuevo</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Profesional</th>
                <th>Mail</th>
                <th>Servicios</th>
                <th>Horarios</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${
                state.professionals.length
                  ? state.professionals.map(renderProfessionalRow).join('')
                  : '<tr><td colspan="6">No hay profesionales cargados.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderProfessionalRow(professional) {
    return `
      <tr>
        <td>
          <div class="person-cell">
            ${professional.photo_url ? `<img src="${escapeHtml(professional.photo_url)}" alt="" />` : '<span class="avatar-placeholder">+</span>'}
            <strong>${escapeHtml(professional.name)}</strong>
          </div>
        </td>
        <td>${escapeHtml(professional.email)}</td>
        <td>${(professional.services || []).map((service) => escapeHtml(service.name)).join(', ') || 'Sin servicios'}</td>
        <td>${renderAvailabilitySummary(professional.availability)}</td>
        <td>${professional.active ? 'Activo' : 'Inactivo'}</td>
        <td>
          <div class="table-actions">
            <button type="button" class="secondary-button" data-action="edit-professional" data-id="${professional.id}">Editar</button>
            <button type="button" class="danger-button" data-action="delete-professional" data-id="${professional.id}">Eliminar</button>
          </div>
        </td>
      </tr>
    `;
  }

  function renderAvailabilitySummary(availability = []) {
    if (!availability.length) return 'Sin horarios';
    return availability
      .map(
        (range) =>
          `${escapeHtml(dayLabel(range.day_of_week))}: ${escapeHtml(String(range.start_time).slice(0, 5))} - ${escapeHtml(String(range.end_time).slice(0, 5))}`,
      )
      .join('<br />');
  }

  function renderAppointments() {
    return `
      <section class="panel">
        <div class="panel-header">
          <h2>Turnos</h2>
        </div>
        ${renderAppointmentsTable(state.appointments)}
      </section>
    `;
  }

  function renderAppointmentsTable(items) {
    return `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Hora</th>
              <th>Servicio</th>
              <th>Profesional</th>
              <th>Paciente</th>
              <th>Pago</th>
              <th>Monto</th>
            </tr>
          </thead>
          <tbody>
            ${
              items.length
                ? items.map(renderAppointmentRow).join('')
                : '<tr><td colspan="7">No hay turnos registrados.</td></tr>'
            }
          </tbody>
        </table>
      </div>
    `;
  }

  function renderAppointmentRow(item) {
    return `
      <tr>
        <td>${escapeHtml(item.appointment_date)}</td>
        <td>${escapeHtml(item.start_time)} - ${escapeHtml(item.end_time)}</td>
        <td>${escapeHtml(item.service_name)}</td>
        <td>${escapeHtml(item.professional_name)}</td>
        <td>${escapeHtml(item.patient_name || item.patient_email || 'Paciente')}</td>
        <td>${escapeHtml(paymentStatusLabel(item.payment_status))}</td>
        <td>${escapeHtml(formatMoney(item.amount))}</td>
      </tr>
    `;
  }

  function renderScheduleBlockFormFields() {
    return `
      <div class="grid-two">
        <label class="span-two">
          Profesional
          <select name="professional_id" required>
            <option value="">Seleccionar</option>
            ${state.professionals
              .filter((professional) => professional.active)
              .map(
                (professional) =>
                  `<option value="${professional.id}">${escapeHtml(professional.name)}</option>`,
              )
              .join('')}
          </select>
        </label>
        <label class="span-two">
          Fecha
          <input name="block_date" type="date" value="${todayInput()}" required />
        </label>
        <label>
          Desde
          <input name="start_time" type="time" required />
        </label>
        <label>
          Hasta
          <input name="end_time" type="time" required />
        </label>
        <label class="span-two">
          Motivo
          <input name="reason" placeholder="Opcional" />
        </label>
        <div class="form-actions span-two">
          <button type="button" class="secondary-button" data-action="close-dialog">Cancelar</button>
          <button type="submit" class="primary-button">Guardar bloqueo</button>
        </div>
      </div>
    `;
  }

  function renderScheduleBlocks() {
    return `
      <section class="panel">
        <div class="panel-header">
          <h2>Bloqueos de horario</h2>
          <button type="button" class="primary-button" data-action="new-schedule-block">Nuevo bloqueo</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Profesional</th>
                <th>Horario</th>
                <th>Motivo</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${
                state.scheduleBlocks.length
                  ? state.scheduleBlocks.map(renderScheduleBlockRow).join('')
                  : '<tr><td colspan="5">No hay bloqueos cargados.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderScheduleBlockRow(item) {
    return `
      <tr>
        <td>${escapeHtml(item.block_date)}</td>
        <td>${escapeHtml(item.professional_name)}</td>
        <td>${escapeHtml(item.start_time)} - ${escapeHtml(item.end_time)}</td>
        <td>${escapeHtml(item.reason || 'Sin motivo')}</td>
        <td>
          <button type="button" class="danger-button" data-action="delete-schedule-block" data-id="${item.id}">Eliminar</button>
        </td>
      </tr>
    `;
  }

  function renderBookingTest() {
    return `
      <section class="panel">
        <div class="panel-header">
          <h2>Probar agenda</h2>
          <button type="button" class="primary-button" data-action="create-test-booking-link">Generar link 48h</button>
        </div>
        ${
          state.testBookingUrl
            ? `
              <div class="template-help">
                <strong>Link de prueba</strong>
                <a href="${escapeHtml(state.testBookingUrl)}" target="_blank" rel="noreferrer">${escapeHtml(state.testBookingUrl)}</a>
              </div>
              <iframe class="booking-preview" src="${escapeHtml(state.testBookingUrl)}" title="Agenda de prueba"></iframe>
            `
            : '<p class="muted">Generá un link para probar el flujo público mobile de agenda.</p>'
        }
      </section>
    `;
  }

  function renderConfig() {
    if (!state.user.can_manage_system) return '<section class="panel">Sin permisos.</section>';
    const settings = {
      mode: 'production',
      development: {},
      production: {},
      ...(state.mercadoPagoSettings || {}),
    };
    const environmentFields = (key, label) => {
      const env = settings[key] || {};
      return `
        <fieldset class="settings-fieldset">
          <legend>${escapeHtml(label)}</legend>
          <label class="span-two">
            Public Key
            <input name="${key}_public_key" value="${escapeHtml(env.public_key || '')}" placeholder="APP_USR-..." autocomplete="off" />
          </label>
          <label class="span-two">
            Access Token
            <input name="${key}_access_token" type="password" placeholder="${env.access_token_set ? 'Token guardado. Ingresá uno nuevo para reemplazarlo.' : 'APP_USR-...'}" autocomplete="off" />
          </label>
          <label>
            Client ID
            <input name="${key}_client_id" value="${escapeHtml(env.client_id || '')}" autocomplete="off" />
          </label>
          <label>
            Client Secret
            <input name="${key}_client_secret" type="password" placeholder="${env.client_secret_set ? 'Guardado' : 'Opcional'}" autocomplete="off" />
          </label>
          <label class="span-two">
            Webhook Secret
            <input name="${key}_webhook_secret" type="password" placeholder="${env.webhook_secret_set ? 'Guardado' : 'Opcional, para validar notificaciones'}" autocomplete="off" />
          </label>
        </fieldset>
      `;
    };
    return `
      <section class="panel">
        <form id="mercado-pago-form" class="grid-two">
          <div class="span-two">
            <h2>Credenciales de Mercado Pago Checkout Pro</h2>
            <p class="muted">La agenda crea una preferencia por turno y confirma la reserva cuando Mercado Pago informa el pago aprobado.</p>
          </div>
          <label class="span-two">
            Entorno activo
            <select name="mode">
              <option value="development" ${settings.mode === 'development' ? 'selected' : ''}>Desarrollo</option>
              <option value="production" ${settings.mode === 'production' ? 'selected' : ''}>Producción</option>
            </select>
          </label>
          ${environmentFields('development', 'Desarrollo')}
          ${environmentFields('production', 'Producción')}
          <div class="form-actions span-two">
            <button type="submit" class="primary-button">Guardar configuración</button>
          </div>
        </form>
      </section>
    `;
  }

  function renderAudit() {
    if (!state.user.can_manage_system) return '<section class="panel">Sin permisos.</section>';
    return `
      <section class="panel">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Usuario</th>
                <th>Evento</th>
                <th>Detalle</th>
              </tr>
            </thead>
            <tbody>
              ${
                state.auditEvents.length
                  ? state.auditEvents
                      .map(
                        (item) => `
                          <tr>
                            <td>${escapeHtml(formatDate(item.created_at))}</td>
                            <td>${escapeHtml(item.actor_email)}</td>
                            <td>${escapeHtml(item.event_type)}</td>
                            <td><code>${escapeHtml(JSON.stringify(item.detail || {}))}</code></td>
                          </tr>
                        `,
                      )
                      .join('')
                  : '<tr><td colspan="4">No hay eventos para mostrar.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function agreementFormValues() {
    return (
      state.agreements.find((agreement) => agreement.id === state.editingAgreementId) || {
        name: '',
        slug: '',
        type: 'Pago',
        cobranded: false,
        payment_evaluation_url: '',
        payment_treatment_url: '',
        email_subject_template: 'Alta de paciente - {{agreement.name}}',
        email_body_template: [
          'Recibimos una nueva solicitud de alta.',
          '',
          'Paciente: {{patient.nombre}} {{patient.apellido}}',
          'Teléfono: {{patient.telefono}}',
          'Mail: {{patient.email}}',
          'Identificador: {{patient.identificador}}',
          'Acuerdo: {{agreement.name}}',
          'Tipo de acuerdo: {{agreement.type}}',
        ].join('\n'),
      }
    );
  }

  function renderAgreementFormFields() {
    const item = agreementFormValues();
    return `
      <div class="grid-two">
        <label>
          Nombre
          <input name="name" value="${escapeHtml(item.name)}" required />
        </label>
        <label>
          Slug URL
          <input name="slug" value="${escapeHtml(item.slug)}" placeholder="se genera desde el nombre" />
        </label>
        <label>
          Tipo
          <select name="type" id="agreement-type-select">
            <option value="Pago" ${item.type === 'Pago' ? 'selected' : ''}>Pago</option>
            <option value="Nomina" ${item.type === 'Nomina' ? 'selected' : ''}>Nómina</option>
          </select>
        </label>
        <label class="check-row">
          <input type="checkbox" name="cobranded" ${item.cobranded ? 'checked' : ''} />
          Cobranded
        </label>
        <div class="span-two grid-two payment-fields" data-payment-fields ${item.type === 'Nomina' ? 'hidden' : ''}>
          <label>
            Link pago evaluación
            <input name="payment_evaluation_url" type="url" value="${escapeHtml(item.payment_evaluation_url)}" />
          </label>
          <label>
            Link pago tratamiento
            <input name="payment_treatment_url" type="url" value="${escapeHtml(item.payment_treatment_url)}" />
          </label>
        </div>
        <label>
          Logo
          <input class="file-input" name="logo" type="file" accept="image/*" />
        </label>
        <label>
          PDF Cómo funciona
          <input class="file-input" name="pdf" type="file" accept="application/pdf" />
        </label>
        ${item.logo_url || item.pdf_url ? `
          <div class="span-two grid-two">
            ${item.logo_url ? `
              <label class="check-row">
                <input type="checkbox" name="remove_logo" />
                Quitar logo actual
              </label>
            ` : '<span></span>'}
            ${item.pdf_url ? `
              <label class="check-row">
                <input type="checkbox" name="remove_pdf" />
                Quitar PDF actual
              </label>
            ` : '<span></span>'}
          </div>
        ` : ''}
        <label class="span-two">
          Subject del mail
          <input name="email_subject_template" value="${escapeHtml(item.email_subject_template)}" required />
        </label>
        <label class="span-two">
          Template del mail
          <textarea name="email_body_template" required>${escapeHtml(item.email_body_template)}</textarea>
        </label>
        <div class="template-help span-two">
          <strong>Variables permitidas</strong>
          <span>{{patient.nombre}}, {{patient.apellido}}, {{patient.telefono}}, {{patient.email}}, {{patient.identificador}}, {{agreement.name}}, {{agreement.type}}</span>
        </div>
        <div class="template-test span-two">
          <label for="template-test-email">Mail para test</label>
          <div class="inline-control">
            <input id="template-test-email" name="template_test_email" type="email" placeholder="mail@dominio.com" />
            <button type="button" class="secondary-button" data-action="send-template-test">Enviar test</button>
          </div>
        </div>
        <div class="form-actions span-two">
          <button type="button" class="secondary-button" data-action="validate-template">Validar template</button>
          <button type="submit" class="primary-button">Guardar acuerdo</button>
        </div>
      </div>
    `;
  }

  function renderAgreements() {
    const agreements = filteredAgreements();
    return `
      <section class="panel">
        <div class="toolbar">
          <label>
            Buscar
            <input
              id="agreement-text-filter"
              type="search"
              value="${escapeHtml(state.agreementTextFilter)}"
              placeholder="Nombre del acuerdo"
            />
          </label>
          <label>
            Tipo
            <select id="agreement-type-filter">
              <option value="">Todos</option>
              <option value="Pago">Pago</option>
              <option value="Nomina">Nómina</option>
            </select>
          </label>
          <label>
            Co-Branded
            <select id="agreement-cobrand-filter">
              <option value="">Todos</option>
              <option value="yes">Sí</option>
              <option value="no">No</option>
            </select>
          </label>
          <span class="toolbar-count">${agreements.length} acuerdos</span>
          <div class="toolbar-actions">
            <button type="button" class="primary-button" data-action="new-agreement">Nuevo</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Slug</th>
                <th>Tipo</th>
                <th>Cobranded</th>
                <th>Archivos</th>
                <th>Altas</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${agreements.length ? agreements.map(renderAgreementRow).join('') : '<tr><td colspan="7">No hay acuerdos para esos filtros.</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderAgreementRow(agreement) {
    return `
      <tr>
        <td><strong>${escapeHtml(agreement.name)}</strong></td>
        <td>${escapeHtml(agreement.slug)}</td>
        <td><span class="pill">${escapeHtml(agreement.type)}</span></td>
        <td>${agreement.cobranded ? 'Sí' : 'No'}</td>
        <td>
          ${agreement.logo_url ? `<a href="${escapeHtml(agreement.logo_url)}" target="_blank" rel="noreferrer">Logo</a>` : 'Sin logo'}
          ·
          ${agreement.pdf_url ? `<a href="${escapeHtml(agreement.pdf_url)}" target="_blank" rel="noreferrer">PDF</a>` : 'Sin PDF'}
        </td>
        <td>${agreement.intake_count || 0}</td>
        <td>
          <div class="table-actions">
            <button type="button" class="secondary-button" data-action="copy-url" data-slug="${escapeHtml(agreement.slug)}">Get URL</button>
            <a
              class="secondary-button"
              href="/api/admin/agreements/${agreement.id}/qr"
              download="reku-alta-pacientes-${escapeHtml(agreement.slug)}-qr.png"
            >
              Get QR
            </a>
            <button type="button" class="secondary-button" data-action="edit-agreement" data-id="${agreement.id}">Editar</button>
            <button type="button" class="danger-button" data-action="delete-agreement" data-id="${agreement.id}">Eliminar</button>
          </div>
        </td>
      </tr>
    `;
  }

  function renderAgreementOptions({ onlyNomina = false, includeAll = true } = {}) {
    const agreements = onlyNomina
      ? state.agreements.filter((agreement) => agreement.type === 'Nomina')
      : state.agreements;
    return `
      ${includeAll ? '<option value="">Todos</option>' : '<option value="">Seleccionar</option>'}
      ${agreements
        .map(
          (agreement) =>
            `<option value="${agreement.id}">${escapeHtml(agreement.name)}</option>`,
        )
        .join('')}
    `;
  }

  function filteredAgreements() {
    const term = state.agreementTextFilter.trim().toLowerCase();
    return state.agreements.filter((agreement) => {
      const matchesText = !term || agreement.name.toLowerCase().includes(term);
      const matchesType = !state.agreementTypeFilter || agreement.type === state.agreementTypeFilter;
      const matchesCobrand =
        !state.agreementCobrandFilter ||
        (state.agreementCobrandFilter === 'yes' && agreement.cobranded) ||
        (state.agreementCobrandFilter === 'no' && !agreement.cobranded);

      return matchesText && matchesType && matchesCobrand;
    });
  }

  function filteredPatientIntakes() {
    const term = state.patientTextFilter.trim().toLowerCase();
    if (!term) return state.patientIntakes;
    return state.patientIntakes.filter((item) =>
      [
        item.nombre,
        item.apellido,
        item.telefono,
        item.email,
        item.identificador,
      ]
        .join(' ')
        .toLowerCase()
        .includes(term),
    );
  }

  function renderPatientIntakes() {
    const items = filteredPatientIntakes();
    return `
      <section class="panel">
        <div class="toolbar">
          <label>
            Filtrar por acuerdo
            <select id="patient-agreement-filter">
              ${renderAgreementOptions()}
            </select>
          </label>
          <label>
            Buscar
            <input
              id="patient-text-filter"
              type="search"
              value="${escapeHtml(state.patientTextFilter)}"
              placeholder="Paciente, teléfono, mail o identificador"
            />
          </label>
          <span class="toolbar-count">${items.length} altas</span>
        </div>
        <div class="table-wrap">
          <table class="centered-table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Acuerdo</th>
                <th>Paciente</th>
                <th>Teléfono</th>
                <th>Mail</th>
                <th>Identificador</th>
                <th>Estado envío</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${items.length ? items.map(renderPatientRow).join('') : '<tr><td colspan="8">No hay altas registradas.</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderPatientRow(item) {
    return `
      <tr>
        <td>${escapeHtml(formatDate(item.created_at))}</td>
        <td>${escapeHtml(item.agreement_name || 'Genérico')}</td>
        <td><strong>${escapeHtml(item.nombre)} ${escapeHtml(item.apellido)}</strong></td>
        <td>${escapeHtml(item.telefono)}</td>
        <td>${escapeHtml(item.email)}</td>
        <td>${escapeHtml(item.identificador)}</td>
        <td>${item.email_error ? `<span class="muted">${escapeHtml(item.email_error)}</span>` : 'Enviado'}</td>
        <td>
          <div class="table-actions">
            <button
              type="button"
              class="danger-button"
              data-action="delete-patient"
              data-id="${item.id}"
              ${state.user.can_delete_records ? '' : 'disabled'}
            >
              Eliminar
            </button>
          </div>
        </td>
      </tr>
    `;
  }

  function renderContacts() {
    return `
      <section class="panel">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Contacto</th>
                <th>Email</th>
                <th>Teléfono</th>
                <th>Organización</th>
                <th>Rol</th>
                <th>Pacientes</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${state.contacts.length ? state.contacts.map(renderContactRow).join('') : '<tr><td colspan="8">No hay contactos registrados.</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderContactRow(item) {
    return `
      <tr>
        <td>${escapeHtml(formatDate(item.created_at))}</td>
        <td><strong>${escapeHtml(item.nombre)} ${escapeHtml(item.apellido)}</strong></td>
        <td>${escapeHtml(item.email)}</td>
        <td>${escapeHtml(item.telefono)}</td>
        <td>${escapeHtml(item.organizacion)}</td>
        <td>${escapeHtml(item.rol)}</td>
        <td>${escapeHtml(item.pacientes)}</td>
        <td>
          <button
            type="button"
            class="danger-button"
            data-action="delete-contact"
            data-id="${item.id}"
            ${state.user.can_delete_records ? '' : 'disabled'}
          >
            Eliminar
          </button>
        </td>
      </tr>
    `;
  }

  function renderNominaFormFields() {
    const nominaAgreements = state.agreements.filter((agreement) => agreement.type === 'Nomina');
    if (!nominaAgreements.length) {
      return '<p class="muted">Primero creá un acuerdo de tipo Nómina.</p>';
    }

    return `
      <div class="grid-two">
        <label class="span-two">
          Acuerdo
          <select name="agreement_id" required>
            ${renderAgreementOptions({ onlyNomina: true, includeAll: false })}
          </select>
        </label>
        <label>
          Nombre
          <input name="nombre" />
        </label>
        <label>
          Apellido
          <input name="apellido" />
        </label>
        <label class="span-two">
          Identificador
          <input name="identificador" required />
        </label>
        <div class="form-actions span-two">
          <button type="button" class="secondary-button" data-action="close-dialog">Cancelar</button>
          <button type="submit" class="primary-button">Guardar</button>
        </div>
      </div>
    `;
  }

  function renderNominaCsvFormFields() {
    const nominaAgreements = state.agreements.filter((agreement) => agreement.type === 'Nomina');
    if (!nominaAgreements.length) {
      return '<p class="muted">Primero creá un acuerdo de tipo Nómina.</p>';
    }

    return `
      <div class="grid-two">
        <label>
          Acuerdo
          <select name="agreement_id" required>
            ${renderAgreementOptions({ onlyNomina: true, includeAll: false })}
          </select>
        </label>
        <label>
          CSV
          <input name="csv" type="file" accept=".csv,text/csv" required />
        </label>
        <div class="template-help span-two">
          CSV esperado: identificador,nombre,apellido. Nombre y apellido son opcionales.
        </div>
        <div class="form-actions span-two">
          <button type="button" class="secondary-button" data-action="close-dialog">Cancelar</button>
          <button type="submit" class="primary-button">Subir CSV</button>
        </div>
      </div>
    `;
  }

  function filteredNominaEntries() {
    if (!state.nominaFormFilter) return state.nominaEntries;
    const mustHaveForm = state.nominaFormFilter === 'yes';
    return state.nominaEntries.filter((item) => Boolean(item.form_submitted) === mustHaveForm);
  }

  function renderNomina() {
    const items = filteredNominaEntries();
    return `
      <section class="panel">
        <div class="toolbar">
          <label>
            Filtrar por acuerdo
            <select id="nomina-agreement-filter">
              ${renderAgreementOptions({ onlyNomina: true })}
            </select>
          </label>
          <label>
            Form
            <select id="nomina-form-filter">
              <option value="">Todos</option>
              <option value="yes">Sí</option>
              <option value="no">No</option>
            </select>
          </label>
          <span class="toolbar-count">${items.length} registros</span>
          <div class="toolbar-actions">
            <button type="button" class="secondary-button" data-action="open-nomina-csv">Subir CSV</button>
            <button type="button" class="primary-button" data-action="new-nomina">Agregar</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Acuerdo</th>
                <th>Nombre</th>
                <th>Apellido</th>
                <th>Identificador</th>
                <th>Form</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${items.length ? items.map(renderNominaRow).join('') : '<tr><td colspan="7">No hay registros de nómina para esos filtros.</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderNominaRow(item) {
    return `
      <tr>
        <td>${escapeHtml(formatDate(item.created_at))}</td>
        <td>${escapeHtml(item.agreement_name)}</td>
        <td>${escapeHtml(item.nombre)}</td>
        <td>${escapeHtml(item.apellido)}</td>
        <td><strong>${escapeHtml(item.identificador)}</strong></td>
        <td>${item.form_submitted ? 'Sí' : 'No'}</td>
        <td><button type="button" class="danger-button" data-action="delete-nomina" data-id="${item.id}">Eliminar</button></td>
      </tr>
    `;
  }

  function bindActionElements(root = document) {
    root.querySelectorAll('[data-action]').forEach((element) => {
      if (element.dataset.boundAction === 'true') return;
      element.dataset.boundAction = 'true';
      element.addEventListener('click', handleActionClick);
    });
  }

  function bindEvents() {
    document.querySelectorAll('[data-module]').forEach((button) => {
      button.addEventListener('click', () => {
        state.active = button.dataset.module;
        state.userMenuOpen = false;
        state.dialog = null;
        clearStatus();
        render();
      });
    });

    bindActionElements();

    document.getElementById('agreement-form')?.addEventListener('submit', handleAgreementSubmit);
    document.getElementById('nomina-form')?.addEventListener('submit', handleNominaSubmit);
    document.getElementById('nomina-csv-form')?.addEventListener('submit', handleNominaCsvSubmit);
    document.getElementById('service-form')?.addEventListener('submit', handleServiceSubmit);
    document.getElementById('professional-form')?.addEventListener('submit', handleProfessionalSubmit);
    document.getElementById('schedule-block-form')?.addEventListener('submit', handleScheduleBlockSubmit);
    document.getElementById('mercado-pago-form')?.addEventListener('submit', handleMercadoPagoSubmit);
    document
      .getElementById('change-password-form')
      ?.addEventListener('submit', handleChangePasswordSubmit);

    const agreementTypeSelect = document.getElementById('agreement-type-select');
    if (agreementTypeSelect) {
      const togglePaymentFields = () => {
        const isNomina = agreementTypeSelect.value === 'Nomina';
        document.querySelectorAll('[data-payment-fields]').forEach((wrapper) => {
          wrapper.hidden = isNomina;
          if (isNomina) {
            wrapper.querySelectorAll('input').forEach((input) => {
              input.value = '';
            });
          }
        });
      };
      agreementTypeSelect.addEventListener('change', togglePaymentFields);
      togglePaymentFields();
    }

    const agreementTextFilter = document.getElementById('agreement-text-filter');
    if (agreementTextFilter) {
      agreementTextFilter.value = state.agreementTextFilter;
      agreementTextFilter.addEventListener('input', () => {
        state.agreementTextFilter = agreementTextFilter.value;
        render();
        const nextInput = document.getElementById('agreement-text-filter');
        nextInput?.focus();
        nextInput?.setSelectionRange(state.agreementTextFilter.length, state.agreementTextFilter.length);
      });
    }

    const agreementTypeFilter = document.getElementById('agreement-type-filter');
    if (agreementTypeFilter) {
      agreementTypeFilter.value = state.agreementTypeFilter;
      agreementTypeFilter.addEventListener('change', () => {
        state.agreementTypeFilter = agreementTypeFilter.value;
        render();
      });
    }

    const agreementCobrandFilter = document.getElementById('agreement-cobrand-filter');
    if (agreementCobrandFilter) {
      agreementCobrandFilter.value = state.agreementCobrandFilter;
      agreementCobrandFilter.addEventListener('change', () => {
        state.agreementCobrandFilter = agreementCobrandFilter.value;
        render();
      });
    }

    const patientFilter = document.getElementById('patient-agreement-filter');
    if (patientFilter) {
      patientFilter.value = state.patientAgreementFilter;
      patientFilter.addEventListener('change', async () => {
        state.patientAgreementFilter = patientFilter.value;
        await loadData();
        render();
      });
    }

    const patientTextFilter = document.getElementById('patient-text-filter');
    if (patientTextFilter) {
      patientTextFilter.value = state.patientTextFilter;
      patientTextFilter.addEventListener('input', () => {
        state.patientTextFilter = patientTextFilter.value;
        render();
        const nextInput = document.getElementById('patient-text-filter');
        nextInput?.focus();
        nextInput?.setSelectionRange(state.patientTextFilter.length, state.patientTextFilter.length);
      });
    }

    const nominaFilter = document.getElementById('nomina-agreement-filter');
    if (nominaFilter) {
      nominaFilter.value = state.nominaAgreementFilter;
      nominaFilter.addEventListener('change', async () => {
        state.nominaAgreementFilter = nominaFilter.value;
        await loadData();
        render();
      });
    }

    const nominaFormFilter = document.getElementById('nomina-form-filter');
    if (nominaFormFilter) {
      nominaFormFilter.value = state.nominaFormFilter;
      nominaFormFilter.addEventListener('change', () => {
        state.nominaFormFilter = nominaFormFilter.value;
        render();
      });
    }
  }

  async function handleActionClick(event) {
    const action = event.currentTarget.dataset.action;
    const id = Number(event.currentTarget.dataset.id || 0);
    const slug = event.currentTarget.dataset.slug || '';

    try {
      if (action === 'toggle-user-menu') {
        state.userMenuOpen = !state.userMenuOpen;
        render();
        return;
      }
      if (action === 'refresh') {
        state.userMenuOpen = false;
        await loadData();
        setStatus('Datos actualizados.', 'ok');
        return;
      }
      if (action === 'logout') {
        await api('/api/admin/auth/logout', { method: 'POST' });
        csrfToken = '';
        state.user = null;
        render();
        return;
      }
      if (action === 'change-password') {
        state.dialog = { type: 'change-password' };
        state.userMenuOpen = false;
        render();
        return;
      }
      if (action === 'open-config') {
        state.active = 'config';
        state.userMenuOpen = false;
        state.dialog = null;
        await loadMercadoPagoSettings();
        render();
        return;
      }
      if (action === 'open-audit') {
        state.active = 'audit';
        state.userMenuOpen = false;
        state.dialog = null;
        await loadAuditEvents();
        render();
        return;
      }
      if (action === 'close-dialog') {
        if (state.dialog?.type === 'agreement-form') {
          state.editingAgreementId = null;
        }
        if (state.dialog?.type === 'service-form') {
          state.editingServiceId = null;
        }
        if (state.dialog?.type === 'professional-form') {
          state.editingProfessionalId = null;
        }
        state.dialog = null;
        render();
        return;
      }
      if (action === 'confirm-delete') {
        await runConfirmedDelete();
        return;
      }
      if (action === 'new-agreement') {
        state.editingAgreementId = null;
        state.dialog = { type: 'agreement-form' };
        render();
        return;
      }
      if (action === 'cancel-agreement-edit') {
        state.editingAgreementId = null;
        state.dialog = null;
        render();
        return;
      }
      if (action === 'validate-template') {
        await validateTemplate();
        return;
      }
      if (action === 'send-template-test') {
        await sendTemplateTest();
        return;
      }
      if (action === 'copy-url') {
        const url = `${publicBaseUrl}/alta-pacientes/?form=${encodeURIComponent(slug)}`;
        await navigator.clipboard.writeText(url);
        setStatus(`URL copiada: ${url}`, 'ok');
        return;
      }
      if (action === 'edit-agreement') {
        state.editingAgreementId = id;
        state.dialog = { type: 'agreement-form' };
        render();
        return;
      }
      if (action === 'new-service') {
        state.editingServiceId = null;
        state.dialog = { type: 'service-form' };
        render();
        return;
      }
      if (action === 'edit-service') {
        state.editingServiceId = id;
        state.dialog = { type: 'service-form' };
        render();
        return;
      }
      if (action === 'new-professional') {
        state.editingProfessionalId = null;
        state.dialog = { type: 'professional-form' };
        render();
        return;
      }
      if (action === 'edit-professional') {
        state.editingProfessionalId = id;
        state.dialog = { type: 'professional-form' };
        render();
        return;
      }
      if (action === 'new-schedule-block') {
        state.dialog = { type: 'schedule-block-form' };
        render();
        return;
      }
      if (action === 'add-availability-range') {
        addAvailabilityRange(event.currentTarget);
        return;
      }
      if (action === 'remove-availability-range') {
        removeAvailabilityRange(event.currentTarget);
        return;
      }
      if (action === 'create-test-booking-link') {
        const payload = await api('/api/admin/booking-links/test', { method: 'POST' });
        state.testBookingUrl = payload.booking_url || '';
        setStatus('Link de agenda generado.', 'ok');
        return;
      }
      if (action === 'new-nomina') {
        state.dialog = { type: 'nomina-form' };
        render();
        return;
      }
      if (action === 'open-nomina-csv') {
        state.dialog = { type: 'nomina-csv-form' };
        render();
        return;
      }
      if (action === 'delete-agreement') {
        state.dialog = {
          type: 'confirm-delete',
          target: 'agreement',
          id,
          title: 'Eliminar acuerdo',
          message: 'El acuerdo se ocultará del admin. Los registros existentes se conservan.',
        };
        render();
        return;
      }
      if (action === 'delete-service') {
        state.dialog = {
          type: 'confirm-delete',
          target: 'service',
          id,
          title: 'Eliminar servicio',
          message: 'El servicio dejará de estar disponible para nuevas reservas.',
        };
        render();
        return;
      }
      if (action === 'delete-professional') {
        state.dialog = {
          type: 'confirm-delete',
          target: 'professional',
          id,
          title: 'Eliminar profesional',
          message: 'El profesional dejará de estar disponible para nuevas reservas.',
        };
        render();
        return;
      }
      if (action === 'delete-schedule-block') {
        state.dialog = {
          type: 'confirm-delete',
          target: 'schedule-block',
          id,
          title: 'Eliminar bloqueo',
          message: 'Ese horario volverá a estar disponible si no hay turnos tomados.',
        };
        render();
        return;
      }
      if (action === 'delete-patient') {
        state.dialog = {
          type: 'confirm-delete',
          target: 'patient',
          id,
          title: 'Eliminar alta',
          message: 'Esta acción elimina el registro de alta.',
        };
        render();
        return;
      }
      if (action === 'delete-contact') {
        state.dialog = {
          type: 'confirm-delete',
          target: 'contact',
          id,
          title: 'Eliminar contacto',
          message: 'Esta acción elimina el registro de contacto.',
        };
        render();
        return;
      }
      if (action === 'delete-nomina') {
        state.dialog = {
          type: 'confirm-delete',
          target: 'nomina',
          id,
          title: 'Eliminar registro de nómina',
          message: 'Esta acción elimina el identificador de la nómina.',
        };
        render();
      }
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function loadMercadoPagoSettings() {
    if (!state.user.can_manage_system) return;
    const payload = await api('/api/admin/settings/mercado-pago');
    state.mercadoPagoSettings = payload.settings || {};
  }

  async function loadAuditEvents() {
    if (!state.user.can_manage_system) return;
    const payload = await api('/api/admin/audit');
    state.auditEvents = payload.audit_events || [];
  }

  function addAvailabilityRange(button) {
    const day = button.closest('.availability-day');
    const ranges = day?.querySelector('.availability-ranges');
    if (!ranges) return;
    ranges.insertAdjacentHTML(
      'beforeend',
      renderAvailabilityRange({ start_time: '09:00', end_time: '18:00' }),
    );
    const checkbox = day.querySelector('.availability-day-toggle input');
    if (checkbox) checkbox.checked = true;
    bindActionElements(day);
  }

  function removeAvailabilityRange(button) {
    const range = button.closest('.availability-range');
    const day = button.closest('.availability-day');
    range?.remove();
    if (day && !day.querySelector('.availability-range')) {
      day
        .querySelector('.availability-ranges')
        ?.insertAdjacentHTML(
          'beforeend',
          renderAvailabilityRange({ start_time: '09:00', end_time: '18:00' }),
        );
      const checkbox = day.querySelector('.availability-day-toggle input');
      if (checkbox) checkbox.checked = false;
      bindActionElements(day);
    }
  }

  function collectAvailability(form) {
    return Array.from(form.querySelectorAll('.availability-day'))
      .filter((day) => day.querySelector('.availability-day-toggle input')?.checked)
      .flatMap((day) =>
        Array.from(day.querySelectorAll('.availability-range')).map((range) => ({
          day_of_week: Number(day.dataset.day),
          start_time: range.querySelector('[data-field="start_time"]')?.value || '',
          end_time: range.querySelector('[data-field="end_time"]')?.value || '',
        })),
      );
  }

  async function handleServiceSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const path = state.editingServiceId
      ? `/api/admin/services/${state.editingServiceId}`
      : '/api/admin/services';
    const method = state.editingServiceId ? 'PUT' : 'POST';

    try {
      await api(path, {
        method,
        body: {
          name: form.name.value,
          duration_minutes: form.duration_minutes.value,
          cost_amount: form.cost_amount.value,
          payment_url: form.payment_url.value,
          active: form.active.checked,
        },
      });
      state.editingServiceId = null;
      state.dialog = null;
      await loadData();
      setStatus('Servicio guardado.', 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function handleProfessionalSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    data.set(
      'service_ids',
      JSON.stringify(Array.from(form.querySelectorAll('input[name="service_ids"]:checked')).map((input) => input.value)),
    );
    data.set('availability', JSON.stringify(collectAvailability(form)));
    data.set('active', form.active.checked ? 'true' : 'false');
    data.set('remove_photo', form.remove_photo?.checked ? 'true' : 'false');

    const path = state.editingProfessionalId
      ? `/api/admin/professionals/${state.editingProfessionalId}`
      : '/api/admin/professionals';
    const method = state.editingProfessionalId ? 'PUT' : 'POST';

    try {
      await api(path, { method, body: data });
      state.editingProfessionalId = null;
      state.dialog = null;
      await loadData();
      setStatus('Profesional guardado.', 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function handleScheduleBlockSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api('/api/admin/schedule-blocks', {
        method: 'POST',
        body: {
          professional_id: form.professional_id.value,
          block_date: form.block_date.value,
          start_time: form.start_time.value,
          end_time: form.end_time.value,
          reason: form.reason.value,
        },
      });
      state.dialog = null;
      await loadData();
      setStatus('Bloqueo guardado.', 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function handleMercadoPagoSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const payload = await api('/api/admin/settings/mercado-pago', {
        method: 'PUT',
        body: {
          mode: form.mode.value,
          development: {
            public_key: form.development_public_key.value,
            access_token: form.development_access_token.value,
            client_id: form.development_client_id.value,
            client_secret: form.development_client_secret.value,
            webhook_secret: form.development_webhook_secret.value,
          },
          production: {
            public_key: form.production_public_key.value,
            access_token: form.production_access_token.value,
            client_id: form.production_client_id.value,
            client_secret: form.production_client_secret.value,
            webhook_secret: form.production_webhook_secret.value,
          },
        },
      });
      state.mercadoPagoSettings = payload.settings || {};
      setStatus('Configuración de Mercado Pago guardada.', 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const payload = await api('/api/admin/auth/login', {
        method: 'POST',
        body: {
          email: form.email.value,
          password: form.password.value,
        },
      });
      csrfToken = payload.csrf_token;
      state.user = payload.user;
      clearStatus();
      await loadData();
      render();
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function handleAgreementSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    data.set('cobranded', form.cobranded.checked ? 'true' : 'false');
    data.set('remove_logo', form.remove_logo?.checked ? 'true' : 'false');
    data.set('remove_pdf', form.remove_pdf?.checked ? 'true' : 'false');

    const path = state.editingAgreementId
      ? `/api/admin/agreements/${state.editingAgreementId}`
      : '/api/admin/agreements';
    const method = state.editingAgreementId ? 'PUT' : 'POST';

    try {
      await api(path, { method, body: data });
      state.editingAgreementId = null;
      state.dialog = null;
      await loadData();
      setStatus('Acuerdo guardado.', 'ok');
    } catch (error) {
      const details = error.payload?.errors?.length
        ? ` ${error.payload.errors.join(' ')}`
        : '';
      setStatus(`${error.message}${details}`, 'error');
    }
  }

  async function validateTemplate() {
    const form = document.getElementById('agreement-form');
    if (!form) return;
    try {
      const payload = await api('/api/admin/templates/validate', {
        method: 'POST',
        body: {
          subject: form.email_subject_template.value,
          body: form.email_body_template.value,
        },
      });
      setStatus(`Template válido. Preview subject: ${payload.preview.subject}`, 'ok');
    } catch (error) {
      const details = error.payload?.errors?.join(' ') || '';
      setStatus(`${error.message} ${details}`, 'error');
    }
  }

  async function sendTemplateTest() {
    const form = document.getElementById('agreement-form');
    if (!form) return;
    const to = form.elements.template_test_email.value.trim();
    if (!to) {
      setStatus('Ingresá un mail para enviar el test.', 'error');
      return;
    }

    try {
      await api('/api/admin/templates/test', {
        method: 'POST',
        body: {
          to,
          agreement_id: state.editingAgreementId || '',
          agreement_name: form.elements.name.value,
          type: form.elements.type.value,
          payment_evaluation_url: form.elements.payment_evaluation_url?.value || '',
          payment_treatment_url: form.elements.payment_treatment_url?.value || '',
          subject: form.elements.email_subject_template.value,
          body: form.elements.email_body_template.value,
        },
      });
      setStatus(`Mail de test enviado a ${to}.`, 'ok');
    } catch (error) {
      const details = error.payload?.errors?.join(' ') || '';
      setStatus(`${error.message}${details ? ` ${details}` : ''}`, 'error');
    }
  }

  async function handleNominaSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api('/api/admin/nomina', {
        method: 'POST',
        body: {
          agreement_id: form.agreement_id.value,
          nombre: form.nombre.value,
          apellido: form.apellido.value,
          identificador: form.identificador.value,
        },
      });
      form.reset();
      state.dialog = null;
      await loadData();
      setStatus('Registro de nómina guardado.', 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function handleNominaCsvSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const result = await api('/api/admin/nomina/import', {
        method: 'POST',
        body: data,
      });
      form.reset();
      state.dialog = null;
      await loadData();
      setStatus(`CSV importado. Registros procesados: ${result.upserted}.`, 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function handleChangePasswordSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api('/api/admin/auth/change-password', {
        method: 'POST',
        body: {
          current_password: form.current_password.value,
          new_password: form.new_password.value,
        },
      });
      csrfToken = '';
      state.user = null;
      state.dialog = null;
      setStatus('Clave actualizada. Volvé a ingresar.', 'ok');
      render();
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function runConfirmedDelete() {
    if (!state.dialog || state.dialog.type !== 'confirm-delete') return;
    const { target, id } = state.dialog;
    const paths = {
      agreement: `/api/admin/agreements/${id}`,
      patient: `/api/admin/patient-intakes/${id}`,
      contact: `/api/admin/contacts/${id}`,
      nomina: `/api/admin/nomina/${id}`,
      service: `/api/admin/services/${id}`,
      professional: `/api/admin/professionals/${id}`,
      'schedule-block': `/api/admin/schedule-blocks/${id}`,
    };
    const labels = {
      agreement: 'Acuerdo eliminado.',
      patient: 'Alta eliminada.',
      contact: 'Contacto eliminado.',
      nomina: 'Registro eliminado.',
      service: 'Servicio eliminado.',
      professional: 'Profesional eliminado.',
      'schedule-block': 'Bloqueo eliminado.',
    };

    try {
      await api(paths[target], { method: 'DELETE' });
      state.dialog = null;
      await loadData();
      setStatus(labels[target], 'ok');
    } catch (error) {
      state.dialog = null;
      setStatus(error.message, 'error');
    }
  }

  document.addEventListener('click', (event) => {
    if (!state.userMenuOpen) return;
    const target = event.target;
    if (target instanceof Element && target.closest('.user-menu')) return;
    state.userMenuOpen = false;
    render();
  });

  loadSession();
})();
