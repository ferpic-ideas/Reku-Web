import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('failed professional saves retain the form, show inline feedback, and allow retrying empty selections', async () => {
  const source = await readFile(new URL('../admin/app.js', import.meta.url), 'utf8');
  const handler = source.match(/^  async function handleProfessionalSubmit\(event\) \{[\s\S]*?^  }/m)?.[0];
  assert.ok(handler);
  const photo = new Blob(['synthetic-photo'], { type: 'image/png' });
  const feedback = { hidden: true, textContent: '', focus() { this.focused = true; }, scrollIntoView() {} };
  const submit = { disabled: false, textContent: 'Guardar profesional' };
  const form = {
    dataset: {}, isConnected: true, active: { checked: true },
    fields: { name: 'Nombre editado', bio: 'Texto sin guardar', account_password: 'Clave temporal' },
    querySelector(selector) { return selector === '#professional-form-error' ? feedback : submit; },
    querySelectorAll(selector) { return selector.includes('service_ids') ? [{ value: '1' }] : []; },
  };
  class FormSnapshot extends FormData {
    constructor(form) {
      super();
      for (const [key, value] of Object.entries(form.fields)) this.set(key, value);
      this.set('photo', photo, 'photo.png');
    }
  }
  const state = { editingProfessionalId: 12, dialog: { type: 'professional-form' }, user: { id: 1 } };
  const statuses = [];
  const requests = [];
  let fail = true;
  let loads = 0;
  const context = {
    state, FormData: FormSnapshot, collectAvailability: () => [],
    api: async (path, options) => {
      requests.push({ path, ...options });
      assert.equal(submit.disabled, true);
      if (fail) throw new Error('Revisá los horarios cargados.');
    },
    loadData: async () => { loads++; },
    setStatus: (...args) => statuses.push(args),
  };
  vm.runInNewContext(`${handler}\nglobalThis.save = handleProfessionalSubmit;`, context);
  const event = { preventDefault() {}, currentTarget: form };
  await context.save(event);
  assert.equal(feedback.hidden, false);
  assert.equal(feedback.focused, true);
  assert.equal(feedback.textContent, 'Revisá los horarios cargados.');
  assert.deepEqual(statuses, [], 'Errors must not rerender and discard the current form');
  assert.equal(state.editingProfessionalId, 12);
  assert.equal(state.dialog.type, 'professional-form');
  assert.equal(form.fields.bio, 'Texto sin guardar');
  assert.equal(submit.disabled, false);
  assert.equal(submit.textContent, 'Guardar profesional');
  assert.equal(loads, 0);
  fail = false;
  await context.save(event);
  assert.equal(feedback.hidden, true);
  assert.equal(state.dialog, null);
  assert.equal(loads, 1);
  assert.deepEqual(statuses, [['Profesional guardado.', 'ok']]);
  for (const request of requests) {
    assert.equal(request.path, '/api/admin/professionals/12');
    assert.equal(request.method, 'PUT');
    assert.equal(request.body.get('agreement_ids'), '[]');
    assert.equal(request.body.get('availability'), '[]');
    assert.equal(request.body.get('bio'), 'Texto sin guardar');
    assert.equal(await request.body.get('photo').text(), 'synthetic-photo');
  }
});
