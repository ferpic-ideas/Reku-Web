(() => {
  const app = document.getElementById('professional-app');
  const queryToken = new URLSearchParams(window.location.search).get('token') || '';
  const hashToken = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token') || '';
  const token = hashToken || queryToken;
  const meetEarlyMinutes = 20;
  let meetRefreshTimer = null;
  const state = {
    loading: true,
    error: '',
    professional: null,
    expiresAt: '',
    appointments: [],
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
    const [year, month, day] = String(value).split('-');
    return `${day}/${month}/${year}`;
  };

  const formatLongDate = (value) => {
    if (!value) return '';
    const [year, month, day] = String(value).split('-').map(Number);
    return new Intl.DateTimeFormat('es-AR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(new Date(year, month - 1, day, 12));
  };

  const appointmentTime = (appointment, field) => {
    const value = new Date(`${appointment.date}T${appointment[field]}:00-03:00`).getTime();
    return Number.isFinite(value) ? value : null;
  };

  const meetAvailable = (appointment) => {
    if (!appointment.google_meet_url) return false;
    const startsAt = appointmentTime(appointment, 'start_time');
    const endsAt = appointmentTime(appointment, 'end_time');
    if (startsAt === null || endsAt === null) return false;
    const now = Date.now();
    return now >= startsAt - meetEarlyMinutes * 60 * 1000 && now <= endsAt;
  };

  function scheduleMeetRefresh() {
    if (meetRefreshTimer !== null) window.clearTimeout(meetRefreshTimer);
    meetRefreshTimer = null;
    const now = Date.now();
    const nextTransition = state.appointments
      .flatMap((appointment) => {
        if (!appointment.google_meet_url) return [];
        const startsAt = appointmentTime(appointment, 'start_time');
        const endsAt = appointmentTime(appointment, 'end_time');
        if (startsAt === null || endsAt === null) return [];
        return [startsAt - meetEarlyMinutes * 60 * 1000, endsAt + 1000];
      })
      .filter((timestamp) => timestamp > now)
      .sort((a, b) => a - b)[0];
    if (!nextTransition) return;
    meetRefreshTimer = window.setTimeout(render, Math.min(nextTransition - now, 2_147_000_000));
  }

  const groupAppointments = () =>
    state.appointments.reduce((groups, appointment) => {
      if (!groups.has(appointment.date)) groups.set(appointment.date, []);
      groups.get(appointment.date).push(appointment);
      return groups;
    }, new Map());

  async function api(path, options = {}) {
    const response = await fetch(path, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'No se pudieron cargar los turnos.');
    return payload;
  }

  async function loadAppointments() {
    try {
      if (token) {
        await api('/api/professional/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        window.history.replaceState({}, '', '/profesional-turnos/');
      }
      const payload = await api(
        '/api/professional/appointments',
      );
      state.professional = payload.professional;
      state.expiresAt = payload.expires_at;
      state.appointments = payload.appointments || [];
    } catch (error) {
      state.error = error.message;
    } finally {
      state.loading = false;
      render();
    }
  }

  function renderHeader() {
    return `
      <header class="page-header">
        <img src="/images/logo-reku.svg" alt="Reku" />
        <div>
          <span>Próximos turnos</span>
          <h1>${escapeHtml(state.professional?.name || 'Profesional')}</h1>
        </div>
      </header>
    `;
  }

  function renderAppointment(appointment) {
    return `
      <article class="appointment-row">
        <time>${escapeHtml(appointment.start_time)} - ${escapeHtml(appointment.end_time)}</time>
        <div class="appointment-main">
          <strong>${escapeHtml(appointment.patient_name || 'Paciente')}</strong>
          <span>${escapeHtml(appointment.service_name)}</span>
          ${appointment.agreement_name ? `<span class="appointment-agreement">Acuerdo: ${escapeHtml(appointment.agreement_name)}</span>` : ''}
          ${meetAvailable(appointment) ? `<a class="meet-button" href="${escapeHtml(appointment.google_meet_url)}" target="_blank" rel="noopener noreferrer">Acceder a Google Meet</a>` : ''}
        </div>
        <div class="appointment-contact">
          ${appointment.patient_phone ? `<a href="tel:${escapeHtml(appointment.patient_phone)}">${escapeHtml(appointment.patient_phone)}</a>` : ''}
          ${appointment.patient_email ? `<a href="mailto:${escapeHtml(appointment.patient_email)}">${escapeHtml(appointment.patient_email)}</a>` : ''}
        </div>
      </article>
    `;
  }

  function renderAppointments() {
    const groups = groupAppointments();
    if (!groups.size) {
      return '<section class="empty-state">No hay turnos próximos confirmados.</section>';
    }

    return Array.from(groups.entries())
      .map(
        ([date, appointments]) => `
          <section class="day-group">
            <div class="day-title">
              <h2>${escapeHtml(formatLongDate(date))}</h2>
              <span>${escapeHtml(formatDate(date))}</span>
            </div>
            <div class="appointment-list">
              ${appointments.map(renderAppointment).join('')}
            </div>
          </section>
        `,
      )
      .join('');
  }

  function render() {
    if (state.loading) {
      app.innerHTML = '<section class="empty-state">Cargando...</section>';
      return;
    }

    if (state.error) {
      app.innerHTML = `
        <header class="page-header">
          <img src="/images/logo-reku.svg" alt="Reku" />
        </header>
        <section class="error-state">${escapeHtml(state.error)}</section>
      `;
      return;
    }

    app.innerHTML = `
      ${renderHeader()}
      ${renderAppointments()}
    `;
    scheduleMeetRefresh();
  }

  loadAppointments();
})();
