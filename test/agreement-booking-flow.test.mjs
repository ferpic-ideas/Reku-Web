import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { buildPatientIntakeSubmission, validatePatientIntakeSubmission } from '../src/patient-intakes.mjs';
import { mapAdminAppointmentDocument, mapAppointmentDocument } from '../src/appointment-documents.mjs';

const setup = async ({ direct = true, required = false, fail = false, emptyFirstMonth = false } = {}) => {
  const source = await readFile(new URL('../agenda/app.js', import.meta.url), 'utf8');
  const requests = [];
  const app = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const agreement = { id: 1, slug: 'demo', type: 'Pago', direct_treatment: direct, treatment_service_id: 2, medical_order_required: required };
  let monthCalls = 0;
  class MockFormData extends FormData {
    constructor(form) {
      super();
      if (form) Object.entries(form).forEach(([key, value]) => this.append(key, value));
    }
  }
  const context = {
    document: { getElementById: () => app },
    window: { location: { search: '', hash: '' } },
    URLSearchParams, URL, FormData: MockFormData,
    fetch: async (path, options = {}) => {
      requests.push({ path, options });
      let payload;
      if (path === '/api/booking/services') payload = { agreement, services: [{ id: 2, name: 'Tratamiento', duration_minutes: 30 }] };
      else if (path.startsWith('/api/booking/days')) {
        const month = new URL(path, 'https://example.test').searchParams.get('month');
        payload = { days: emptyFirstMonth && monthCalls++ === 0 ? [] : [{ date: `${month}-20`, slots_count: 1 }, { date: `${month}-15`, slots_count: 2 }] };
      } else if (path.startsWith('/api/booking/slots')) payload = { slots: ['09:00', '10:00'] };
      else if (path === '/api/booking/intake') payload = fail
        ? { errors: { nombre: 'Revisá tu nombre.' } }
        : { verification_required: true };
      else throw new Error(`Unexpected ${path}`);
      return { ok: !fail, json: async () => payload };
    },
  };
  vm.runInNewContext(source.replace('  loadInitial();', '  globalThis.page = { state, loadServices, selectDate, renderIntakeForm, renderCalendar, renderHeader, renderSuccess, submitIntake, bindEvents };'), context);
  context.page.state.loading = false;
  context.page.state.step = 2;
  context.page.state.agreement = agreement;
  context.page.state.formSlug = 'demo';
  return { ...context.page, app, requests };
};

test('direct treatment bypasses practice and professional selection without preselecting a day', async () => {
  const page = await setup();
  await page.loadServices();
  assert.equal(page.state.step, 4);
  assert.equal(page.state.service.id, 2);
  assert.equal(page.state.professional.id, 'first_available');
  assert.equal(page.state.selectedDate, '');
  assert.equal(page.state.selectedSlot, '');
  assert.equal(page.state.slots.length, 0);
  assert.ok(!page.requests.some(item => item.path.includes('/slots')));
  assert.doesNotMatch(page.app.innerHTML, /class="date-button[^"]*active|id="booking-time-options"/);
  assert.match(page.app.innerHTML, /data-action="go-payment" disabled/);
  assert.ok(page.requests.filter(item => /\/days|\/slots/.test(item.path)).every(item => item.path.includes('professional_id=first_available')));
  assert.ok(!page.requests.some(item => item.path.includes('/professionals')));
  assert.doesNotMatch(page.app.innerHTML, /data-step="3"|Seleccioná la práctica|data-action="select-professional"/);
  assert.match(page.app.innerHTML, /Seleccioná el turno más cercano/);
  assert.equal((page.renderHeader().match(/class="step[ "]/g) || []).length, 3);
});

test('direct treatment searches the next month when this month has no availability', async () => {
  const page = await setup({ emptyFirstMonth: true });
  await page.loadServices();
  assert.equal(page.requests.filter(item => item.path.includes('/days')).length, 2);
  assert.equal(page.state.selectedDate, '');
  assert.ok(!page.requests.some(item => item.path.includes('/slots')));
  const lastRequestedMonth = new URL(page.requests.filter(item => item.path.includes('/days')).at(-1).path, 'https://example.test').searchParams.get('month');
  assert.match(page.app.innerHTML, new RegExp(`data-date="${lastRequestedMonth}-15"`));
});

test('direct treatment loads time options only after the patient chooses a day', async () => {
  const page = await setup();
  page.state.selectedDate = '2026-01-01';
  page.state.selectedSlot = '09:00';
  await page.loadServices();
  assert.equal(page.state.selectedDate, '', 'entering the calendar clears any previous selection');
  assert.equal(page.state.selectedSlot, '');
  const date = page.state.availableDays[0].date;
  await page.selectDate(date);
  assert.equal(page.state.selectedDate, date);
  assert.equal(page.requests.filter(item => item.path.includes('/slots')).length, 1);
  assert.equal(page.state.slots.length, 2);
  assert.match(page.app.innerHTML, /id="booking-time-options"/);
  assert.match(page.app.innerHTML, /data-action="go-payment" disabled/);
});

test('booking confirmation offers only Google Calendar regardless of patient email', async () => {
  const page = await setup();
  for (const email of ['paciente@gmail.com', 'paciente@example.test']) {
    page.state.patient = { email };
    page.state.appointment = { id: 42, payment_status: 'nomina', prefers_google_calendar: false };
    const html = page.renderSuccess();
    assert.match(html, /Agregar a Google Calendar/);
    assert.match(html, /href="\/api\/booking\/appointments\/42\/google-calendar"/);
    assert.doesNotMatch(html, /Usar otro calendario|calendar\.ics|Agregar a mi calendario/);
  }
});

test('normal agreements keep practice selection and optional order wording', async () => {
  const page = await setup({ direct: false });
  await page.loadServices();
  assert.equal(page.state.step, 2);
  assert.match(page.app.innerHTML, /Seleccioná la práctica/);
  assert.match(page.renderIntakeForm(), /Si tenés una orden médica, podés subirla desde acá/);
  assert.doesNotMatch(page.renderIntakeForm(), /name="medical_order"[^>]*required/);
});

test('payroll intake uses the configured identifier label, safely escaped, with a legacy fallback', async () => {
  const page = await setup({ direct: false });
  page.state.agreement.type = 'Nomina';
  page.state.agreement.identifier_label = 'Número de cliente';
  assert.match(page.renderIntakeForm(), /Número de cliente\s*<input name="identificador"/);
  page.state.agreement.identifier_label = '<img src=x onerror=alert(1)>';
  assert.match(page.renderIntakeForm(), /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(page.renderIntakeForm(), /<img src=x/);
  page.state.agreement.identifier_label = '';
  assert.match(page.renderIntakeForm(), /Identificador\s*<input name="identificador"/);
  page.state.agreement.type = 'Pago';
  assert.doesNotMatch(page.renderIntakeForm(), /name="identificador"/);
  const submission = buildPatientIntakeSubmission({ values: { nombre: 'Ana', apellido: 'Perez', telefono: '1155551111', email: 'ana@example.test' } });
  assert.equal((await validatePatientIntakeSubmission(submission, { type: 'Nomina', identifier_label: 'DNI' })).identificador, 'Ingresá tu DNI para validar la nómina.');
});

test('required orders block progression without a file and keep patient fields', async () => {
  const page = await setup({ required: true });
  page.state.step = 1;
  assert.match(page.renderIntakeForm(), /name="medical_order"[^>]*required/);
  await page.submitIntake({ nombre: 'Paciente', email: 'test@example.test' });
  assert.equal(page.requests.length, 0);
  assert.equal(page.state.intakeValues.nombre, 'Paciente');
  assert.match(page.state.intakeErrors.medical_order, /Subí la orden médica/);
});

test('multipart order is retained after validation errors and sent only with patient fields', async () => {
  const page = await setup({ required: true, fail: true });
  page.state.step = 1;
  const file = new File(['%PDF-1.4 test'], 'orden.pdf', { type: 'application/pdf' });
  await page.submitIntake({ nombre: 'Paciente', medical_order: file });
  assert.equal(page.state.intakeMedicalOrder.name, 'orden.pdf');
  assert.equal(page.state.intakeErrors.nombre, 'Revisá tu nombre.');
  assert.equal(page.requests[0].options.headers['Content-Type'], undefined);
  assert.equal(page.requests[0].options.body.get('medical_order').name, 'orden.pdf');
  assert.match(page.app.innerHTML, /aria-live="polite">orden.pdf<\/span>/);
});

test('medical order picker uses Spanish copy and replaces the hint immediately with the selected filename', async () => {
  const page = await setup({ required: true });
  page.state.step = 1;
  const html = page.renderIntakeForm();
  assert.match(html, /Seleccionar archivo<\/span>/);
  assert.match(html, /aria-live="polite">PDF o imagen JPG, PNG o WebP\. Hasta 10 MB\.<\/span>/);
  assert.doesNotMatch(html, /Para poder sacar|Choose File|No file chosen|Seleccionada:/i);
  assert.match(html, /data-action="clear-medical-order" hidden/);
  const handlers = {};
  const input = { value: '', addEventListener: (event, callback) => { handlers[event] = callback; } };
  const status = { textContent: '' };
  const clear = { hidden: true, addEventListener: (event, callback) => { handlers.clear = callback; } };
  let errorRemoved = false;
  const orderError = { remove: () => { errorRemoved = true; } };
  page.state.intakeErrors = { medical_order: 'Subí la orden médica para continuar.', nombre: 'Revisá tu nombre.' };
  page.state.intakeValues.email = 'paciente@example.test';
  const previousHtml = page.app.innerHTML;
  page.app.querySelector = selector => ({
    'input[name="medical_order"]': input,
    '#medical-order-file-name': status,
    '[data-action="clear-medical-order"]': clear,
    '.medical-order-field .field-error': orderError,
  })[selector] || null;
  page.bindEvents();
  handlers.change({ currentTarget: { files: [] } });
  assert.equal(errorRemoved, false, 'cancelling the picker does not clear the required order error');
  assert.ok(page.state.intakeErrors.medical_order);
  const file = new File(['%PDF-1.4 test'], 'orden <personal>.pdf', { type: 'application/pdf' });
  handlers.change({ currentTarget: { files: [file] } });
  assert.equal(errorRemoved, true, 'selecting a file immediately removes the visible order alert');
  assert.equal(page.state.intakeErrors.medical_order, undefined);
  assert.equal(page.state.intakeErrors.nombre, 'Revisá tu nombre.');
  assert.equal(page.state.intakeValues.email, 'paciente@example.test');
  assert.equal(page.app.innerHTML, previousHtml, 'selection does not rerender or reset the form');
  assert.doesNotMatch(page.renderIntakeForm(), /Subí la orden médica para continuar/);
  assert.equal(page.state.intakeMedicalOrder, file);
  assert.equal(status.textContent, 'orden <personal>.pdf');
  assert.equal(clear.hidden, false);
  assert.match(page.renderIntakeForm(), /orden &lt;personal&gt;\.pdf/);
  assert.doesNotMatch(page.renderIntakeForm(), /aria-live="polite">PDF o imagen/);
  handlers.change({ currentTarget: { files: [] } });
  assert.equal(page.state.intakeMedicalOrder, file, 'cancelling replacement preserves the chosen order');
  handlers.clear();
  assert.equal(page.state.intakeMedicalOrder, null);
  assert.match(page.app.innerHTML, /aria-live="polite">PDF o imagen/);
  assert.match(page.app.innerHTML, /name="medical_order"[^>]*required/);
});

test('medical order helper is normal weight and the native picker remains keyboard accessible', async () => {
  const css = await readFile(new URL('../agenda/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.medical-order-file-name,\s*\.medical-order-help\s*\{[^}]*font-weight: 400;/);
  assert.match(css, /\.medical-order-picker:focus-within/);
  const html = (await setup()).renderIntakeForm();
  assert.doesNotMatch(html, /name="medical_order"[^>]*(?:hidden|tabindex="-1")/);
});

test('server validates required, optional, forged and oversized medical orders', async () => {
  const submission = buildPatientIntakeSubmission({ values: { nombre: 'Ana', apellido: 'Perez', telefono: '1155551111', email: 'ana@example.test' } });
  assert.deepEqual(await validatePatientIntakeSubmission(submission, { type: 'Pago' }), {});
  assert.match((await validatePatientIntakeSubmission(submission, { medical_order_required: true })).medical_order, /orden médica/);
  submission.medicalOrder = { filename: 'orden.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') };
  assert.deepEqual(await validatePatientIntakeSubmission(submission, { medical_order_required: true }), {});
  submission.medicalOrder.buffer = Buffer.from('<script>not a PDF</script>');
  assert.match((await validatePatientIntakeSubmission(submission, {})).medical_order, /PDF o imagen/);
  submission.medicalOrder.buffer = Buffer.alloc(10 * 1024 * 1024 + 1);
  assert.match((await validatePatientIntakeSubmission(submission, {})).medical_order, /10 MB/);
});

test('admin and physio document views identify orders without exposing private storage', () => {
  for (const map of [mapAdminAppointmentDocument, mapAppointmentDocument]) {
    const document = map({ id: 1, kind: 'file', purpose: 'medical_order', original_name: 'orden.pdf', storage_path: 'intakes/private' });
    assert.equal(document.name, 'Orden médica · orden.pdf');
    assert.equal(document.purpose, 'medical_order');
    assert.equal(document.storage_path, undefined);
  }
});
