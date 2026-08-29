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
    ['profile', 'Mi perfil'],
  ];
  const appointmentsPollIntervalMs = 5 * 60 * 1000;
  const initialQuery = new URLSearchParams(window.location.search);
  const requestedModule = initialQuery.get('module');
  const requestedAppointmentId = Number(initialQuery.get('appointment')) || null;
  const requestedRoom = initialQuery.get('room') === '1' || initialQuery.get('waiting') === '1';
  const initialAuthFragment = new URLSearchParams(String(window.location.hash || '').slice(1));
  const initialInvitationToken = initialAuthFragment.get('invite') || '';
  const initialPasswordResetToken = initialAuthFragment.get('reset-password') || '';
  let appointmentsPollTimer = null;
  let appointmentsRefreshPromise = null;
  let meetWindowTimer = null;
  let waitingCounterTimer = null;
  const state = {
    loading: true,
    user: null,
    profile: null,
    services: [],
    active: modules.some(([key]) => key === requestedModule) ? requestedModule : 'overview',
    csrf: '',
    appointments: [],
    appointmentsRefreshing: false,
    appointmentSearch: '',
    patients: [],
    availability: [],
    blocks: [],
    blocksModalOpen: false,
    blocksMessage: '',
    blocksMessageType: '',
    google: { available: false, connected: false, status: 'not_configured' },
    push: {
      configured: false,
      public_key: '',
      active_devices: 0,
      active_mobile_devices: 0,
      devices: [],
      supported: false,
      permission: 'default',
      current_device_active: false,
      current_endpoint: '',
      show_install_guide: false,
      busy: false,
      message: '',
      message_type: '',
    },
    patientSearch: '',
    selectedPatientId: null,
    selectedAppointmentId: requestedAppointmentId,
    consultationRoomOpen: requestedRoom,
    waitingAppointmentId: initialQuery.get('waiting') === '1' ? requestedAppointmentId : null,
    copiedBookingUrlAppointmentId: null,
    pushActivationRequested: initialQuery.get('activar-notificaciones') === '1',
    patientDetailMessage: '',
    patientDetailMessageType: '',
    sendingTriageReminderId: null,
    invitationToken: initialInvitationToken,
    passwordResetToken: initialPasswordResetToken,
    authView: initialPasswordResetToken ? 'reset-password' : 'login',
    passwordResetRequested: false,
    authSubmitting: false,
    status: '',
    statusType: '',
    actionModal: null,
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

  const formatDateTime = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('es-AR', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: 'America/Argentina/Buenos_Aires',
    }).format(date);
  };

  const normalizeSearchText = (value) =>
    String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();

  const appointmentTime = (appointment, field) => {
    const value = new Date(`${appointment.date}T${appointment[field]}:00-03:00`).getTime();
    return Number.isFinite(value) ? value : null;
  };

  const formatWaitingDelay = (startsAt) => {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startsAt) / 1000));
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = String(elapsedSeconds % 60).padStart(2, '0');
    return `Demora del profesional: ${minutes}:${seconds}`;
  };

  function syncWaitingCounter() {
    if (waitingCounterTimer !== null) {
      window.clearInterval(waitingCounterTimer);
      waitingCounterTimer = null;
    }
    const counter = document.querySelector?.('[data-waiting-counter]');
    if (!counter) return;
    const startsAt = Number(counter.dataset.startsAt);
    if (!Number.isFinite(startsAt)) return;
    const update = () => {
      counter.textContent = formatWaitingDelay(startsAt);
    };
    update();
    waitingCounterTimer = window.setInterval(update, 1000);
  }

  const isFutureAppointment = (appointment) => {
    const startsAt = appointmentTime(appointment, 'start_time');
    return startsAt !== null && startsAt > Date.now();
  };

  function meetAccess(appointment) {
    if (appointment.status !== 'confirmed' || !appointment.google_meet_url) {
      return { visible: false, available: false };
    }
    const startsAt = appointmentTime(appointment, 'start_time');
    const endsAt = appointmentTime(appointment, 'end_time');
    if (startsAt === null || endsAt === null) return { visible: false, available: false };
    const availableFrom = startsAt - 20 * 60 * 1000;
    const now = Date.now();
    if (now > endsAt) return { visible: false, available: false };
    return {
      visible: true,
      available: now >= availableFrom,
      availableFrom,
    };
  }

  const eyeIcon = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"></path>
      <circle cx="12" cy="12" r="2.6"></circle>
    </svg>
  `;

  const copyIcon = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="8" y="8" width="11" height="11" rx="2"></rect>
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path>
    </svg>
  `;

  const isConsultationService = (value) =>
    /\b(consulta|evaluacion|valoracion)\b/.test(normalizeSearchText(value));

  const consultationRoomUrl = (appointment) =>
    `/profesional/?module=appointments&appointment=${encodeURIComponent(appointment.id)}&room=1`;

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
    const controller = new AbortController();
    const timeoutMs = Number(options.timeoutMs) || (options.body instanceof FormData ? 60_000 : 20_000);
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
    if (state.csrf && !['GET', 'HEAD'].includes(method)) {
      headers['X-CSRF-Token'] = state.csrf;
    }
    const request = {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    };
    if (options.body instanceof FormData) {
      request.body = options.body;
    } else if (options.body) {
      headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(options.body);
    }
    try {
      const response = await fetch(path, request);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload.error || 'No se pudo completar la acción.');
        error.status = response.status;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error.name === 'AbortError') {
        const timeoutError = new Error('La conexión tardó demasiado. Probá nuevamente.');
        timeoutError.status = 408;
        throw timeoutError;
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function setStatus(message, type = '') {
    state.status = message;
    state.statusType = type;
    render();
  }

  async function loadData() {
    const results = await Promise.allSettled([
      api('/api/professional/profile'),
      api('/api/professional/availability'),
      api('/api/professional/blocks'),
      api('/api/professional/patients'),
      api('/api/professional/appointments'),
      api('/api/professional/integrations/google'),
      api('/api/professional/notifications/push'),
    ]);
    const expiredSession = results.find(
      (result) => result.status === 'rejected' && result.reason?.status === 401,
    );
    if (expiredSession) throw expiredSession.reason;

    const [profile, availability, blocks, patients, appointments, google, push] = results.map(
      (result) => (result.status === 'fulfilled' ? result.value : null),
    );
    if (profile) {
      state.profile = profile.profile;
      state.services = profile.services || [];
    }
    if (availability) state.availability = availability.availability || [];
    if (blocks) state.blocks = blocks.schedule_blocks || [];
    if (patients) state.patients = patients.patients || [];
    if (appointments) state.appointments = appointments.appointments || [];
    if (google) state.google = google.google || state.google;
    if (push) state.push = { ...state.push, ...(push.push || {}) };

    if (results.some((result) => result.status === 'rejected')) {
      state.status =
        'Ingresaste correctamente, pero algunos datos no pudieron actualizarse. Podés seguir usando el portal y reintentar recargando.';
      state.statusType = 'error';
    }
    void refreshPushDeviceState().then(() => {
      if (state.user) render();
    });
  }

  const isIosDevice = () =>
    typeof navigator !== 'undefined' &&
    (/iphone|ipad|ipod/i.test(navigator.userAgent || '') ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
  const isMobileDevice = () =>
    isIosDevice() ||
    (typeof navigator !== 'undefined' && /android|mobile/i.test(navigator.userAgent || ''));
  const isStandaloneApp = () =>
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator?.standalone === true;

  const pushSupported = () =>
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  const waitWithTimeout = (promise, timeoutMs, message) => {
    let timeoutId;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]).finally(() => window.clearTimeout(timeoutId));
  };

  async function ensurePushServiceWorker() {
    if (!pushSupported()) return null;
    const registration = await navigator.serviceWorker.register(
      '/profesional/service-worker.js',
      { scope: '/profesional/' },
    );
    await waitWithTimeout(
      navigator.serviceWorker.ready,
      8_000,
      'No pudimos inicializar las notificaciones en este dispositivo.',
    );
    return registration;
  }

  async function refreshPushDeviceState() {
    state.push.supported = pushSupported();
    state.push.permission = 'Notification' in window ? Notification.permission : 'unsupported';
    state.push.current_device_active = false;
    state.push.current_endpoint = '';
    if (!state.push.configured || !state.push.supported) return;
    try {
      const registration = await ensurePushServiceWorker();
      const subscription = await registration?.pushManager.getSubscription();
      state.push.current_endpoint = subscription?.endpoint || '';
      if (subscription && state.push.permission !== 'granted' && state.csrf) {
        const payload = await api('/api/professional/notifications/push/subscriptions', {
          method: 'DELETE',
          body: { endpoint: subscription.endpoint },
        });
        state.push = { ...state.push, ...(payload.push || {}) };
        return;
      }
      if (subscription && state.csrf) {
        const status = await api(
          '/api/professional/notifications/push/subscriptions/check',
          { method: 'POST', body: { endpoint: subscription.endpoint } },
        );
        state.push.current_device_active = Boolean(status.active);
      }
    } catch {
      state.push.current_device_active = false;
    }
  }

  function stopAppointmentsPolling() {
    if (appointmentsPollTimer === null) return;
    window.clearTimeout(appointmentsPollTimer);
    appointmentsPollTimer = null;
  }

  function shouldPollAppointments() {
    return Boolean(
      state.user &&
        state.active === 'appointments' &&
        document.visibilityState !== 'hidden',
    );
  }

  function syncAppointmentsPolling() {
    if (!shouldPollAppointments()) {
      stopAppointmentsPolling();
      return;
    }
    if (appointmentsPollTimer !== null) return;
    appointmentsPollTimer = window.setTimeout(async () => {
      appointmentsPollTimer = null;
      if (shouldPollAppointments()) await refreshAppointments();
      syncAppointmentsPolling();
    }, appointmentsPollIntervalMs);
  }

  function syncMeetWindowRefresh() {
    if (meetWindowTimer !== null) {
      window.clearTimeout(meetWindowTimer);
      meetWindowTimer = null;
    }
    if (!state.user || !['overview', 'appointments'].includes(state.active)) return;
    const now = Date.now();
    const transitions = state.appointments.flatMap((appointment) => {
      if (appointment.status !== 'confirmed' || !appointment.google_meet_url) return [];
      const startsAt = appointmentTime(appointment, 'start_time');
      const endsAt = appointmentTime(appointment, 'end_time');
      if (startsAt === null || endsAt === null || endsAt < now) return [];
      const availableFrom = startsAt - 20 * 60 * 1000;
      return [availableFrom > now ? availableFrom : endsAt + 1];
    });
    if (!transitions.length) return;
    const nextTransition = Math.min(...transitions);
    meetWindowTimer = window.setTimeout(() => {
      meetWindowTimer = null;
      render();
    }, Math.max(0, nextTransition - now));
  }

  async function refreshAppointments({ showError = false } = {}) {
    if (!state.user) return;
    if (appointmentsRefreshPromise) return appointmentsRefreshPromise;

    state.appointmentsRefreshing = true;
    if (state.active === 'appointments') render();
    appointmentsRefreshPromise = (async () => {
      try {
        const payload = await api('/api/professional/appointments');
        state.appointments = payload.appointments || [];
      } catch (error) {
        if (error.status === 401) {
          state.user = null;
          state.csrf = '';
          state.status = 'Tu sesión venció. Volvé a ingresar.';
          state.statusType = 'error';
          stopAppointmentsPolling();
        } else if (showError) {
          state.status = error.message;
          state.statusType = 'error';
        }
      } finally {
        state.appointmentsRefreshing = false;
        appointmentsRefreshPromise = null;
        if (!state.user || state.active === 'appointments') render();
      }
    })();
    return appointmentsRefreshPromise;
  }

  async function activateModule(moduleId) {
    state.active = moduleId;
    state.status = '';
    render();
    if (moduleId === 'appointments') {
      await refreshAppointments({ showError: true });
    }
  }

  async function loadSession() {
    let authenticated = false;
    try {
      const payload = await api('/api/professional/auth/me');
      authenticated = true;
      state.user = payload.user;
      state.profile = payload.professional;
      state.csrf = payload.csrf_token;
      state.loading = false;
      render();
      await loadData();
    } catch (error) {
      if (!authenticated || error.status === 401) {
        state.user = null;
        state.csrf = '';
      }
      if (error.status !== 401) {
        state.status = error.message || 'No se pudo cargar el portal. Probá nuevamente.';
        state.statusType = 'error';
      }
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
            <button class="primary-button" type="submit" ${state.authSubmitting ? 'disabled' : ''}>
              ${state.authSubmitting ? 'Ingresando…' : 'Entrar al portal'}
            </button>
            <button class="auth-link" type="button" data-auth-view="forgot-password">Olvidé mi contraseña</button>
            <div class="portal-legal-links" aria-label="Información legal">
              <a href="/privacidad/">Privacidad</a>
              <a href="/terminos/">Términos</a>
            </div>
            ${renderStatus()}
          </form>
        </section>
      </main>
    `;
    document.getElementById('login-form').addEventListener('submit', handleLogin);
    document.querySelector('[data-auth-view="forgot-password"]')?.addEventListener('click', () => {
      state.authView = 'forgot-password';
      state.passwordResetRequested = false;
      state.status = '';
      state.statusType = '';
      render();
    });
  }

  function renderForgotPassword() {
    app.className = '';
    app.innerHTML = `
      <main class="login-shell">
        <section class="login-story">
          <img src="/images/logo-reku.svg" alt="Reku" />
          <div>
            <h1>Volvé a tu práctica con seguridad.</h1>
            <p>Te enviaremos un enlace de un solo uso para que recuperes el acceso.</p>
          </div>
        </section>
        <section class="login-panel">
          <form id="forgot-password-form" class="login-form form-stack">
            <div>
              <h2>Recuperar contraseña</h2>
              <p>Ingresá el email de tu cuenta profesional. El enlace será válido por 30 minutos.</p>
            </div>
            ${state.passwordResetRequested ? '' : `
              <label>
                Email
                <input name="email" type="email" autocomplete="email" maxlength="320" required />
              </label>
              <button class="primary-button" type="submit">Enviar enlace</button>
            `}
            <button class="auth-link" type="button" data-auth-view="login">Volver al ingreso</button>
            <div class="portal-legal-links" aria-label="Información legal">
              <a href="/privacidad/">Privacidad</a>
              <a href="/terminos/">Términos</a>
            </div>
            ${renderStatus()}
          </form>
        </section>
      </main>
    `;
    document.getElementById('forgot-password-form').addEventListener('submit', handlePasswordResetRequest);
    document.querySelector('[data-auth-view="login"]')?.addEventListener('click', () => {
      state.authView = 'login';
      state.passwordResetRequested = false;
      state.status = '';
      state.statusType = '';
      render();
    });
  }

  function renderPasswordReset() {
    app.className = '';
    app.innerHTML = `
      <main class="login-shell">
        <section class="login-story">
          <img src="/images/logo-reku.svg" alt="Reku" />
          <div>
            <h1>Protegé tu cuenta.</h1>
            <p>Elegí una nueva contraseña. Al guardarla, cerraremos las demás sesiones abiertas.</p>
          </div>
        </section>
        <section class="login-panel">
          <form id="password-reset-form" class="login-form form-stack">
            <div>
              <h2>Crear nueva contraseña</h2>
              <p>Usá una contraseña distinta a la anterior.</p>
            </div>
            <label>
              Nueva contraseña
              <input name="password" type="password" minlength="8" maxlength="128" autocomplete="new-password" required />
              <span class="field-help">Entre 8 y 128 caracteres.</span>
            </label>
            <label>
              Repetir contraseña
              <input name="password_confirmation" type="password" minlength="8" maxlength="128" autocomplete="new-password" required />
            </label>
            <button class="primary-button" type="submit">Actualizar contraseña</button>
            <div class="portal-legal-links" aria-label="Información legal">
              <a href="/privacidad/">Privacidad</a>
              <a href="/terminos/">Términos</a>
            </div>
            ${renderStatus()}
          </form>
        </section>
      </main>
    `;
    document.getElementById('password-reset-form').addEventListener('submit', handlePasswordReset);
  }

  function renderInvitation() {
    app.className = '';
    app.innerHTML = `
      <main class="login-shell">
        <section class="login-story">
          <img src="/images/logo-reku.svg" alt="Reku" />
          <div>
            <h1>Tu espacio profesional empieza acá.</h1>
            <p>Activá tu cuenta y después completá tus prácticas, horarios y conexión con Google Calendar.</p>
          </div>
        </section>
        <section class="login-panel">
          <form id="invitation-form" class="login-form form-stack">
            <div>
              <h2>Activar cuenta</h2>
              <p>Elegí la contraseña que vas a usar para ingresar al portal.</p>
            </div>
            <label>
              Contraseña
              <input name="password" type="password" minlength="8" autocomplete="new-password" required />
              <span class="field-help">Mínimo 8 caracteres.</span>
            </label>
            <label>
              Repetir contraseña
              <input name="password_confirmation" type="password" minlength="8" autocomplete="new-password" required />
            </label>
            <button class="primary-button" type="submit">Activar y entrar</button>
            <div class="portal-legal-links" aria-label="Información legal">
              <a href="/privacidad/">Privacidad</a>
              <a href="/terminos/">Términos</a>
            </div>
            ${renderStatus()}
          </form>
        </section>
      </main>
    `;
    document.getElementById('invitation-form').addEventListener('submit', handleInvitation);
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
          <div class="sidebar-legal-links">
            <a href="/privacidad/">Privacidad</a>
            <a href="/terminos/">Términos</a>
          </div>
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

  function renderMeetAccess(appointment) {
    const access = meetAccess(appointment);
    if (!access.visible) return '';
    if (access.available) {
      return `<a class="consultation-room-entry" href="${escapeHtml(consultationRoomUrl(appointment))}" target="_blank" rel="noopener noreferrer">Abrir sala</a><small class="meet-availability">Ficha del paciente + Meet</small>`;
    }
    const availableFrom = new Intl.DateTimeFormat('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(access.availableFrom));
    return `<span class="meet-link-disabled" title="Se habilita 20 minutos antes">Abrir sala</span><small class="meet-availability">Disponible desde las ${escapeHtml(availableFrom)}</small>`;
  }

  function renderAppointmentActions(item) {
    const canCancel = item.status === 'confirmed' && isFutureAppointment(item);
    return `
      <div class="appointment-actions">
        <button class="appointment-icon-button" data-action="appointment-patient-details" data-id="${item.id}" type="button" aria-label="Ver información del paciente" title="Ver información del paciente">
          ${eyeIcon}
        </button>
        ${
          canCancel
            ? `<button class="appointment-icon-button danger" data-action="cancel-appointment" data-id="${item.id}" type="button" aria-label="Cancelar turno" title="Cancelar turno">×</button>`
            : ''
        }
        ${
          item.status === 'cancelled' && item.refund_status === 'failed'
            ? `<button class="secondary-button compact-button" data-action="retry-refund" data-id="${item.id}" data-reason="${escapeHtml(item.cancellation_reason || 'Cancelado por el profesional')}" type="button">Reintentar devolución</button>`
            : ''
        }
      </div>
    `;
  }

  function renderGoogleIntegration() {
    const google = state.google || {};
    const googleDescription = !google.available
      ? 'Reku debe cargar las credenciales de la aplicación de Google antes de habilitar esta conexión.'
      : google.needs_meet_reauthorization
        ? `Tu calendario${google.google_email ? ` (${google.google_email})` : ''} sigue conectado, pero necesitamos una autorización adicional para detectar cuándo se abrió la videollamada y habilitar el ingreso del paciente.`
      : google.connected
        ? `Calendario principal conectado${google.google_email ? ` con ${google.google_email}` : ''}. Los nuevos turnos generan una sala de Meet y bloquean ese horario.`
        : google.status === 'error'
          ? 'La autorización venció o fue revocada. Volvé a conectar Google para validar tu agenda.'
          : 'Autorizá el calendario principal de tu cuenta personal. Reku sólo solicita acceso a eventos propios y disponibilidad.';
    const googleAction = !google.available
      ? '<span class="badge">Configuración pendiente</span>'
      : google.needs_meet_reauthorization
        ? '<button id="google-connect-button" class="primary-button" type="button">Habilitar sala de espera</button>'
      : google.connected
        ? '<button id="google-disconnect-button" class="secondary-button" type="button">Desconectar</button>'
        : '<button id="google-connect-button" class="primary-button" type="button">Conectar Google Calendar</button>';
    return `
      <section class="panel">
        <div class="integration-card">
          <div>
            <h2>Google Calendar y Meet</h2>
            <p class="muted">${escapeHtml(googleDescription)}</p>
            ${
              google.available
                ? `<div class="google-data-notice">
                    <strong>Cómo usa Reku tu información de Google</strong>
                    <p>Al conectar tu cuenta, Reku consulta los bloques libre/ocupado de tu calendario principal, puede crear, actualizar o eliminar eventos de turnos con Google Meet e invitación al paciente, y verifica si la sala del turno está activa para habilitar el ingreso. No consulta la identidad de los participantes, audio, video, chat ni transcripciones. Guarda el email de la cuenta, identificadores de conexión y tokens cifrados. Los datos obtenidos de Google no se venden ni se usan para publicidad u otras finalidades ajenas a gestionar la agenda y la videollamada. Podés revocar el acceso desde este panel.</p>
                    <a href="/privacidad/#google">Ver Política de Privacidad</a>
                  </div>`
                : ''
            }
          </div>
          ${googleAction}
        </div>
      </section>
    `;
  }

  function renderPushIntegration({ attention = false } = {}) {
    const push = state.push || {};
    if (!push.configured && !push.active_devices) return '';
    const mobile = isMobileDevice();
    const iosNeedsInstall = mobile && isIosDevice() && !isStandaloneApp();
    const permissionDenied = push.permission === 'denied';
    const needsPhone = Number(push.active_mobile_devices || 0) === 0;
    const devices = push.devices || [];
    let description = 'Recibí un aviso inmediato cuando un paciente esté esperando para entrar a la videollamada.';
    if (push.current_device_active) {
      description = 'Las notificaciones están activas en este dispositivo.';
    } else if (!push.supported && mobile) {
      description = 'Este navegador no admite notificaciones Web Push. Probá con Safari actualizado en iPhone o Chrome en Android.';
    } else if (permissionDenied) {
      description = 'Las notificaciones están bloqueadas en este dispositivo. Habilitalas desde la configuración del sitio o del teléfono y volvé a intentar.';
    }
    return `
      <section class="panel push-panel ${attention ? 'push-panel-attention' : ''}" id="push-notifications-panel">
        <div class="integration-card">
          <div>
            <span class="eyebrow">Avisos importantes</span>
            <h2>Notificaciones en el teléfono</h2>
            <p class="muted">${escapeHtml(description)}</p>
            ${needsPhone ? '<p class="push-warning">Falta activar al menos un teléfono para no perder avisos de pacientes en espera.</p>' : '<p class="push-success">Ya hay un teléfono activo.</p>'}
          </div>
          <div class="push-primary-actions">
            ${
              mobile && !push.current_device_active && push.supported && !permissionDenied
                ? `<button id="push-enable-button" class="primary-button" type="button" ${push.busy ? 'disabled' : ''}>${iosNeedsInstall ? 'Ver cómo activarlas' : 'Activar en este teléfono'}</button>`
                : ''
            }
            ${
              !mobile || !push.current_device_active
                ? `<button id="push-activation-email-button" class="secondary-button" type="button" ${push.busy ? 'disabled' : ''}>Enviarme el link al celular</button>`
                : ''
            }
            ${push.current_device_active ? `<button id="push-test-button" class="primary-button" type="button" ${push.busy ? 'disabled' : ''}>Enviar prueba</button>` : ''}
            ${push.current_device_active ? `<button id="push-disable-current-button" class="secondary-button" type="button" ${push.busy ? 'disabled' : ''}>Desactivar en este dispositivo</button>` : ''}
          </div>
        </div>
        ${
          (push.show_install_guide || iosNeedsInstall) && mobile && isIosDevice()
            ? `<div class="push-install-guide">
                <strong>Activación en iPhone</strong>
                <ol>
                  <li>Abrí esta página en Safari.</li>
                  <li>Tocá Compartir y luego “Agregar a inicio”.</li>
                  <li>Abrí Reku desde el ícono nuevo de la pantalla de inicio.</li>
                  <li>Volvé a tocar “Activar en este teléfono” y aceptá el permiso.</li>
                </ol>
              </div>`
            : ''
        }
        ${push.message ? `<div class="status-message ${escapeHtml(push.message_type)}">${escapeHtml(push.message)}</div>` : ''}
        ${
          devices.length
            ? `<div class="push-devices">
                <strong>Dispositivos activos</strong>
                ${devices.map((device) => `
                  <div class="push-device-row">
                    <div><span>${escapeHtml(device.label)}</span><small>${device.kind === 'mobile' ? 'Teléfono' : 'Computadora'} · última actividad ${escapeHtml(formatDateTime(device.last_success_at || device.last_seen_at))}</small></div>
                    <button class="link-button push-device-remove" data-action="remove-push-device" data-id="${device.id}" type="button" ${push.busy ? 'disabled' : ''}>Quitar</button>
                  </div>
                `).join('')}
              </div>`
            : ''
        }
      </section>
    `;
  }

  function renderOverview() {
    const upcoming = upcomingAppointments();
    return `
      ${pageHeader(`Hola, ${state.profile?.name || 'Profesional'}`, 'Este es el estado actual de tu agenda.')}
      <section class="grid-cards">
        <button class="card metric-card metric-card-appointments" data-module="appointments" type="button" aria-label="Ver próximos turnos">
          <span>Próximos turnos</span><strong>${upcoming.length}</strong>
        </button>
        <button class="card metric-card metric-card-patients" data-module="patients" type="button" aria-label="Ver pacientes disponibles">
          <span>Pacientes disponibles</span><strong>${state.patients.length}</strong>
        </button>
        <button class="card metric-card metric-card-blocks" data-module="availability" type="button" aria-label="Ver bloqueos y horarios">
          <span>Bloqueos próximos</span><strong>${state.blocks.length}</strong>
        </button>
      </section>
      ${state.google?.connected ? '' : renderGoogleIntegration()}
      ${state.push?.configured && (Number(state.push.active_mobile_devices || 0) === 0 || state.pushActivationRequested) ? renderPushIntegration({ attention: true }) : ''}
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
                    <td>
                      ${escapeHtml(item.patient_name || 'Paciente')}
                      ${item.agreement_name ? `<small class="appointment-agreement">Acuerdo: ${escapeHtml(item.agreement_name)}</small>` : ''}
                    </td>
                    <td>${escapeHtml(item.service_name)}</td>
                    <td>
                      ${item.patient_email ? `<a href="mailto:${escapeHtml(item.patient_email)}">${escapeHtml(item.patient_email)}</a><br />` : ''}
                      ${item.patient_phone ? `<a href="tel:${escapeHtml(item.patient_phone)}">${escapeHtml(item.patient_phone)}</a>` : ''}
                    </td>
                    <td>
                      ${renderMeetAccess(item)}
                      ${
                      item.status === 'confirmed'
                        ? `Confirmado${item.google_sync_status === 'failed' ? ' · Google pendiente' : ''}${item.triage_status === 'failed' ? ' · Cuestionario no disponible' : ''}`
                        : item.status === 'cancelled'
                          ? `Cancelado${item.refund_status === 'approved' ? ' · reembolsado' : item.refund_status === 'failed' ? ' · devolución pendiente' : ''}`
                          : 'Pendiente de pago'
                    }</td>
                    <td>${renderAppointmentActions(item)}</td>
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
    const search = normalizeSearchText(state.appointmentSearch);
    const items = state.appointments
      .filter((item) => !search || normalizeSearchText(item.patient_name).includes(search))
      .sort((a, b) =>
        `${b.date}${b.start_time}`.localeCompare(`${a.date}${a.start_time}`),
      );
    return `
      ${pageHeader('Turnos', 'Próximos e históricos vinculados a tu ficha profesional.')}
      <section class="panel">
        <div class="panel-header">
          <h2>Agenda</h2>
          <div class="appointments-panel-tools">
            <span class="appointments-refresh-status">
              ${state.appointmentsRefreshing ? 'Actualizando…' : 'Actualización automática cada 5 min'}
            </span>
            <form id="appointment-search-form" class="search-form appointment-search-form">
              <input name="q" value="${escapeHtml(state.appointmentSearch)}" placeholder="Buscar por nombre" aria-label="Buscar turno por nombre del paciente" />
              <button class="secondary-button" type="submit">Buscar</button>
            </form>
          </div>
        </div>
        ${
          items.length
            ? renderAppointmentsTable(items)
            : `<div class="empty-state">${search ? 'No encontramos turnos para ese paciente.' : 'No hay turnos para mostrar.'}</div>`
        }
      </section>
    `;
  }

  const paymentStatusLabel = (value) =>
    ({
      approved: 'Pagado',
      paid_simulated: 'Pagado',
      free: 'Sin costo',
      nomina: 'Cubierto por acuerdo',
      pending: 'Pago pendiente',
      in_process: 'Pago en proceso',
      authorized: 'Pago autorizado',
      rejected: 'Pago rechazado',
      cancelled: 'Pago cancelado',
      refunded: 'Reembolsado',
      charged_back: 'Contracargo',
    })[value] || 'Sin información';

  const patientSourceLabel = (patient) => {
    if (patient.source?.name) {
      return `Acuerdo · ${patient.source.name}`;
    }
    if (String(patient.source?.type || '').toLowerCase() === 'nomina') {
      return 'Acuerdo';
    }
    if (patient.source?.type || patient.payment?.status) {
      return `Pago · ${paymentStatusLabel(patient.payment?.status)}`;
    }
    return 'Sin información';
  };

  const triageLabel = (status) =>
    ({
      assigned: 'Enlace enviado',
      failed: 'No disponible',
      pending: 'Pendiente',
      not_applicable: 'Sin próximo turno',
    })[status] || 'Sin información';

  function selectedPatientDetails() {
    if (state.selectedPatientId !== null) {
      return state.patients.find(
        (patient) => Number(patient.id) === Number(state.selectedPatientId),
      );
    }
    if (state.selectedAppointmentId === null) return null;
    const appointment = state.appointments.find(
      (item) => Number(item.id) === Number(state.selectedAppointmentId),
    );
    if (!appointment) return null;
    const patient = state.patients.find(
      (item) =>
        (appointment.patient_id && Number(item.id) === Number(appointment.patient_id)) ||
        (appointment.patient_email &&
          normalizeSearchText(item.email) === normalizeSearchText(appointment.patient_email)),
    );
    const detailAppointment = {
      id: appointment.id,
      date: appointment.date,
      start_time: appointment.start_time,
      end_time: appointment.end_time,
      status: appointment.status,
      agreement_name: appointment.agreement_name || '',
      agreement_type: appointment.agreement_type || '',
      service_name: appointment.service_name || '',
      documents: appointment.documents || [],
      triage_url: appointment.triage_url || '',
      triage_reminder_sent_at: appointment.triage_reminder_sent_at || null,
      google_meet_url: appointment.google_meet_url || '',
      booking_url: appointment.booking_url || '',
    };
    if (patient) {
      return {
        ...patient,
        detail_appointment: detailAppointment,
        practice: appointment.service_name || patient.practice,
        triage_status: appointment.triage_status,
        payment: {
          status: appointment.payment_status || '',
          amount: Number(appointment.amount || 0),
        },
        source: appointment.agreement_name
          ? { type: 'agreement', name: appointment.agreement_name }
          : patient.source,
      };
    }
    const hasUpcomingAppointment =
      appointment.status === 'confirmed' && isFutureAppointment(appointment);
    return {
      id: null,
      name: appointment.patient_name || 'Paciente',
      email: appointment.patient_email || '',
      phone: appointment.patient_phone || '',
      detail_appointment: detailAppointment,
      next_appointment: hasUpcomingAppointment
        ? {
            id: appointment.id,
            date: appointment.date,
            start_time: appointment.start_time,
            end_time: appointment.end_time,
            service_name: appointment.service_name || '',
            documents: appointment.documents || [],
            triage_url: appointment.triage_url || '',
            booking_url: appointment.booking_url || '',
          }
        : null,
      practice: appointment.service_name || '',
      triage_status: hasUpcomingAppointment ? appointment.triage_status : 'not_applicable',
      source: appointment.agreement_name
        ? { type: 'agreement', name: appointment.agreement_name }
        : { type: '', name: '' },
      payment: {
        status: appointment.payment_status || '',
        amount: Number(appointment.amount || 0),
      },
      latest_appointment_date: appointment.date,
    };
  }

  function renderPatientDetails(patient) {
    if (!patient) return '';
    const detailAppointment = patient.detail_appointment || patient.next_appointment;
    const documents = detailAppointment?.documents || [];
    const isAppointmentRoom = Boolean(patient.detail_appointment) && state.consultationRoomOpen;
    const roomMeetAccess = detailAppointment ? meetAccess(detailAppointment) : { visible: false, available: false };
    const triageUrl = detailAppointment?.triage_url || '';
    const bookingUrl = detailAppointment?.booking_url || '';
    const consultationService = detailAppointment?.service_name || patient.practice || '';
    const showTreatmentHandoff = isConsultationService(consultationService) && Boolean(bookingUrl);
    const canRemindTriage =
      patient.triage_status === 'assigned' &&
      detailAppointment?.status !== 'cancelled' &&
      (!patient.detail_appointment || isFutureAppointment(detailAppointment)) &&
      Boolean(detailAppointment?.id);
    const reminderSentAt = detailAppointment?.triage_reminder_sent_at;
    const waitingForThisAppointment =
      Number(state.waitingAppointmentId) === Number(detailAppointment?.id);
    const waitingStartsAt = detailAppointment
      ? appointmentTime(detailAppointment, 'start_time')
      : null;
    return `
      <div class="modal-backdrop" role="presentation">
        <section class="modal-panel ${isAppointmentRoom ? 'consultation-room-panel' : ''}" role="dialog" aria-modal="true" aria-labelledby="patient-details-title">
          <div class="modal-header">
            <div>
              <span class="eyebrow">${isAppointmentRoom ? 'Sala profesional' : 'Paciente'}</span>
              <h2 id="patient-details-title">${escapeHtml(patient.name || 'Sin nombre')}</h2>
              ${isAppointmentRoom ? `<p class="muted">Todo lo necesario para preparar y acompañar esta consulta.</p>` : ''}
            </div>
            <button class="icon-button" data-action="close-patient-details" type="button" aria-label="Cerrar detalles" title="Cerrar">×</button>
          </div>
          ${
            waitingForThisAppointment
              ? `<div class="patient-waiting-alert">
                  <div>
                    <strong>El paciente está esperando</strong>
                    <span class="waiting-delay" data-waiting-counter data-starts-at="${waitingStartsAt}">${formatWaitingDelay(waitingStartsAt)}</span>
                  </div>
                  <span class="waiting-room-ready">Atender ahora</span>
                </div>`
              : ''
          }
          ${
            isAppointmentRoom
              ? `<div class="consultation-room-hero">
                  <div>
                    <span class="consultation-room-kicker">${escapeHtml(formatDate(detailAppointment.date))} · ${escapeHtml(detailAppointment.start_time)}–${escapeHtml(detailAppointment.end_time)}</span>
                    <strong>Preparación de la videollamada</strong>
                    <p>Revisá la ficha y mantené esta pestaña abierta como referencia durante la atención.</p>
                  </div>
                  <div class="consultation-room-actions">
                    ${roomMeetAccess.available
                      ? `<a class="primary-button" href="${escapeHtml(detailAppointment.google_meet_url)}" target="_blank" rel="noopener noreferrer">Entrar a Google Meet</a>`
                      : roomMeetAccess.visible
                        ? '<span class="room-action-disabled">Meet se habilita 20 minutos antes</span>'
                        : '<span class="room-action-disabled">Meet no disponible</span>'}
                    ${triageUrl
                      ? `<a class="secondary-button triage-form-button" href="${escapeHtml(triageUrl)}" target="_blank" rel="noopener noreferrer">Ver Formulario Triage</a>`
                      : '<span class="room-action-disabled">Formulario Triage no disponible</span>'}
                  </div>
                </div>`
              : ''
          }
          <dl class="patient-details-grid">
            <div><dt>Email</dt><dd>${patient.email ? `<a href="mailto:${escapeHtml(patient.email)}">${escapeHtml(patient.email)}</a>` : '—'}</dd></div>
            <div><dt>Teléfono</dt><dd>${patient.phone ? `<a href="tel:${escapeHtml(patient.phone)}">${escapeHtml(patient.phone)}</a>` : '—'}</dd></div>
            <div><dt>${patient.detail_appointment ? 'Turno seleccionado' : 'Próximo turno'}</dt><dd>${detailAppointment ? `${escapeHtml(formatDate(detailAppointment.date))} · ${escapeHtml(detailAppointment.start_time)}–${escapeHtml(detailAppointment.end_time)}` : 'Sin próximo turno'}</dd></div>
            <div><dt>Práctica</dt><dd>${escapeHtml(patient.practice || 'Sin información')}</dd></div>
            <div><dt>Triaje</dt><dd>${escapeHtml(triageLabel(patient.triage_status))}</dd></div>
            <div><dt>Acuerdo / origen</dt><dd>${escapeHtml(patientSourceLabel(patient))}</dd></div>
            <div><dt>Importe</dt><dd>${patient.payment?.amount ? escapeHtml(new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(patient.payment.amount)) : '—'}</dd></div>
            <div><dt>Último turno registrado</dt><dd>${patient.latest_appointment_date ? escapeHtml(formatDate(patient.latest_appointment_date)) : '—'}</dd></div>
          </dl>
          <div class="patient-documents">
            <strong>Documentación ${patient.detail_appointment ? 'del turno' : 'del próximo turno'}</strong>
            ${
              documents.length
                ? `<ul>${documents
                    .map(
                      (document) => `<li><a href="${escapeHtml(document.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(document.name)}</a><span>${document.kind === 'link' ? 'Enlace externo' : 'Archivo adjunto'}</span></li>`,
                    )
                    .join('')}</ul>`
                : '<span>El paciente todavía no compartió documentación.</span>'
            }
          </div>
          ${
            showTreatmentHandoff
              ? `<div class="treatment-handoff-card">
                  <div class="treatment-handoff-copy">
                    <span class="treatment-handoff-label">Después de la consulta</span>
                    <strong>¿El paciente quiere comenzar el tratamiento?</strong>
                    <p>Compartile esta agenda para que ingrese y seleccione el tratamiento que corresponda.</p>
                  </div>
                  <div class="booking-url-box">
                    <a href="${escapeHtml(bookingUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(bookingUrl)}</a>
                    <button class="copy-url-button" data-action="copy-booking-url" data-id="${detailAppointment.id}" data-url="${escapeHtml(bookingUrl)}" type="button" aria-label="Copiar URL de turnos" title="Copiar URL de turnos">
                      ${copyIcon}
                    </button>
                  </div>
                  ${Number(state.copiedBookingUrlAppointmentId) === Number(detailAppointment.id) ? '<span class="copy-success" role="status">URL copiada</span>' : ''}
                </div>`
              : ''
          }
          <div class="details-note">
            <strong>Seguimiento del triaje</strong>
            <span>${triageUrl ? 'El formulario está disponible desde esta ficha. Hasta cerrar la integración con ReHub, se muestra el enlace asignado como si el paciente ya lo hubiera completado.' : 'No hay un formulario disponible para este turno.'}</span>
            ${reminderSentAt ? `<span>Último recordatorio enviado: ${escapeHtml(formatDateTime(reminderSentAt))}.</span>` : ''}
          </div>
          ${state.patientDetailMessage ? `<div class="status-message ${escapeHtml(state.patientDetailMessageType)}">${escapeHtml(state.patientDetailMessage)}</div>` : ''}
          <div class="form-actions patient-detail-actions">
            <button class="secondary-button" data-action="close-patient-details" type="button">Cerrar</button>
            ${canRemindTriage
              ? `<button class="primary-button" data-action="remind-triage" data-id="${detailAppointment.id}" type="button" ${state.sendingTriageReminderId === detailAppointment.id ? 'disabled' : ''}>${state.sendingTriageReminderId === detailAppointment.id ? 'Enviando…' : 'Recordar cuestionario'}</button>`
              : ''}
          </div>
        </section>
      </div>
    `;
  }

  function renderActionModal() {
    const modal = state.actionModal;
    if (!modal) return '';
    const content = {
      'cancel-appointment': {
        eyebrow: 'Turnos',
        title: modal.retry ? 'Reintentar devolución' : 'Cancelar turno',
        message: modal.retry
          ? 'Se volverá a solicitar la devolución correspondiente a este turno cancelado.'
          : 'El paciente recibirá un aviso y, si pagó por Mercado Pago, se solicitará el reembolso total.',
        confirm: modal.retry ? 'Reintentar devolución' : 'Cancelar turno',
        dangerous: true,
      },
      'triage-reminder': {
        eyebrow: 'Paciente',
        title: 'Enviar recordatorio',
        message: '¿Querés enviarle un mail al paciente para recordarle que complete el cuestionario?',
        confirm: 'Enviar recordatorio',
      },
      'delete-block': {
        eyebrow: 'Horarios',
        title: 'Quitar bloqueo',
        message: 'Este horario volverá a quedar disponible según tu configuración habitual.',
        confirm: 'Quitar bloqueo',
        dangerous: true,
      },
      'disconnect-google': {
        eyebrow: 'Google Calendar',
        title: 'Desconectar calendario',
        message: 'Reku dejará de consultar tu disponibilidad y de sincronizar nuevos turnos con esta cuenta.',
        confirm: 'Desconectar',
        dangerous: true,
      },
    }[modal.type];
    if (!content) return '';
    const needsReason = modal.type === 'cancel-appointment' && !modal.retry;
    return `
      <div class="modal-backdrop action-modal-backdrop" data-action="close-action-modal" role="presentation">
        <section class="modal-panel action-modal" role="dialog" aria-modal="true" aria-labelledby="action-modal-title">
          <div class="modal-header">
            <div>
              <span class="eyebrow">${escapeHtml(content.eyebrow)}</span>
              <h2 id="action-modal-title">${escapeHtml(content.title)}</h2>
            </div>
            <button class="icon-button" data-action="close-action-modal" type="button" aria-label="Cerrar" title="Cerrar" ${modal.submitting ? 'disabled' : ''}>×</button>
          </div>
          <p class="action-modal-message">${escapeHtml(content.message)}</p>
          <form id="action-modal-form" class="form-stack">
            ${
              needsReason
                ? `<label>Motivo<textarea name="reason" rows="4" maxlength="500" required placeholder="Contale brevemente al paciente por qué se cancela">${escapeHtml(modal.reason || '')}</textarea></label>`
                : ''
            }
            ${modal.error ? `<div class="status-message error">${escapeHtml(modal.error)}</div>` : ''}
            <div class="form-actions">
              <button class="secondary-button" data-action="close-action-modal" type="button" ${modal.submitting ? 'disabled' : ''}>Volver</button>
              <button class="${content.dangerous ? 'danger-button' : 'primary-button'}" type="submit" ${modal.submitting ? 'disabled' : ''}>${modal.submitting ? 'Procesando…' : escapeHtml(content.confirm)}</button>
            </div>
          </form>
        </section>
      </div>
    `;
  }

  function renderPatients() {
    return `
      ${pageHeader('Pacientes', 'Contacto, próxima atención y situación administrativa de cada paciente.')}
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
                  <thead><tr><th>Paciente</th><th>Contacto</th><th>Próximo turno</th><th>Práctica</th><th>Triaje</th><th>Origen</th><th></th></tr></thead>
                  <tbody>
                    ${state.patients
                      .map(
                        (patient) => `
                          <tr>
                            <td><strong>${escapeHtml(patient.name || 'Sin nombre')}</strong></td>
                            <td>
                              ${patient.email ? `<a href="mailto:${escapeHtml(patient.email)}">${escapeHtml(patient.email)}</a><br />` : ''}
                              ${patient.phone ? `<a href="tel:${escapeHtml(patient.phone)}">${escapeHtml(patient.phone)}</a>` : ''}
                              ${!patient.email && !patient.phone ? '—' : ''}
                            </td>
                            <td>${patient.next_appointment ? `<strong>${escapeHtml(formatDate(patient.next_appointment.date))}</strong><br />${escapeHtml(patient.next_appointment.start_time)}–${escapeHtml(patient.next_appointment.end_time)}` : 'Sin próximo turno'}</td>
                            <td>${escapeHtml(patient.practice || '—')}</td>
                            <td><span class="patient-status ${escapeHtml(patient.triage_status)}">${escapeHtml(triageLabel(patient.triage_status))}</span></td>
                            <td>${escapeHtml(patientSourceLabel(patient))}</td>
                            <td>
                              <button class="appointment-icon-button" data-action="patient-details" data-id="${patient.id}" type="button" aria-label="Ver información del paciente" title="Ver información del paciente">
                                ${eyeIcon}
                              </button>
                            </td>
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
        <button class="icon-button remove-range-button" data-action="remove-range" type="button" aria-label="Quitar horario" title="Quitar horario">−</button>
      </div>
    `;
  }

  function renderAvailability() {
    return `
      ${pageHeader('Horarios', 'Definí tus franjas habituales de atención.')}
      <form id="availability-form" class="panel">
        <div class="panel-header">
          <div>
            <h2>Disponibilidad habitual</h2>
            <p class="muted">Configurá los días y franjas en los que atendés normalmente.</p>
          </div>
          <button class="secondary-button" data-action="open-blocks-modal" type="button">Bloqueos y excepciones</button>
        </div>
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
      ${renderBlocksModal()}
    `;
  }

  function renderBlocksModal() {
    if (!state.blocksModalOpen) return '';
    return `
      <div class="modal-backdrop" role="presentation">
        <section class="modal-panel modal-panel-wide blocks-modal" role="dialog" aria-modal="true" aria-labelledby="blocks-modal-title">
          <div class="modal-header">
            <div>
              <span class="eyebrow">Horarios</span>
              <h2 id="blocks-modal-title">Bloqueos y excepciones</h2>
              <p class="muted">Reservá franjas puntuales en las que no vas a estar disponible.</p>
            </div>
            <button class="icon-button" data-action="close-blocks-modal" type="button" aria-label="Cerrar bloqueos" title="Cerrar">×</button>
          </div>
          ${state.blocksMessage ? `<div class="status-message ${escapeHtml(state.blocksMessageType)}">${escapeHtml(state.blocksMessage)}</div>` : ''}
          <div class="blocks-modal-layout">
            <form id="block-form" class="modal-section form-stack">
              <h3>Nuevo bloqueo</h3>
              <label>Fecha<input name="block_date" type="date" min="${today()}" required /></label>
              <div class="form-grid">
                <label>Desde<input name="start_time" type="time" required /></label>
                <label>Hasta<input name="end_time" type="time" required /></label>
              </div>
              <label>Motivo<textarea name="reason" rows="3" maxlength="300" placeholder="Ej.: capacitación, trámite o licencia"></textarea></label>
              <button class="primary-button" type="submit">Crear bloqueo</button>
            </form>
            <section class="modal-section">
              <div class="panel-header"><h3>Próximos bloqueos</h3></div>
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
                              <button class="danger-button compact-button" data-action="delete-block" data-id="${block.id}" type="button">Quitar</button>
                            </article>
                          `,
                        )
                        .join('')
                    : '<div class="empty-state">No hay bloqueos próximos.</div>'
                }
              </div>
            </section>
          </div>
        </section>
      </div>
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
        <fieldset class="service-selector span-two">
          <legend>Prácticas que atendés</legend>
          <div class="service-options">
            ${state.services.length
              ? state.services.map((service) => `
                  <label class="check-row">
                    <input name="service_ids" type="checkbox" value="${service.id}" ${service.selected ? 'checked' : ''} />
                    ${escapeHtml(service.name)}
                  </label>
                `).join('')
              : '<p class="muted">No hay prácticas disponibles.</p>'}
          </div>
        </fieldset>
        <div class="form-actions span-two"><button class="primary-button" type="submit">Guardar perfil</button></div>
      </form>
      <form id="password-form" class="panel form-grid">
        <div class="span-two"><h2>Cambiar contraseña</h2></div>
        <label>Contraseña actual<input name="current_password" type="password" autocomplete="current-password" required /></label>
        <label>Nueva contraseña<input name="new_password" type="password" minlength="8" autocomplete="new-password" required /></label>
        <div class="form-actions span-two"><button class="secondary-button" type="submit">Actualizar contraseña</button></div>
      </form>
      ${state.google?.connected ? renderGoogleIntegration() : ''}
      ${renderPushIntegration()}
    `;
  }

  function renderContent() {
    if (state.active === 'appointments') return renderAppointments();
    if (state.active === 'patients') return renderPatients();
    if (state.active === 'availability') return renderAvailability();
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
      ${renderPatientDetails(selectedPatientDetails())}
      ${renderActionModal()}
    `;
    bindEvents();
    syncWaitingCounter();
    if (state.pushActivationRequested && state.active === 'overview') {
      window.requestAnimationFrame(() => {
        document.getElementById('push-notifications-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  function render() {
    syncAppointmentsPolling();
    syncMeetWindowRefresh();
    if (state.loading) return;
    if (state.passwordResetToken) renderPasswordReset();
    else if (state.invitationToken) renderInvitation();
    else if (state.authView === 'forgot-password') renderForgotPassword();
    else if (!state.user) renderLogin();
    else renderPortal();
  }

  async function copyBookingUrl(button) {
    const bookingUrl = String(button.dataset.url || '');
    if (!bookingUrl) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(bookingUrl);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = bookingUrl;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        if (!document.execCommand('copy')) throw new Error('COPY_FAILED');
        textarea.remove();
      }
      state.copiedBookingUrlAppointmentId = Number(button.dataset.id);
      state.patientDetailMessage = '';
      render();
    } catch {
      state.patientDetailMessage = 'No pudimos copiar la URL. Podés abrirla y copiarla desde la nueva pestaña.';
      state.patientDetailMessageType = 'error';
      render();
    }
  }

  function bindEvents() {
    app.querySelectorAll('[data-module]').forEach((button) => {
      button.addEventListener('click', () => activateModule(button.dataset.module));
    });
    document.getElementById('logout-button')?.addEventListener('click', handleLogout);
    document.getElementById('profile-form')?.addEventListener('submit', handleProfile);
    document.getElementById('availability-form')?.addEventListener('submit', handleAvailability);
    document.getElementById('block-form')?.addEventListener('submit', handleBlock);
    document.getElementById('password-form')?.addEventListener('submit', handlePassword);
    document.getElementById('patient-search-form')?.addEventListener('submit', handlePatientSearch);
    document
      .getElementById('appointment-search-form')
      ?.addEventListener('submit', handleAppointmentSearch);
    document.getElementById('google-connect-button')?.addEventListener('click', handleGoogleConnect);
    document.getElementById('google-disconnect-button')?.addEventListener('click', () => {
      openActionModal({ type: 'disconnect-google' });
    });
    document.getElementById('push-enable-button')?.addEventListener('click', handlePushEnable);
    document.getElementById('push-test-button')?.addEventListener('click', handlePushTest);
    document
      .getElementById('push-disable-current-button')
      ?.addEventListener('click', handlePushDisableCurrent);
    document
      .getElementById('push-activation-email-button')
      ?.addEventListener('click', handlePushActivationEmail);
    app.querySelectorAll('[data-action="remove-push-device"]').forEach((button) => {
      button.addEventListener('click', () => handlePushRemoveDevice(Number(button.dataset.id)));
    });
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
      button.addEventListener('click', () => {
        openActionModal({ type: 'delete-block', id: button.dataset.id });
      });
    });
    app.querySelectorAll('[data-action="open-blocks-modal"]').forEach((button) => {
      button.addEventListener('click', () => {
        state.blocksModalOpen = true;
        state.blocksMessage = '';
        state.blocksMessageType = '';
        render();
      });
    });
    app.querySelectorAll('[data-action="close-blocks-modal"]').forEach((button) => {
      button.addEventListener('click', () => {
        state.blocksModalOpen = false;
        state.blocksMessage = '';
        state.blocksMessageType = '';
        render();
      });
    });
    app.querySelectorAll('[data-action="cancel-appointment"]').forEach((button) => {
      button.addEventListener('click', () => {
        openActionModal({ type: 'cancel-appointment', id: button.dataset.id, reason: '' });
      });
    });
    app.querySelectorAll('[data-action="retry-refund"]').forEach((button) => {
      button.addEventListener('click', () => {
        openActionModal({
          type: 'cancel-appointment',
          id: button.dataset.id,
          reason: button.dataset.reason,
          retry: true,
        });
      });
    });
    app.querySelectorAll('[data-action="appointment-patient-details"]').forEach((button) => {
      button.addEventListener('click', () => {
        state.selectedAppointmentId = Number(button.dataset.id);
        state.selectedPatientId = null;
        state.consultationRoomOpen = true;
        state.copiedBookingUrlAppointmentId = null;
        state.patientDetailMessage = '';
        state.patientDetailMessageType = '';
        render();
      });
    });
    app.querySelectorAll('[data-action="patient-details"]').forEach((button) => {
      button.addEventListener('click', () => {
        state.selectedPatientId = Number(button.dataset.id);
        state.selectedAppointmentId = null;
        state.waitingAppointmentId = null;
        state.consultationRoomOpen = false;
        state.copiedBookingUrlAppointmentId = null;
        state.patientDetailMessage = '';
        state.patientDetailMessageType = '';
        render();
      });
    });
    app.querySelectorAll('[data-action="close-patient-details"]').forEach((button) => {
      button.addEventListener('click', () => {
        state.selectedPatientId = null;
        state.selectedAppointmentId = null;
        state.waitingAppointmentId = null;
        state.consultationRoomOpen = false;
        state.copiedBookingUrlAppointmentId = null;
        state.patientDetailMessage = '';
        state.patientDetailMessageType = '';
        render();
      });
    });
    app.querySelectorAll('[data-action="remind-triage"]').forEach((button) => {
      button.addEventListener('click', () => {
        openActionModal({ type: 'triage-reminder', id: Number(button.dataset.id) });
      });
    });
    app.querySelectorAll('[data-action="copy-booking-url"]').forEach((button) => {
      button.addEventListener('click', () => copyBookingUrl(button));
    });
    app.querySelectorAll('[data-action="close-action-modal"]').forEach((button) => {
      button.addEventListener('click', (event) => {
        if (
          event.currentTarget.classList?.contains('action-modal-backdrop') &&
          event.target !== event.currentTarget
        ) {
          return;
        }
        closeActionModal();
      });
    });
    document
      .getElementById('action-modal-form')
      ?.addEventListener('submit', handleActionModalSubmit);
  }

  async function handleTriageReminder(appointmentId) {
    state.sendingTriageReminderId = appointmentId;
    state.patientDetailMessage = '';
    render();
    try {
      const result = await api(
        `/api/professional/appointments/${appointmentId}/triage-reminder`,
        { method: 'POST' },
      );
      const patient = state.patients.find(
        (item) => Number(item.next_appointment?.id) === appointmentId,
      );
      if (patient?.next_appointment) {
        patient.next_appointment.triage_reminder_sent_at = result.triage_reminder_sent_at;
        patient.next_appointment.triage_reminder_count = result.triage_reminder_count;
      }
      state.patientDetailMessage = result.message || 'Recordatorio enviado.';
      state.patientDetailMessageType = 'ok';
    } catch (error) {
      state.patientDetailMessage = error.message;
      state.patientDetailMessageType = 'error';
    } finally {
      state.sendingTriageReminderId = null;
      render();
    }
  }

  async function handleInvitation(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.password.value !== form.password_confirmation.value) {
      setStatus('Las contraseñas no coinciden.', 'error');
      return;
    }
    try {
      const payload = await api('/api/professional/invitations/accept', {
        method: 'POST',
        body: { token: state.invitationToken, password: form.password.value },
      });
      state.user = payload.user;
      state.profile = payload.professional;
      state.csrf = payload.csrf_token;
      state.invitationToken = '';
      state.active = 'profile';
      state.status = 'Cuenta activada. Completá tus datos y prácticas para empezar.';
      state.statusType = 'ok';
      window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`);
      await loadData();
      render();
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    if (state.authSubmitting) return;
    const form = event.currentTarget;
    const credentials = { email: form.email.value, password: form.password.value };
    state.authSubmitting = true;
    state.status = '';
    state.statusType = '';
    render();
    try {
      const payload = await api('/api/professional/auth/login', {
        method: 'POST',
        body: credentials,
      });
      state.user = payload.user;
      state.csrf = payload.csrf_token;
      state.status = '';
      state.authSubmitting = false;
      render();
      await loadData();
    } catch (error) {
      if (error.status === 401) {
        state.user = null;
        state.csrf = '';
      }
      state.status = error.message;
      state.statusType = 'error';
    } finally {
      state.authSubmitting = false;
      render();
    }
  }

  async function handlePasswordResetRequest(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const payload = await api('/api/professional/auth/password-reset/request', {
        method: 'POST',
        body: { email: form.email.value },
      });
      state.passwordResetRequested = true;
      setStatus(payload.message, 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function handlePasswordReset(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.password.value !== form.password_confirmation.value) {
      setStatus('Las contraseñas no coinciden.', 'error');
      return;
    }
    try {
      const payload = await api('/api/professional/auth/password-reset', {
        method: 'POST',
        body: {
          token: state.passwordResetToken,
          password: form.password.value,
        },
      });
      state.passwordResetToken = '';
      state.authView = 'login';
      window.history.replaceState(
        {},
        '',
        `${window.location.pathname}${window.location.search}`,
      );
      setStatus(payload.message || 'Contraseña actualizada. Ingresá nuevamente.', 'ok');
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
    data.set(
      'service_ids',
      JSON.stringify(
        Array.from(event.currentTarget.querySelectorAll('input[name="service_ids"]:checked'))
          .map((input) => input.value),
      ),
    );
    data.set('remove_photo', event.currentTarget.remove_photo?.checked ? 'true' : 'false');
    try {
      const payload = await api('/api/professional/profile', { method: 'PUT', body: data });
      state.profile = payload.profile;
      state.services = payload.services || state.services;
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
      state.blocksMessage = 'Bloqueo creado.';
      state.blocksMessageType = 'ok';
      render();
    } catch (error) {
      state.blocksMessage = error.message;
      state.blocksMessageType = 'error';
      render();
    }
  }

  async function handleDeleteBlock(id) {
    try {
      await api(`/api/professional/blocks/${id}`, { method: 'DELETE' });
      state.blocks = (await api('/api/professional/blocks')).schedule_blocks;
      state.blocksMessage = 'Bloqueo eliminado.';
      state.blocksMessageType = 'ok';
      render();
    } catch (error) {
      state.blocksMessage = error.message;
      state.blocksMessageType = 'error';
      render();
    }
  }

  async function handleCancelAppointment(id, reason) {
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

  function handleAppointmentSearch(event) {
    event.preventDefault();
    state.appointmentSearch = event.currentTarget.q.value.trim();
    render();
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
    try {
      await api('/api/professional/integrations/google/disconnect', { method: 'POST' });
      state.google = (await api('/api/professional/integrations/google')).google;
      setStatus('Google Calendar fue desconectado.', 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  const urlBase64ToUint8Array = (base64String) => {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = window.atob(base64);
    return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
  };

  const pushDeviceLabel = () => {
    if (isIosDevice()) return 'iPhone o iPad';
    if (/android/i.test(navigator.userAgent || '')) return 'Teléfono Android';
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    return platform ? `Computadora ${platform}` : 'Computadora';
  };

  const updatePushState = async (push, message, messageType = 'ok') => {
    state.push = { ...state.push, ...(push || {}), message, message_type: messageType };
    await refreshPushDeviceState();
    if (state.push.current_device_active) state.pushActivationRequested = false;
    state.push.busy = false;
    render();
  };

  async function handlePushEnable() {
    if (isIosDevice() && !isStandaloneApp()) {
      state.push.show_install_guide = true;
      state.push.message = 'Primero agregá Reku a la pantalla de inicio siguiendo estos pasos.';
      state.push.message_type = '';
      render();
      return;
    }
    state.push.busy = true;
    state.push.message = '';
    render();
    try {
      const registration = await ensurePushServiceWorker();
      if (!registration) throw new Error('Este navegador no admite notificaciones.');
      const permission = await Notification.requestPermission();
      state.push.permission = permission;
      if (permission !== 'granted') {
        throw new Error(
          permission === 'denied'
            ? 'El permiso quedó bloqueado. Habilitalo desde la configuración del sitio o del teléfono.'
            : 'Necesitamos tu permiso para enviarte avisos.',
        );
      }
      let subscription = await registration.pushManager.getSubscription();
      if (subscription && !state.push.current_device_active) {
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ||= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(state.push.public_key),
      });
      const payload = await api('/api/professional/notifications/push/subscriptions', {
        method: 'POST',
        body: {
          subscription: subscription.toJSON(),
          device_label: pushDeviceLabel(),
          device_kind: isMobileDevice() ? 'mobile' : 'desktop',
        },
      });
      await updatePushState(
        payload.push,
        'Notificaciones activadas. Enviaremos una prueba para confirmarlo.',
      );
      await handlePushTest();
    } catch (error) {
      state.push.busy = false;
      state.push.message = error.message;
      state.push.message_type = 'error';
      render();
    }
  }

  async function handlePushTest() {
    state.push.busy = true;
    state.push.message = '';
    render();
    try {
      const payload = await api('/api/professional/notifications/push/test', {
        method: 'POST',
      });
      await updatePushState(
        payload.push,
        payload.message,
        payload.ok ? 'ok' : 'error',
      );
    } catch (error) {
      state.push.busy = false;
      state.push.message = error.message;
      state.push.message_type = 'error';
      render();
    }
  }

  async function handlePushDisableCurrent() {
    const registration = await ensurePushServiceWorker();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    state.push.busy = true;
    render();
    try {
      const payload = await api('/api/professional/notifications/push/subscriptions', {
        method: 'DELETE',
        body: { endpoint: subscription.endpoint },
      });
      await subscription.unsubscribe();
      await updatePushState(payload.push, 'Notificaciones desactivadas en este dispositivo.');
    } catch (error) {
      state.push.busy = false;
      state.push.message = error.message;
      state.push.message_type = 'error';
      render();
    }
  }

  async function handlePushRemoveDevice(id) {
    state.push.busy = true;
    render();
    try {
      const payload = await api(
        `/api/professional/notifications/push/subscriptions/${id}`,
        { method: 'DELETE' },
      );
      await updatePushState(payload.push, 'Dispositivo quitado.');
    } catch (error) {
      state.push.busy = false;
      state.push.message = error.message;
      state.push.message_type = 'error';
      render();
    }
  }

  async function handlePushActivationEmail() {
    state.push.busy = true;
    state.push.message = '';
    render();
    try {
      const payload = await api('/api/professional/notifications/push/activation-email', {
        method: 'POST',
      });
      state.push.busy = false;
      state.push.message = payload.message;
      state.push.message_type = 'ok';
      render();
    } catch (error) {
      state.push.busy = false;
      state.push.message = error.message;
      state.push.message_type = 'error';
      render();
    }
  }

  function openActionModal(modal) {
    state.actionModal = { ...modal, error: '', submitting: false };
    render();
  }

  function closeActionModal() {
    if (state.actionModal?.submitting) return;
    state.actionModal = null;
    render();
  }

  async function handleActionModalSubmit(event) {
    event.preventDefault();
    const modal = state.actionModal;
    if (!modal || modal.submitting) return;
    const reason =
      modal.type === 'cancel-appointment' && !modal.retry
        ? event.currentTarget.reason.value.trim()
        : modal.reason || '';
    if (modal.type === 'cancel-appointment' && !reason) {
      state.actionModal = { ...modal, reason, error: 'Indicá el motivo de la cancelación.' };
      render();
      return;
    }

    state.actionModal = { ...modal, reason, error: '', submitting: true };
    render();
    try {
      if (modal.type === 'cancel-appointment') {
        await handleCancelAppointment(modal.id, reason);
      } else if (modal.type === 'triage-reminder') {
        await handleTriageReminder(Number(modal.id));
      } else if (modal.type === 'delete-block') {
        await handleDeleteBlock(modal.id);
      } else if (modal.type === 'disconnect-google') {
        await handleGoogleDisconnect();
      }
    } finally {
      state.actionModal = null;
      render();
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
  document.addEventListener?.('visibilitychange', () => {
    syncAppointmentsPolling();
    if (shouldPollAppointments()) refreshAppointments();
  });
  document.addEventListener?.('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (state.actionModal) {
      closeActionModal();
    } else if (state.selectedPatientId !== null || state.selectedAppointmentId !== null) {
      state.selectedPatientId = null;
      state.selectedAppointmentId = null;
      render();
    } else if (state.blocksModalOpen) {
      state.blocksModalOpen = false;
      render();
    }
  });
  if (state.invitationToken || state.passwordResetToken) {
    state.loading = false;
    render();
  } else {
    loadSession();
  }
})();
