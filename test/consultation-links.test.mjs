import test from 'node:test';
import assert from 'node:assert/strict';
import { appointmentBotUrl, professionalReportUrl, adminReportUrl, adminReHubTriageUrl } from '../src/consultation-links.mjs';
import { hasBotAppointmentAccess } from '../src/consultation-bot-access.mjs';

test('admin report and ReHub links are distinct and reject unsafe destinations', () => {
  assert.equal(adminReportUrl(12), '/api/admin/appointments/12/consultation-report');
  assert.equal(adminReportUrl('../12'), '');
  assert.equal(adminReHubTriageUrl('https://patient.rehub.cloud/opentriage/example'), 'https://patient.rehub.cloud/opentriage/example');
  for (const url of ['', 'javascript:alert(1)', 'http://patient.rehub.cloud', 'https://rehub.cloud.attacker.test', 'https://user:password@rehub.cloud']) assert.equal(adminReHubTriageUrl(url), '');
});

test('private appointment URLs use the registered prefix and keep tokens out of queries', () => {
  const token = 'a'.repeat(43);
  const url = new URL(appointmentBotUrl('empresa', token, 'https://www.reku.io'));
  assert.equal(url.hostname, 'empresa.reku.io');
  assert.equal(url.pathname, '/bot');
  assert.equal(url.search, '');
  assert.equal(url.hash, `#appointment=${token}`);
  assert.equal(new URL(appointmentBotUrl('', token, 'https://www.reku.io')).hostname, 'www.reku.io');
  assert.throws(() => appointmentBotUrl('attacker.example', token, 'https://www.reku.io'));
  assert.throws(() => appointmentBotUrl('empresa', '123', 'https://www.reku.io'));
  assert.equal(professionalReportUrl(123), '/api/professional/appointments/123/consultation-report');
  assert.equal(professionalReportUrl('../123'), '');
});

test('test mode still enforces appointment access whenever its cookie is present', () => {
  const previous = process.env.CONSULTATION_BOT_MODE;
  process.env.CONSULTATION_BOT_MODE = 'test';
  try {
    assert.equal(hasBotAppointmentAccess({ headers: {} }), false);
    assert.equal(hasBotAppointmentAccess({ headers: { cookie: 'reku_bot_appointment=invalid' } }), true);
    assert.equal(hasBotAppointmentAccess({ headers: { cookie: 'reku_bot_appointment=' } }), true);
  } finally {
    if (previous === undefined) delete process.env.CONSULTATION_BOT_MODE;
    else process.env.CONSULTATION_BOT_MODE = previous;
  }
});
