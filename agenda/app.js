(() => {
  const app = document.getElementById('booking-app');
  const urlParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const initialToken = urlParams.get('token') || hashParams.get('token') || '';
  const verificationToken = hashParams.get('verify') || '';
  const managementToken = hashParams.get('manage') || '';
  const managementMode = Boolean(managementToken || urlParams.get('manage') === '1');
  const formSlug = urlParams.get('form') || '';
  const returnAppointmentId = urlParams.get('appointment_id') || '';
  const returnPaymentId = urlParams.get('payment_id') || urlParams.get('collection_id') || '';
  const returnResult = urlParams.get('mp_return') || '';
  const state = {
    step: managementMode ? 8 : verificationToken ? 7 : initialToken ? 2 : 1,
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
    triageUrl: '',
    triageLoading: false,
    triageError: '',
    documents: [],
    documentsUploading: false,
    documentsMessage: '',
    documentsError: '',
    documentFiles: [],
    documentLinksDraft: '',
    management: {
      appointment: null,
      rescheduling: false,
      availableDays: [],
      slots: [],
      selectedDate: '',
      selectedSlot: '',
      month: new Date(),
      submitting: false,
      message: '',
      error: '',
      cancelModalOpen: false,
    },
  };

  const escapeHtml = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');

  const normalizeDocumentLinkInput = (value) => {
    const link = String(value || '').trim();
    if (!link) return '';
    if (/^http:\/\//i.test(link)) return `https://${link.slice('http://'.length)}`;
    if (/^\/\//.test(link)) return `https:${link}`;
    if (/^https:\/\//i.test(link) || /^[a-z][a-z0-9+.-]*:/i.test(link)) return link;
    return `https://${link}`;
  };

  const removeSensitiveUrlTokens = () => {
    const clean = new URL(window.location.href);
    clean.searchParams.delete('token');
    clean.hash = '';
    window.history.replaceState({}, '', `${clean.pathname}${clean.search}`);
  };

  const removeManagementToken = () => {
    const clean = new URL(window.location.href);
    clean.search = '';
    clean.searchParams.set('manage', '1');
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

  const friendlyDate = (value) => {
    const date = new Date(`${value}T12:00:00`);
    if (!Number.isFinite(date.getTime())) return String(value || '');
    return new Intl.DateTimeFormat('es-AR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(date);
  };

  const localTime = (value, timeZone) => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat('es-AR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  };

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

  async function loadManagedAppointment() {
    const payload = await api('/api/booking/manage/appointment');
    state.management.appointment = payload.appointment;
    const date = payload.appointment?.date;
    if (date) state.management.month = new Date(`${date}T12:00:00`);
    state.step = 8;
  }

  let managementMeetRefreshTimer = 0;

  function scheduleManagementMeetRefresh() {
    if (managementMeetRefreshTimer && typeof window.clearTimeout === 'function') {
      window.clearTimeout(managementMeetRefreshTimer);
    }
    managementMeetRefreshTimer = 0;
    const meet = state.step === 8 ? state.management.appointment?.meet : null;
    const target =
      meet?.state === 'upcoming'
        ? meet.available_from
        : meet?.state === 'available'
          ? meet.available_until
          : '';
    if (!target || typeof window.setTimeout !== 'function') return;
    const remaining = new Date(target).getTime() - Date.now();
    const delay = Math.max(1_000, Math.min(30_000, remaining + 1_000));
    managementMeetRefreshTimer = window.setTimeout(async () => {
      try {
        await loadManagedAppointment();
        render();
      } catch {
        scheduleManagementMeetRefresh();
      }
    }, delay);
  }

  async function loadManagement() {
    try {
      if (managementToken) {
        const payload = await api('/api/booking/manage/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: managementToken }),
        });
        state.management.appointment = payload.appointment;
        if (payload.appointment?.date) {
          state.management.month = new Date(`${payload.appointment.date}T12:00:00`);
        }
        removeManagementToken();
      } else {
        await loadManagedAppointment();
      }
      state.step = 8;
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
      if (payload.appointment?.status === 'confirmed') {
        await loadTriage();
      }
      return true;
    } catch (error) {
      state.error = error.message;
      state.loading = false;
      render();
      return true;
    }
  }

  async function loadInitial() {
    if (managementMode) {
      await loadManagement();
      return;
    }
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
      const payload = await api('/api/booking/intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agreement_slug: state.formSlug,
          ...state.intakeValues,
        }),
      });
      if (payload.verification_required === false) {
        state.patient = payload.patient || null;
        state.agreement = payload.agreement || state.agreement;
        state.paymentRequired = state.agreement?.type !== 'Nomina';
        state.step = 2;
        await loadServices();
        return;
      }
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
    state.professional = professionalId === 'first_available'
      ? {
          id: 'first_available',
          name: 'Primera disponibilidad',
          specialty: 'Asignación automática',
          automatic: true,
        }
      : state.professionals.find((professional) => professional.id === professionalId);
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
          first_available: state.professional.automatic === true,
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
      if (payload.appointment?.professional_id) {
        state.professional = {
          id: payload.appointment.professional_id,
          name: payload.appointment.professional_name || state.professional.name,
        };
      }
      state.step = 6;
      await loadTriage();
    } catch (error) {
      state.paymentNotice = error.message;
    } finally {
      if (!redirecting) {
        state.paymentSubmitting = false;
        render();
      }
    }
  }

  async function loadTriage() {
    if (state.appointment?.status !== 'confirmed' || !state.appointment?.id) return;
    state.triageLoading = true;
    state.triageError = '';
    render();
    try {
      const payload = await api('/api/booking/triage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appointment_id: state.appointment.id }),
      });
      state.triageUrl = payload.url || '';
    } catch (error) {
      state.triageError = error.message;
    } finally {
      state.triageLoading = false;
      render();
    }
  }

  async function submitDocuments(form) {
    if (state.documentsUploading || !state.appointment?.id) return;
    const fileInput = form.querySelector('input[name="documents"]');
    const linkInput = form.querySelector('textarea[name="links"]');
    const links = String(linkInput?.value ?? state.documentLinksDraft)
      .split(/\r?\n/)
      .map(normalizeDocumentLinkInput)
      .filter(Boolean);
    const selectedFiles = Array.from(fileInput?.files || []);
    const files = selectedFiles.length ? selectedFiles : state.documentFiles;
    if (!files.length && !links.length) {
      state.documentsError = 'Adjuntá al menos un archivo o pegá un enlace.';
      state.documentsMessage = '';
      render();
      return;
    }
    state.documentFiles = files;
    state.documentLinksDraft = links.join('\n');
    const data = new FormData();
    files.forEach((file) => data.append('documents', file));
    data.set('links_json', JSON.stringify(links));
    state.documentsUploading = true;
    state.documentsError = '';
    state.documentsMessage = '';
    render();
    try {
      const payload = await api(
        `/api/booking/appointments/${state.appointment.id}/documents`,
        { method: 'POST', body: data },
      );
      state.documents.push(...(payload.documents || []));
      state.documentFiles = [];
      state.documentLinksDraft = '';
      state.documentsMessage = payload.message || 'La documentación se compartió.';
    } catch (error) {
      state.documentsError = error.message;
    } finally {
      state.documentsUploading = false;
      render();
    }
  }

  async function loadManagementDays() {
    const management = state.management;
    management.error = '';
    try {
      const payload = await api(
        `/api/booking/manage/days?month=${monthKey(management.month)}`,
      );
      management.availableDays = payload.days || [];
    } catch (error) {
      management.error = error.message;
    } finally {
      render();
    }
  }

  async function openManagementReschedule() {
    const management = state.management;
    management.rescheduling = true;
    management.selectedDate = '';
    management.selectedSlot = '';
    management.slots = [];
    management.message = '';
    management.error = '';
    render();
    window.requestAnimationFrame?.(() => {
      document.getElementById('management-reschedule-panel')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
    await loadManagementDays();
  }

  async function changeManagementMonth(offset) {
    const management = state.management;
    management.month = new Date(
      management.month.getFullYear(),
      management.month.getMonth() + offset,
      1,
    );
    management.selectedDate = '';
    management.selectedSlot = '';
    management.slots = [];
    await loadManagementDays();
  }

  async function selectManagementDate(date) {
    const management = state.management;
    management.selectedDate = date;
    management.selectedSlot = '';
    management.error = '';
    render();
    try {
      const payload = await api(
        `/api/booking/manage/slots?date=${encodeURIComponent(date)}`,
      );
      management.slots = payload.slots || [];
    } catch (error) {
      management.error = error.message;
    } finally {
      render();
    }
  }

  async function rescheduleManagedAppointment() {
    const management = state.management;
    if (!management.selectedDate || !management.selectedSlot || management.submitting) return;
    management.submitting = true;
    management.error = '';
    management.message = '';
    render();
    try {
      const payload = await api('/api/booking/manage/reschedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: management.selectedDate,
          start_time: management.selectedSlot,
        }),
      });
      management.appointment = payload.appointment;
      management.message = payload.message || 'El turno fue reprogramado.';
      management.rescheduling = false;
      management.availableDays = [];
      management.slots = [];
      management.selectedDate = '';
      management.selectedSlot = '';
    } catch (error) {
      management.error = error.message;
    } finally {
      management.submitting = false;
      render();
    }
  }

  async function cancelManagedAppointment() {
    const management = state.management;
    if (management.submitting) return;
    management.submitting = true;
    management.error = '';
    management.message = '';
    render();
    let cancelled = false;
    try {
      const payload = await api('/api/booking/manage/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      management.appointment = payload.appointment;
      management.message = payload.message || 'La reserva fue cancelada.';
      management.rescheduling = false;
      cancelled = true;
    } catch (error) {
      management.error = error.message;
    } finally {
      management.submitting = false;
      if (cancelled) management.cancelModalOpen = false;
      render();
    }
  }

  function renderHeader() {
    if (state.step === 8) {
      return `
        <header class="booking-header management-header">
          <div class="booking-title">
            <img src="/images/logo-reku.svg" alt="Reku" />
            <h1>Gestioná tu turno</h1>
          </div>
        </header>
      `;
    }
    const progress =
      state.step === 7
        ? { activeStep: 0, completedThrough: 1 }
        : state.step >= 6
          ? { activeStep: 0, completedThrough: 5 }
          : { activeStep: state.step, completedThrough: state.step - 1 };

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
                <div class="step${progress.activeStep === step ? ' active' : ''}${progress.completedThrough >= step ? ' done' : ''}">
                  <span>${progress.completedThrough >= step ? '✓' : step}</span>
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
        <h2 class="section-title">Elegí cómo querés buscar</h2>
        <p class="section-copy">Podés elegir un kinesiólogo o ver directamente los horarios más próximos.</p>
        <div class="card-grid">
          ${
            state.professionals.length
              ? `<button type="button" class="choice-card automatic-choice" data-action="select-professional" data-id="first_available">
                  <div class="choice-media automatic-choice-media" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="3" y="5" width="18" height="16" rx="3"></rect>
                      <path d="M8 3v4M16 3v4M3 10h18M8 15l2.2 2.2L16 12"></path>
                    </svg>
                  </div>
                  <h3>Primera disponibilidad</h3>
                  <p class="professional-specialty">Te mostramos los horarios más próximos entre todos los profesionales disponibles.</p>
                </button>`
              : ''
          }
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
                  ${professional.specialty ? `<p class="professional-specialty">${escapeHtml(professional.specialty)}</p>` : ''}
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
        <p class="section-copy">${
          state.professional?.automatic
            ? 'Te mostramos la disponibilidad combinada de los kinesiólogos que realizan esta práctica.'
            : 'Seleccioná el día y horario que prefieras.'
        }</p>
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
          <p><strong>Profesional:</strong> ${escapeHtml(state.professional.name)}${state.professional.automatic ? ' · Reku lo asignará al confirmar' : ''}</p>
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

  function renderDocumentsCard() {
    return `
      <div class="documents-card">
        <div>
          <span class="optional-label">Opcional</span>
          <h3>Compartí documentación con tu fisio</h3>
          <p>Podés subir la orden del traumatólogo, estudios o enlaces a imágenes.</p>
        </div>
        ${
          state.documents.length
            ? `<ul class="uploaded-documents">${state.documents
                .map(
                  (document) => `<li>${document.kind === 'link' ? 'Enlace' : 'Archivo'} · ${escapeHtml(document.name)}</li>`,
                )
                .join('')}</ul>`
            : ''
        }
        ${state.documentsMessage ? `<div class="document-status ok">${escapeHtml(state.documentsMessage)}</div>` : ''}
        ${state.documentsError ? `<div class="document-status error">${escapeHtml(state.documentsError)}</div>` : ''}
        <form id="appointment-documents-form" class="documents-form">
          <label>
            Imágenes o PDF
            <input name="documents" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple />
            <span>Hasta 5 archivos y 10 MB en total.</span>
            ${state.documentFiles.length ? `<span class="selected-document-files">Seleccionados: ${state.documentFiles.map((file) => escapeHtml(file.name)).join(', ')}</span>` : ''}
          </label>
          <label>
            Links a estudios de imágenes
            <textarea name="links" rows="3" placeholder="Pegá un link por línea">${escapeHtml(state.documentLinksDraft)}</textarea>
          </label>
          <button class="primary-button documents-submit-button" type="submit" ${state.documentsUploading ? 'disabled' : ''}>${
            state.documentsUploading ? 'Compartiendo…' : 'Compartir documentación'
          }</button>
        </form>
      </div>
    `;
  }

  function renderTriageCard() {
    return `
      <div class="triage-card">
        <h3>Último paso: cuestionario previo</h3>
        <p>Completalo antes de la consulta para que tu fisio pueda preparar mejor la atención.</p>
        ${
          state.triageLoading
            ? '<p class="triage-loading">Preparando tu cuestionario…</p>'
            : state.triageUrl
              ? `<a class="primary-button" href="${escapeHtml(state.triageUrl)}" target="_blank" rel="noopener noreferrer">Completar cuestionario</a>
                 <p class="triage-note">También vas a recibir este enlace por mail.</p>`
              : `<p class="triage-error">${escapeHtml(state.triageError || 'Todavía no pudimos preparar el cuestionario.')}</p>
                 <button type="button" class="secondary-button" data-action="retry-triage">Volver a intentar</button>`
        }
      </div>
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
          ${isPaid ? renderDocumentsCard() : ''}
          ${isPaid ? renderTriageCard() : ''}
          ${
            isPaid
              ? ''
              : '<button type="button" class="secondary-button" data-action="restart-booking">Volver a la agenda</button>'
          }
        </div>
      </section>
    `;
  }

  function managementCalendarCells() {
    const management = state.management;
    const year = management.month.getFullYear();
    const month = management.month.getMonth();
    const first = new Date(year, month, 1);
    const startOffset = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const available = new Set(management.availableDays.map((item) => item.date));
    const cells = Array.from({ length: startOffset }, () => '<span></span>');
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${monthKey(management.month)}-${String(day).padStart(2, '0')}`;
      const isAvailable = available.has(date);
      cells.push(`
        <button
          type="button"
          class="date-button${isAvailable ? ' available' : ''}${management.selectedDate === date ? ' active' : ''}"
          data-action="select-management-date"
          data-date="${date}"
          ${isAvailable ? '' : 'disabled'}
        >${day}</button>
      `);
    }
    return cells.join('');
  }

  const managedAppointmentStatus = (appointment) => {
    if (appointment.status === 'cancelled') return 'Reserva cancelada';
    if (appointment.status === 'pending_payment') return 'Pago pendiente';
    if (appointment.status === 'payment_failed') return 'Reserva vencida';
    return 'Turno confirmado';
  };

  function renderManagementReschedule(appointment) {
    const management = state.management;
    return `
      <div class="management-reschedule" id="management-reschedule-panel">
        <div class="calendar-head">
          <div>
            <span class="optional-label">Reprogramación</span>
            <h3>Elegí un nuevo día y horario</h3>
          </div>
          <div class="calendar-nav">
            <button type="button" class="icon-btn" data-action="previous-management-month" aria-label="Mes anterior">‹</button>
            <button type="button" class="icon-btn" data-action="next-management-month" aria-label="Mes siguiente">›</button>
          </div>
        </div>
        <strong class="management-month">${escapeHtml(monthTitle(management.month))}</strong>
        <div class="weekday-grid">
          <span>Dom</span><span>Lun</span><span>Mar</span><span>Mié</span><span>Jue</span><span>Vie</span><span>Sáb</span>
        </div>
        <div class="calendar-grid">${managementCalendarCells()}</div>
        ${
          management.selectedDate
            ? `<strong class="time-section-title">Horarios disponibles</strong>
               <div class="time-grid">${management.slots
                 .map((slot) => {
                   const isCurrent =
                     management.selectedDate === appointment.date &&
                     slot === appointment.start_time;
                   return `<button type="button" class="time-button${management.selectedSlot === slot ? ' active' : ''}" data-action="select-management-slot" data-slot="${slot}" ${isCurrent ? 'disabled' : ''}>${escapeHtml(slot)}${isCurrent ? ' · actual' : ''}</button>`;
                 })
                 .join('') || '<div class="empty-card">No quedan horarios para este día.</div>'}</div>`
            : ''
        }
        <div class="actions">
          <button type="button" class="back-button" data-action="close-management-reschedule">Cancelar cambio</button>
          <button type="button" class="primary-button" data-action="confirm-management-reschedule" ${management.selectedSlot && !management.submitting ? '' : 'disabled'}>${management.submitting ? 'Reprogramando…' : 'Confirmar nuevo horario'}</button>
        </div>
      </div>
    `;
  }

  function renderAppointmentManagement() {
    const management = state.management;
    const appointment = management.appointment;
    if (!appointment) return '<div class="empty-card">No pudimos cargar el turno.</div>';
    const capabilities = appointment.capabilities || {};
    const meet = appointment.meet || {};
    const appointmentSchedule = `Tu turno es el ${friendlyDate(appointment.date)} de ${appointment.start_time} a ${appointment.end_time}.`;
    const meetCard = appointment.status === 'confirmed'
      ? `<div class="management-meet-card ${escapeHtml(meet.state || 'not_configured')}">
          <div>
            <span class="optional-label">Videollamada</span>
            <h3>Acceso a Google Meet</h3>
            ${
              meet.state === 'available'
                ? `<p>El acceso está habilitado ahora. Permanecerá disponible hasta las ${escapeHtml(localTime(meet.available_until, meet.time_zone))}.</p>`
                : meet.state === 'upcoming'
                  ? `<p>La videollamada todavía no está disponible. ${escapeHtml(appointmentSchedule)} Podés ingresar desde las ${escapeHtml(localTime(meet.available_from, meet.time_zone))}.</p>`
                  : meet.state === 'finished'
                    ? `<p>El acceso a la videollamada ya finalizó. ${escapeHtml(appointmentSchedule)}</p>`
                    : `<p>La videollamada todavía no fue habilitada. ${escapeHtml(appointmentSchedule)}</p>`
            }
          </div>
          ${
            meet.state === 'available'
              ? '<a class="primary-button meet-access-button" href="/api/booking/manage/meet" target="_blank" rel="noopener noreferrer">Entrar a Google Meet</a>'
              : '<button type="button" class="secondary-button meet-access-button" disabled>Entrar a Google Meet</button>'
          }
        </div>`
      : '';
    return `
      <section class="management-shell">
        <div class="management-access-note">
          <strong>Guardá el mail que recibiste</strong>
          <p>No necesitás usuario ni contraseña. El enlace de ese mail es tu acceso privado para volver a esta pantalla y gestionar el turno. No lo reenvíes.</p>
        </div>
        ${management.message ? `<div class="document-status ok">${escapeHtml(management.message)}</div>` : ''}
        ${management.error ? `<div class="document-status error">${escapeHtml(management.error)}</div>` : ''}
        <div class="payment-card management-summary">
          <div class="management-status">${escapeHtml(managedAppointmentStatus(appointment))}</div>
          <h2 class="section-title">${escapeHtml(appointment.service.name)}</h2>
          <p><strong>Fecha:</strong> ${escapeHtml(appointment.date)}</p>
          <p><strong>Hora:</strong> ${escapeHtml(appointment.start_time)} a ${escapeHtml(appointment.end_time)}</p>
          <p><strong>Profesional:</strong> ${escapeHtml(appointment.professional.name)}</p>
          ${meetCard}
          <div class="management-actions">
            ${appointment.payment_url && appointment.status === 'pending_payment' ? `<a class="primary-button" href="${escapeHtml(appointment.payment_url)}">Completar pago</a>` : ''}
            ${capabilities.can_reschedule ? '<button type="button" class="secondary-button" data-action="open-management-reschedule">Mover turno</button>' : ''}
            ${capabilities.can_cancel ? `<button type="button" class="danger-outline-button" data-action="cancel-management-appointment" ${management.submitting ? 'disabled' : ''}>Cancelar reserva</button>` : ''}
            ${appointment.triage_url ? `<a class="primary-button" href="${escapeHtml(appointment.triage_url)}" target="_blank" rel="noopener noreferrer">Completar cuestionario previo</a>` : ''}
          </div>
          ${appointment.status === 'confirmed' ? '<p class="management-reminder-note">También te enviaremos un recordatorio aproximadamente 24 horas antes.</p>' : ''}
        </div>
        ${management.rescheduling ? renderManagementReschedule(appointment) : ''}
      </section>
    `;
  }

  function renderManagementCancelModal() {
    const management = state.management;
    if (!management.cancelModalOpen) return '';
    return `
      <div class="booking-modal-backdrop" data-action="close-management-cancel-modal" role="presentation">
        <section class="booking-modal" role="dialog" aria-modal="true" aria-labelledby="management-cancel-title">
          <div class="booking-modal-header">
            <div>
              <span class="optional-label">Tu reserva</span>
              <h2 id="management-cancel-title">Cancelar reserva</h2>
            </div>
            <button type="button" class="booking-modal-close" data-action="close-management-cancel-modal" aria-label="Cerrar" ${management.submitting ? 'disabled' : ''}>×</button>
          </div>
          <p>¿Querés cancelar esta reserva pendiente de pago? El horario volverá a quedar disponible.</p>
          ${management.error ? `<div class="document-status error">${escapeHtml(management.error)}</div>` : ''}
          <div class="booking-modal-actions">
            <button type="button" class="secondary-button" data-action="close-management-cancel-modal" ${management.submitting ? 'disabled' : ''}>Volver</button>
            <button type="button" class="danger-outline-button" data-action="confirm-management-cancel" ${management.submitting ? 'disabled' : ''}>${management.submitting ? 'Cancelando…' : 'Cancelar reserva'}</button>
          </div>
        </section>
      </div>
    `;
  }

  function renderVerificationPending() {
    return `
      <section>
        <div class="payment-card">
          <div class="success-mark pending">✉</div>
          <h2 class="section-title">Confirmá tu mail para continuar</h2>
          <p class="section-copy">Completaste el paso 1. Todavía no reservamos ningún turno.</p>
          <p class="section-copy">Te enviamos un enlace para confirmar tu dirección. Al abrirlo, vas a poder elegir servicio, profesional, fecha y horario.</p>
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
      8: renderAppointmentManagement,
    }[state.step]();
    app.innerHTML = `${renderHeader()}${content}${renderManagementCancelModal()}`;
    bindEvents();
    scheduleManagementMeetRefresh();
  }

  function bindEvents() {
    app.querySelector('#booking-intake-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      state.error = '';
      await submitIntake(event.currentTarget);
    });
    const documentsForm = app.querySelector('#appointment-documents-form');
    const documentFileInput = documentsForm?.querySelector('input[name="documents"]');
    const documentLinkInput = documentsForm?.querySelector('textarea[name="links"]');
    if (documentFileInput && state.documentFiles.length && typeof DataTransfer !== 'undefined') {
      try {
        const transfer = new DataTransfer();
        state.documentFiles.forEach((file) => transfer.items.add(file));
        documentFileInput.files = transfer.files;
      } catch {
        // The selected names remain visible and the in-memory files are reused on retry.
      }
    }
    documentFileInput?.addEventListener('change', (event) => {
      state.documentFiles = Array.from(event.currentTarget.files || []);
    });
    documentLinkInput?.addEventListener('input', (event) => {
      state.documentLinksDraft = event.currentTarget.value;
    });
    documentsForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      await submitDocuments(event.currentTarget);
    });

    app.querySelectorAll('[data-action]').forEach((element) => {
      element.addEventListener('click', async (event) => {
        const action = element.dataset.action;
        state.error = '';
        if (action === 'select-service') await selectService(Number(element.dataset.id));
        if (action === 'select-professional') {
          await selectProfessional(
            element.dataset.id === 'first_available'
              ? 'first_available'
              : Number(element.dataset.id),
          );
        }
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
        if (action === 'retry-triage') await loadTriage();
        if (action === 'restart-booking') {
          window.history.replaceState({}, '', '/agenda/');
          state.step = 2;
          state.appointment = null;
          state.documents = [];
          state.documentFiles = [];
          state.documentLinksDraft = '';
          state.documentsMessage = '';
          state.documentsError = '';
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
        if (action === 'open-management-reschedule') {
          await openManagementReschedule();
        }
        if (action === 'close-management-reschedule') {
          state.management.rescheduling = false;
          state.management.selectedDate = '';
          state.management.selectedSlot = '';
          state.management.slots = [];
          state.management.error = '';
          render();
        }
        if (action === 'previous-management-month') {
          await changeManagementMonth(-1);
        }
        if (action === 'next-management-month') {
          await changeManagementMonth(1);
        }
        if (action === 'select-management-date') {
          await selectManagementDate(element.dataset.date);
        }
        if (action === 'select-management-slot') {
          state.management.selectedSlot = element.dataset.slot;
          state.management.error = '';
          render();
        }
        if (action === 'confirm-management-reschedule') {
          await rescheduleManagedAppointment();
        }
        if (action === 'cancel-management-appointment') {
          state.management.cancelModalOpen = true;
          state.management.error = '';
          render();
        }
        if (action === 'close-management-cancel-modal') {
          if (
            element.classList.contains('booking-modal-backdrop') &&
            event.target !== element
          ) {
            return;
          }
          if (!state.management.submitting) {
            state.management.cancelModalOpen = false;
            state.management.error = '';
            render();
          }
        }
        if (action === 'confirm-management-cancel') {
          await cancelManagedAppointment();
        }
      });
    });
  }

  document.addEventListener?.('keydown', (event) => {
    if (
      event.key === 'Escape' &&
      state.management.cancelModalOpen &&
      !state.management.submitting
    ) {
      state.management.cancelModalOpen = false;
      state.management.error = '';
      render();
    }
  });

  loadInitial();
})();
