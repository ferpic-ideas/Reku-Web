(() => {
  const app = document.getElementById('app');
  const publicBaseUrl = 'https://www.reku.io';
  const agreementPublicUrl = (agreement = {}) => {
    const prefix = String(agreement.subdomain_prefix || '').trim().toLowerCase();
    if (prefix) return `https://${prefix}.reku.io/turnos/`;
    return `${publicBaseUrl}/turnos/?form=${encodeURIComponent(agreement.slug || '')}`;
  };
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
    patients: [],
    contacts: [],
    congressRegistrations: [],
    nominaEntries: [],
    dashboard: null,
    users: [],
    services: [],
    professionals: [],
    appointments: [],
    agreementApiCredentials: [],
    settlement: null,
    settlementAgreementId: '',
    settlementMonth: new Date().toISOString().slice(0, 7),
    settlementLoading: false,
    scheduleBlocks: [],
    auditEvents: [],
    mercadoPagoSettings: null,
    testBookingUrl: '',
    testBookingAgreementId: '',
    agreementTypeFilter: '',
    agreementCobrandFilter: '',
    agreementTextFilter: '',
    patientAgreementFilter: '',
    patientTextFilter: '',
    contactTextFilter: '',
    contactOrganizationFilter: '',
    contactTab: 'website',
    congressTextFilter: '',
    nominaAgreementFilter: '',
    nominaFormFilter: '',
    appointmentStatusFilter: 'future',
    appointmentPaymentFilter: '',
    appointmentProfessionalFilter: '',
    appointmentPatientFilter: '',
    appointmentEditSlots: [],
    appointmentEditLoading: false,
    appointmentEditError: '',
    scheduleBlockDateFilter: 'future',
    scheduleBlockProfessionalFilter: '',
    status: '',
    statusType: '',
    dialog: null,
  };

  const modules = [
    { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
    { id: 'agreements', label: 'Acuerdos', icon: 'agreements' },
    { id: 'nomina', label: 'Nóminas', icon: 'nomina' },
    { id: 'services', label: 'Servicios', icon: 'services' },
    { id: 'professionals', label: 'Profesionales', icon: 'professionals' },
    { id: 'blocks', label: 'Bloquear horario', icon: 'blocks' },
    { id: 'booking-test', label: 'Probar Agenda', icon: 'booking-test' },
    { type: 'divider' },
    { id: 'appointments', label: 'Turnos', icon: 'appointments' },
    { id: 'settlements', label: 'Liquidaciones', icon: 'settlements' },
    { id: 'patient-intakes', label: 'Pacientes', icon: 'patient-intakes' },
    { id: 'contacts', label: 'Contactos', icon: 'contacts' },
  ];

  const moduleRoutes = {
    dashboard: '/admin/',
    agreements: '/admin/acuerdos',
    nomina: '/admin/nominas',
    services: '/admin/servicios',
    professionals: '/admin/profesionales',
    blocks: '/admin/bloquear-horario',
    'booking-test': '/admin/probar-agenda',
    appointments: '/admin/turnos',
    settlements: '/admin/liquidaciones',
    'patient-intakes': '/admin/alta-pacientes',
    contacts: '/admin/contactos',
    users: '/admin/usuarios',
    config: '/admin/configurar',
    audit: '/admin/auditoria',
  };

  const routeModules = Object.fromEntries(
    Object.entries(moduleRoutes).map(([moduleId, path]) => [path, moduleId]),
  );

  const modulePermissions = {
    dashboard: 'dashboard.read',
    agreements: 'agreements.read',
    nomina: 'nomina.read',
    services: 'services.read',
    professionals: 'professionals.read',
    blocks: 'schedule_blocks.read',
    'booking-test': 'booking_links.create',
    appointments: 'appointments.read',
    settlements: 'settlements.read',
    'patient-intakes': 'patient_intakes.read',
    contacts: 'contacts.read',
    users: 'users.read',
    config: 'settings.read',
    audit: 'audit.read',
  };

  const navIcons = {
    dashboard: `
      <rect width="7" height="9" x="3" y="3" rx="1" />
      <rect width="7" height="5" x="14" y="3" rx="1" />
      <rect width="7" height="9" x="14" y="12" rx="1" />
      <rect width="7" height="5" x="3" y="16" rx="1" />
    `,
    agreements: `
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M8 13h8" />
      <path d="M8 17h5" />
    `,
    nomina: `
      <rect width="8" height="4" x="8" y="2" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M8 12h8" />
      <path d="M8 16h8" />
    `,
    services: `
      <path d="M10 6V5a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v1" />
      <rect width="18" height="14" x="3" y="6" rx="2" />
      <path d="M8 13h8" />
      <path d="M12 9v8" />
    `,
    professionals: `
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    `,
    blocks: `
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
      <path d="m10 14 4 4" />
      <path d="m14 14-4 4" />
    `,
    'booking-test': `
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
      <path d="m9 16 2 2 4-5" />
    `,
    appointments: `
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 14h.01" />
      <path d="M12 14h.01" />
      <path d="M16 14h.01" />
      <path d="M8 18h.01" />
      <path d="M12 18h.01" />
    `,
    settlements: `
      <path d="M6 2h9l4 4v16H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" />
      <path d="M14 2v5h5" />
      <path d="M8 12h8" />
      <path d="M8 16h8" />
      <path d="M8 8h2" />
    `,
    'patient-intakes': `
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M19 8v6" />
      <path d="M22 11h-6" />
    `,
    contacts: `
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a2 2 0 0 1-2.06 0L2 7" />
    `,
  };

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

  const modulePath = (moduleId) => moduleRoutes[moduleId] || moduleRoutes.dashboard;

  const moduleFromPath = (pathname = window.location.pathname) => {
    const normalized = pathname.endsWith('/') && pathname !== '/' ? pathname.slice(0, -1) : pathname;
    return routeModules[normalized] || 'dashboard';
  };

  const can = (permission) =>
    Boolean(
      state.user?.permissions?.includes('*') ||
        state.user?.permissions?.includes(permission),
    );

  const canAccessModule = (moduleId) =>
    !modulePermissions[moduleId] || can(modulePermissions[moduleId]);

  const applyModuleFiltersFromSearch = (moduleId, search = window.location.search) => {
    if (moduleId === 'contacts') {
      state.contactTab = new URLSearchParams(search).get('tab') === 'cokiba'
        ? 'congress'
        : 'website';
      return;
    }
    if (moduleId !== 'appointments') return;
    const paymentFilter = new URLSearchParams(search).get('pago') || '';
    if (['pending', 'confirmed'].includes(paymentFilter)) {
      state.appointmentStatusFilter = '';
      state.appointmentPaymentFilter = paymentFilter;
      return;
    }
    state.appointmentPaymentFilter = '';
  };

  const syncAppointmentPaymentSearch = () => {
    if (state.active !== 'appointments') return;
    const params = new URLSearchParams(window.location.search);
    if (state.appointmentPaymentFilter) {
      params.set('pago', state.appointmentPaymentFilter);
    } else {
      params.delete('pago');
    }
    const nextSearch = params.toString();
    window.history.replaceState(
      { module: 'appointments' },
      '',
      `${modulePath('appointments')}${nextSearch ? `?${nextSearch}` : ''}`,
    );
  };

  const syncContactTabSearch = () => {
    if (state.active !== 'contacts') return;
    const params = new URLSearchParams(window.location.search);
    if (state.contactTab === 'congress') {
      params.set('tab', 'cokiba');
    } else {
      params.delete('tab');
    }
    const nextSearch = params.toString();
    window.history.replaceState(
      { module: 'contacts' },
      '',
      `${modulePath('contacts')}${nextSearch ? `?${nextSearch}` : ''}`,
    );
  };

  const navigateToModule = async (moduleId, { replace = false, search = '' } = {}) => {
    let nextModule = moduleRoutes[moduleId] ? moduleId : 'dashboard';
    if (state.user && !canAccessModule(nextModule)) {
      nextModule = 'dashboard';
      search = '';
      replace = true;
    }
    state.active = nextModule;
    state.userMenuOpen = false;
    state.dialog = null;
    clearStatus();
    applyModuleFiltersFromSearch(nextModule, search);

    const nextPath = modulePath(nextModule);
    const nextLocation = `${nextPath}${search}`;
    if (`${window.location.pathname}${window.location.search}` !== nextLocation) {
      const method = replace ? 'replaceState' : 'pushState';
      window.history[method]({ module: nextModule }, '', nextLocation);
    }

    if (state.user) {
      await loadData();
      if (nextModule === 'config') {
        await loadMercadoPagoSettings();
      }
      if (nextModule === 'audit') {
        await loadAuditEvents();
      }
      if (nextModule === 'settlements') {
        await loadSettlementPreview();
      }
    }

    render();
  };

  const navIcon = (name) => `
    <svg class="nav-icon" aria-hidden="true" viewBox="0 0 24 24">
      ${navIcons[name] || ''}
    </svg>
  `;

  const actionIcon = (name) => {
    const icons = {
      eye: `
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      `,
      copy: `
        <rect width="14" height="14" x="8" y="8" rx="2" />
        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
      `,
      edit: `
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
      `,
      cancel: `
        <circle cx="12" cy="12" r="9" />
        <path d="m9 9 6 6" />
        <path d="m15 9-6 6" />
      `,
      revoke: `
        <path d="M10 17l5-5-5-5" />
        <path d="M15 12H3" />
        <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      `,
      mail: `
        <rect width="20" height="16" x="2" y="4" rx="2" />
        <path d="m22 7-8.97 5.7a2 2 0 0 1-2.06 0L2 7" />
      `,
      trash: `
        <path d="M3 6h18" />
        <path d="M8 6V4h8v2" />
        <path d="M19 6l-1 14H6L5 6" />
        <path d="M10 11v5" />
        <path d="M14 11v5" />
      `,
    };
    return `
      <svg class="action-icon" aria-hidden="true" viewBox="0 0 24 24">
        ${icons[name] || ''}
      </svg>
    `;
  };

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
      nomina: 'Nómina',
      agreement_api_paid: 'Pagado por acuerdo (API)',
      preference_error: 'Error al crear pago',
      calendar_error: 'Error de calendario',
      expired: 'Reserva vencida',
    })[value] || value || '';

  const appointmentStatusLabel = (appointment) => {
    if (appointment?.payment_status === 'nomina') return 'Nómina';
    if (appointment?.status === 'confirmed') return 'Confirmado';
    if (appointment?.status === 'pending_payment' || appointment?.payment_status === 'pending') {
      return 'Pendiente';
    }
    return (
      {
        payment_failed: 'Pago rechazado',
        payment_reversed: 'Pago revertido',
        cancelled: 'Cancelado',
      }[appointment?.status] ||
      appointment?.status ||
      'Sin dato'
    );
  };

  const appointmentPaymentMatches = (item, filter) => {
    if (!filter) return true;
    if (filter === 'pending') return item.payment_status === 'pending';
    if (filter === 'confirmed') return ['approved', 'nomina', 'agreement_api_paid'].includes(item.payment_status);
    return true;
  };

  const todayInput = () => new Date().toISOString().slice(0, 10);

  const appointmentDateTime = (item, timeField = 'start_time') => {
    const date = item.appointment_date;
    const time = item[timeField] || item.start_time || '00:00';
    const parsed = new Date(`${date}T${String(time).slice(0, 5)}:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const isPastAppointment = (item, now = new Date()) => {
    const endDate = appointmentDateTime(item, 'end_time') || appointmentDateTime(item);
    return endDate ? endDate < now : false;
  };

  const canManageAppointment = (appointment) =>
    can('appointments.write') &&
    appointment?.is_future === true &&
    appointment?.reservation_active !== false &&
    ['confirmed', 'pending_payment'].includes(appointment?.status);

  const scheduleBlockDateTime = (item, timeField = 'start_time') => {
    const date = item.block_date;
    const time = item[timeField] || item.start_time || '00:00';
    const parsed = new Date(`${date}T${String(time).slice(0, 5)}:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const isPastScheduleBlock = (item, now = new Date()) => {
    const endDate = scheduleBlockDateTime(item, 'end_time') || scheduleBlockDateTime(item);
    return endDate ? endDate < now : false;
  };

  const dayLabel = (dayOfWeek) =>
    dayLabels.find((day) => day.id === Number(dayOfWeek))?.label || '';

  const roleLabel = (role) =>
    ({
      admin: 'Admin',
      user: 'User',
      professional: 'Profesional',
    })[role] || role || 'User';

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
    const request = { method, headers, credentials: 'same-origin', cache: 'no-store' };

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

  async function apiAll(path, collectionKey) {
    const url = new URL(path, window.location.origin);
    const records = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      url.searchParams.set('page', String(page));
      url.searchParams.set('page_size', '500');
      const payload = await api(`${url.pathname}${url.search}`);
      records.push(...(payload[collectionKey] || []));
      hasMore = payload.pagination?.has_more === true;
      page += 1;
      if (page > 1000) throw new Error('El listado supera el máximo seguro de páginas.');
    }
    return { [collectionKey]: records };
  }

  async function loadSession() {
    state.active = moduleFromPath();
    applyModuleFiltersFromSearch(state.active);
    try {
      const payload = await api('/api/admin/auth/me');
      csrfToken = payload.csrf_token;
      state.user = payload.user;
      if (!canAccessModule(state.active)) {
        state.active = 'dashboard';
        window.history.replaceState({ module: 'dashboard' }, '', modulePath('dashboard'));
      }
      await loadData();
      if (state.active === 'config') {
        await loadMercadoPagoSettings();
      }
      if (state.active === 'audit') {
        await loadAuditEvents();
      }
      if (state.active === 'settlements') {
        await loadSettlementPreview();
      }
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
      congressData,
      nominaData,
      serviceData,
      professionalData,
      appointmentData,
      blockData,
      userData,
    ] = await Promise.all([
      can('dashboard.read') ? api('/api/admin/dashboard') : Promise.resolve({}),
      can('agreements.read') ? api('/api/admin/agreements') : Promise.resolve({ agreements: [] }),
      can('patient_intakes.read')
        ? apiAll(`/api/admin/patients${state.patientAgreementFilter ? `?agreement_id=${state.patientAgreementFilter}` : ''}`, 'patients')
        : Promise.resolve({ patients: [] }),
      can('contacts.read') ? apiAll('/api/admin/contacts', 'contacts') : Promise.resolve({ contacts: [] }),
      can('contacts.read')
        ? apiAll('/api/admin/congress-registrations', 'congress_registrations')
        : Promise.resolve({ congress_registrations: [] }),
      can('nomina.read')
        ? apiAll(`/api/admin/nomina${state.nominaAgreementFilter ? `?agreement_id=${state.nominaAgreementFilter}` : ''}`, 'nomina_entries')
        : Promise.resolve({ nomina_entries: [] }),
      can('services.read') ? api('/api/admin/services') : Promise.resolve({ services: [] }),
      can('professionals.read')
        ? api('/api/admin/professionals')
        : Promise.resolve({ professionals: [] }),
      can('appointments.read')
        ? apiAll('/api/admin/appointments', 'appointments')
        : Promise.resolve({ appointments: [] }),
      can('schedule_blocks.read')
        ? apiAll('/api/admin/schedule-blocks', 'schedule_blocks')
        : Promise.resolve({ schedule_blocks: [] }),
      can('users.read')
        ? api('/api/admin/users')
        : Promise.resolve({ users: [] }),
    ]);
    state.dashboard = dashboardData.dashboard || null;
    state.agreements = agreementData.agreements || [];
    state.patients = patientData.patients || [];
    state.contacts = contactData.contacts || [];
    state.congressRegistrations = congressData.congress_registrations || [];
    state.nominaEntries = nominaData.nomina_entries || [];
    state.services = serviceData.services || [];
    state.professionals = professionalData.professionals || [];
    state.appointments = appointmentData.appointments || [];
    state.scheduleBlocks = blockData.schedule_blocks || [];
    state.users = userData.users || [];
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
            .map((module) => {
              if (module.type === 'divider') {
                return '<span class="nav-divider" aria-hidden="true"></span>';
              }
              if (!canAccessModule(module.id)) return '';
              return `
                <a
                  href="${modulePath(module.id)}"
                  class="nav-button${state.active === module.id ? ' active' : ''}"
                  data-module="${module.id}"
                >
                  ${navIcon(module.icon)}
                  <span>${escapeHtml(module.label)}</span>
                </a>
              `;
            })
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
                ${can('users.read') ? '<button type="button" class="dropdown-button" data-action="open-users">Usuarios</button>' : ''}
                ${can('settings.read') ? '<button type="button" class="dropdown-button" data-action="open-config">Configurar</button>' : ''}
                ${can('audit.read') ? '<button type="button" class="dropdown-button" data-action="open-audit">Auditoría</button>' : ''}
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
    if (state.active === 'users') return 'Usuarios';
    if (state.active === 'config') return 'Configurar';
    if (state.active === 'audit') return 'Auditoría';
    return modules.find((module) => module.id === state.active)?.label || 'Admin';
  }

  function renderActiveModule() {
    if (state.active === 'dashboard') return renderDashboard();
    if (state.active === 'agreements') return renderAgreements();
    if (state.active === 'patient-intakes') return renderPatients();
    if (state.active === 'contacts') return renderContacts();
    if (state.active === 'nomina') return renderNomina();
    if (state.active === 'services') return renderServices();
    if (state.active === 'professionals') return renderProfessionals();
    if (state.active === 'appointments') return renderAppointments();
    if (state.active === 'settlements') return renderSettlements();
    if (state.active === 'blocks') return renderScheduleBlocks();
    if (state.active === 'booking-test') return renderBookingTest();
    if (state.active === 'users') return renderUsers();
    if (state.active === 'config') return renderConfig();
    if (state.active === 'audit') return renderAudit();
    return '';
  }

  function selectedAppointment() {
    if (!String(state.dialog?.type || '').startsWith('appointment-')) return null;
    return state.appointments.find((appointment) => appointment.id === state.dialog.id) || null;
  }

  function renderCopyInline(value, label) {
    const cleanValue = String(value || '').trim();
    if (!cleanValue) return '<span class="muted">Sin dato</span>';
    return `
      <span class="copy-inline">
        <span>${escapeHtml(cleanValue)}</span>
        <button
          type="button"
          class="icon-button mini-button"
          data-action="copy-field"
          data-copy="${escapeHtml(cleanValue)}"
          aria-label="Copiar ${escapeHtml(label)}"
          title="Copiar"
        >
          ${actionIcon('copy')}
        </button>
      </span>
    `;
  }

  function detailRow(label, value) {
    return `
      <div class="detail-row">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value || 'Sin dato')}</strong>
      </div>
    `;
  }

  function detailCopyRow(label, value) {
    return `
      <div class="detail-row">
        <span>${escapeHtml(label)}</span>
        <strong>${renderCopyInline(value, label)}</strong>
      </div>
    `;
  }

  const formatDocumentSize = (value) => {
    const bytes = Number(value || 0);
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  function renderAppointmentDocuments(documents = []) {
    return `
      <section class="appointment-documents-panel">
        <div class="appointment-documents-header">
          <div>
            <span>Documentación compartida</span>
            <h3>Estudios y enlaces del turno</h3>
          </div>
          <span class="pill">${documents.length}</span>
        </div>
        ${
          documents.length
            ? `<ul class="appointment-document-list">
                ${documents
                  .map(
                    (document) => `
                      <li>
                        <div>
                          <strong>${escapeHtml(document.name || 'Documento')}</strong>
                          <span>${document.kind === 'link' ? 'Enlace externo' : `Archivo${formatDocumentSize(document.size_bytes) ? ` · ${escapeHtml(formatDocumentSize(document.size_bytes))}` : ''}`}</span>
                        </div>
                        <a href="${escapeHtml(document.url)}" target="_blank" rel="noopener noreferrer">
                          ${document.kind === 'link' ? 'Abrir enlace' : 'Ver archivo'}
                        </a>
                      </li>
                    `,
                  )
                  .join('')}
              </ul>`
            : '<div class="appointment-documents-empty">El paciente no compartió documentación para este turno.</div>'
        }
      </section>
    `;
  }

  function professionalsForAppointment(appointment) {
    return state.professionals.filter(
      (professional) =>
        Number(professional.id) === Number(appointment.professional_id) ||
        (professional.active &&
          (professional.services || []).some(
            (service) => Number(service.id) === Number(appointment.service_id),
          ) &&
          (!appointment.agreement_id ||
            (professional.agreements || []).some(
              (agreement) => Number(agreement.id) === Number(appointment.agreement_id),
            ))),
    );
  }

  function renderDialog() {
    if (!state.dialog) return '';

    if (state.dialog.type === 'agreement-api-revoke-confirm') {
      return `
        <div class="modal-backdrop">
          <div class="modal-panel" role="dialog" aria-modal="true">
            <h2>Revocar credencial API</h2>
            <p class="muted">El sistema que usa este token dejará de poder operar inmediatamente. Los turnos ya creados se conservan.</p>
            <div class="modal-actions">
              <button type="button" class="secondary-button" data-action="manage-agreement-api" data-id="${state.dialog.agreementId}">Volver</button>
              <button type="button" class="danger-button" data-action="confirm-revoke-agreement-api">Revocar</button>
            </div>
          </div>
        </div>
      `;
    }

    if (state.dialog.type === 'agreement-api') {
      const agreement = state.agreements.find(
        (item) => Number(item.id) === Number(state.dialog.agreementId),
      );
      if (!agreement) return '';
      return `
        <div class="modal-backdrop">
          <div class="modal-panel modal-panel-wide" role="dialog" aria-modal="true">
            <div class="modal-header">
              <div>
                <h2>API · ${escapeHtml(agreement.name)}</h2>
                <p class="muted">Credenciales para reservar, modificar y cancelar turnos desde el sistema del acuerdo.</p>
              </div>
              <button type="button" class="icon-button" data-action="close-dialog" aria-label="Cerrar">×</button>
            </div>
            ${state.dialog.revealedToken
              ? `<div class="api-token-reveal">
                  <strong>Copiá este token ahora</strong>
                  <p>Por seguridad no se volverá a mostrar completo.</p>
                  <div class="copy-inline api-token-value">
                    <code>${escapeHtml(state.dialog.revealedToken)}</code>
                    <button type="button" class="secondary-button" data-action="copy-field" data-copy="${escapeHtml(state.dialog.revealedToken)}">Copiar</button>
                  </div>
                </div>`
              : ''}
            <div class="api-credentials-list">
              <div class="modal-header compact-modal-header">
                <h3>Credenciales</h3>
                <a href="/integraciones/api/" target="_blank" rel="noopener">Ver documentación</a>
              </div>
              ${state.agreementApiCredentials.length
                ? state.agreementApiCredentials.map((credential) => `
                    <div class="api-credential-row">
                      <div>
                        <strong>${escapeHtml(credential.name)}</strong>
                        <code>${escapeHtml(credential.token_prefix)}…</code>
                        <span class="muted">Creada ${escapeHtml(formatDate(credential.created_at))}${credential.last_used_at ? ` · Último uso ${escapeHtml(formatDate(credential.last_used_at))}` : ' · Nunca usada'}</span>
                      </div>
                      ${credential.active
                        ? `<button type="button" class="danger-button" data-action="revoke-agreement-api" data-id="${credential.id}" data-agreement-id="${agreement.id}">Revocar</button>`
                        : '<span class="pill">Revocada</span>'}
                    </div>
                  `).join('')
                : '<div class="empty-state">Todavía no hay credenciales para este acuerdo.</div>'}
            </div>
            ${can('agreements.write')
              ? `<form id="agreement-api-credential-form" class="api-credential-form">
                  <input type="hidden" name="agreement_id" value="${agreement.id}" />
                  <label>
                    Nombre de la integración
                    <input name="name" value="Integración principal" maxlength="80" required />
                  </label>
                  <button type="submit" class="primary-button">Generar token</button>
                </form>`
              : ''}
          </div>
        </div>
      `;
    }

    if (state.dialog.type === 'user-form') {
      return `
        <div class="modal-backdrop">
          <form class="modal-panel" id="user-form">
            <h2>Nuevo usuario</h2>
            <label>
              Nombre
              <input name="name" autocomplete="name" />
            </label>
            <label>
              Email
              <input name="email" type="email" autocomplete="email" required />
            </label>
            <label>
              Clave
              <input name="password" type="password" autocomplete="new-password" minlength="10" required />
            </label>
            <label>
              Rol
              <select name="role" ${state.user.can_manage_system ? '' : 'disabled'}>
                <option value="user" selected>User</option>
                ${state.user.can_manage_system ? '<option value="admin">Admin</option>' : ''}
              </select>
            </label>
            <p class="field-help">Las cuentas de acceso de profesionales se crean y administran desde el módulo Profesionales.</p>
            <div class="modal-actions">
              <button type="button" class="secondary-button" data-action="close-dialog">Cancelar</button>
              <button type="submit" class="primary-button">Crear usuario</button>
            </div>
          </form>
        </div>
      `;
    }

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
              <button type="button" class="danger-button" data-action="confirm-delete">${escapeHtml(state.dialog.confirmLabel || 'Eliminar')}</button>
            </div>
          </div>
        </div>
      `;
    }

    if (state.dialog.type === 'appointment-view') {
      const appointment = selectedAppointment();
      if (!appointment) return '';
      const isPaidAppointment = ['approved', 'paid_simulated', 'free', 'nomina', 'agreement_api_paid'].includes(
        appointment.payment_status,
      );
      const detailPaymentClass =
        appointment.agreement_type === 'Pago' && !isPaidAppointment
          ? 'detail-payment-alert'
          : 'detail-payment-ok';
      return `
        <div class="modal-backdrop">
          <div class="modal-panel modal-panel-wide" role="dialog" aria-modal="true">
            <div class="modal-header">
              <h2>Detalle del turno</h2>
              <button type="button" class="icon-button" data-action="close-dialog" aria-label="Cerrar">×</button>
            </div>
            <div class="detail-grid appointment-detail-grid ${detailPaymentClass}">
              ${detailRow('Fecha', appointment.appointment_date)}
              ${detailRow('Hora', `${appointment.start_time} - ${appointment.end_time}`)}
              ${detailRow('Servicio', appointment.service_name)}
              ${detailRow('Profesional', appointment.professional_name)}
              ${detailRow('Paciente', appointment.patient_name || 'Paciente')}
              ${detailCopyRow('Teléfono', appointment.patient_phone)}
              ${detailCopyRow('Mail', appointment.patient_email)}
              ${detailRow('Acuerdo', appointment.agreement_name || 'Sin acuerdo')}
              ${detailRow('Tipo de acuerdo', appointment.agreement_type || 'Sin dato')}
              ${detailRow('Identificador', appointment.identificador || 'Sin dato')}
              ${detailRow('Pago', paymentStatusLabel(appointment.payment_status))}
              ${appointment.booking_channel === 'agreement_api' ? detailRow('Canal', 'API del acuerdo') : ''}
              ${appointment.agreement_api_external_id ? detailCopyRow('ID externo', appointment.agreement_api_external_id) : ''}
              ${appointment.payment_reference ? detailCopyRow('Referencia de pago', appointment.payment_reference) : ''}
              ${detailRow('Monto', formatMoney(appointment.amount))}
              ${detailRow('Estado', appointmentStatusLabel(appointment))}
              ${appointment.cancellation_reason ? detailRow('Motivo de cancelación', appointment.cancellation_reason) : ''}
              ${appointment.refund_status && appointment.refund_status !== 'not_required' ? detailRow('Devolución', appointment.refund_status === 'approved' ? 'Completada' : appointment.refund_status === 'failed' ? 'Fallida / requiere reintento' : appointment.refund_status === 'external_management' ? 'A cargo del acuerdo' : 'Pendiente') : ''}
              ${appointment.refund_error ? detailRow('Error de devolución', appointment.refund_error) : ''}
              ${appointment.google_sync_status ? detailRow('Google Calendar', appointment.google_sync_status) : ''}
              ${appointment.google_meet_url ? detailCopyRow('Google Meet', appointment.google_meet_url) : ''}
              ${appointment.google_sync_error ? detailRow('Error de Google', appointment.google_sync_error) : ''}
              ${detailRow('Cuestionario previo', appointment.triage_status === 'assigned' ? 'Enlace generado' : appointment.triage_status === 'failed' ? 'Alerta: no se pudo obtener de ReHub' : 'Pendiente')}
              ${detailRow('Alta paciente', appointment.patient_intake_id ? `#${appointment.patient_intake_id}` : 'Sin alta asociada')}
            </div>
            ${renderAppointmentDocuments(appointment.documents)}
            ${
              canManageAppointment(appointment)
                ? `<div class="modal-actions appointment-detail-actions">
                    <button type="button" class="danger-button" data-action="cancel-appointment" data-id="${appointment.id}">Cancelar turno</button>
                    <button type="button" class="primary-button" data-action="edit-appointment" data-id="${appointment.id}">Editar turno</button>
                  </div>`
                : ''
            }
          </div>
        </div>
      `;
    }

    if (state.dialog.type === 'appointment-edit') {
      const appointment = selectedAppointment();
      if (!appointment) return '';
      const dialog = state.dialog;
      const professionals = professionalsForAppointment(appointment);
      const slots = state.appointmentEditSlots;
      return `
        <div class="modal-backdrop">
          <form class="modal-panel modal-panel-wide appointment-edit-form" id="appointment-edit-form">
            <div class="modal-header">
              <div>
                <h2>Editar turno</h2>
                <p class="muted">${escapeHtml(appointment.patient_name || 'Paciente')} · ${escapeHtml(appointment.service_name)}</p>
              </div>
              <button type="button" class="icon-button" data-action="close-dialog" aria-label="Cerrar">×</button>
            </div>
            <div class="appointment-current-summary">
              <span>Actual</span>
              <strong>${escapeHtml(appointment.professional_name)} · ${escapeHtml(appointment.appointment_date)} · ${escapeHtml(appointment.start_time)}</strong>
            </div>
            <div class="grid-two">
              <label>
                Profesional
                <select name="professional_id" id="appointment-edit-professional" required>
                  ${professionals
                    .map(
                      (professional) => `<option value="${professional.id}" ${Number(dialog.professionalId) === Number(professional.id) ? 'selected' : ''}>${escapeHtml(professional.name)}</option>`,
                    )
                    .join('')}
                </select>
              </label>
              <label>
                Fecha
                <input name="appointment_date" id="appointment-edit-date" type="date" min="${todayInput()}" value="${escapeHtml(dialog.appointmentDate)}" required />
              </label>
              <label class="span-two">
                Horario disponible
                <select name="start_time" id="appointment-edit-slot" ${state.appointmentEditLoading || !slots.length ? 'disabled' : ''} required>
                  ${
                    state.appointmentEditLoading
                      ? '<option>Cargando horarios…</option>'
                      : slots.length
                        ? slots.map((slot) => `<option value="${escapeHtml(slot)}" ${dialog.startTime === slot ? 'selected' : ''}>${escapeHtml(slot)}</option>`).join('')
                        : '<option value="">No hay horarios disponibles</option>'
                  }
                </select>
              </label>
            </div>
            ${state.appointmentEditError ? `<div class="status-box error">${escapeHtml(state.appointmentEditError)}</div>` : ''}
            <p class="field-help">Al guardar se actualizará Google Calendar y se enviará el nuevo detalle por mail.</p>
            <div class="modal-actions">
              <button type="button" class="secondary-button" data-action="close-dialog">Cerrar</button>
              <button type="submit" class="primary-button" ${state.appointmentEditLoading || !slots.length ? 'disabled' : ''}>Guardar cambios</button>
            </div>
          </form>
        </div>
      `;
    }

    if (state.dialog.type === 'appointment-cancel') {
      const appointment = selectedAppointment();
      if (!appointment) return '';
      const requiresRefund =
        appointment.payment_status === 'approved' &&
        appointment.payment_provider === 'mercadopago';
      return `
        <div class="modal-backdrop">
          <form class="modal-panel" id="appointment-cancel-form">
            <div class="modal-header">
              <h2>Cancelar turno</h2>
              <button type="button" class="icon-button" data-action="close-dialog" aria-label="Cerrar">×</button>
            </div>
            <div class="appointment-current-summary">
              <span>${escapeHtml(appointment.patient_name || 'Paciente')}</span>
              <strong>${escapeHtml(appointment.professional_name)} · ${escapeHtml(appointment.appointment_date)} · ${escapeHtml(appointment.start_time)}</strong>
            </div>
            <label>
              Motivo de cancelación
              <textarea name="reason" rows="4" maxlength="500" required placeholder="Contale al paciente por qué se cancela"></textarea>
            </label>
            <p class="field-help">${requiresRefund ? 'Este turno está pagado por Mercado Pago: al confirmar se solicitará el reembolso total.' : 'El paciente recibirá un mail informando la cancelación.'}</p>
            <div class="modal-actions">
              <button type="button" class="secondary-button" data-action="close-dialog">Volver</button>
              <button type="submit" class="danger-button">Confirmar cancelación</button>
            </div>
          </form>
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

    if (state.dialog.type === 'professional-create-choice') {
      return `
        <div class="modal-backdrop">
          <div class="modal-panel" role="dialog" aria-modal="true">
            <div class="modal-header">
              <div>
                <h2>Nuevo profesional</h2>
                <p class="muted">Elegí cómo querés darlo de alta.</p>
              </div>
              <button type="button" class="icon-button" data-action="close-dialog" aria-label="Cerrar">×</button>
            </div>
            <div class="professional-create-options">
              <button type="button" class="professional-create-option" data-action="create-professional-manual">
                <strong>Crearlo manualmente</strong>
                <span>Cargás la ficha, prácticas, horarios y clave de acceso.</span>
              </button>
              <button type="button" class="professional-create-option" data-action="invite-professional">
                <strong>Invitar por mail</strong>
                <span>Cargás nombre y email; el profesional configura el resto.</span>
              </button>
            </div>
          </div>
        </div>
      `;
    }

    if (state.dialog.type === 'professional-invite-form') {
      return `
        <div class="modal-backdrop">
          <form class="modal-panel" id="professional-invite-form">
            <div class="modal-header">
              <div>
                <h2>Invitar profesional</h2>
                <p class="muted">Va a recibir un enlace para crear su clave y configurar su ficha.</p>
              </div>
              <button type="button" class="icon-button" data-action="close-dialog" aria-label="Cerrar">×</button>
            </div>
            <div class="grid-two">
              <label>
                Nombre
                <input name="name" autocomplete="name" required />
              </label>
              <label>
                Email
                <input name="email" type="email" autocomplete="email" required />
              </label>
              <div class="form-actions span-two">
                <button type="button" class="secondary-button" data-action="close-dialog">Cancelar</button>
                <button type="submit" class="primary-button">Enviar invitación</button>
              </div>
            </div>
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
    const confirmedAppointments =
      data.appointments_confirmed ??
      state.appointments.filter((appointment) =>
        appointmentPaymentMatches(appointment, 'confirmed'),
      ).length;
    const pendingAppointments =
      data.appointments_pending ??
      state.appointments.filter((appointment) =>
        appointmentPaymentMatches(appointment, 'pending'),
      ).length;
    const cards = [
      { label: 'Contactos', value: data.contacts || 0, module: 'contacts' },
      {
        label: 'Pacientes',
        value: data.patients ?? data.patient_intakes ?? 0,
        module: 'patient-intakes',
      },
      {
        label: 'Turnos Confirmados',
        value: confirmedAppointments,
        module: 'appointments',
        appointmentPaymentFilter: 'confirmed',
      },
      {
        label: 'Turnos Pendientes',
        value: pendingAppointments,
        module: 'appointments',
        appointmentPaymentFilter: 'pending',
      },
      { label: 'Facturado', value: formatMoney(data.revenue || 0), module: 'appointments' },
      { label: 'Servicios activos', value: data.services || 0, module: 'services' },
      { label: 'Profesionales activos', value: data.professionals || 0, module: 'professionals' },
      { label: 'Bloqueos próximos', value: data.upcoming_blocks || 0, module: 'blocks' },
    ];

    return `
      <section class="dashboard-grid">
        ${cards
          .map(
            (card) => `
              <a
                href="${modulePath(card.module)}${card.appointmentPaymentFilter ? `?pago=${card.appointmentPaymentFilter}` : ''}"
                class="metric-card"
                data-module="${escapeHtml(card.module)}"
                ${card.appointmentPaymentFilter ? `data-appointment-payment-filter="${escapeHtml(card.appointmentPaymentFilter)}"` : ''}
              >
                <span>${escapeHtml(card.label)}</span>
                <strong>${escapeHtml(card.value)}</strong>
              </a>
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
        image_url: '',
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
        <label class="span-two">
          Imagen
          <input class="file-input" name="image" type="file" accept="image/png,image/jpeg,image/webp" />
          <span class="field-help">Recomendado: 1200 × 720 px, formato JPG/PNG/WebP, hasta 10 MB. Se optimiza a WebP liviano al guardar.</span>
        </label>
        ${
          item.image_url
            ? `
              <div class="span-two current-asset">
                <img src="${escapeHtml(item.image_url)}" alt="" />
                <label class="check-row">
                  <input type="checkbox" name="remove_image" />
                  Quitar imagen actual
                </label>
              </div>
            `
            : ''
        }
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
        <div class="panel-header panel-header-actions-only">
          ${can('services.write') ? '<button type="button" class="primary-button" data-action="new-service">Nuevo</button>' : ''}
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Imagen</th>
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
                  : '<tr><td colspan="7">No hay servicios cargados.</td></tr>'
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
        <td>
          <span class="asset-thumb">
            ${service.image_url ? `<img src="${escapeHtml(service.image_url)}" alt="" />` : '<span>Sin imagen</span>'}
          </span>
        </td>
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
            ${
              can('services.write')
                ? `
                  <button type="button" class="secondary-button" data-action="edit-service" data-id="${service.id}">Editar</button>
                `
                : ''
            }
            ${
              can('services.delete')
                ? `<button type="button" class="danger-button" data-action="delete-service" data-id="${service.id}">Eliminar</button>`
                : ''
            }
            ${
              !can('services.write') && !can('services.delete')
                ? '<span class="muted">Solo lectura</span>'
                : ''
            }
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
        license_number: '',
        specialty: '',
        bio: '',
        phone: '',
        photo_url: '',
        active: true,
        has_user: false,
        user_email: '',
        services: [],
        agreements: [],
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

  function agreementsForProfessional(item) {
    const selected = new Set((item.agreements || []).map((agreement) => Number(agreement.id)));
    return state.agreements
      .map(
        (agreement) => `
          <label class="check-row compact-check">
            <input type="checkbox" name="agreement_ids" value="${agreement.id}" ${selected.has(agreement.id) ? 'checked' : ''} />
            ${escapeHtml(agreement.name)}
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
    const needsAccount = !item.has_user && !item.invitation_pending;
    const isEditing = Boolean(state.editingProfessionalId);
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
        <div class="professional-account-box span-two ${needsAccount && isEditing ? 'warning' : ''}">
          <div>
            <strong>Cuenta de acceso profesional</strong>
            <p>
              ${
                item.has_user
                  ? `Cuenta activa: ${escapeHtml(item.user_email || item.email)}`
                  : item.invitation_pending
                    ? `Invitación pendiente para ${escapeHtml(item.user_email || item.email)}. Podés guardar los datos sin crearle una clave manual.`
                  : isEditing
                    ? 'Este profesional todavía no tiene una cuenta activa. Para guardar los cambios, tenés que crearla o reactivarla ahora.'
                    : 'La cuenta se creará junto con la ficha profesional.'
              }
            </p>
          </div>
          <label>
            ${item.has_user || item.invitation_pending ? 'Nueva clave (opcional)' : 'Clave de acceso'}
            <input
              name="account_password"
              type="password"
              autocomplete="new-password"
              minlength="8"
              ${needsAccount ? 'required' : ''}
            />
            <span class="field-help">
              ${item.has_user
                ? 'Dejala vacía para conservar la clave actual.'
                : item.invitation_pending
                  ? 'Dejala vacía para que el profesional la cree desde su invitación.'
                  : 'Mínimo 8 caracteres.'}
            </span>
          </label>
        </div>
        <label>
          Matrícula
          <input name="license_number" value="${escapeHtml(item.license_number || '')}" maxlength="120" />
        </label>
        <label>
          Especialidad
          <input name="specialty" value="${escapeHtml(item.specialty || '')}" maxlength="160" />
        </label>
        <label>
          Teléfono
          <input name="phone" value="${escapeHtml(item.phone || '')}" maxlength="80" autocomplete="tel" />
        </label>
        <label class="span-two">
          Bio
          <textarea name="bio" maxlength="2000" rows="4">${escapeHtml(item.bio || '')}</textarea>
        </label>
        <label>
          Foto
          <input class="file-input" name="photo" type="file" accept="image/png,image/jpeg,image/webp" />
          <span class="field-help">Recomendado: foto cuadrada de 512 × 512 px o más. Se optimiza a WebP liviano al guardar.</span>
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
        <div class="span-two checkbox-grid">
          <strong>Acuerdos que atiende</strong>
          ${agreementsForProfessional(item) || '<p class="muted">Primero cargá acuerdos.</p>'}
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
        <div class="panel-header panel-header-actions-only">
          ${can('professionals.write') ? '<button type="button" class="primary-button" data-action="new-professional">Nuevo</button>' : ''}
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Profesional</th>
                <th>Mail</th>
                <th>Accesos</th>
                <th>Servicios</th>
                <th>Acuerdos</th>
                <th>Horarios</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${
                state.professionals.length
                  ? state.professionals.map(renderProfessionalRow).join('')
                  : '<tr><td colspan="8">No hay profesionales cargados.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderProfessionalRow(professional) {
    const calendarConnected = Boolean(professional.calendar_connected);
    const notificationsConnected = Boolean(professional.notifications_connected);
    const connectionStatus = calendarConnected && notificationsConnected
      ? { label: 'All connected', className: 'active' }
      : calendarConnected
        ? { label: 'Calendar connected', className: 'pending' }
        : notificationsConnected
          ? { label: 'Notif connected', className: 'pending' }
          : { label: 'Nothing connected', className: 'missing' };
    return `
      <tr>
        <td>
          <div class="person-cell">
            ${professional.photo_url ? `<img src="${escapeHtml(professional.photo_url)}" alt="" />` : '<span class="avatar-placeholder">+</span>'}
            <strong>${escapeHtml(professional.name)}</strong>
          </div>
        </td>
        <td>${escapeHtml(professional.email)}</td>
        <td>
          <div class="access-statuses">
            <span class="account-status ${professional.has_user ? 'active' : 'missing'}">
              Cuenta ${professional.has_user ? 'activa' : 'pendiente'}
            </span>
            <span class="account-status ${connectionStatus.className}" title="Calendar: ${calendarConnected ? 'conectado' : 'pendiente'} · Notificaciones: ${notificationsConnected ? 'conectadas' : 'pendientes'}">
              ${connectionStatus.label}
            </span>
          </div>
        </td>
        <td>${(professional.services || []).map((service) => escapeHtml(service.name)).join(', ') || 'Sin servicios'}</td>
        <td>${(professional.agreements || []).map((agreement) => escapeHtml(agreement.name)).join(', ') || 'Sin acuerdos'}</td>
        <td>${renderAvailabilitySummary(professional.availability)}</td>
        <td>${professional.active ? 'Activo' : 'Inactivo'}</td>
        <td>
          <div class="table-actions">
            ${
              can('professionals.write') && !professional.has_user
                ? `<button type="button" class="table-icon-button" data-action="invite-existing-professional" data-id="${professional.id}" aria-label="${professional.invitation_pending ? 'Reenviar invitación' : 'Enviar invitación'}" title="${professional.invitation_pending ? 'Reenviar invitación' : 'Enviar invitación'}">${actionIcon('mail')}</button>`
                : ''
            }
            ${
              can('professionals.write')
                ? `<button type="button" class="table-icon-button" data-action="edit-professional" data-id="${professional.id}" aria-label="Editar profesional" title="Editar profesional">${actionIcon('edit')}</button>`
                : ''
            }
            ${
              can('professionals.revoke_access')
                ? `<button type="button" class="table-icon-button" data-action="revoke-professional-access" data-id="${professional.id}" aria-label="Revocar" title="Revocar">${actionIcon('revoke')}</button>`
                : ''
            }
            ${
              can('professionals.delete')
                ? `<button type="button" class="table-icon-button danger" data-action="delete-professional" data-id="${professional.id}" aria-label="Eliminar profesional" title="Eliminar profesional">${actionIcon('trash')}</button>`
                : ''
            }
            ${
              !can('professionals.write') &&
              !can('professionals.delete') &&
              !can('professionals.revoke_access')
                ? '<span class="muted">Solo lectura</span>'
                : ''
            }
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
    const items = filteredAppointments();
    return `
      <section class="panel">
        <div class="toolbar appointments-toolbar">
          <div class="toolbar-actions">
            <label>
              Estado
              <select id="appointment-status-filter">
                <option value="">Todos</option>
                <option value="past">Pasados</option>
                <option value="future">Futuros</option>
              </select>
            </label>
            <label>
              Pago
              <select id="appointment-payment-filter">
                <option value="">Todos</option>
                <option value="pending">Pendientes</option>
                <option value="confirmed">Confirmados</option>
              </select>
            </label>
            <label>
              Profesional
              <select id="appointment-professional-filter">
                <option value="">Todos</option>
                ${renderAppointmentProfessionalOptions()}
              </select>
            </label>
            <label>
              Paciente
              <input
                id="appointment-patient-filter"
                type="search"
                value="${escapeHtml(state.appointmentPatientFilter)}"
                placeholder="Nombre, mail o teléfono"
              />
            </label>
          </div>
          <span class="toolbar-count">Total: ${items.length}</span>
        </div>
        ${renderAppointmentsTable(items)}
      </section>
    `;
  }

  function renderSettlements() {
    const eligibleAgreements = state.agreements.filter((agreement) => agreement.type === 'Pago');
    const settlement = state.settlement;
    const appointments = settlement?.appointments || [];
    return `
      <section class="panel settlement-panel">
        <div class="toolbar settlement-toolbar">
          <div class="toolbar-actions settlement-filter-actions">
            <label>
              Acuerdo
              <select id="settlement-agreement-filter">
                ${eligibleAgreements.length
                  ? eligibleAgreements.map((agreement) => `<option value="${agreement.id}">${escapeHtml(agreement.name)}</option>`).join('')
                  : '<option value="">No hay acuerdos habilitados</option>'}
              </select>
            </label>
            <label>
              Mes
              <input id="settlement-month-filter" type="month" value="${escapeHtml(state.settlementMonth)}" />
            </label>
          </div>
          <div class="toolbar-actions settlement-end-actions">
            ${settlement?.generated_settlement
              ? `<a class="secondary-button" href="/api/admin/settlements/${settlement.generated_settlement.id}/pdf" target="_blank" rel="noopener" title="Descarga la última versión guardada para este acuerdo y mes">Descargar PDF generado</a>`
              : ''}
            ${can('settlements.write') && state.settlementAgreementId
              ? `<button type="button" class="primary-button" data-action="generate-settlement">${settlement?.generated_settlement ? 'Regenerar PDF' : 'Generar PDF'}</button>`
              : ''}
          </div>
        </div>
        ${state.settlementLoading
          ? '<div class="empty-state">Cargando liquidación…</div>'
          : !settlement
            ? '<div class="empty-state">Seleccioná un acuerdo y un mes.</div>'
            : `
              <div class="settlement-summary-grid">
                <article><span>Turnos facturables</span><strong>${settlement.totals.appointments}</strong></article>
                <article><span>Cancelados</span><strong>${settlement.totals.cancelled}</strong></article>
                <article><span>Total</span><strong>${escapeHtml(formatMoney(settlement.totals.amount))}</strong></article>
              </div>
              <p class="field-help">Incluye únicamente turnos creados por la API del acuerdo. Los cancelados quedan visibles para conciliación pero no suman al total. Generar el PDF guarda una versión del período, pero no cambia el estado de los turnos.</p>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Horario</th>
                      <th>Paciente</th>
                      <th>Profesional</th>
                      <th>Práctica</th>
                      <th>ID externo</th>
                      <th>Estado</th>
                      <th>Monto</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${appointments.length
                      ? appointments.map((appointment) => `
                          <tr>
                            <td>${escapeHtml(appointment.date)}</td>
                            <td>${escapeHtml(appointment.start_time)} - ${escapeHtml(appointment.end_time)}</td>
                            <td><strong>${escapeHtml(appointment.patient_name)}</strong><br /><span class="muted">${escapeHtml(appointment.patient_email)}</span></td>
                            <td>${escapeHtml(appointment.professional_name)}</td>
                            <td>${escapeHtml(appointment.service_name)}</td>
                            <td><code>${escapeHtml(appointment.external_id)}</code></td>
                            <td><span class="pill">${appointment.billable ? 'Confirmado' : 'Cancelado'}</span></td>
                            <td>${appointment.billable ? escapeHtml(formatMoney(appointment.amount)) : '—'}</td>
                          </tr>
                        `).join('')
                      : '<tr><td colspan="8">No hay turnos por API en este período.</td></tr>'}
                  </tbody>
                </table>
              </div>
            `}
      </section>
    `;
  }

  function renderAppointmentProfessionalOptions() {
    const options = new Map();
    state.professionals.forEach((professional) => {
      options.set(String(professional.id), professional.name);
    });
    state.appointments.forEach((appointment) => {
      if (appointment.professional_id) {
        options.set(
          String(appointment.professional_id),
          options.get(String(appointment.professional_id)) || appointment.professional_name,
        );
      }
    });

    return [...options.entries()]
      .sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'es'))
      .map(
        ([id, name]) =>
          `<option value="${escapeHtml(id)}">${escapeHtml(name || `Profesional ${id}`)}</option>`,
      )
      .join('');
  }

  function filteredAppointments(items = state.appointments) {
    const now = new Date();
    const patientTerm = state.appointmentPatientFilter.trim().toLowerCase();

    return items
      .filter((item) => {
        if (state.appointmentStatusFilter === 'past' && !isPastAppointment(item, now)) return false;
        if (state.appointmentStatusFilter === 'future' && isPastAppointment(item, now)) return false;
        if (!appointmentPaymentMatches(item, state.appointmentPaymentFilter)) return false;
        if (
          state.appointmentProfessionalFilter &&
          String(item.professional_id) !== state.appointmentProfessionalFilter
        ) {
          return false;
        }
        if (
          patientTerm &&
          ![item.patient_name, item.patient_email, item.patient_phone]
            .join(' ')
            .toLowerCase()
            .includes(patientTerm)
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const aDate = appointmentDateTime(a)?.getTime() || 0;
        const bDate = appointmentDateTime(b)?.getTime() || 0;
        return state.appointmentStatusFilter === 'past' ? bDate - aDate : aDate - bDate;
      });
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
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${
              items.length
                ? items.map(renderAppointmentRow).join('')
                : '<tr><td colspan="8">No hay turnos registrados.</td></tr>'
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
        <td>
          <div class="table-actions">
            <button
              type="button"
              class="icon-button mini-button"
              data-action="view-appointment"
              data-id="${item.id}"
              aria-label="Ver turno"
              title="Ver"
            >
              ${actionIcon('eye')}
            </button>
            ${
              canManageAppointment(item)
                ? `<button
                    type="button"
                    class="icon-button mini-button"
                    data-action="edit-appointment"
                    data-id="${item.id}"
                    aria-label="Editar turno"
                    title="Editar turno"
                  >${actionIcon('edit')}</button>
                  <button
                    type="button"
                    class="icon-button mini-button danger"
                    data-action="cancel-appointment"
                    data-id="${item.id}"
                    aria-label="Cancelar turno"
                    title="Cancelar turno"
                  >${actionIcon('cancel')}</button>`
                : ''
            }
          </div>
        </td>
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
    const items = filteredScheduleBlocks();
    return `
      <section class="panel">
        <div class="toolbar compact-filter-toolbar">
          <div class="toolbar-actions compact-filter-actions">
            <label>
              Fecha
              <select id="schedule-block-date-filter">
                <option value="">Todos</option>
                <option value="past">Vencidos</option>
                <option value="future">Próximos</option>
              </select>
            </label>
            <label>
              Profesional
              <select id="schedule-block-professional-filter">
                <option value="">Todos</option>
                ${renderScheduleBlockProfessionalOptions()}
              </select>
            </label>
          </div>
          <div class="toolbar-actions toolbar-end-actions">
            ${can('schedule_blocks.write') ? '<button type="button" class="primary-button" data-action="new-schedule-block">Nuevo bloqueo</button>' : ''}
          </div>
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
                items.length
                  ? items.map(renderScheduleBlockRow).join('')
                  : '<tr><td colspan="5">No hay bloqueos para esos filtros.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderScheduleBlockProfessionalOptions() {
    const options = new Map();
    state.professionals.forEach((professional) => {
      options.set(String(professional.id), professional.name);
    });
    state.scheduleBlocks.forEach((item) => {
      if (item.professional_id) {
        options.set(
          String(item.professional_id),
          options.get(String(item.professional_id)) || item.professional_name,
        );
      }
    });

    return [...options.entries()]
      .sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'es'))
      .map(
        ([id, name]) =>
          `<option value="${escapeHtml(id)}">${escapeHtml(name || `Profesional ${id}`)}</option>`,
      )
      .join('');
  }

  function filteredScheduleBlocks(items = state.scheduleBlocks) {
    const now = new Date();

    return items
      .filter((item) => {
        if (state.scheduleBlockDateFilter === 'past' && !isPastScheduleBlock(item, now)) return false;
        if (state.scheduleBlockDateFilter === 'future' && isPastScheduleBlock(item, now)) return false;
        if (
          state.scheduleBlockProfessionalFilter &&
          String(item.professional_id) !== state.scheduleBlockProfessionalFilter
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const aDate = scheduleBlockDateTime(a)?.getTime() || 0;
        const bDate = scheduleBlockDateTime(b)?.getTime() || 0;
        if (!state.scheduleBlockDateFilter) return bDate - aDate;
        return state.scheduleBlockDateFilter === 'past' ? bDate - aDate : aDate - bDate;
      });
  }

  function renderScheduleBlockRow(item) {
    return `
      <tr>
        <td>${escapeHtml(item.block_date)}</td>
        <td>${escapeHtml(item.professional_name)}</td>
        <td>${escapeHtml(item.start_time)} - ${escapeHtml(item.end_time)}</td>
        <td>${escapeHtml(item.reason || 'Sin motivo')}</td>
        <td>
          <div class="table-actions">
            ${
              can('schedule_blocks.delete')
                ? `<button type="button" class="danger-button" data-action="delete-schedule-block" data-id="${item.id}">Eliminar</button>`
                : can('schedule_blocks.write')
                  ? ''
                  : '<span class="muted">Solo lectura</span>'
            }
          </div>
        </td>
      </tr>
    `;
  }

  function renderBookingTest() {
    return `
      <section class="panel">
        <div class="toolbar booking-test-toolbar">
          <label>
            Acuerdo
            <select id="test-booking-agreement">
              <option value="">Seleccionar acuerdo</option>
              ${state.agreements
                .map(
                  (agreement) =>
                    `<option value="${agreement.id}">${escapeHtml(agreement.name)} (${escapeHtml(agreement.type)})</option>`,
                )
                .join('')}
            </select>
          </label>
          <button type="button" class="primary-button" data-action="create-test-booking-link">Generar link</button>
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

  function renderUsers() {
    return `
      <section class="panel">
        <div class="panel-header panel-header-actions-only">
          ${can('users.write') ? '<button type="button" class="primary-button" data-action="new-user">Nuevo usuario</button>' : ''}
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Email</th>
                <th>Rol</th>
                <th>Último login</th>
                <th>Creado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${
                state.users.length
                  ? state.users.map(renderUserRow).join('')
                  : '<tr><td colspan="6">No hay usuarios activos.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderUserRow(item) {
    const isSelf = Number(item.id) === Number(state.user.id);
    const canDelete = can('users.write') && !isSelf;
    return `
      <tr>
        <td><strong>${escapeHtml(item.name || 'Sin nombre')}</strong></td>
        <td>${escapeHtml(item.email)}</td>
        <td>${escapeHtml(roleLabel(item.role))}</td>
        <td>${escapeHtml(item.last_login_at ? formatDate(item.last_login_at) : 'Sin login')}</td>
        <td>${escapeHtml(formatDate(item.created_at))}</td>
        <td>
          <div class="table-actions">
            <button
              type="button"
              class="danger-button"
              data-action="delete-user"
              data-id="${item.id}"
              ${canDelete ? '' : 'disabled'}
            >
              Eliminar
            </button>
          </div>
        </td>
      </tr>
    `;
  }

  function renderConfig() {
    if (!can('settings.read')) return '<section class="panel">Sin permisos.</section>';
    const settings = {
      mode: 'production',
      development: {},
      production: {},
      ...(state.mercadoPagoSettings || {}),
    };
    const environmentFields = (key, label) => {
      const env = settings[key] || {};
      return `
        <fieldset class="settings-fieldset" ${can('settings.write') ? '' : 'disabled'}>
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
            <input name="${key}_webhook_secret" type="password" placeholder="${env.webhook_secret_set ? 'Guardado' : 'Obligatorio para recibir notificaciones'}" autocomplete="off" />
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
            <select name="mode" ${can('settings.write') ? '' : 'disabled'}>
              <option value="development" ${settings.mode === 'development' ? 'selected' : ''}>Desarrollo</option>
              <option value="production" ${settings.mode === 'production' ? 'selected' : ''}>Producción</option>
            </select>
          </label>
          ${environmentFields('development', 'Desarrollo')}
          ${environmentFields('production', 'Producción')}
          <div class="form-actions span-two">
            ${can('settings.write') ? '<button type="submit" class="primary-button">Guardar configuración</button>' : '<span class="muted">Solo lectura</span>'}
          </div>
        </form>
      </section>
    `;
  }

  function renderAudit() {
    if (!can('audit.read')) return '<section class="panel">Sin permisos.</section>';
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
        subdomain_prefix: '',
        type: 'Pago',
        cobranded: true,
        payment_evaluation_url: '',
        payment_treatment_url: '',
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
          Prefijo de subdominio
          <input
            name="subdomain_prefix"
            value="${escapeHtml(item.subdomain_prefix || '')}"
            placeholder="ypf"
            maxlength="63"
            pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
            autocapitalize="none"
            spellcheck="false"
            required
          />
          <span class="field-help">La agenda quedará en https://prefijo.reku.io/turnos/</span>
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
        <div class="form-actions span-two">
          <button type="submit" class="primary-button">Guardar acuerdo</button>
        </div>
      </div>
    `;
  }

  function renderAgreements() {
    const agreements = filteredAgreements();
    return `
      <section class="panel">
        <div class="toolbar compact-filter-toolbar">
          <div class="toolbar-actions compact-filter-actions">
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
          </div>
          <div class="toolbar-actions toolbar-end-actions">
            ${can('agreements.write') ? '<button type="button" class="primary-button" data-action="new-agreement">Nuevo</button>' : ''}
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Slug</th>
                <th>Subdominio</th>
                <th>Tipo</th>
                <th>Cobranded</th>
                <th>Archivos</th>
                <th>Altas</th>
                <th>Profesionales</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${agreements.length ? agreements.map(renderAgreementRow).join('') : '<tr><td colspan="9">No hay acuerdos para esos filtros.</td></tr>'}
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
        <td>
          ${agreement.subdomain_prefix
            ? `<a href="${escapeHtml(agreementPublicUrl(agreement))}" target="_blank" rel="noreferrer">${escapeHtml(agreement.subdomain_prefix)}.reku.io</a>`
            : 'Sin prefijo'}
        </td>
        <td><span class="pill">${escapeHtml(agreement.type)}</span></td>
        <td>${agreement.cobranded ? 'Sí' : 'No'}</td>
        <td>
          ${agreement.logo_url ? `<a href="${escapeHtml(agreement.logo_url)}" target="_blank" rel="noreferrer">Logo</a>` : 'Sin logo'}
          ·
          ${agreement.pdf_url ? `<a href="${escapeHtml(agreement.pdf_url)}" target="_blank" rel="noreferrer">PDF</a>` : 'Sin PDF'}
        </td>
        <td>${agreement.intake_count || 0}</td>
        <td>
          ${Number(agreement.professional_count || 0) > 0
            ? `<span class="agreement-professional-count">${Number(agreement.professional_count)} asignado${Number(agreement.professional_count) === 1 ? '' : 's'}</span>`
            : '<span class="agreement-professional-warning" title="Los pacientes de este acuerdo no podrán reservar hasta asignar un profesional.">⚠ Sin profesionales</span>'}
        </td>
        <td>
          <div class="table-actions">
            <button type="button" class="secondary-button" data-action="copy-url" data-slug="${escapeHtml(agreement.slug)}" data-prefix="${escapeHtml(agreement.subdomain_prefix || '')}">Get URL</button>
            ${agreement.api_available && can('agreements.write')
              ? `<button type="button" class="secondary-button" data-action="manage-agreement-api" data-id="${agreement.id}">API${Number(agreement.active_api_credentials || 0) ? ` (${Number(agreement.active_api_credentials)})` : ''}</button>`
              : ''}
            <a
              class="secondary-button"
              href="/api/admin/agreements/${agreement.id}/qr"
              download="reku-agenda-${escapeHtml(agreement.slug)}-qr.png"
            >
              Get QR
            </a>
            ${
              can('agreements.write')
                ? `
                  <button type="button" class="secondary-button" data-action="edit-agreement" data-id="${agreement.id}">Editar</button>
                `
                : ''
            }
            ${
              can('agreements.delete')
                ? `<button type="button" class="danger-button" data-action="delete-agreement" data-id="${agreement.id}">Eliminar</button>`
                : ''
            }
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

  function filteredPatients() {
    const term = state.patientTextFilter.trim().toLowerCase();
    if (!term) return state.patients;
    return state.patients.filter((item) =>
      [
        item.full_name,
        item.telefono,
        item.email,
        item.identificador,
        item.agreement_name,
      ]
        .join(' ')
        .toLowerCase()
        .includes(term),
    );
  }

  function contactOrganizationOptions() {
    return [
      ...new Set(
        state.contacts
          .map((contact) => String(contact.organizacion || '').trim())
          .filter(Boolean),
      ),
    ]
      .sort((a, b) => a.localeCompare(b, 'es'))
      .map(
        (organizacion) =>
          `<option value="${escapeHtml(organizacion)}">${escapeHtml(organizacion)}</option>`,
      )
      .join('');
  }

  function filteredContacts() {
    const contactTerm = state.contactTextFilter.trim().toLowerCase();
    const organization = state.contactOrganizationFilter;
    return state.contacts.filter((item) => {
      const matchesContact =
        !contactTerm ||
        [item.nombre, item.apellido, item.email, item.telefono]
          .join(' ')
          .toLowerCase()
          .includes(contactTerm);
      const matchesOrganization = !organization || item.organizacion === organization;
      return matchesContact && matchesOrganization;
    });
  }

  function filteredCongressRegistrations() {
    const term = state.congressTextFilter.trim().toLowerCase();
    if (!term) return state.congressRegistrations;
    return state.congressRegistrations.filter((item) =>
      [
        item.nombre_apellido,
        item.email,
        item.telefono,
        item.profesion,
        ...(item.ambitos || []),
        item.interes_telerehabilitacion,
        item.interes_tecnologia,
        item.comentario,
      ]
        .join(' ')
        .toLowerCase()
        .includes(term),
    );
  }

  function renderPatients() {
    const items = filteredPatients();
    return `
      <section class="panel">
        <div class="toolbar compact-filter-toolbar total-right-toolbar">
          <div class="toolbar-actions compact-filter-actions">
            <label>
              Filtrar por acuerdo
              <select id="patient-agreement-filter">
                ${renderAgreementOptions()}
              </select>
            </label>
            <label class="wide-filter">
              Buscar
              <input
                id="patient-text-filter"
                type="search"
                value="${escapeHtml(state.patientTextFilter)}"
                placeholder="Paciente, teléfono, mail o identificador"
              />
            </label>
          </div>
          <span class="toolbar-count">Total: ${items.length}</span>
        </div>
        <div class="table-wrap">
          <table class="centered-table">
            <thead>
              <tr>
                <th>Última actividad</th>
                <th>Acuerdos</th>
                <th>Paciente</th>
                <th>Teléfono</th>
                <th>Mail</th>
                <th>Identificador</th>
                <th>Altas / turnos</th>
                <th>Estado última alta</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${items.length ? items.map(renderPatientRow).join('') : '<tr><td colspan="9">No hay pacientes registrados.</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderPatientRow(item) {
    return `
      <tr>
        <td>${escapeHtml(formatDate(item.last_activity_at || item.created_at))}</td>
        <td>${escapeHtml(item.agreement_name || 'Genérico')}</td>
        <td><strong>${escapeHtml(item.full_name || `${item.nombre} ${item.apellido}`.trim())}</strong></td>
        <td>${escapeHtml(item.telefono)}</td>
        <td>${escapeHtml(item.email)}</td>
        <td>${escapeHtml(item.identificador)}</td>
        <td>${escapeHtml(item.intake_count)} / ${escapeHtml(item.appointment_count)}</td>
        <td>
          ${
            item.intake_count === 0
              ? 'Sin alta registrada'
              : item.verification_email_error
              ? `<span class="muted">Error al verificar: ${escapeHtml(item.verification_email_error)}</span>`
              : item.verification_email_message_id
                ? 'Verificación enviada'
                : item.email_error
                  ? `<span class="muted">${escapeHtml(item.email_error)}</span>`
                  : 'Pendiente'
          }
        </td>
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
    const websiteActive = state.contactTab === 'website';
    return `
      <section class="panel">
        <div class="record-tabs" role="tablist" aria-label="Origen de los contactos">
          <button
            type="button"
            class="record-tab${websiteActive ? ' active' : ''}"
            role="tab"
            aria-selected="${websiteActive}"
            aria-controls="website-contacts-panel"
            data-action="set-contact-tab"
            data-tab="website"
          >
            Sitio web <span>${state.contacts.length}</span>
          </button>
          <button
            type="button"
            class="record-tab${websiteActive ? '' : ' active'}"
            role="tab"
            aria-selected="${!websiteActive}"
            aria-controls="congress-contacts-panel"
            data-action="set-contact-tab"
            data-tab="congress"
          >
            Congreso COKIBA <span>${state.congressRegistrations.length}</span>
          </button>
        </div>
        ${websiteActive ? renderWebsiteContacts() : renderCongressContacts()}
      </section>
    `;
  }

  function renderWebsiteContacts() {
    const items = filteredContacts();
    return `
      <div class="record-tab-panel" id="website-contacts-panel" role="tabpanel">
        <div class="toolbar compact-filter-toolbar total-right-toolbar">
          <div class="toolbar-actions compact-filter-actions">
            <label class="wide-filter">
              Contacto
              <input
                id="contact-text-filter"
                type="search"
                value="${escapeHtml(state.contactTextFilter)}"
                placeholder="Nombre, mail o teléfono"
              />
            </label>
            <label>
              Organización
              <select id="contact-organization-filter">
                <option value="">Todas</option>
                ${contactOrganizationOptions()}
              </select>
            </label>
          </div>
          <span class="toolbar-count">Total: ${items.length}</span>
        </div>
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
              ${items.length ? items.map(renderContactRow).join('') : '<tr><td colspan="8">No hay contactos registrados.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
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
          <div class="table-actions">
            <button
              type="button"
              class="danger-button"
              data-action="delete-contact"
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

  function renderCongressAnswer(value) {
    const answers = Array.isArray(value)
      ? value.filter(Boolean)
      : String(value || '').trim()
        ? [String(value).trim()]
        : [];
    if (!answers.length) return '<span class="muted">Sin respuesta</span>';
    return answers
      .map((answer) => `<span class="answer-line">${escapeHtml(answer)}</span>`)
      .join('');
  }

  function renderCongressContacts() {
    const items = filteredCongressRegistrations();
    return `
      <div class="record-tab-panel" id="congress-contacts-panel" role="tabpanel">
        <div class="toolbar compact-filter-toolbar total-right-toolbar">
          <div class="toolbar-actions compact-filter-actions">
            <label class="wide-filter">
              Buscar
              <input
                id="congress-text-filter"
                type="search"
                value="${escapeHtml(state.congressTextFilter)}"
                placeholder="Nombre, contacto, profesión o respuesta"
              />
            </label>
          </div>
          <div class="toolbar-actions toolbar-end-actions">
            <a
              class="secondary-button"
              href="/api/admin/congress-registrations.csv"
              download="reku-contactos-congreso-cokiba.csv"
            >
              Descargar CSV
            </a>
            <span class="toolbar-count">Total: ${items.length}</span>
          </div>
        </div>
        <div class="table-wrap">
          <table class="congress-contacts-table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Nombre y apellido</th>
                <th>Contacto</th>
                <th>Profesión</th>
                <th>Ámbitos</th>
                <th>Red de telerehabilitación</th>
                <th>Tecnología</th>
                <th>Comentario</th>
                <th>Estado envío</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${items.length ? items.map(renderCongressContactRow).join('') : '<tr><td colspan="10">No hay registros del Congreso COKIBA.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderCongressContactRow(item) {
    return `
      <tr>
        <td>${escapeHtml(formatDate(item.created_at))}</td>
        <td><strong>${escapeHtml(item.nombre_apellido)}</strong></td>
        <td class="contact-details-cell">
          <a href="mailto:${escapeHtml(item.email)}">${escapeHtml(item.email)}</a>
          <span>${escapeHtml(item.telefono)}</span>
        </td>
        <td>${escapeHtml(item.profesion)}</td>
        <td class="answer-cell">${renderCongressAnswer(item.ambitos)}</td>
        <td class="answer-cell">${renderCongressAnswer(item.interes_telerehabilitacion)}</td>
        <td class="answer-cell">${renderCongressAnswer(item.interes_tecnologia)}</td>
        <td class="answer-cell">${renderCongressAnswer(item.comentario)}</td>
        <td>
          ${
            item.email_error
              ? `<span class="muted">Error: ${escapeHtml(item.email_error)}</span>`
              : item.email_message_id
                ? '<span class="pill">Enviado</span>'
                : '<span class="muted">Pendiente</span>'
          }
        </td>
        <td>
          <div class="table-actions">
            <button
              type="button"
              class="danger-button"
              data-action="delete-congress-registration"
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
        <div class="toolbar compact-filter-toolbar">
          <div class="toolbar-actions compact-filter-actions">
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
          </div>
          <div class="toolbar-actions toolbar-end-actions">
            ${
              can('nomina.write')
                ? `
                  <button type="button" class="secondary-button" data-action="open-nomina-csv">Subir CSV</button>
                  <button type="button" class="primary-button" data-action="new-nomina">Agregar</button>
                `
                : ''
            }
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
        <td>
          <div class="table-actions">
            ${
              can('nomina.delete')
                ? `<button type="button" class="danger-button" data-action="delete-nomina" data-id="${item.id}">Eliminar</button>`
                : '<span class="muted">Solo lectura</span>'
            }
          </div>
        </td>
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
    document.querySelectorAll('[data-module]').forEach((link) => {
      link.addEventListener('click', (event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        if (link.dataset.module === 'appointments' && link.dataset.appointmentPaymentFilter) {
          state.appointmentStatusFilter = '';
          state.appointmentPaymentFilter = link.dataset.appointmentPaymentFilter;
          state.appointmentProfessionalFilter = '';
          state.appointmentPatientFilter = '';
        }
        const search = link instanceof HTMLAnchorElement ? link.search : '';
        navigateToModule(link.dataset.module, { search }).catch((error) => {
          setStatus(error.message, 'error');
        });
      });
    });

    bindActionElements();

    document.getElementById('agreement-form')?.addEventListener('submit', handleAgreementSubmit);
    document
      .getElementById('agreement-api-credential-form')
      ?.addEventListener('submit', handleAgreementApiCredentialSubmit);
    document.getElementById('nomina-form')?.addEventListener('submit', handleNominaSubmit);
    document.getElementById('nomina-csv-form')?.addEventListener('submit', handleNominaCsvSubmit);
    document.getElementById('service-form')?.addEventListener('submit', handleServiceSubmit);
    document.getElementById('professional-form')?.addEventListener('submit', handleProfessionalSubmit);
    document.getElementById('professional-invite-form')?.addEventListener('submit', handleProfessionalInviteSubmit);
    document.getElementById('schedule-block-form')?.addEventListener('submit', handleScheduleBlockSubmit);
    document.getElementById('appointment-edit-form')?.addEventListener('submit', handleAppointmentEditSubmit);
    document.getElementById('appointment-cancel-form')?.addEventListener('submit', handleAppointmentCancelSubmit);
    document.getElementById('mercado-pago-form')?.addEventListener('submit', handleMercadoPagoSubmit);
    document.getElementById('user-form')?.addEventListener('submit', handleUserSubmit);
    document
      .getElementById('change-password-form')
      ?.addEventListener('submit', handleChangePasswordSubmit);

    const appointmentEditProfessional = document.getElementById('appointment-edit-professional');
    appointmentEditProfessional?.addEventListener('change', async () => {
      if (state.dialog?.type !== 'appointment-edit') return;
      state.dialog.professionalId = Number(appointmentEditProfessional.value);
      state.dialog.startTime = '';
      await loadAppointmentEditSlots();
    });
    const appointmentEditDate = document.getElementById('appointment-edit-date');
    appointmentEditDate?.addEventListener('change', async () => {
      if (state.dialog?.type !== 'appointment-edit') return;
      state.dialog.appointmentDate = appointmentEditDate.value;
      state.dialog.startTime = '';
      await loadAppointmentEditSlots();
    });
    const appointmentEditSlot = document.getElementById('appointment-edit-slot');
    appointmentEditSlot?.addEventListener('change', () => {
      if (state.dialog?.type === 'appointment-edit') {
        state.dialog.startTime = appointmentEditSlot.value;
      }
    });

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

    const agreementSubdomainInput = document.querySelector(
      '#agreement-form input[name="subdomain_prefix"]',
    );
    agreementSubdomainInput?.addEventListener('input', () => {
      agreementSubdomainInput.value = agreementSubdomainInput.value.toLowerCase();
    });

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

    const contactTextFilter = document.getElementById('contact-text-filter');
    if (contactTextFilter) {
      contactTextFilter.value = state.contactTextFilter;
      contactTextFilter.addEventListener('input', () => {
        state.contactTextFilter = contactTextFilter.value;
        render();
        const nextInput = document.getElementById('contact-text-filter');
        nextInput?.focus();
        nextInput?.setSelectionRange(state.contactTextFilter.length, state.contactTextFilter.length);
      });
    }

    const contactOrganizationFilter = document.getElementById('contact-organization-filter');
    if (contactOrganizationFilter) {
      contactOrganizationFilter.value = state.contactOrganizationFilter;
      contactOrganizationFilter.addEventListener('change', () => {
        state.contactOrganizationFilter = contactOrganizationFilter.value;
        render();
      });
    }

    const congressTextFilter = document.getElementById('congress-text-filter');
    if (congressTextFilter) {
      congressTextFilter.value = state.congressTextFilter;
      congressTextFilter.addEventListener('input', () => {
        state.congressTextFilter = congressTextFilter.value;
        render();
        const nextInput = document.getElementById('congress-text-filter');
        nextInput?.focus();
        nextInput?.setSelectionRange(
          state.congressTextFilter.length,
          state.congressTextFilter.length,
        );
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

    const appointmentStatusFilter = document.getElementById('appointment-status-filter');
    if (appointmentStatusFilter) {
      appointmentStatusFilter.value = state.appointmentStatusFilter;
      appointmentStatusFilter.addEventListener('change', () => {
        state.appointmentStatusFilter = appointmentStatusFilter.value;
        render();
      });
    }

    const appointmentPaymentFilter = document.getElementById('appointment-payment-filter');
    if (appointmentPaymentFilter) {
      appointmentPaymentFilter.value = state.appointmentPaymentFilter;
      appointmentPaymentFilter.addEventListener('change', () => {
        state.appointmentPaymentFilter = appointmentPaymentFilter.value;
        syncAppointmentPaymentSearch();
        render();
      });
    }

    const appointmentProfessionalFilter = document.getElementById(
      'appointment-professional-filter',
    );
    if (appointmentProfessionalFilter) {
      appointmentProfessionalFilter.value = state.appointmentProfessionalFilter;
      appointmentProfessionalFilter.addEventListener('change', () => {
        state.appointmentProfessionalFilter = appointmentProfessionalFilter.value;
        render();
      });
    }

    const appointmentPatientFilter = document.getElementById('appointment-patient-filter');
    if (appointmentPatientFilter) {
      appointmentPatientFilter.value = state.appointmentPatientFilter;
      appointmentPatientFilter.addEventListener('input', () => {
        state.appointmentPatientFilter = appointmentPatientFilter.value;
        render();
        const nextInput = document.getElementById('appointment-patient-filter');
        nextInput?.focus();
        nextInput?.setSelectionRange(
          state.appointmentPatientFilter.length,
          state.appointmentPatientFilter.length,
        );
      });
    }

    const settlementAgreementFilter = document.getElementById('settlement-agreement-filter');
    if (settlementAgreementFilter) {
      settlementAgreementFilter.value = state.settlementAgreementId;
      settlementAgreementFilter.addEventListener('change', async () => {
        state.settlementAgreementId = settlementAgreementFilter.value;
        state.settlementLoading = true;
        render();
        try {
          await loadSettlementPreview();
        } catch (error) {
          setStatus(error.message, 'error');
        }
        render();
      });
    }

    const settlementMonthFilter = document.getElementById('settlement-month-filter');
    if (settlementMonthFilter) {
      settlementMonthFilter.value = state.settlementMonth;
      settlementMonthFilter.addEventListener('change', async () => {
        state.settlementMonth = settlementMonthFilter.value;
        state.settlementLoading = true;
        render();
        try {
          await loadSettlementPreview();
        } catch (error) {
          setStatus(error.message, 'error');
        }
        render();
      });
    }

    const scheduleBlockDateFilter = document.getElementById('schedule-block-date-filter');
    if (scheduleBlockDateFilter) {
      scheduleBlockDateFilter.value = state.scheduleBlockDateFilter;
      scheduleBlockDateFilter.addEventListener('change', () => {
        state.scheduleBlockDateFilter = scheduleBlockDateFilter.value;
        render();
      });
    }

    const scheduleBlockProfessionalFilter = document.getElementById(
      'schedule-block-professional-filter',
    );
    if (scheduleBlockProfessionalFilter) {
      scheduleBlockProfessionalFilter.value = state.scheduleBlockProfessionalFilter;
      scheduleBlockProfessionalFilter.addEventListener('change', () => {
        state.scheduleBlockProfessionalFilter = scheduleBlockProfessionalFilter.value;
        render();
      });
    }

    const testBookingAgreement = document.getElementById('test-booking-agreement');
    if (testBookingAgreement) {
      testBookingAgreement.value = state.testBookingAgreementId;
      testBookingAgreement.addEventListener('change', () => {
        state.testBookingAgreementId = testBookingAgreement.value;
        state.testBookingUrl = '';
        render();
      });
    }
  }

  async function handleActionClick(event) {
    const action = event.currentTarget.dataset.action;
    const id = Number(event.currentTarget.dataset.id || 0);
    const slug = event.currentTarget.dataset.slug || '';
    const prefix = event.currentTarget.dataset.prefix || '';
    const tab = event.currentTarget.dataset.tab || '';

    try {
      if (action === 'toggle-user-menu') {
        state.userMenuOpen = !state.userMenuOpen;
        render();
        return;
      }
      if (action === 'refresh') {
        state.userMenuOpen = false;
        await loadData();
        if (state.active === 'settlements') await loadSettlementPreview();
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
      if (action === 'open-users') {
        await navigateToModule('users');
        return;
      }
      if (action === 'open-config') {
        await navigateToModule('config');
        return;
      }
      if (action === 'open-audit') {
        await navigateToModule('audit');
        return;
      }
      if (action === 'set-contact-tab') {
        state.contactTab = tab === 'congress' ? 'congress' : 'website';
        syncContactTabSearch();
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
        if (state.dialog?.type === 'appointment-edit') {
          state.appointmentEditSlots = [];
          state.appointmentEditError = '';
        }
        state.dialog = null;
        render();
        return;
      }
      if (action === 'view-appointment') {
        state.dialog = { type: 'appointment-view', id };
        render();
        return;
      }
      if (action === 'edit-appointment') {
        await openAppointmentEdit(id);
        return;
      }
      if (action === 'cancel-appointment') {
        openAppointmentCancel(id);
        return;
      }
      if (action === 'copy-field') {
        const value = event.currentTarget.dataset.copy || '';
        if (value) {
          await navigator.clipboard.writeText(value);
          setStatus('Dato copiado.', 'ok');
        }
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
      if (action === 'copy-url') {
        const url = agreementPublicUrl({ slug, subdomain_prefix: prefix });
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
      if (action === 'manage-agreement-api') {
        await openAgreementApiCredentials(id);
        return;
      }
      if (action === 'revoke-agreement-api') {
        state.dialog = {
          type: 'agreement-api-revoke-confirm',
          agreementId: Number(event.currentTarget.dataset.agreementId),
          credentialId: id,
        };
        render();
        return;
      }
      if (action === 'confirm-revoke-agreement-api') {
        const { agreementId, credentialId } = state.dialog || {};
        await api(`/api/admin/agreements/${agreementId}/api-credentials/${credentialId}/revoke`, {
          method: 'POST',
        });
        await loadData();
        await openAgreementApiCredentials(agreementId);
        setStatus('Credencial revocada.', 'ok');
        return;
      }
      if (action === 'generate-settlement') {
        await generateSettlementPdf();
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
        state.dialog = { type: 'professional-create-choice' };
        render();
        return;
      }
      if (action === 'create-professional-manual') {
        state.editingProfessionalId = null;
        state.dialog = { type: 'professional-form' };
        render();
        return;
      }
      if (action === 'invite-professional') {
        state.editingProfessionalId = null;
        state.dialog = { type: 'professional-invite-form' };
        render();
        return;
      }
      if (action === 'invite-existing-professional') {
        const result = await api(`/api/admin/professionals/${id}/invite`, { method: 'POST' });
        await loadData();
        setStatus(
          result.invitation_sent
            ? 'Invitación enviada.'
            : 'La invitación quedó creada, pero el mail no pudo enviarse. Podés reintentarlo.',
          result.invitation_sent ? 'ok' : 'error',
        );
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
      if (action === 'new-user') {
        state.dialog = { type: 'user-form' };
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
        if (!state.testBookingAgreementId) {
          setStatus('Seleccioná un acuerdo para probar la agenda.', 'error');
          return;
        }
        const agreement = state.agreements.find(
          (item) => String(item.id) === String(state.testBookingAgreementId),
        );
        state.testBookingUrl = agreement ? agreementPublicUrl(agreement) : '';
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
      if (action === 'revoke-professional-access') {
        state.dialog = {
          type: 'confirm-delete',
          target: 'professional-access',
          id,
          title: 'Revocar',
          message:
            'Todos los links y sesiones vigentes de este profesional dejarán de funcionar.',
          confirmLabel: 'Revocar',
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
          title: 'Eliminar paciente',
          message: 'El paciente se ocultará del listado. Sus turnos e historial se conservan.',
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
      if (action === 'delete-congress-registration') {
        state.dialog = {
          type: 'confirm-delete',
          target: 'congress-registration',
          id,
          title: 'Eliminar contacto de COKIBA',
          message: 'Esta acción elimina el registro de contacto de COKIBA.',
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
      if (action === 'delete-user') {
        const targetUser = state.users.find((item) => Number(item.id) === id);
        state.dialog = {
          type: 'confirm-delete',
          target: 'user',
          id,
          title: 'Eliminar usuario',
          message: `El usuario ${targetUser?.email || ''} dejará de poder ingresar.`,
        };
        render();
      }
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function loadMercadoPagoSettings() {
    if (!can('settings.read')) return;
    const payload = await api('/api/admin/settings/mercado-pago');
    state.mercadoPagoSettings = payload.settings || {};
  }

  async function loadAuditEvents() {
    if (!can('audit.read')) return;
    const payload = await apiAll('/api/admin/audit', 'audit_events');
    state.auditEvents = payload.audit_events || [];
  }

  async function loadSettlementPreview() {
    if (!can('settlements.read')) return;
    const eligibleAgreements = state.agreements.filter((agreement) => agreement.type === 'Pago');
    if (!eligibleAgreements.some((agreement) => String(agreement.id) === String(state.settlementAgreementId))) {
      state.settlementAgreementId = eligibleAgreements[0] ? String(eligibleAgreements[0].id) : '';
    }
    if (!state.settlementAgreementId || !state.settlementMonth) {
      state.settlement = null;
      return;
    }
    state.settlementLoading = true;
    try {
      const params = new URLSearchParams({
        agreement_id: state.settlementAgreementId,
        month: state.settlementMonth,
      });
      const payload = await api(`/api/admin/settlements/preview?${params.toString()}`);
      state.settlement = payload.settlement || null;
    } finally {
      state.settlementLoading = false;
    }
  }

  async function generateSettlementPdf() {
    if (!state.settlementAgreementId || !state.settlementMonth) return;
    const payload = await api('/api/admin/settlements', {
      method: 'POST',
      body: {
        agreement_id: state.settlementAgreementId,
        month: state.settlementMonth,
      },
    });
    await loadSettlementPreview();
    const pdfUrl = payload.settlement?.pdf_url;
    if (pdfUrl) {
      const link = document.createElement('a');
      link.href = pdfUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.click();
    }
    setStatus('Liquidación generada. El PDF se abrió en una nueva pestaña.', 'ok');
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

  async function loadAppointmentEditSlots() {
    const appointment = selectedAppointment();
    const dialog = state.dialog;
    if (!appointment || dialog?.type !== 'appointment-edit') return;
    state.appointmentEditLoading = true;
    state.appointmentEditError = '';
    render();
    try {
      const params = new URLSearchParams({
        professional_id: String(dialog.professionalId),
        date: dialog.appointmentDate,
      });
      const payload = await api(
        `/api/admin/appointments/${appointment.id}/slots?${params.toString()}`,
      );
      state.appointmentEditSlots = payload.slots || [];
      if (!state.appointmentEditSlots.includes(dialog.startTime)) {
        dialog.startTime = state.appointmentEditSlots[0] || '';
      }
    } catch (error) {
      state.appointmentEditSlots = [];
      state.appointmentEditError = error.message;
    } finally {
      state.appointmentEditLoading = false;
      render();
    }
  }

  async function openAppointmentEdit(appointmentId) {
    const appointment = state.appointments.find((item) => item.id === appointmentId);
    if (!appointment || !canManageAppointment(appointment)) return;
    state.appointmentEditSlots = [];
    state.appointmentEditError = '';
    state.dialog = {
      type: 'appointment-edit',
      id: appointmentId,
      professionalId: appointment.professional_id,
      appointmentDate: appointment.appointment_date,
      startTime: appointment.start_time,
    };
    render();
    await loadAppointmentEditSlots();
  }

  function openAppointmentCancel(appointmentId) {
    const appointment = state.appointments.find((item) => item.id === appointmentId);
    if (!appointment || !canManageAppointment(appointment)) return;
    state.dialog = { type: 'appointment-cancel', id: appointmentId };
    render();
  }

  async function handleAppointmentEditSubmit(event) {
    event.preventDefault();
    const appointment = selectedAppointment();
    if (!appointment) return;
    const form = event.currentTarget;
    try {
      const result = await api(`/api/admin/appointments/${appointment.id}`, {
        method: 'PUT',
        body: {
          professional_id: form.professional_id.value,
          appointment_date: form.appointment_date.value,
          start_time: form.start_time.value,
        },
      });
      state.dialog = null;
      state.appointmentEditSlots = [];
      await loadData();
      const warning = (result.warnings || []).join(' ');
      setStatus(
        warning ? `${result.message} ${warning}` : result.message || 'Turno actualizado.',
        warning ? 'error' : 'ok',
      );
    } catch (error) {
      state.appointmentEditError = error.message;
      render();
    }
  }

  async function handleAppointmentCancelSubmit(event) {
    event.preventDefault();
    const appointment = selectedAppointment();
    if (!appointment) return;
    const form = event.currentTarget;
    try {
      const result = await api(`/api/admin/appointments/${appointment.id}/cancel`, {
        method: 'POST',
        body: { reason: form.reason.value },
      });
      state.dialog = null;
      await loadData();
      setStatus(
        result.refund_status === 'failed' && result.refund_error
          ? `${result.message} ${result.refund_error}`
          : result.message || 'Turno cancelado.',
        result.refund_status === 'failed' ? 'error' : 'ok',
      );
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function handleServiceSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    data.set('active', form.active.checked ? 'true' : 'false');
    data.set('remove_image', form.remove_image?.checked ? 'true' : 'false');

    const path = state.editingServiceId
      ? `/api/admin/services/${state.editingServiceId}`
      : '/api/admin/services';
    const method = state.editingServiceId ? 'PUT' : 'POST';

    try {
      await api(path, { method, body: data });
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
    data.set(
      'agreement_ids',
      JSON.stringify(Array.from(form.querySelectorAll('input[name="agreement_ids"]:checked')).map((input) => input.value)),
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

  async function handleProfessionalInviteSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const result = await api('/api/admin/professionals/invite', {
        method: 'POST',
        body: { name: form.name.value, email: form.email.value },
      });
      state.dialog = null;
      await loadData();
      setStatus(
        result.invitation_sent
          ? 'Profesional creado e invitación enviada.'
          : 'El profesional quedó creado, pero el mail no pudo enviarse. Podés reintentarlo desde el ícono de mail.',
        result.invitation_sent ? 'ok' : 'error',
      );
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

  async function handleUserSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api('/api/admin/users', {
        method: 'POST',
        body: {
          name: form.name.value,
          email: form.email.value,
          password: form.password.value,
          role: state.user.can_manage_system ? form.role.value : 'user',
        },
      });
      state.dialog = null;
      await loadData();
      setStatus('Usuario creado.', 'ok');
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

  async function openAgreementApiCredentials(agreementId, { revealedToken = '' } = {}) {
    const payload = await api(`/api/admin/agreements/${agreementId}/api-credentials`);
    state.agreementApiCredentials = payload.credentials || [];
    state.dialog = {
      type: 'agreement-api',
      agreementId: Number(agreementId),
      revealedToken,
    };
    render();
  }

  async function handleAgreementApiCredentialSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const agreementId = Number(form.agreement_id.value);
    try {
      const payload = await api(`/api/admin/agreements/${agreementId}/api-credentials`, {
        method: 'POST',
        body: { name: form.name.value },
      });
      await loadData();
      await openAgreementApiCredentials(agreementId, { revealedToken: payload.token || '' });
      setStatus('Token generado. Copialo antes de cerrar esta ventana.', 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
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
      patient: `/api/admin/patients/${id}`,
      contact: `/api/admin/contacts/${id}`,
      'congress-registration': `/api/admin/congress-registrations/${id}`,
      nomina: `/api/admin/nomina/${id}`,
      service: `/api/admin/services/${id}`,
      professional: `/api/admin/professionals/${id}`,
      'professional-access': `/api/admin/professionals/${id}/revoke-access`,
      'schedule-block': `/api/admin/schedule-blocks/${id}`,
      user: `/api/admin/users/${id}`,
    };
    const labels = {
      agreement: 'Acuerdo eliminado.',
      patient: 'Paciente eliminado.',
      contact: 'Contacto eliminado.',
      'congress-registration': 'Contacto de COKIBA eliminado.',
      nomina: 'Registro eliminado.',
      service: 'Servicio eliminado.',
      professional: 'Profesional eliminado.',
      'professional-access': 'Accesos del profesional revocados.',
      'schedule-block': 'Bloqueo eliminado.',
      user: 'Usuario eliminado.',
    };

    try {
      await api(paths[target], {
        method: target === 'professional-access' ? 'POST' : 'DELETE',
      });
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

  window.addEventListener('popstate', () => {
    navigateToModule(moduleFromPath(), { replace: true, search: window.location.search }).catch((error) => {
      setStatus(error.message, 'error');
    });
  });

  loadSession();
})();
