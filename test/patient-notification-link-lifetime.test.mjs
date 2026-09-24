import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { escapeHtml } from '../src/http.mjs';
import { config } from '../src/config.mjs';
import { patientCommunicationsSql } from '../src/agreement-policy.mjs';
import { googleCalendarTemplateUrl, isGoogleCalendarEmail, patientCalendarActionUrl } from '../src/appointment-calendar.mjs';

for (const action of ['notifyPatientForAppointment', 'notifyPatientForPendingPayment', 'notifyPatientAppointmentFollowup']) {
  test(`${action} delivers without invalidating earlier questionnaire or waiting-room links`, async () => {
    const sql = [], mail = [], audit = [];
    const source = await readFile(new URL('../src/appointment-notifications.mjs', import.meta.url), 'utf8');
    const appointment = { id: 1, appointment_date: '2026-10-01', start_time: '14:00', end_time: '14:30',
      patient_email: 'synthetic@example.test', professional_name: 'Profesional de prueba', service_name: 'Consulta', google_meet_url: 'https://meet.google.com/synthetic' };
    const context = {
      config, escapeHtml, googleCalendarTemplateUrl, isGoogleCalendarEmail, patientCalendarActionUrl, patientCommunicationsSql,
      query: async text => { sql.push(text); return { rows: /RETURNING/.test(text) ? [appointment] : [] }; },
      recordAudit: async event => audit.push(event),
      readAppointmentConsultationStatus: async () => 'pending',
      createPatientAppointmentAccessLink: async () => ({ id: 2, url: 'https://www.reku.io/turnos/#manage=new-token', meet_url: 'https://www.reku.io/turnos/?view=videollamada#manage=new-token', bot_url: 'https://www.reku.io/bot#appointment=new-token' }),
      sendEmail: async message => { mail.push(message); return { id: 'synthetic-delivery' }; },
      revokeOtherPatientAppointmentAccessLinks: async () => { throw new Error('Unexpected link rotation'); },
    };
    vm.runInNewContext(source.replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '').replace(/\bexport /g, '') + `\nglobalThis.run = ${action};`, context);
    const result = await context.run(1);
    assert.equal(result.ok, true, result.error);
    assert.equal(mail.length, 1);
    assert.ok(audit.some(event => /notified$/.test(event)));
    assert.ok(!audit.some(event => /rotation/.test(event)));
    assert.ok(!sql.some(text => /revoked_at|DELETE FROM patient_appointment/.test(text)));
    assert.doesNotMatch(source, /revokeOtherPatientAppointmentAccessLinks|rotateDeliveredPatientAccessLink/);
  });
}
