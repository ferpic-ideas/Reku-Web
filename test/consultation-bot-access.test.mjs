import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { consultationBotMode, validateBotAppointment, botAppointmentCookie, requireBotAppointment, botAccessMessages } from '../src/consultation-bot-access.mjs';
import { handleConsultationBot } from '../src/consultation-bot.mjs';

test('access mode is server-only and invalid values fail closed', () => {
  assert.equal(consultationBotMode({}), 'test');
  assert.equal(consultationBotMode({ APP_ENV: 'production' }), 'production');
  assert.equal(consultationBotMode({ APP_ENV: 'production', CONSULTATION_BOT_MODE: 'test' }), 'test');
  assert.equal(consultationBotMode({ CONSULTATION_BOT_MODE: 'production' }), 'production');
  assert.throws(() => consultationBotMode({ CONSULTATION_BOT_MODE: 'prod' }), /MODE_INVALID/);
});
test('production validates confirmed current appointment, tenant and single-use marker', () => {
  const row = { appointment_id: 1, status: 'confirmed', current_appointment: true, agreement_prefix: 'ypf', completed_at: null };
  assert.equal(validateBotAppointment(row, 'ypf'), row);
  assert.throws(() => validateBotAppointment({ ...row, consultation_required: false }, 'ypf'), /ACCESS_REQUIRED/);
  for (const invalid of [null, { ...row, status: 'cancelled' }, { ...row, status: 'pending_payment' }, { ...row, current_appointment: false }])
    assert.throws(() => validateBotAppointment(invalid, 'ypf'), /ACCESS_REQUIRED/);
  assert.throws(() => validateBotAppointment(row, 'other'), /ACCESS_REQUIRED/);
  assert.throws(() => validateBotAppointment({ ...row, completed_at: new Date() }, 'ypf'), /ACCESS_COMPLETED/);
  assert.ok(validateBotAppointment({ ...row, completed_at: new Date() }, 'ypf', { allowCompleted: true }));
});
test('appointment ids cannot substitute for a private access token; cookie is scoped and HttpOnly', async () => {
  await assert.rejects(requireBotAppointment({ headers: {} }, { token: '123', execute: async () => { throw new Error('Should not query'); } }), /ACCESS_REQUIRED/);
  assert.match(botAppointmentCookie('a'.repeat(43)), /Path=\/api\/bot\/; HttpOnly; SameSite=Strict/);
  assert.ok(!botAppointmentCookie('a'.repeat(43)).includes('Domain='));
});
test('production context shows friendly denial and session cannot be created with client test bypass', async () => {
  const before = process.env.CONSULTATION_BOT_MODE;
  process.env.CONSULTATION_BOT_MODE = 'production';
  const call = async (method, action, body = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, headers: { host: 'www.reku.io', origin: 'https://www.reku.io' } });
    let code, data;
    await handleConsultationBot(req, { writeHead(c) { code = c; }, end(text) { data = JSON.parse(text); } }, new URL(`https://www.reku.io/api/bot/${action}?mode=test`));
    return { code, data };
  };
  try {
    const context = await call('GET', 'context');
    assert.equal(context.data.access.allowed, false);
    assert.equal(context.data.access.message, botAccessMessages.required);
    const session = await call('POST', 'session', { consent: true, mode: 'test', appointmentId: 1 });
    assert.equal(session.code, 403);
    assert.equal(session.data.error, botAccessMessages.required);
  } finally { if (before === undefined) delete process.env.CONSULTATION_BOT_MODE; else process.env.CONSULTATION_BOT_MODE = before; }
});
