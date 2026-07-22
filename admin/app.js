(() => {
  const app = document.getElementById('app');
  const publicBaseUrl = 'https://www.reku.io';
  let csrfToken = '';
  const state = {
    user: null,
    loading: true,
    active: 'agreements',
    menuOpen: false,
    userMenuOpen: false,
    editingAgreementId: null,
    agreements: [],
    patientIntakes: [],
    contacts: [],
    nominaEntries: [],
    patientAgreementFilter: '',
    nominaAgreementFilter: '',
    status: '',
    statusType: '',
    dialog: null,
  };

  const modules = [
    { id: 'agreements', label: 'Acuerdos' },
    { id: 'patient-intakes', label: 'Altas' },
    { id: 'contacts', label: 'Contactos' },
    { id: 'nomina', label: 'Nóminas' },
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
    const [agreementData, patientData, contactData, nominaData] = await Promise.all([
      api('/api/admin/agreements'),
      api(`/api/admin/patient-intakes${state.patientAgreementFilter ? `?agreement_id=${state.patientAgreementFilter}` : ''}`),
      api('/api/admin/contacts'),
      api(`/api/admin/nomina${state.nominaAgreementFilter ? `?agreement_id=${state.nominaAgreementFilter}` : ''}`),
    ]);
    state.agreements = agreementData.agreements || [];
    state.patientIntakes = patientData.patient_intakes || [];
    state.contacts = contactData.contacts || [];
    state.nominaEntries = nominaData.nomina_entries || [];
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

    app.className = `app-shell${state.menuOpen ? ' menu-open' : ''}`;
    app.innerHTML = `
      ${state.menuOpen ? '<div class="overlay" data-action="close-mobile-menu"></div>' : ''}
      <aside class="sidebar">
        <div class="side-brand">
          <img src="/images/logo-reku.svg" alt="Reku" />
          <span>Administración</span>
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
        <div class="sidebar-foot">Reku Admin</div>
      </aside>
      <main class="content">
        <header class="topbar">
          <div class="brand-row">
            <button type="button" class="icon-button mobile-menu-button" data-action="toggle-mobile-menu" aria-label="Abrir menú">☰</button>
            <div>
              <h1>${escapeHtml(activeModuleLabel())}</h1>
              <p>${escapeHtml(activeModuleDescription())}</p>
            </div>
          </div>
          <div class="topbar-actions">
            <button type="button" class="secondary-button" data-action="refresh">Actualizar</button>
            <div class="user-menu">
              <button type="button" class="user-menu-trigger" data-action="toggle-user-menu">
                ${escapeHtml(state.user.email)} ▾
              </button>
              <div class="user-menu-popover" ${state.userMenuOpen ? '' : 'hidden'}>
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
    return modules.find((module) => module.id === state.active)?.label || 'Admin';
  }

  function activeModuleDescription() {
    const descriptions = {
      agreements: 'Configuración de acuerdos, cobranding, PDFs, pagos y templates.',
      'patient-intakes': 'Registro de altas recibidas desde el formulario.',
      contacts: 'Registro de contactos recibidos desde la página principal.',
      nomina: 'Carga manual o por CSV de personas habilitadas por acuerdo.',
    };
    return descriptions[state.active] || '';
  }

  function renderActiveModule() {
    if (state.active === 'agreements') return renderAgreements();
    if (state.active === 'patient-intakes') return renderPatientIntakes();
    if (state.active === 'contacts') return renderContacts();
    if (state.active === 'nomina') return renderNomina();
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

    return '';
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

  function renderAgreements() {
    const item = agreementFormValues();
    return `
      <section class="panel">
        <div class="panel-header">
          <h2>${state.editingAgreementId ? 'Editar acuerdo' : 'Nuevo acuerdo'}</h2>
          ${state.editingAgreementId ? '<button type="button" class="secondary-button" data-action="cancel-agreement-edit">Cancelar edición</button>' : ''}
        </div>
        <form id="agreement-form" class="grid-two">
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
            <select name="type">
              <option value="Pago" ${item.type === 'Pago' ? 'selected' : ''}>Pago</option>
              <option value="Nomina" ${item.type === 'Nomina' ? 'selected' : ''}>Nómina</option>
            </select>
          </label>
          <label class="check-row">
            <input type="checkbox" name="cobranded" ${item.cobranded ? 'checked' : ''} />
            Cobranded
          </label>
          <label>
            Link pago evaluación
            <input name="payment_evaluation_url" type="url" value="${escapeHtml(item.payment_evaluation_url)}" />
          </label>
          <label>
            Link pago tratamiento
            <input name="payment_treatment_url" type="url" value="${escapeHtml(item.payment_treatment_url)}" />
          </label>
          <label>
            Logo
            <input name="logo" type="file" accept="image/*" />
          </label>
          <label>
            PDF Cómo funciona
            <input name="pdf" type="file" accept="application/pdf" />
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
          <div class="form-actions span-two">
            <button type="button" class="secondary-button" data-action="validate-template">Validar template</button>
            <button type="submit" class="primary-button">Guardar acuerdo</button>
          </div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-header">
          <h2>Acuerdos</h2>
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
              ${state.agreements.length ? state.agreements.map(renderAgreementRow).join('') : '<tr><td colspan="7">No hay acuerdos cargados.</td></tr>'}
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

  function renderPatientIntakes() {
    return `
      <section class="panel">
        <div class="toolbar">
          <label>
            Filtrar por acuerdo
            <select id="patient-agreement-filter">
              ${renderAgreementOptions()}
            </select>
          </label>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Acuerdo</th>
                <th>Paciente</th>
                <th>Teléfono</th>
                <th>Mail</th>
                <th>Identificador</th>
                <th>Email</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${state.patientIntakes.length ? state.patientIntakes.map(renderPatientRow).join('') : '<tr><td colspan="8">No hay altas registradas.</td></tr>'}
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
        <td>${item.email_error ? `<span class="muted">${escapeHtml(item.email_error)}</span>` : 'OK'}</td>
        <td>
          <button
            type="button"
            class="danger-button"
            data-action="delete-patient"
            data-id="${item.id}"
            ${state.user.can_delete_records ? '' : 'disabled'}
          >
            Eliminar
          </button>
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

  function renderNomina() {
    const nominaAgreements = state.agreements.filter((agreement) => agreement.type === 'Nomina');
    return `
      <section class="panel">
        <div class="panel-header">
          <h2>Agregar registro</h2>
        </div>
        ${nominaAgreements.length ? `
          <form id="nomina-form" class="grid-four grid-three">
            <label>
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
            <label>
              Identificador
              <input name="identificador" required />
            </label>
            <div class="form-actions span-two">
              <button type="submit" class="primary-button">Agregar registro</button>
            </div>
          </form>
          <form id="nomina-csv-form" class="grid-two">
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
              <button type="submit" class="secondary-button">Subir CSV</button>
            </div>
          </form>
        ` : '<p class="muted">Primero creá un acuerdo de tipo Nómina.</p>'}
      </section>
      <section class="panel">
        <div class="toolbar">
          <label>
            Filtrar por acuerdo
            <select id="nomina-agreement-filter">
              ${renderAgreementOptions({ onlyNomina: true })}
            </select>
          </label>
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
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${state.nominaEntries.length ? state.nominaEntries.map(renderNominaRow).join('') : '<tr><td colspan="6">No hay registros de nómina.</td></tr>'}
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
        <td><button type="button" class="danger-button" data-action="delete-nomina" data-id="${item.id}">Eliminar</button></td>
      </tr>
    `;
  }

  function bindEvents() {
    document.querySelectorAll('[data-module]').forEach((button) => {
      button.addEventListener('click', () => {
        state.active = button.dataset.module;
        state.menuOpen = false;
        clearStatus();
        render();
      });
    });

    document.querySelectorAll('[data-action]').forEach((element) => {
      element.addEventListener('click', handleActionClick);
    });

    document.getElementById('agreement-form')?.addEventListener('submit', handleAgreementSubmit);
    document.getElementById('nomina-form')?.addEventListener('submit', handleNominaSubmit);
    document.getElementById('nomina-csv-form')?.addEventListener('submit', handleNominaCsvSubmit);
    document
      .getElementById('change-password-form')
      ?.addEventListener('submit', handleChangePasswordSubmit);

    const patientFilter = document.getElementById('patient-agreement-filter');
    if (patientFilter) {
      patientFilter.value = state.patientAgreementFilter;
      patientFilter.addEventListener('change', async () => {
        state.patientAgreementFilter = patientFilter.value;
        await loadData();
        render();
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
  }

  async function handleActionClick(event) {
    const action = event.currentTarget.dataset.action;
    const id = Number(event.currentTarget.dataset.id || 0);
    const slug = event.currentTarget.dataset.slug || '';

    try {
      if (action === 'toggle-mobile-menu') {
        state.menuOpen = !state.menuOpen;
        render();
        return;
      }
      if (action === 'close-mobile-menu') {
        state.menuOpen = false;
        render();
        return;
      }
      if (action === 'toggle-user-menu') {
        state.userMenuOpen = !state.userMenuOpen;
        render();
        return;
      }
      if (action === 'refresh') {
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
      if (action === 'close-dialog') {
        state.dialog = null;
        render();
        return;
      }
      if (action === 'confirm-delete') {
        await runConfirmedDelete();
        return;
      }
      if (action === 'cancel-agreement-edit') {
        state.editingAgreementId = null;
        render();
        return;
      }
      if (action === 'validate-template') {
        await validateTemplate();
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
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
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
    };
    const labels = {
      agreement: 'Acuerdo eliminado.',
      patient: 'Alta eliminada.',
      contact: 'Contacto eliminado.',
      nomina: 'Registro eliminado.',
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

  loadSession();
})();
