import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { requiresAgreementEmailVerification, patientCommunicationsSql } from '../src/agreement-policy.mjs';

test('email ownership verification follows the agreement, not a global testing switch', () => {
  for (const agreement of [undefined, {}, { access_mode: 'web' }, { access_mode: 'web', email_verification_required: true }]) {
    assert.equal(requiresAgreementEmailVerification(agreement), true);
  }
  for (const agreement of [{ access_mode: 'web', email_verification_required: false }, { access_mode: 'api' }, { access_mode: 'api', email_verification_required: true }]) {
    assert.equal(requiresAgreementEmailVerification(agreement), false);
  }
});

test('communications are disabled only for API agreements delegated to integrator', () => {
  const sql = patientCommunicationsSql('appointment');
  assert.match(sql, /communication_agreement.id = appointment.agreement_id/);
  assert.match(sql, /access_mode = 'api'/);
  assert.match(sql, /communication_sender = 'integrator'/);
  assert.throws(() => patientCommunicationsSql('a; DROP TABLE'), /INVALID_SQL_ALIAS/);
});

test('API keeps co-branding and logo while hiding PDF and web payment fields', async () => {
  const source = await readFile(new URL('../admin/app.js', import.meta.url), 'utf8');
  assert.match(source, /name="access_mode"/);
  assert.match(source, /name="communication_sender"/);
  assert.match(source, /<label class="check-row">\s*<input type="checkbox" name="cobranded"/);
  assert.match(source, /<div class="agreement-form-stack">\s*<label>\s*Logo/);
  assert.match(source, /<div class="agreement-form-stack" data-web-only>\s*<label>\s*PDF Cómo funciona/);
  assert.match(source, /input.disabled = hide/);
});
