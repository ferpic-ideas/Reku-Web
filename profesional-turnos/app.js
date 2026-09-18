(() => {
  const app = document.getElementById('professional-app');
  const queryToken = new URLSearchParams(window.location.search).get('token') || '';
  const requestedAppointmentId = Number(new URLSearchParams(window.location.search).get('appointment')) || null;
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
    copiedAppointmentId: null,
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

  const normalizeSearchText = (value) =>
    String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();

  const isConsultationService = (value) =>
    /\b(consulta|evaluacion|valoracion)\b/.test(normalizeSearchText(value));

  const copyIcon = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="8" y="8" width="11" height="11" rx="2"></rect>
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path>
    </svg>
  `;

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
        const startsAt = appointmentTime(appointment, 'start_time');
        const endsAt = appointmentTime(appointment, 'end_time');
        return [
          ...(appointment.google_meet_url && startsAt !== null ? [startsAt - meetEarlyMinutes * 60 * 1000] : []),
          ...(endsAt !== null ? [endsAt + 1] : []),
        ];
      })
      .filter((timestamp) => timestamp > now)
      .sort((a, b) => a - b)[0];
    if (!nextTransition) return;
    meetRefreshTimer = window.setTimeout(render, Math.min(nextTransition - now, 2_147_000_000));
  }

  const groupAppointments = () =>
    [...state.appointments]
      .filter(appointment => !requestedAppointmentId || Number(appointment.id) === requestedAppointmentId)
      .sort((a, b) => `${a.date} ${a.start_time}`.localeCompare(`${b.date} ${b.start_time}`) || Number(a.id) - Number(b.id))
      .reduce((groups, appointment) => {
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
        window.history.replaceState(
          {},
          '',
          requestedAppointmentId
            ? `/profesional-turnos/?appointment=${requestedAppointmentId}`
            : '/profesional-turnos/',
        );
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
          <span>${requestedAppointmentId ? 'Sala profesional' : 'Próximos turnos'}</span>
          <h1>${escapeHtml(state.professional?.name || 'Profesional')}</h1>
        </div>
        ${requestedAppointmentId ? '<a class="all-appointments-link" href="/profesional-turnos/">Ver todos los turnos</a>' : ''}
      </header>
    `;
  }

  function renderAppointment(appointment) {
    const documents = appointment.documents || [];
    const hasMedicalOrder = documents.some(document => document.purpose === 'medical_order');
    const hasStudies = documents.some(document => document.purpose !== 'medical_order');
    const documentsTitle = hasMedicalOrder
      ? (hasStudies ? 'Estudios y orden médica del paciente' : 'Orden médica del paciente')
      : (hasStudies ? 'Estudios del paciente' : 'Documentación del paciente');
    const consultation = isConsultationService(appointment.service_name);
    const featured = Number(appointment.id) === Number(requestedAppointmentId);
    const endsAt = appointmentTime(appointment, 'end_time');
    const elapsed = endsAt !== null && Date.now() > endsAt;
    return `
      <article class="appointment-row ${featured ? 'appointment-featured' : ''}">
        <div class="appointment-heading">
          <div>
            <time>${escapeHtml(appointment.start_time)} - ${escapeHtml(appointment.end_time)}</time>
            <strong>${escapeHtml(appointment.patient_name || 'Paciente')}</strong>
          </div>
          ${featured || elapsed ? `<div class="appointment-badges">
            ${elapsed ? '<span class="elapsed-badge">Horario finalizado</span>' : ''}
            ${featured ? '<span class="featured-badge">Turno seleccionado</span>' : ''}
          </div>` : ''}
        </div>
        <dl class="appointment-facts">
          <div><dt>Práctica</dt><dd>${escapeHtml(appointment.service_name || 'Sin información')}</dd></div>
          <div><dt>Acuerdo / origen</dt><dd>${escapeHtml(appointment.agreement_name || 'Particular')}</dd></div>
          <div><dt>Email</dt><dd>${appointment.patient_email ? `<a href="mailto:${escapeHtml(appointment.patient_email)}">${escapeHtml(appointment.patient_email)}</a>` : '—'}</dd></div>
          <div><dt>Teléfono</dt><dd>${appointment.patient_phone ? `<a href="tel:${escapeHtml(appointment.patient_phone)}">${escapeHtml(appointment.patient_phone)}</a>` : '—'}</dd></div>
        </dl>
        <div class="room-actions">
          ${elapsed ? '' : meetAvailable(appointment) ? `<a class="meet-button" href="${escapeHtml(appointment.google_meet_url)}" target="_blank" rel="noopener noreferrer">Entrar a Google Meet</a>` : '<span class="action-unavailable">Meet disponible 20 minutos antes</span>'}
          ${appointment.consultation_report_url ? `<a class="triage-button" href="${escapeHtml(appointment.consultation_report_url)}" target="_blank" rel="noopener noreferrer">Ver informe PDF</a>` : `<span class="action-unavailable">${appointment.consultation_status === 'started' ? 'Cuestionario en curso' : 'Cuestionario pendiente'}</span>`}
        </div>
        <section class="appointment-documents">
          <div>
            <strong>${documentsTitle}</strong>
            <span>${documents.length ? `${documents.length} archivo${documents.length === 1 ? '' : 's'} o enlace${documents.length === 1 ? '' : 's'}` : 'Sin documentación enviada'}</span>
          </div>
          ${documents.length
            ? `<ul>${documents.map((document) => `<li><a href="${escapeHtml(document.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(document.name)}</a><small>${document.kind === 'link' ? 'Enlace externo' : 'Archivo adjunto'}</small></li>`).join('')}</ul>`
            : ''}
          ${!hasMedicalOrder ? '<span>El paciente aún no envió la orden médica.</span>' : ''}
        </section>
        ${consultation && appointment.booking_url
          ? `<section class="treatment-note">
              <span>Después de la consulta</span>
              <strong>Si el paciente quiere comenzar el tratamiento</strong>
              <p>Pasale esta URL para que ingrese a la agenda y seleccione el tratamiento.</p>
              <div class="booking-url-box">
                <a href="${escapeHtml(appointment.booking_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(appointment.booking_url)}</a>
                <button class="copy-url-button" data-action="copy-booking-url" data-id="${appointment.id}" data-url="${escapeHtml(appointment.booking_url)}" type="button" aria-label="Copiar URL de turnos" title="Copiar URL de turnos">${copyIcon}</button>
              </div>
              ${Number(state.copiedAppointmentId) === Number(appointment.id) ? '<small class="copy-success" role="status">URL copiada</small>' : ''}
            </section>`
          : ''}
        ${appointment.consultation_report_url ? '' : `<div class="triage-note">
          <strong>Informe del bot Reku</strong>
          <span>${appointment.consultation_status === 'started' ? 'El paciente inició el cuestionario y todavía no lo completó. El informe PDF estará disponible al finalizar.' : 'El paciente todavía no completó el cuestionario. El informe PDF estará disponible al finalizar.'}</span>
        </div>`}
      </article>
    `;
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
      state.copiedAppointmentId = Number(button.dataset.id);
      render();
    } catch {
      button.title = 'No se pudo copiar. Abrí la URL para copiarla.';
    }
  }

  function bindActions() {
    (app.querySelectorAll?.('[data-action="copy-booking-url"]') || []).forEach((button) => {
      button.addEventListener('click', () => copyBookingUrl(button));
    });
  }

  function renderAppointments() {
    const groups = groupAppointments();
    if (!groups.size) {
      return `<section class="empty-state">${requestedAppointmentId ? 'El turno seleccionado no está disponible.' : 'No hay turnos próximos confirmados.'}</section>`;
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
    bindActions();
    scheduleMeetRefresh();
  }

  loadAppointments();
})();
