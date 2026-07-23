(() => {
  const app = document.getElementById('booking-app');
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token') || '';
  const returnAppointmentId = urlParams.get('appointment_id') || '';
  const returnPaymentId = urlParams.get('payment_id') || urlParams.get('collection_id') || '';
  const state = {
    step: 1,
    loading: true,
    error: '',
    patient: null,
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
  };

  const escapeHtml = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');

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

  async function api(path, options = {}) {
    const response = await fetch(path, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'No se pudo completar la acción.');
    return payload;
  }

  async function loadServices() {
    if (!token) {
      state.error = 'El link de agenda no es válido.';
      state.loading = false;
      render();
      return;
    }

    try {
      const payload = await api(`/api/booking/services?token=${encodeURIComponent(token)}`);
      state.patient = payload.patient;
      state.services = payload.services || [];
    } catch (error) {
      state.error = error.message;
    } finally {
      state.loading = false;
      render();
    }
  }

  async function loadPaymentReturn() {
    if (!token || !returnAppointmentId) return false;
    try {
      const query = new URLSearchParams({
        token,
        appointment_id: returnAppointmentId,
      });
      if (returnPaymentId) query.set('payment_id', returnPaymentId);
      const payload = await api(`/api/booking/payment-status?${query.toString()}`);
      state.appointment = payload.appointment;
      state.step = 5;
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
    if (await loadPaymentReturn()) return;
    await loadServices();
  }

  async function selectService(serviceId) {
    state.service = state.services.find((service) => service.id === serviceId);
    state.professional = null;
    state.selectedDate = '';
    state.selectedSlot = '';
    state.slots = [];
    state.step = 2;
    state.loading = true;
    render();
    try {
      const payload = await api(
        `/api/booking/professionals?token=${encodeURIComponent(token)}&service_id=${serviceId}`,
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
    state.step = 3;
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
        `/api/booking/days?token=${encodeURIComponent(token)}&service_id=${state.service.id}&professional_id=${state.professional.id}&month=${monthKey(state.month)}`,
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
    state.loading = true;
    render();
    try {
      const payload = await api(
        `/api/booking/slots?token=${encodeURIComponent(token)}&service_id=${state.service.id}&professional_id=${state.professional.id}&date=${date}`,
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
    state.loading = true;
    render();
    try {
      const payload = await api('/api/booking/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          service_id: state.service.id,
          professional_id: state.professional.id,
          date: state.selectedDate,
          start_time: state.selectedSlot,
        }),
      });
      if (payload.payment?.url) {
        redirectToPayment(payload.payment.url);
        return;
      }
      state.appointment = payload.appointment;
      state.step = 5;
    } catch (error) {
      state.error = error.message;
    } finally {
      state.loading = false;
      render();
    }
  }

  function renderHeader() {
    return `
      <header class="booking-header">
        <div class="booking-title">
          <img src="/images/logo-reku.svg" alt="Reku" />
          <h1>Nueva Reserva</h1>
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
                  <div class="choice-media">Reku</div>
                  <h3>${escapeHtml(service.name)}</h3>
                  <div class="choice-meta">
                    <span>${escapeHtml(service.duration_minutes)} min</span>
                    <strong>${escapeHtml(money(service.cost_amount))}</strong>
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
        ${renderBackButton(1)}
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
                <strong class="time-section-title">Seleccione un horario</strong>
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
          ${renderBackButton(2)}
          <button type="button" class="primary-button" data-action="go-payment" ${state.selectedSlot ? '' : 'disabled'}>Continuar</button>
        </div>
      </section>
    `;
  }

  function renderPayment() {
    return `
      <section>
        <h2 class="section-title">Pago</h2>
        <p class="section-copy">Vas a continuar en Mercado Pago para completar el pago online.</p>
        <div class="payment-card">
          <p><strong>Servicio:</strong> ${escapeHtml(state.service.name)}</p>
          <p><strong>Profesional:</strong> ${escapeHtml(state.professional.name)}</p>
          <p><strong>Fecha:</strong> ${escapeHtml(state.selectedDate)} ${escapeHtml(state.selectedSlot)}</p>
          <p><strong>Total:</strong> ${escapeHtml(money(state.service.cost_amount))}</p>
        </div>
        <div class="actions">
          ${renderBackButton(3)}
          <button type="button" class="primary-button" data-action="confirm-payment">Pagar con Mercado Pago</button>
        </div>
      </section>
    `;
  }

  function renderSuccess() {
    const paymentStatus = state.appointment?.payment_status || '';
    const isPaid = ['approved', 'paid_simulated', 'free'].includes(paymentStatus);
    const isPending = ['pending', 'in_process', 'authorized'].includes(paymentStatus);
    const title = isPaid ? 'Turno reservado' : isPending ? 'Pago pendiente' : 'Pago no confirmado';
    const copy = isPaid
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
            state.appointment?.date
              ? `<p><strong>Fecha:</strong> ${escapeHtml(state.appointment.date)} ${escapeHtml(state.appointment.start_time)}</p>`
              : ''
          }
          ${
            isPaid
              ? ''
              : '<button type="button" class="secondary-button" data-action="restart-booking">Volver a la agenda</button>'
          }
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
      1: renderServices,
      2: renderProfessionals,
      3: renderCalendar,
      4: renderPayment,
      5: renderSuccess,
    }[state.step]();
    app.innerHTML = `${renderHeader()}${content}`;
    bindEvents();
  }

  function bindEvents() {
    app.querySelectorAll('[data-action]').forEach((element) => {
      element.addEventListener('click', async () => {
        const action = element.dataset.action;
        state.error = '';
        if (action === 'select-service') await selectService(Number(element.dataset.id));
        if (action === 'select-professional') await selectProfessional(Number(element.dataset.id));
        if (action === 'select-date') await selectDate(element.dataset.date);
        if (action === 'select-slot') {
          state.selectedSlot = element.dataset.slot;
          render();
        }
        if (action === 'go-payment' && state.selectedSlot) {
          state.step = 4;
          render();
        }
        if (action === 'confirm-payment') await confirmPayment();
        if (action === 'restart-booking') {
          window.history.replaceState({}, '', `/agenda/?token=${encodeURIComponent(token)}`);
          state.step = 1;
          state.appointment = null;
          state.error = '';
          await loadServices();
        }
        if (action === 'go-step') {
          state.step = Number(element.dataset.step);
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
