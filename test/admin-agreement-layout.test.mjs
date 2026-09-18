import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../admin/app.js', import.meta.url), 'utf8');
const renderSource = source.slice(source.indexOf('  function renderAgreementFormFields()'), source.indexOf('  function renderAgreements()'));
const render = (overrides = {}) => vm.runInNewContext(`${renderSource}\nrenderAgreementFormFields()`, {
  agreementFormValues: () => ({ name: 'YPF', slug: 'ypf', type: 'Nomina', logo_url: '/logo', pdf_url: '/pdf', ...overrides }),
  escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
  state: { services: [{ id: 2, name: 'Tratamiento', active: true }] },
});

test('agreement form groups requested pairs in stable rows', () => {
  const html = render();
  const rows = html.split('<div class="grid-two agreement-form-row">').slice(1);
  assert.equal(rows.length, 4);
  for (const [index, names] of [['name', 'type'], ['slug', 'identifier_label'], ['direct_treatment', 'cobranded', 'medical_order_required'], ['logo', 'remove_logo', 'pdf', 'remove_pdf']].entries()) {
    let previous = -1;
    for (const name of names) {
      const position = rows[index].indexOf(`name="${name}"`);
      assert.ok(position > previous, `${name} belongs in row ${index + 1} in the requested order`);
      previous = position;
    }
  }
  assert.match(rows[2], /name="treatment_service_id"/);
  assert.match(rows[3], /name="logo"[\s\S]*name="remove_logo"[\s\S]*<\/div>\s*<div class="agreement-form-stack">[\s\S]*name="pdf"[\s\S]*name="remove_pdf"/);
});

test('conditional agreement fields keep their behavior and removal stays with its file', () => {
  const html = render({ type: 'Pago', direct_treatment: true, treatment_service_id: 2, pdf_url: '' });
  assert.match(html, /data-nomina-identifier hidden/);
  assert.match(html, /name="identifier_label"[^>]*disabled/);
  assert.match(html, /name="treatment_service_id" required/);
  assert.match(html, /value="2" selected/);
  assert.match(html, /name="remove_logo"/);
  assert.doesNotMatch(html, /name="remove_pdf"/);
  assert.doesNotMatch(html, /data-payment-fields hidden/);
  assert.match(render(), /data-payment-fields hidden/);
  assert.doesNotMatch(render({ logo_url: '', pdf_url: '' }), /name="remove_(logo|pdf)"/);
});

test('agreement layout prevents vertical stretching and keeps mobile stacking', async () => {
  const css = await readFile(new URL('../admin/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.agreement-form-row\s*\{\s*align-items: start;/);
  assert.match(css, /\.agreement-form-row label\s*\{[^}]*align-content: start;/);
  assert.match(css, /\.agreement-form-layout \.check-row\s*\{\s*padding-top: 0;/);
  assert.match(css, /\.grid-two,\s*\.grid-three\s*\{\s*grid-template-columns: 1fr;/);
});
