(() => {
  const app = document.getElementById('booking-app');
  const urlParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const initialToken = urlParams.get('token') || hashParams.get('token') || '';
  const verificationToken = hashParams.get('verify') || '';
  const formSlug = urlParams.get('form') || '';
  const returnAppointmentId = urlParams.get('appointment_id') || '';
  const returnPaymentId = urlParams.get('payment_id') || urlParams.get('collection_id') || '';
  const returnResult = urlParams.get('mp_return') || '';
  const state = {
    step: verificationToken ? 7 : initialToken ? 2 : 1,
    loading: true,
    error: '',
    formSlug,
    intakeErrors: {},
    intakeValues: {
      nombre: '',
      apellido: '',
      telefono: '',
      email: '',
      identificador: '',
    },
    patient: null,
    agreement: null,
    paymentRequired: true,
    services: [],
    professionals: [],
    availableDays: [],
    slots: [],
    service: null,
    professional: null,
    selectedDate: '',
    selectedSlot: '',
    month: new Date(),
    appointment: null,
    paymentNotice: '',
    retryPaymentUrl: '',
    paymentSubmitting: false,
  };

  const escapeHtml = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');

  const removeSensitiveUrlTokens = () => {
    const clean = new URL(window.location.href);
    clean.searchParams.delete('token');
    clean.hash = '';
    window.history.replaceState({}, '', `${clean.pathname}${clean.search}`);
  };

  const isEmbedded = () => {
    try {
      return window.self !== window.top;
    } catch {
      return true;
    }
  };

  const redirectToPayment = (url) => {
    if (isEmbedded()) {
      window.top.location.href = url;
      return;
    }
    window.location.href = url;
  };

  const money = (value) =>
    new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      maximumFractionDigits: 0,
    }).format(Number(value || 0));

  const monthKey = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

  const monthTitle = (date) =>
    new Intl.DateTimeFormat('es-AR', { month: 'long', year: 'numeric' }).format(date);

  const paymentReturnNotice = (payload) => {
    if (payload.payment_error) return payload.payment_error;
    if (returnResult === 'pending') {
      return 'El pago quedó pendiente en Mercado Pago. Si no lo completaste, podés reintentarlo.';
    }
    if (returnResult === 'failure') {
      return 'No se realizó el pago. Podés reintentarlo para confirmar el turno.';
    }
    return 'No pudimos confirmar el pago. Podés reintentarlo para reservar el turno.';
  };

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    const response = await fetch(path, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || 'No se pudo completar la acción.');
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function loadServices() {
    try {
      const payload = await api('/api/booking/services');
      state.patient = payload.patient;
      state.agreement = payload.agreement || null;
      state.paymentRequired = payload.payment_required !== false;
      state.services = payload.services || [];
    } catch (error) {
      state.error = error.message;
    } finally {
      state.loading = false;
      render();
    }
  }

  async function loadPaymentReturn() {
    if (!returnAppointmentId) return false;
    try {
      const query = new URLSearchParams({
        appointment_id: returnAppointmentId,
      });
      if (returnPaymentId) query.set('payment_id', returnPaymentId);
      const payload = await api(`/api/booking/payment-status?${query.toString()}`);
      state.appointment = payload.appointment;
      state.paymentRequired = payload.payment_required !== false;
      if (payload.selection) {
        state.service = payload.selection.service || null;
        state.professional = payload.selection.professional || null;
        state.selectedDate = payload.selection.date || '';
        state.selectedSlot = payload.selection.start_time || '';
        if (state.selectedDate) {
          state.month = new Date(`${state.selectedDate}T12:00:00`);
        }
      }
      if (payload.appointment?.status === 'confirmed') {
        state.paymentNotice = '';
        state.retryPaymentUrl = '';
        state.step = 6;
      } else {
        state.paymentNotice = paymentReturnNotice(payload);
        state.retryPaymentUrl = payload.payment?.url || '';
        state.step = 5;
      }
      state.loading = false;
      render();
      return true;
    } catch (error) {
      state.error = error.message;
      state.loading = false;
      render();
      return true;
    }
  }

  async function loadInitial() {
    if (verificationToken) {
      await verifyIntake();
      return;
    }
    if (initialToken) {
      try {
        await api('/api/booking/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: initialToken }),
        });
        removeSensitiveUrlTokens();
      } catch (error) {
        state.error = error.message;
        state.loading = false;
        render();
        return;
      }
      if (await loadPaymentReturn()) return;
      state.step = 2;
      await loadServices();
      return;
    }
    if (await loadPaymentReturn()) return;
    if (state.formSlug) {
      await loadAgreement();
      return;
    }
    state.step = 2;
    await loadServices();
  }

  async function verifyIntake() {
    try {
      const payload = await api('/api/booking/intake/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verification_token: verificationToken }),
      });
      state.patient = payload.patient || null;
      state.agreement = payload.agreement || null;
      state.paymentRequired = state.agreement?.type !== 'Nomina';
      state.step = 2;
      removeSensitiveUrlTokens();
      await loadServices();
    } catch (error) {
      state.error = error.message;
      state.loading = false;
      render();
    }
  }

  async function loadAgreement() {
    try {
      const payload = await api(
        `/api/booking/agreement?form=${encodeURIComponent(state.formSlug)}`,
      );
      state.agreement = payload.agreement || null;
      state.paymentRequired = state.agreement?.type !== 'Nomina';
    } catch (error) {
      state.error = error.message;
    } finally {
      state.loading = false;
      render();
    }
  }

  async function submitIntake(form) {
    const data = Object.fromEntries(new FormData(form).entries());
    state.intakeValues = {
      nombre: data.nombre || '',
      apellido: data.apellido || '',
      telefono: data.telefono || '',
      email: data.email || '',
      identificador: data.identificador || '',
    };
    state.intakeErrors = {};
    state.loading = true;
    render();

    try {
      await api('/api/booking/intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agreement_slug: state.formSlug,
          ...state.intakeValues,
        }),
      });
      state.loading = false;
      state.step = 7;
      render();
    } catch (error) {
      state.loading = false;
      state.intakeErrors = error.payload?.errors || {};
      state.error = state.intakeErrors && Object.keys(state.intakeErrors).length
        ? ''
        : error.message;
      render();
    }
  }

  async function selectService(serviceId) {
    state.service = state.services.find((service) => service.id === serviceId);
    state.professional = null;
    state.selectedDate = '';
    state.selectedSlot = '';
    state.slots = [];
    state.paymentNotice = '';
    state.retryPaymentUrl = '';
    state.step = 3;
    state.loading = true;
    render();
    try {
      const payload = await api(
        `/api/booking/professionals?service_id=${serviceId}`,
      );
      state.professionals = payload.professionals || [];
    } catch (error) {
      state.error = error.message;
    } finally {
      state.loading = false;
      render();
    }
  }

  async function selectProfessional(professionalId) {
    state.professional = state.professionals.find((professional) => professional.id === professionalId);
    state.selectedDate = '';
    state.selectedSlot = '';
    state.slots = [];
    state.paymentNotice = '';
    state.retryPaymentUrl = '';
    state.step = 4;
    await loadDays();
  }

  async function changeMonth(offset) {
    state.month = new Date(state.month.getFullYear(), state.month.getMonth() + offset, 1);
    state.selectedDate = '';
    state.selectedSlot = '';
    state.slots = [];
    await loadDays();
  }

  async function loadDays() {
    if (!state.service || !state.professional) return;
    state.loading = true;
    render();
    try {
      const payload = await api(
        `/api/booking/days?service_id=${state.service.id}&professional_id=${state.professional.id}&month=${monthKey(state.month)}`,
      );
      state.availableDays = payload.days || [];
    } catch (error) {
      state.error = error.message;
    } finally {
      state.loading = false;
      render();
    }
  }

  async function selectDate(date) {
    state.selectedDate = date;
    state.selectedSlot = '';
    state.paymentNotice = '';
    state.retryPaymentUrl = '';
    state.loading = true;
    render();
    try {
      const payload = await api(
        `/api/booking/slots?service_id=${state.service.id}&professional_id=${state.professional.id}&date=${date}`,
      );
      state.slots = payload.slots || [];
    } catch (error) {
      state.error = error.message;
    } finally {
      state.loading = false;
      render();
    }
  }

  async function confirmPayment() {
    if (state.paymentSubmitting) return;
    state.paymentSubmitting = true;
    state.paymentNotice = '';
    render();

    let redirecting = false;
    if (state.retryPaymentUrl) {
      redirecting = true;
      redirectToPayment(state.retryPaymentUrl);
      return;
    }

    try {
      const payload = await api('/api/booking/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_id: state.service.id,
          professional_id: state.professional.id,
          date: state.selectedDate,
          start_time: state.selectedSlot,
        }),
      });
      if (payload.payment?.url) {
        redirecting = true;
        redirectToPayment(payload.payment.url);
        return;
      }
      state.appointment = payload.appointment;
      state.step = 6;
    } catch (error) {
      state.paymentNotice = error.message;
    } finally {
      if (!redirecting) {
        state.paymentSubmitting = false;
        render();
      }
    }
  }

  function renderHeader() {
    return `
      <header class="booking-header">
        <div class="booking-title">
          <img src="/images/logo-reku.svg" alt="Reku" />
          <h1>Reserva tu turno</h1>
        </div>
        <div class="stepper">
          ${[1, 2, 3, 4, 5]
            .map(
              (step) => `
                <div class="step${state.step === step ? ' active' : ''}${state.step > step ? ' done' : ''}">
                  <span>${state.step > step ? '✓' : step}</span>
                </div>
              `,
            )
            .join('')}
        </div>
      </header>
    `;
  }

  function fieldError(name) {
    return state.intakeErrors[name]
      ? `<span class="field-error">${escapeHtml(state.intakeErrors[name])}</span>`
      : '';
  }

  function renderIntakeForm() {
    const agreement = state.agreement || {};
    const values = state.intakeValues;
    const showIdentifier = agreement.type === 'Nomina';
    return `
      <section>
        <div class="intake-brand">
          ${agreement.logo_url ? `<img src="${escapeHtml(agreement.logo_url)}" alt="" />` : ''}
          ${agreement.pdf_url ? `<a class="secondary-button how-it-works-button" href="${escapeHtml(agreement.pdf_url)}" target="_blank" rel="noreferrer">Cómo funciona</a>` : ''}
        </div>
        <h2 class="section-title">Tus datos</h2>
        <p class="section-copy">Completá tus datos para iniciar el alta y continuar con la reserva.</p>
        <form class="intake-card" id="booking-intake-form" novalidate>
          <label>
            Nombre
            <input name="nombre" value="${escapeHtml(values.nombre)}" autocomplete="given-name" required />
            ${fieldError('nombre')}
          </label>
          <label>
            Apellido
            <input name="apellido" value="${escapeHtml(values.apellido)}" autocomplete="family-name" required />
            ${fieldError('apellido')}
          </label>
          <label>
            Teléfono
            <input name="telefono" value="${escapeHtml(values.telefono)}" autocomplete="tel" inputmode="tel" required />
            ${fieldError('telefono')}
          </label>
          <label>
            Mail
            <input name="email" type="email" value="${escapeHtml(values.email)}" autocomplete="email" required />
            ${fieldError('email')}
          </label>
          ${
            showIdentifier
              ? `
                <label class="span-two">
                  Identificador
                  <input name="identificador" value="${escapeHtml(values.identificador)}" autocomplete="off" required />
                  ${fieldError('identificador')}
                </label>
              `
              : ''
          }
          <div class="form-actions span-two">
            <button type="submit" class="primary-button">Continuar</button>
          </div>
        </form>
      </section>
    `;
  }

  function renderServices() {
    return `
      <section>
        <h2 class="section-title">Elegí tu servicio</h2>
        <p class="section-copy">Seleccioná el servicio que deseás reservar.</p>
        <div class="card-grid">
          ${state.services
            .map(
              (service) => `
                <button type="button" class="choice-card" data-action="select-service" data-id="${service.id}">
                  <div class="choice-media service-media">
                    ${
                      service.image_url
                        ? `<img class="service-image" src="${escapeHtml(service.image_url)}" alt="" />`
                        : 'Reku'
                    }
                  </div>
                  <h3>${escapeHtml(service.name)}</h3>
                  <div class="choice-meta">
                    <span>${escapeHtml(service.duration_minutes)} min</span>
                    <strong>${
                      service.covered_by_agreement
                        ? 'Cubierto por acuerdo'
                        : escapeHtml(money(service.cost_amount))
                    }</strong>
                  </div>
                </button>
              `,
            )
            .join('') || '<div class="empty-card">No hay servicios disponibles.</div>'}
        </div>
      </section>
    `;
  }

  function initials(name) {
    return String(name || '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('');
  }

  function renderProfessionals() {
    return `
      <section>
        <h2 class="section-title">Elegí tu profesional</h2>
        <p class="section-copy">Seleccioná el profesional de tu preferencia.</p>
        <div class="card-grid">
          ${state.professionals
            .map(
              (professional) => `
                <button type="button" class="choice-card" data-action="select-professional" data-id="${professional.id}">
                  <div class="choice-media">
                    ${
                      professional.photo_url
                        ? `<img class="professional-photo" src="${escapeHtml(professional.photo_url)}" alt="" />`
                        : `<span class="professional-initials">${escapeHtml(initials(professional.name))}</span>`
                    }
                  </div>
                  <h3>${escapeHtml(professional.name)}</h3>
                </button>
              `,
            )
            .join('') || '<div class="empty-card">No hay profesionales para este servicio.</div>'}
        </div>
        ${renderBackButton(2)}
      </section>
    `;
  }

  function calendarCells() {
    const year = state.month.getFullYear();
    const month = state.month.getMonth();
    const first = new Date(year, month, 1);
    const startOffset = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const available = new Map(state.availableDays.map((item) => [item.date, item.slots_count]));
    const cells = Array.from({ length: startOffset }, () => '<span></span>');

    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${monthKey(state.month)}-${String(day).padStart(2, '0')}`;
      const isAvailable = available.has(date);
      cells.push(`
        <button
          type="button"
          class="date-button${isAvailable ? ' available' : ''}${state.selectedDate === date ? ' active' : ''}"
          data-action="select-date"
          data-date="${date}"
          ${isAvailable ? '' : 'disabled'}
        >
          ${day}
        </button>
      `);
    }

    return cells.join('');
  }

  function renderCalendar() {
    return `
      <section>
        <h2 class="section-title">Elegí fecha y hora</h2>
        <p class="section-copy">Seleccioná el día y horario que prefieras.</p>
        <div class="calendar-card">
          <div class="calendar-head">
            <h3>${escapeHtml(monthTitle(state.month))}</h3>
            <div class="calendar-nav">
              <button type="button" class="icon-btn" data-action="previous-month" aria-label="Mes anterior">‹</button>
              <button type="button" class="icon-btn" data-action="next-month" aria-label="Mes siguiente">›</button>
            </div>
          </div>
          <div class="weekday-grid">
            <span>Dom</span><span>Lun</span><span>Mar</span><span>Mié</span><span>Jue</span><span>Vie</span><span>Sáb</span>
          </div>
          <div class="calendar-grid">${calendarCells()}</div>
          ${
            state.selectedDate
              ? `
                <strong class="time-section-title">Seleccioná un horario</strong>
                <div class="time-grid">
                  ${state.slots
                    .map(
                      (slot) => `
                        <button type="button" class="time-button${state.selectedSlot === slot ? ' active' : ''}" data-action="select-slot" data-slot="${slot}">
                          ${escapeHtml(slot)}
                        </button>
                      `,
                    )
                    .join('') || '<div class="empty-card">No quedan horarios para este día.</div>'}
                </div>
              `
              : ''
          }
        </div>
        <div class="actions">
          ${renderBackButton(3)}
          <button type="button" class="primary-button" data-action="go-payment" ${state.selectedSlot ? '' : 'disabled'}>Continuar</button>
        </div>
      </section>
    `;
  }

  function renderPayment() {
    const isCoveredByAgreement = !state.paymentRequired || state.service?.covered_by_agreement;
    return `
      <section>
        <h2 class="section-title">${isCoveredByAgreement ? 'Confirmá tu turno' : 'Pago'}</h2>
        <p class="section-copy">${
          isCoveredByAgreement
            ? 'Tu acuerdo ya validó la cobertura. Confirmá la reserva para finalizar.'
            : 'Vas a continuar en Mercado Pago para completar el pago online.'
        }</p>
        <div class="payment-card">
          ${state.paymentNotice ? `<div class="status-warning">${escapeHtml(state.paymentNotice)}</div>` : ''}
          <p><strong>Servicio:</strong> ${escapeHtml(state.service.name)}</p>
          <p><strong>Profesional:</strong> ${escapeHtml(state.professional.name)}</p>
          <p><strong>Fecha:</strong> ${escapeHtml(state.selectedDate)} ${escapeHtml(state.selectedSlot)}</p>
          <p><strong>Total:</strong> ${
            isCoveredByAgreement ? 'Cubierto por acuerdo' : escapeHtml(money(state.service.cost_amount))
          }</p>
        </div>
        <div class="actions">
          ${renderBackButton(4)}
          <button type="button" class="primary-button" data-action="confirm-payment" ${state.paymentSubmitting ? 'disabled' : ''}>${
            state.paymentSubmitting
              ? isCoveredByAgreement
                ? 'Confirmando turno...'
                : 'Redirigiendo a Mercado Pago...'
              : isCoveredByAgreement
                ? 'Confirmar turno'
                : state.paymentNotice
                  ? 'Reintentar pago'
                  : 'Pagar con Mercado Pago'
          }</button>
        </div>
      </section>
    `;
  }

  function renderSuccess() {
    const paymentStatus = state.appointment?.payment_status || '';
    const isNomina = paymentStatus === 'nomina';
    const isFree = paymentStatus === 'free';
    const isPaid = ['approved', 'paid_simulated', 'free', 'nomina'].includes(paymentStatus);
    const isPending = ['pending', 'in_process', 'authorized'].includes(paymentStatus);
    const date = state.appointment?.date || state.selectedDate;
    const startTime = state.appointment?.start_time || state.selectedSlot;
    const professionalName =
      state.appointment?.professional_name || state.professional?.name || '';
    const serviceName = state.appointment?.service_name || state.service?.name || '';
    const title = isPaid ? 'Turno reservado' : isPending ? 'Pago pendiente' : 'Pago no confirmado';
    const copy = isNomina
      ? 'Tu acuerdo ya validó la cobertura y el turno quedó confirmado.'
      : isFree
        ? 'El turno quedó confirmado.'
      : isPaid
        ? 'El pago fue aprobado y el turno quedó confirmado.'
        : isPending
          ? 'Mercado Pago todavía está procesando el pago. Te avisaremos cuando se confirme.'
          : 'Mercado Pago no informó un pago aprobado para este turno.';
    return `
      <section>
        <div class="payment-card">
          <div class="success-mark${isPaid ? '' : ' pending'}">${isPaid ? '✓' : '!'}</div>
          <h2 class="section-title">${escapeHtml(title)}</h2>
          <p class="section-copy">${escapeHtml(copy)}</p>
          ${
            date
              ? `
                <p><strong>Fecha:</strong> ${escapeHtml(date)}</p>
                <p><strong>Hora:</strong> ${escapeHtml(startTime)}</p>
              `
              : ''
          }
          ${professionalName ? `<p><strong>Profesional:</strong> ${escapeHtml(professionalName)}</p>` : ''}
          ${serviceName ? `<p><strong>Práctica:</strong> ${escapeHtml(serviceName)}</p>` : ''}
          ${
            isPaid
              ? ''
              : '<button type="button" class="secondary-button" data-action="restart-booking">Volver a la agenda</button>'
          }
        </div>
      </section>
    `;
  }

  function renderVerificationPending() {
    return `
      <section>
        <div class="payment-card">
          <div class="success-mark">✓</div>
          <h2 class="section-title">Revisá tu mail</h2>
          <p class="section-copy">Te enviamos un enlace para confirmar tu dirección y continuar con la reserva.</p>
          <p class="section-copy">El enlace vence en 24 horas y puede usarse una sola vez.</p>
        </div>
      </section>
    `;
  }

  function renderBackButton(step) {
    return `<button type="button" class="back-button" data-action="go-step" data-step="${step}">← Atrás</button>`;
  }

  function render() {
    if (state.loading) {
      app.innerHTML = `${renderHeader()}<div class="empty-card">Cargando...</div>`;
      bindEvents();
      return;
    }

    if (state.error) {
      app.innerHTML = `${renderHeader()}<div class="status-error">${escapeHtml(state.error)}</div>`;
      bindEvents();
      return;
    }

    const content = {
      1: renderIntakeForm,
      2: renderServices,
      3: renderProfessionals,
      4: renderCalendar,
      5: renderPayment,
      6: renderSuccess,
      7: renderVerificationPending,
    }[state.step]();
    app.innerHTML = `${renderHeader()}${content}`;
    bindEvents();
  }

  function bindEvents() {
    app.querySelector('#booking-intake-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      state.error = '';
      await submitIntake(event.currentTarget);
    });

    app.querySelectorAll('[data-action]').forEach((element) => {
      element.addEventListener('click', async () => {
        const action = element.dataset.action;
        state.error = '';
        if (action === 'select-service') await selectService(Number(element.dataset.id));
        if (action === 'select-professional') await selectProfessional(Number(element.dataset.id));
        if (action === 'select-date') await selectDate(element.dataset.date);
        if (action === 'select-slot') {
          state.selectedSlot = element.dataset.slot;
          state.paymentNotice = '';
          state.retryPaymentUrl = '';
          render();
        }
        if (action === 'go-payment' && state.selectedSlot) {
          state.step = 5;
          render();
        }
        if (action === 'confirm-payment') await confirmPayment();
        if (action === 'restart-booking') {
          window.history.replaceState({}, '', '/agenda/');
          state.step = 2;
          state.appointment = null;
          state.error = '';
          await loadServices();
        }
        if (action === 'go-step') {
          state.step = Number(element.dataset.step);
          if (state.step === 4 && state.service && state.professional && !state.availableDays.length) {
            await loadDays();
            return;
          }
          render();
        }
        if (action === 'previous-month') {
          await changeMonth(-1);
        }
        if (action === 'next-month') {
          await changeMonth(1);
        }
      });
    });
  }

  loadInitial();
})();
