import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { requiresAgreementEmailVerification, patientCommunicationsSql, minimumBookingNoticeHours, parseMinimumBookingNoticeHours } from '../src/agreement-policy.mjs';

test('booking notice defaults to four hours, preserves zero and validates admin input', () => {
  assert.equal(minimumBookingNoticeHours(), 4);
  assert.equal(minimumBookingNoticeHours({}), 4);
  assert.equal(minimumBookingNoticeHours({ minimum_booking_notice_hours: 0 }), 0);
  assert.equal(minimumBookingNoticeHours({ minimum_booking_notice_hours: 48 }), 48);
  assert.equal(parseMinimumBookingNoticeHours(undefined), undefined);
  for (const hours of ['0', '4', '48', '8760']) assert.equal(parseMinimumBookingNoticeHours(hours), Number(hours));
  for (const value of ['', ' ', '-1', '0.5', 'Infinity', 'NaN', '8761', '4h', '0x10']) {
    assert.throws(() => parseMinimumBookingNoticeHours(value), { message: 'AGREEMENT_BOOKING_NOTICE_INVALID', statusCode: 422 });
  }
});

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
