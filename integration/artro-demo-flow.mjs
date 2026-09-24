import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { encryptSecret } from '../src/secret-envelope.mjs';

export async function testArtroDemo({ pool, baseUrl, fixture }) {
  const request = async (path, { method = 'GET', body, session, headers = {}, key = randomUUID() } = {}) => {
    const response = await fetch(`${baseUrl}/test/api${path}`, { method, headers: {
      Origin: baseUrl, 'X-Demo-Request': '1', ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
      'Idempotency-Key': key, ...headers,
    }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
    return { status: response.status, headers: response.headers, json: await response.json() };
  };
  assert.equal((await request('/session')).status, 503);
  const agreement = (await pool.query("INSERT INTO agreements (name,slug,subdomain_prefix,type,access_mode,communication_sender,email_verification_required) VALUES ('Artro demo fixture','artro','artro','Pago','api','integrator',FALSE) RETURNING id")).rows[0];
  await pool.query('INSERT INTO professional_agreements (professional_id,agreement_id) VALUES ($1,$2)', [fixture.professionalIds[0],agreement.id]);
  const token = `rku_ag_${randomBytes(32).toString('base64url')}`;
  const credential = (await pool.query("INSERT INTO agreement_api_credentials (agreement_id,name,token_hash,token_prefix) VALUES ($1,'demo',$2,$3) RETURNING id", [agreement.id,createHash('sha256').update(token).digest('hex'),token.slice(0,18)])).rows[0];
  await pool.query("INSERT INTO app_settings (key,value) VALUES ('artro_api_demo',$1)", [{enabled:true,credential_id:credential.id,token_encrypted:encryptSecret(token,{material:'api-test-settings-key-with-at-least-32-characters',context:'artro-api-demo:credential'})}]);
  assert.equal((await request('/agreement')).status,401);
  assert.equal((await request('/session',{method:'POST',headers:{Origin:'https://evil.test'}})).status,403);
  assert.equal((await request('/session',{method:'POST',headers:{Origin:''}})).status,403);
  assert.equal((await request('/session',{method:'POST',headers:{'X-Demo-Request':''}})).status,403);
  const startSession = async () => {
    const r = await request('/session',{method:'POST'});
    assert.equal(r.status,200); assert.match(r.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
    assert.doesNotMatch(JSON.stringify(r.json),/rku_ag_/);
    return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:r.json.csrf};
  };
  const session = await startSession(), other = await startSession();
  assert.notEqual(session.cookie,other.cookie);
  assert.equal((await request('/login',{session,method:'POST',body:{password:'unused'}})).status,404);
  assert.equal((await request('/session',{session})).status,200);
  assert.equal((await request('/agreement',{session})).json.data.slug,'artro');
  assert.equal((await request('/services',{session})).status,200);
  assert.equal((await request('/professionals?service_id='+fixture.serviceId,{session})).status,200);
  assert.equal((await request('/availability?url=https://evil.test',{session})).status,400);
  assert.equal((await request('/admin',{session})).status,404);
  assert.equal((await request('/holds',{session,method:'POST',body:{},headers:{'X-CSRF-Token':''}})).status,403);
  const date = new Date(Date.now()+40*86400_000).toISOString().slice(0,10);
  const available = await request(`/availability?service_id=${fixture.serviceId}&date=${date}`,{session});
  const slot = available.json.data.days[0].slots[0]; assert.ok(slot);
  const held = await request('/holds',{session,method:'POST',body:{service_id:fixture.serviceId,date,start_time:slot.start_time,professional_id:slot.professional.id}});
  assert.equal(held.status,201,JSON.stringify(held.json));
  const payload = {hold_id:held.json.data.id,patient:{first_name:'Prueba',last_name:'Demo',email:'artro-demo@example.test',phone:'1155555555'}};
  assert.equal((await request('/appointments',{session:other,method:'POST',body:payload})).status,404);
  const key = randomUUID();
  const created = await request('/appointments',{session,method:'POST',body:payload,key});
  assert.equal(created.status,201,JSON.stringify(created.json));
  assert.equal(created.json.data.consultation_status,'not_applicable');
  assert.match(created.json.data.payment.reference,/^DEMO-NO-COBRAR:/);
  assert.ok(created.json.data.links.waiting_room_url);
  const id = created.json.data.id;
  const replay = await request('/appointments',{session,method:'POST',body:payload,key});
  assert.equal(replay.json.data.id,id); assert.deepEqual(replay.json.data.links,created.json.data.links);
  const mine = await request('/appointments',{session}); assert.equal(mine.json.data.length,1);
  const resumed = await request('/session',{session,method:'POST',headers:{'X-CSRF-Token':''}});
  assert.equal(resumed.status,200); assert.equal(resumed.json.csrf,session.csrf);
  assert.equal(resumed.headers.get('set-cookie'),null);
  assert.equal((await request('/appointments',{session})).json.data[0].id,id);
  assert.equal((await request('/appointments',{session:other})).json.data.length,0);
  assert.equal((await request(`/appointments/${id}`,{session:other})).status,404);
  assert.equal((await request(`/appointments/${id}`,{session:other,method:'PATCH',body:{date}})).status,404);
  assert.equal((await request(`/appointments/${id}/cancel`,{session:other,method:'POST',body:{}})).status,404);
  const nextDate = new Date(Date.now()+41*86400_000).toISOString().slice(0,10);
  const moved = await request(`/appointments/${id}`,{session,method:'PATCH',body:{date:nextDate,start_time:slot.start_time}});
  assert.equal(moved.status,200,JSON.stringify(moved.json)); assert.equal(moved.json.data.schedule.date,nextDate);
  const stored = (await pool.query('SELECT response_encrypted FROM artro_demo_objects WHERE object_id=$1',[id])).rows[0].response_encrypted;
  assert.match(stored,/^v1\./); assert.ok(!stored.includes(payload.patient.email)); assert.ok(!stored.includes('/turnos'));
  assert.equal((await request(`/appointments/${id}/cancel`,{session,method:'POST',body:{}})).status,200);
  const cancelled = await request('/appointments',{session}); assert.equal(cancelled.json.data[0].status,'cancelled'); assert.equal(cancelled.json.data[0].links,undefined);
  // The adapter must preserve real API validation and multipart semantics.
  await pool.query('UPDATE agreements SET medical_order_required=TRUE WHERE id=$1',[agreement.id]);
  const heldWithOrder = await request('/holds',{session,method:'POST',body:{service_id:fixture.serviceId,date:nextDate,start_time:slot.start_time}});
  assert.equal(heldWithOrder.status,201);
  const orderPayload = {...payload,hold_id:heldWithOrder.json.data.id};
  assert.equal((await request('/appointments',{session,method:'POST',body:orderPayload})).status,422);
  const form = new FormData();
  form.set('payload',JSON.stringify(orderPayload));
  form.set('medical_order',new Blob(['%PDF-1.4\nsynthetic demo document\n%%EOF'],{type:'application/pdf'}),'demo-order.pdf');
  const withOrder = await request('/appointments',{session,method:'POST',body:form});
  assert.equal(withOrder.status,201,JSON.stringify(withOrder.json));
  assert.deepEqual(withOrder.json.data.medical_order,{required:true,received:true});
  assert.equal((await request(`/appointments/${withOrder.json.data.id}/cancel`,{session,method:'POST',body:{}})).status,200);
  const expired = await request('/holds',{session,method:'POST',body:{service_id:fixture.serviceId,date:nextDate,start_time:slot.start_time}});
  assert.equal(expired.status,201);
  await pool.query('UPDATE agreement_api_holds SET expires_at=NOW()-INTERVAL \'1 minute\' WHERE public_id=$1',[expired.json.data.id]);
  await pool.query('UPDATE agreements SET medical_order_required=FALSE WHERE id=$1',[agreement.id]);
  // Core API intentionally allows an expired hold if its slot is still free; it
  // revalidates the slot under lock, so this is not a bypass of availability.
  const recovered = await request('/appointments',{session,method:'POST',body:{...payload,hold_id:expired.json.data.id}});
  assert.equal(recovered.status,201,JSON.stringify(recovered.json));
  assert.equal((await request(`/appointments/${recovered.json.data.id}/cancel`,{session,method:'POST',body:{}})).status,200);
  assert.equal((await request('/logout',{session,method:'POST',body:{}})).status,200);
  assert.equal((await request('/session',{session})).status,401);
  // Anonymous sessions cannot bypass the IP write budget, but reads still work.
  const fresh = await startSession();
  await pool.query("UPDATE public_rate_limits SET hit_count=61 WHERE scope='artro-demo.write.ip'");
  for (const current of [other,fresh]) {
    const limited = await request('/holds',{session:current,method:'POST',body:{}});
    assert.equal(limited.status,429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  }
  assert.equal((await request('/agreement',{session:fresh})).status,200);
  await pool.query("DELETE FROM public_rate_limits WHERE scope='artro-demo.write.ip'");
  await pool.query("UPDATE public_rate_limits SET hit_count=11 WHERE scope='artro-demo.session.ip'");
  assert.equal((await request('/session',{method:'POST'})).status,429);
  assert.equal((await request('/session',{method:'POST',session:fresh})).status,200);
  await pool.query("DELETE FROM public_rate_limits WHERE scope='artro-demo.session.ip'");
  // Expired cookies produce a new isolated session without asking for a password.
  await pool.query('UPDATE artro_demo_sessions SET expires_at=NOW()-INTERVAL \'1 minute\' WHERE token_hash=$1',[createHash('sha256').update(fresh.cookie.split('=')[1]).digest('hex')]);
  assert.equal((await request('/session',{session:fresh})).status,401);
  const renewed = await request('/session',{method:'POST',session:fresh});
  assert.equal(renewed.status,200); assert.notEqual(renewed.json.csrf,fresh.csrf);
  // Upgrading the previously protected installation must preserve its sessions.
  const legacyToken = randomBytes(32).toString('base64url');
  const legacyMarker = 'synthetic-legacy-session-generation';
  await pool.query("UPDATE app_settings SET value=value || jsonb_build_object('password_hash',$1::text) WHERE key='artro_api_demo'",[legacyMarker]);
  await pool.query("INSERT INTO artro_demo_sessions (token_hash,gate_version,csrf,expires_at) VALUES ($1,$2,'legacy-csrf',NOW()+INTERVAL '1 hour')",[createHash('sha256').update(legacyToken).digest('hex'),createHash('sha256').update(legacyMarker).digest('hex')]);
  const legacy = {cookie:`reku_artro_demo=${legacyToken}`,csrf:'legacy-csrf'};
  const preserved = await request('/session',{method:'POST',session:legacy});
  assert.equal(preserved.status,200); assert.equal(preserved.json.csrf,legacy.csrf);
  assert.equal(preserved.headers.get('set-cookie'),null);
  await pool.query('UPDATE agreement_api_credentials SET active=FALSE WHERE id=$1',[credential.id]);
  assert.equal((await request('/session',{session:other})).status,503);
}
