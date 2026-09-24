// Example BFF: the browser never receives an agreement API credential.
import { randomBytes } from 'node:crypto';
import { config } from './config.mjs';
import { one, query } from './db.mjs';
import { getClientIp, parseCookies, readBody, sendJson } from './http.mjs';
import { hashToken } from './security.mjs';
import { encryptSecret, decryptSecret } from './secret-envelope.mjs';
import { consumeRateLimit } from './rate-limit.mjs';
import { parseMultipartForm } from './uploads.mjs';

const cookieName = 'reku_artro_demo';
const ttl = 8 * 60 * 60;
const failure = (statusCode, message) => Object.assign(new Error(message), { statusCode, publicMessage: message });
const envelope = context => ({ material: config.settingsEncryptionKey, context });
export const demoCookie = (token, age = ttl) => `${cookieName}=${token}; Path=/test; HttpOnly; SameSite=Strict; Max-Age=${age}${config.sessionSecure ? '; Secure' : ''}`;

export const demoRoute = (method, path) => {
  if (method === 'GET' && ['/agreement', '/services', '/professionals', '/availability', '/appointments'].includes(path)) return true;
  if (method === 'POST' && ['/holds', '/appointments'].includes(path)) return true;
  return /^(GET|PATCH)$/.test(method) && /^\/appointments\/apt_[a-f0-9]{32}$/.test(path)
    || method === 'POST' && /^\/appointments\/apt_[a-f0-9]{32}\/cancel$/.test(path);
};

export const demoIdempotencyKey = (sessionHash, key) => {
  if (!/^[a-f0-9-]{36}$/.test(String(key || ''))) throw failure(400, 'Falta una clave de operación válida.');
  return `demo:${sessionHash.slice(0, 24)}:${key}`;
};

export const demoQuery = params => {
  const allowed = new Set(['service_id', 'professional_id', 'date', 'from', 'to']);
  const result = new URLSearchParams();
  for (const [key, value] of params) {
    if (!allowed.has(key) || value.length > 30 || result.has(key)) throw failure(400, 'Filtro no permitido.');
    result.set(key, value);
  }
  return result.toString();
};

const readJson = async request => {
  if (!String(request.headers['content-type']).startsWith('application/json')) throw failure(415, 'Enviá JSON.');
  try {
    const value = JSON.parse(await readBody(request, 40_000));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw failure(400, 'La solicitud no es válida.'); }
};

const loadSettings = async () => {
  const row = await one("SELECT value FROM app_settings WHERE key = 'artro_api_demo'");
  const value = row?.value;
  if (!value?.enabled || !value.token_encrypted) throw failure(503, 'La demo no está habilitada.');
  const credential = await one(`SELECT c.id FROM agreement_api_credentials c
    JOIN agreements a ON a.id = c.agreement_id
    WHERE c.id = $1 AND c.active AND c.revoked_at IS NULL AND a.slug = 'artro' AND a.deleted_at IS NULL`, [value.credential_id]);
  if (!credential) throw failure(503, 'La demo no está habilitada.');
  return { ...value, token: decryptSecret(value.token_encrypted, envelope('artro-api-demo:credential')) };
};

const upstream = async (settings, path, { method = 'GET', payload, file, key } = {}) => {
  // Fixed server-configured Reku destination, never a URL supplied by the browser.
  // Use the canonical origin: Node fetch may ignore a Host override on loopback,
  // and production intentionally redirects non-canonical requests.
  const headers = { Authorization: `Bearer ${settings.token}` };
  if (key) headers['Idempotency-Key'] = key;
  let body;
  if (file) {
    body = new FormData();
    body.set('payload', JSON.stringify(payload));
    body.set('medical_order', new Blob([file.buffer], { type: file.mimeType }), file.filename);
  } else if (payload) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(payload);
  }
  const response = await fetch(`${config.appPublicUrl}/api/partners/v1${path}`, {
    method, headers, body, redirect: 'error', signal: AbortSignal.timeout(60_000),
  });
  const json = await response.json();
  return { status: response.status, json, requestId: response.headers.get('x-request-id'), retryAfter: response.headers.get('retry-after') };
};

const ownedObject = async (sessionHash, id, kind) => {
  const row = await one('SELECT response_encrypted FROM artro_demo_objects WHERE session_hash = $1 AND object_id = $2 AND kind = $3', [sessionHash, id, kind]);
  if (!row) throw failure(404, 'No encontramos ese elemento en tu sesión de prueba.');
  return JSON.parse(decryptSecret(row.response_encrypted, envelope(`artro-demo:${sessionHash}:${id}`)));
};

const saveObject = async (sessionHash, data, kind) => {
  await query(`INSERT INTO artro_demo_objects (session_hash, object_id, kind, response_encrypted)
    VALUES ($1, $2, $3, $4) ON CONFLICT (session_hash, object_id)
    DO UPDATE SET response_encrypted = EXCLUDED.response_encrypted`,
  [sessionHash, data.id, kind, encryptSecret(JSON.stringify(data), envelope(`artro-demo:${sessionHash}:${data.id}`))]);
};

export const handleArtroDemo = async (request, response, url) => {
  try {
    const path = url.pathname.slice('/test/api'.length);
    const mutation = request.method !== 'GET';
    if (mutation && (request.headers.origin !== new URL(config.appPublicUrl).origin || request.headers['x-demo-request'] !== '1')) {
      throw failure(403, 'No pudimos validar el origen de la solicitud.');
    }
    const settings = await loadSettings();
    // Preserve existing demo sessions on upgrade. The legacy hash is only a
    // session generation marker now; nobody needs to provide a password.
    const gateVersion = hashToken(settings.password_hash || settings.token);
    const token = parseCookies(request)[cookieName] || '';
    const sessionHash = hashToken(token);
    const session = token && await one('SELECT csrf FROM artro_demo_sessions WHERE token_hash = $1 AND gate_version = $2 AND expires_at > NOW()', [sessionHash, gateVersion]);
    if (path === '/session' && request.method === 'POST') {
      // Reloading the page must not orphan appointments from this browser.
      if (session) { sendJson(response, 200, { csrf: session.csrf }); return; }
      await consumeRateLimit({ scope: 'artro-demo.session.ip', key: getClientIp(request), limit: 10, windowSeconds: 900 });
      await consumeRateLimit({ scope: 'artro-demo.session.global', key: 'global', limit: 100, windowSeconds: 900 });
      const token = randomBytes(32).toString('base64url');
      const csrf = randomBytes(32).toString('base64url');
      await query('DELETE FROM artro_demo_sessions WHERE expires_at < NOW()');
      await query('INSERT INTO artro_demo_sessions (token_hash, gate_version, csrf, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL \'8 hours\')', [hashToken(token), gateVersion, csrf]);
      sendJson(response, 200, { csrf }, { 'Set-Cookie': demoCookie(token) });
      return;
    }
    if (!session) throw failure(401, 'La sesión de prueba venció. Reintentá la conexión para comenzar una nueva.');
    if (mutation && request.headers['x-csrf-token'] !== session.csrf) throw failure(403, 'La sesión no es válida. Volvé a ingresar.');
    if (path === '/session' && request.method === 'GET') { sendJson(response, 200, { csrf: session.csrf }); return; }
    if (path === '/logout' && request.method === 'POST') {
      await query('DELETE FROM artro_demo_sessions WHERE token_hash = $1', [sessionHash]);
      sendJson(response, 200, { ok: true }, { 'Set-Cookie': demoCookie('', 0) }); return;
    }
    if (!demoRoute(request.method, path)) throw failure(404, 'Endpoint no disponible en esta demo.');
    await consumeRateLimit({ scope: `artro-demo.${mutation ? 'write' : 'read'}`, key: sessionHash, limit: mutation ? 25 : 100, windowSeconds: 60 });
    if (mutation) {
      // Opening another anonymous session must not reset the write limits.
      await consumeRateLimit({ scope: 'artro-demo.write.ip', key: getClientIp(request), limit: 60, windowSeconds: 60 });
      await consumeRateLimit({ scope: 'artro-demo.write.global', key: 'global', limit: 200, windowSeconds: 60 });
    }
    let saved;
    const appointmentId = path.match(/\/(apt_[a-f0-9]{32})(?:\/cancel)?$/)?.[1];
    if (appointmentId) saved = await ownedObject(sessionHash, appointmentId, 'appointment');
    if (path === '/appointments' && request.method === 'GET') {
      const rows = await query("SELECT object_id FROM artro_demo_objects WHERE session_hash = $1 AND kind = 'appointment' ORDER BY created_at DESC LIMIT 20", [sessionHash]);
      const data = [];
      for (const row of rows.rows) {
        const current = await upstream(settings, `/appointments/${row.object_id}`);
        if (current.status !== 200) { sendJson(response, current.status, current.json); return; }
        const stored = await ownedObject(sessionHash, row.object_id, 'appointment');
        data.push({ ...current.json.data, ...(current.json.data.status === 'confirmed' ? { links: stored.links } : {}) });
      }
      sendJson(response, 200, { data }); return;
    }
    let payload, file, key;
    if (mutation) {
      key = demoIdempotencyKey(sessionHash, request.headers['idempotency-key']);
      if (path === '/appointments' && String(request.headers['content-type']).startsWith('multipart/form-data')) {
        const form = await parseMultipartForm(request, { maxBytes: 10 * 1024 * 1024, maxFiles: 1 });
        try { payload = JSON.parse(form.fields.payload); } catch { throw failure(400, 'El formulario no es válido.'); }
        if (Object.keys(form.files).some(k => k !== 'medical_order')) throw failure(400, 'Archivo no permitido.');
        file = form.files.medical_order;
      } else payload = await readJson(request);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw failure(400, 'Solicitud no válida.');
      if (path === '/appointments') {
        await ownedObject(sessionHash, String(payload.hold_id || ''), 'hold');
        payload = { hold_id: payload.hold_id, patient: payload.patient, external_id: key,
          // No charge is made. Never use this simulated reference in a production integrator.
          payment_reference: `DEMO-NO-COBRAR:${key}` };
      } else if (path === '/holds') {
        payload = { service_id: payload.service_id, professional_id: payload.professional_id, date: payload.date, start_time: payload.start_time };
      } else if (request.method === 'PATCH') {
        payload = { date: payload.date, start_time: payload.start_time, professional_id: payload.professional_id };
      } else payload = { reason: 'Cancelación desde la demo de integración Artro' };
    }
    const filters = request.method === 'GET' ? demoQuery(url.searchParams) : '';
    const result = await upstream(settings, path + (filters ? `?${filters}` : ''), { method: request.method, payload, file, key });
    if (result.status < 300 && result.json.data?.id && (appointmentId || mutation && ['/holds', '/appointments'].includes(path))) {
      const kind = path === '/holds' ? 'hold' : 'appointment';
      const data = { ...result.json.data, ...(saved?.links ? { links: saved.links } : {}) };
      await saveObject(sessionHash, data, kind);
      if (data.status !== 'confirmed') delete data.links;
      result.json.data = data;
    }
    sendJson(response, result.status, result.json, {
      ...(result.requestId ? { 'X-Request-Id': result.requestId } : {}),
      ...(result.retryAfter ? { 'Retry-After': result.retryAfter } : {}),
    });
  } catch (error) {
    const status = error.message === 'RATE_LIMITED' ? 429 : error.statusCode || 502;
    sendJson(response, status, { error: { code: status === 429 ? 'rate_limited' : 'demo_request_failed', message:
      status === 429 ? 'Demasiados intentos. Esperá unos minutos.' : error.publicMessage || 'No pudimos completar la solicitud. Reintentá la misma operación.' } },
    error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
  }
};
