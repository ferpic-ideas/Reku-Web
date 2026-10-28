import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { hashPassword } from '../src/security.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const slotAfter = hours => {
  const instant = new Date(Math.ceil((Date.now() + hours * 3_600_000) / 1_800_000) * 1_800_000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, start_time: `${parts.hour}:${parts.minute}` };
};

export const testBookingNotice = async ({ pool, baseUrl, apiRequest }) => {
  const password = 'Local-booking-notice-test-2026!';
  const email = 'notice-admin@example.test';
  await pool.query("INSERT INTO users (email,name,password_hash,role) VALUES ($1,'Admin anticipación',$2,'admin')", [email, await hashPassword(password)]);
  const login = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl }, body: JSON.stringify({ email, password }),
  });
  assert.equal(login.status, 200);
  const adminHeaders = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: baseUrl, 'X-CSRF-Token': (await login.json()).csrf_token };
  const settings = { name: 'Anticipación prueba', slug: 'notice-test', type: 'Pago' };
  const save = async (values, id = '') => {
    const body = new FormData();
    Object.entries(values).forEach(([key, value]) => body.set(key, value));
    const response = await fetch(`${baseUrl}/api/admin/agreements${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', headers: adminHeaders, body });
    return { status: response.status, ...await response.json() };
  };
  const created = await save(settings);
  assert.equal(created.status, 201);
  assert.equal(created.agreement.minimum_booking_notice_hours, 4);
  const agreement = created.agreement;
  const zeroCreated = await save({ ...settings, slug: 'notice-zero-test', minimum_booking_notice_hours: '0' });
  assert.equal(zeroCreated.status, 201);
  assert.equal(zeroCreated.agreement.minimum_booking_notice_hours, 0);
  const setNotice = async hours => {
    const result = await save({ ...settings, minimum_booking_notice_hours: String(hours) }, agreement.id);
    assert.equal(result.status, 200);
    assert.equal(result.agreement.minimum_booking_notice_hours, hours);
  };
  for (const value of ['-1', '0.5', '', 'NaN', '8761']) {
    assert.equal((await save({ ...settings, minimum_booking_notice_hours: value }, agreement.id)).status, 422);
  }
  await setNotice(0);
  assert.equal((await save(settings, agreement.id)).agreement.minimum_booking_notice_hours, 0, 'old clients preserve the existing value');
  const listed = await (await fetch(`${baseUrl}/api/admin/agreements`, { headers: adminHeaders })).json();
  assert.equal(listed.agreements.find(item => item.id === agreement.id).minimum_booking_notice_hours, 0);
  const serviceId = Number((await pool.query("INSERT INTO services (name,duration_minutes,cost_amount,active) VALUES ('Anticipación',15,0,TRUE) RETURNING id")).rows[0].id);
  const professionalId = Number((await pool.query("INSERT INTO professionals (name,email,active) VALUES ('Profesional anticipación','notice-professional@example.test',TRUE) RETURNING id")).rows[0].id);
  await pool.query('INSERT INTO professional_services (professional_id,service_id) VALUES ($1,$2)', [professionalId, serviceId]);
  await pool.query('INSERT INTO professional_agreements (professional_id,agreement_id) VALUES ($1,$2)', [professionalId, agreement.id]);
  await pool.query("INSERT INTO professional_availability (professional_id,day_of_week,start_time,end_time) SELECT $1,day,'00:00','23:59' FROM generate_series(1,7) day", [professionalId]);
  const token = `rku_ag_${randomBytes(32).toString('base64url')}`;
  await pool.query('INSERT INTO agreement_api_credentials (agreement_id,name,token_hash,token_prefix) VALUES ($1,$2,$3,$4)', [agreement.id, 'Notice test', hash(token), token.slice(0, 18)]);
  const bookingToken = randomBytes(32).toString('base64url');
  await pool.query("INSERT INTO booking_access_links (token_hash,agreement_id,expires_at,patient_email,patient_name) VALUES ($1,$2,NOW()+INTERVAL '1 day','notice-web@example.test','Paciente prueba')", [hash(bookingToken), agreement.id]);
  const bookingHeaders = { 'X-Booking-Token': bookingToken, Origin: baseUrl, 'Content-Type': 'application/json' };
  const near = slotAfter(1);
  const next = slotAfter(2);
  const booking = { service_id: serviceId, professional_id: professionalId, ...near };
  const webSlots = async professional => {
    const response = await fetch(`${baseUrl}/api/booking/slots?service_id=${serviceId}&professional_id=${professional}&date=${near.date}`, { headers: bookingHeaders });
    assert.equal(response.status, 200);
    return (await response.json()).slots;
  };
  const book = async payload => fetch(`${baseUrl}/api/booking/appointments`, { method: 'POST', headers: bookingHeaders, body: JSON.stringify(payload) });
  const partner = (path, options = {}) => apiRequest(baseUrl, path, { token, ...options });
  const hold = key => partner('/holds', { method: 'POST', headers: { 'Idempotency-Key': key }, body: booking });
  assert.ok((await webSlots(professionalId)).includes(near.start_time));
  assert.ok((await webSlots('first_available')).includes(near.start_time));
  assert.equal((await partner('/agreement')).json.data.minimum_booking_notice_hours, 0);
  await setNotice(4);
  for (const professional of [professionalId, 'first_available']) {
    assert.ok(!(await webSlots(professional)).includes(near.start_time));
    assert.equal((await book({ ...booking, professional_id: professional })).status, 409);
  }
  const available = await partner(`/availability?service_id=${serviceId}&date=${near.date}`);
  assert.equal(available.status, 200);
  assert.ok(!available.json.data.days.flatMap(day => day.slots).some(slot => slot.start_time === near.start_time));
  assert.equal((await hold('notice-too-soon')).status, 409);
  await setNotice(96);
  const days = await (await fetch(`${baseUrl}/api/booking/days?service_id=${serviceId}&professional_id=first_available&month=${near.date.slice(0, 7)}`, { headers: bookingHeaders })).json();
  assert.ok(!days.days.some(day => day.date === near.date), 'days with no eligible slots are hidden');
  await setNotice(0);
  const held = await hold('notice-allowed');
  assert.equal(held.status, 201);
  const confirmation = {
    hold_id: held.json.data.id, external_id: 'notice-patient-001',
    patient: { first_name: 'Paciente', last_name: 'Anticipación', email: 'notice-api@example.test', phone: '1155559999' },
  };
  const confirm = () => partner('/appointments', { method: 'POST', headers: { 'Idempotency-Key': 'notice-confirm' }, body: confirmation });
  await setNotice(4);
  const stale = await confirm();
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, 'slot_unavailable', 'a hold cannot bypass the current margin');
  await setNotice(0);
  const confirmed = await confirm();
  assert.equal(confirmed.status, 201);
  const appointmentId = confirmed.json.data.id;
  const reschedule = () => partner(`/appointments/${appointmentId}`, { method: 'PATCH', headers: { 'Idempotency-Key': 'notice-reschedule' }, body: next });
  await setNotice(4);
  assert.equal((await reschedule()).status, 409);
  await setNotice(0);
  assert.equal((await reschedule()).status, 200);
  // The patient uses the same agreement policy when managing an existing appointment.
  const manageToken = new URL(confirmed.json.data.links.manage_url).hash.replace('#manage=', '');
  const session = await fetch(`${baseUrl}/api/booking/manage/session`, { method: 'POST', headers: { Origin: baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: manageToken }) });
  assert.equal(session.status, 200);
  const manageHeaders = { Origin: baseUrl, 'Content-Type': 'application/json', Cookie: session.headers.get('set-cookie').split(';')[0] };
  await setNotice(4);
  const managedSlots = await (await fetch(`${baseUrl}/api/booking/manage/slots?date=${near.date}`, { headers: manageHeaders })).json();
  assert.ok(!managedSlots.slots.includes(near.start_time));
  const managedReschedule = await fetch(`${baseUrl}/api/booking/manage/reschedule`, { method: 'POST', headers: manageHeaders, body: JSON.stringify(near) });
  assert.equal(managedReschedule.status, 409);
  await setNotice(0);
  const booked = await book(booking);
  assert.equal(booked.status, 201, await booked.clone().text());
};
