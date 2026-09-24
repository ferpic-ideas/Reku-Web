import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import pg from 'pg';
import { consultationStatusSql } from '../src/consultation-status.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
test('professional directory includes confirmed appointment snapshots without reactivating patients or leaking other professionals', { skip: !databaseUrl }, async () => {
  assert.match(new URL(databaseUrl).pathname, /test/i);
  const schema = `professional_directory_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await pool.query(`
      CREATE TABLE patients (id BIGINT PRIMARY KEY, full_name TEXT, email TEXT, phone TEXT,
        email_normalized TEXT UNIQUE, active BOOLEAN);
      CREATE TABLE services (id BIGINT PRIMARY KEY, name TEXT);
      CREATE TABLE agreements (id BIGINT PRIMARY KEY, slug TEXT, subdomain_prefix TEXT, deleted_at TIMESTAMPTZ);
      CREATE TABLE appointments (id BIGINT PRIMARY KEY, patient_id BIGINT, professional_id BIGINT,
        patient_name TEXT, patient_email TEXT, patient_phone TEXT, status TEXT, consultation_required BOOLEAN DEFAULT TRUE,
        appointment_date DATE, start_time TIME, end_time TIME, service_id BIGINT DEFAULT 1,
        agreement_id BIGINT, agreement_slug_snapshot TEXT, agreement_name_snapshot TEXT,
        agreement_type_snapshot TEXT, triage_assignment_error TEXT, triage_reminder_sent_at TIMESTAMPTZ,
        triage_reminder_count INT DEFAULT 0, payment_status TEXT, amount NUMERIC DEFAULT 0);
      CREATE TABLE consultation_bot_usage (appointment_id BIGINT, completed_at TIMESTAMPTZ,
        report_encrypted TEXT, message_count INT DEFAULT 0, audio_count INT DEFAULT 0);
      CREATE TABLE appointment_documents (id BIGINT, appointment_id BIGINT, kind TEXT, purpose TEXT,
        original_name TEXT, mime_type TEXT, size_bytes BIGINT, external_url TEXT, created_at TIMESTAMPTZ);
      INSERT INTO services VALUES (1, 'Tratamiento');
      INSERT INTO patients VALUES (1, 'Ficha activa', 'active@example.test', '', 'active@example.test', true),
        (2, 'Ficha inactiva', 'inactive@example.test', '', 'inactive@example.test', false),
        (3, 'Paciente histórico', 'past@example.test', '', 'past@example.test', true),
        (4, 'Otro profesional', 'other@example.test', '', 'other@example.test', true);
      INSERT INTO appointments (id, patient_id, professional_id, patient_name, patient_email, patient_phone,
        status, appointment_date, start_time, end_time) VALUES
        (10, 1, 100, 'Activa', 'active@example.test', '', 'confirmed', CURRENT_DATE+2, '14:00', '14:30'),
        (11, NULL, 100, 'Sin vincular', 'active@example.test', '', 'confirmed', CURRENT_DATE+1, '14:00', '14:30'),
        (20, NULL, 100, 'Reserva inactiva', 'inactive@example.test', '', 'confirmed', CURRENT_DATE+1, '15:00', '15:30'),
        (21, 2, 100, 'Reserva inactiva', 'inactive@example.test', '', 'confirmed', CURRENT_DATE+3, '15:00', '15:30'),
        (30, NULL, 100, 'Sin ficha', 'new@example.test', '', 'confirmed', CURRENT_DATE+2, '16:00', '16:30'),
        (31, NULL, 100, 'Sin ficha', ' NEW@example.test ', '', 'confirmed', CURRENT_DATE+1, '16:00', '16:30'),
        (40, 3, 100, 'Pasado', 'past@example.test', '', 'confirmed', CURRENT_DATE-1, '14:00', '14:30'),
        (41, 3, 100, 'Pasado', 'past@example.test', '', 'cancelled', CURRENT_DATE+1, '14:00', '14:30'),
        (50, 4, 200, 'Privado', 'other@example.test', '', 'confirmed', CURRENT_DATE+1, '14:00', '14:30'),
        (51, NULL, 200, 'Privado sin ficha', 'private@example.test', '', 'confirmed', CURRENT_DATE+1, '14:00', '14:30'),
        (52, NULL, 200, 'Mismo email otro profesional', 'new@example.test', '', 'confirmed', CURRENT_DATE+1, '12:00', '12:30'),
        (60, NULL, 100, 'Sin email uno', '', '', 'confirmed', CURRENT_DATE+1, '17:00', '17:30'),
        (61, NULL, 100, 'Sin email dos', '', '', 'confirmed', CURRENT_DATE+1, '18:00', '18:30');
      INSERT INTO consultation_bot_usage VALUES (31, NOW(), 'synthetic', 1, 0), (52, NOW(), 'private', 1, 0);
    `);
    const source = await readFile(new URL('../src/professional-api.mjs', import.meta.url), 'utf8');
    const handler = source.match(/^const listPatients = [\s\S]+?^};/m)?.[0];
    assert.ok(handler);
    let payload;
    const context = {
      query: pool.query.bind(pool), consultationStatusSql,
      recordAudit: async () => {}, sendJson: (_response, status, body) => { assert.equal(status, 200); payload = body; },
      professionalReportUrl: id => `/reports/${id}`, agreementBookingUrl: () => '/turnos/',
      mapAppointmentDocument: document => document, config: { appPublicUrl: 'https://example.test' },
    };
    vm.runInNewContext(`${handler}\nglobalThis.listPatients = listPatients;`, context);
    const list = async (professionalId, search = '') => {
      await context.listPatients(new URL(`https://example.test/?q=${encodeURIComponent(search)}`), {}, { user: { id: 1, professional_id: professionalId } });
      return payload.patients;
    };
    const patients = await list(100);
    assert.equal(patients.length, 6);
    const active = patients.find(patient => patient.id === 1);
    assert.equal(active.next_appointment.id, 11);
    assert.match(active.next_appointment.date, /^\d{4}-\d{2}-\d{2}$/);
    const inactive = patients.find(patient => patient.email === 'inactive@example.test');
    assert.equal(inactive.id, null);
    assert.equal(inactive.name, 'Reserva inactiva');
    assert.equal(inactive.next_appointment.id, 20);
    assert.match(inactive.directory_key, /^appointment:/);
    assert.equal((await pool.query('SELECT active FROM patients WHERE id=2')).rows[0].active, false);
    const unlinked = patients.find(patient => patient.email === 'new@example.test');
    assert.equal(unlinked.next_appointment.id, 31);
    assert.equal(unlinked.consultation_reports.length, 1);
    assert.equal(Number(unlinked.consultation_reports[0].appointment_id), 31);
    assert.equal(patients.find(patient => patient.id === 3).next_appointment, null);
    assert.equal(patients.find(patient => patient.name === 'Sin email uno').next_appointment.id, 60);
    assert.equal(patients.find(patient => patient.name === 'Sin email dos').next_appointment.id, 61);
    assert.equal(new Set(patients.map(patient => patient.directory_key)).size, 6);
    assert.equal((await list(100, 'inactiva')).length, 1);
    assert.equal((await list(100, 'private@example.test')).length, 0);
    assert.equal((await list(200)).length, 3);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
