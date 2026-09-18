import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function portal() {
  const source = await readFile(new URL('../profesional/app.js', import.meta.url), 'utf8');
  class FixedDate extends Date { static now() { return Date.parse('2026-09-18T18:00:00Z'); } }
  const context = {
    Date: FixedDate, URLSearchParams,
    document: { getElementById: () => ({}) },
    window: { location: { search: '', hash: '' } },
  };
  vm.runInNewContext(source.replace('    loadSession();', '    globalThis.portal = { state, renderAppointments, renderPatients, selectedPatientDetails, activateModule, bindEvents };'), context);
  return context.portal;
}

test('agenda defaults to upcoming, keeps ongoing visits and filters search without losing scope', async () => {
  const { state, renderAppointments } = await portal();
  state.appointments = [
    { id: 1, date: '2026-09-18', start_time: '11:00', end_time: '11:30', status: 'confirmed', patient_name: 'Pasado' },
    { id: 2, date: '2026-09-18', start_time: '14:50', end_time: '15:20', status: 'confirmed', patient_name: 'En curso' },
    { id: 3, date: '2026-09-19', start_time: '10:00', end_time: '10:30', status: 'confirmed', patient_name: 'Lejano' },
    { id: 4, date: '2026-09-18', start_time: '16:00', end_time: '16:30', status: 'confirmed', patient_name: 'Cercano' },
    { id: 5, date: '2026-09-20', start_time: '10:00', end_time: '10:30', status: 'cancelled', patient_name: 'Cancelado' },
    { id: 6, date: '2026-09-20', start_time: '11:00', end_time: '11:30', status: 'pending_payment', patient_name: 'Sin pagar' },
  ];
  assert.equal(state.appointmentScope, 'upcoming');
  let html = renderAppointments();
  assert.match(html, /data-appointment-scope="upcoming" aria-pressed="true"/);
  assert.ok(html.indexOf('En curso') < html.indexOf('Cercano'));
  assert.ok(html.indexOf('Cercano') < html.indexOf('Lejano'));
  assert.doesNotMatch(html, /Pasado|Cancelado|Sin pagar/);
  state.appointmentSearch = 'cercano';
  html = renderAppointments();
  assert.match(html, /Cercano/);
  assert.doesNotMatch(html, /En curso|Lejano/);
  state.appointmentScope = 'all';
  state.appointmentSearch = '';
  html = renderAppointments();
  assert.match(html, /Pasado/);
  assert.match(html, /Cancelado/);
  assert.match(html, /Sin pagar/);
  assert.match(html, /data-appointment-scope="all" aria-pressed="true"/);
});

test('directory opens the correct unlinked patient and has no triage column', async () => {
  const { state, renderPatients, selectedPatientDetails } = await portal();
  state.patients = [
    { id: null, directory_key: 'appointment:52', name: 'Paciente uno', next_appointment: { date: '2026-09-23', start_time: '14:00', end_time: '14:30' } },
    { id: null, directory_key: 'appointment:53', name: 'Paciente dos', next_appointment: null },
  ];
  const html = renderPatients();
  assert.doesNotMatch(html, /<th>Triaje<\/th>|patient-status/);
  assert.match(html, /23\/09\/2026/);
  assert.match(html, /data-id="appointment:52"/);
  state.selectedPatientId = 'appointment:53';
  assert.equal(selectedPatientDetails().name, 'Paciente dos');
  state.selectedPatientId = 'appointment:52';
  assert.equal(selectedPatientDetails().name, 'Paciente uno');
});
