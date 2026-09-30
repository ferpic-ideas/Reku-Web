import { randomBytes } from 'node:crypto';
import { config } from './config.mjs';
import { query, tx } from './db.mjs';
import { hashToken } from './security.mjs';
import {
  isWebPushConfigured,
  normalizePushSubscription,
  saveProfessionalPushSubscription,
} from './web-push.mjs';

export const pushActivationTtlHours = 72;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const activationError = (message = 'PUSH_ACTIVATION_INVALID', statusCode = 401) =>
  Object.assign(new Error(message), { statusCode });

export const buildPushActivationUrl = (token) => {
  const url = new URL('/profesional/activar-notificaciones.html', config.appPublicUrl);
  url.hash = `activar=${encodeURIComponent(token)}`;
  return url.toString();
};

export const createPushActivationLink = async (userId) => {
  const token = randomBytes(32).toString('base64url');
  const result = await query(`
    INSERT INTO professional_push_activation_links
      (token_hash, user_id, professional_id, session_version, expires_at)
    SELECT $1, u.id, u.professional_id, u.session_version,
      NOW() + ($3::int * INTERVAL '1 hour')
    FROM users u
    JOIN professionals p ON p.id = u.professional_id
    WHERE u.id = $2 AND u.role = 'professional' AND u.is_active = TRUE
      AND p.active = TRUE AND p.deleted_at IS NULL
    RETURNING id, expires_at
  `, [hashToken(token), userId, pushActivationTtlHours]);
  if (!result.rows[0]) throw activationError();
  return { id: Number(result.rows[0].id), expires_at: result.rows[0].expires_at, url: buildPushActivationUrl(token) };
};

const loadActivation = async (token, queryImpl, { lock = false } = {}) => {
  if (typeof token !== 'string' || !tokenPattern.test(token)) throw activationError();
  const result = await queryImpl(`
    SELECT l.id, l.user_id, l.professional_id, l.expires_at, l.used_at,
      l.subscription_hash, p.name
    FROM professional_push_activation_links l
    JOIN users u ON u.id = l.user_id AND u.professional_id = l.professional_id
    JOIN professionals p ON p.id = l.professional_id
    WHERE l.token_hash = $1 AND l.expires_at > NOW() AND l.revoked_at IS NULL
      AND u.role = 'professional' AND u.is_active = TRUE
      AND u.session_version = l.session_version
      AND p.active = TRUE AND p.deleted_at IS NULL
    ${lock ? 'FOR UPDATE OF l' : ''}
  `, [hashToken(token)]);
  if (!result.rows[0]) throw activationError();
  return result.rows[0];
};

const subscriptionHash = (subscription) => hashToken(JSON.stringify(subscription));
const subscriptionStillActive = async (link, subscription, queryImpl) => {
  if (!subscription || subscriptionHash(subscription) !== link.subscription_hash) return false;
  const result = await queryImpl(`
    SELECT 1 FROM professional_push_subscriptions
    WHERE professional_id = $1 AND endpoint = $2 AND p256dh = $3 AND auth = $4 AND active = TRUE
  `, [link.professional_id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]);
  return result.rows.length > 0;
};

export const getPushActivation = async ({ token, subscription }) => {
  const link = await loadActivation(token, query);
  const normalized = subscription ? normalizePushSubscription(subscription) : null;
  return {
    name: link.name,
    expires_at: link.expires_at,
    configured: isWebPushConfigured(),
    public_key: isWebPushConfigured() ? config.webPushVapidPublicKey : '',
    used: Boolean(link.used_at),
    active: Boolean(link.used_at) && await subscriptionStillActive(link, normalized, query),
  };
};

export const activatePushFromLink = async ({ token, subscription, deviceLabel, deviceKind, userAgent }) =>
  tx(async (client) => {
    const queryImpl = client.query.bind(client);
    const link = await loadActivation(token, queryImpl, { lock: true });
    const normalized = normalizePushSubscription(subscription);
    if (link.used_at) {
      // A network retry may confirm the same device, never register a second one.
      if (await subscriptionStillActive(link, normalized, queryImpl)) return { ok: true };
      throw activationError('PUSH_ACTIVATION_USED', 409);
    }
    const auditImpl = (eventType, { actorUserId, detail }) => queryImpl(
      'INSERT INTO audit_events (actor_user_id, event_type, detail) VALUES ($1, $2, $3::jsonb)',
      [actorUserId, eventType, JSON.stringify(detail)],
    );
    await saveProfessionalPushSubscription({
      professionalId: link.professional_id,
      userId: link.user_id,
      subscription: normalized,
      deviceLabel,
      deviceKind,
      userAgent,
    }, { queryImpl, auditImpl });
    await queryImpl(`
      UPDATE professional_push_activation_links
      SET used_at = NOW(), subscription_hash = $2 WHERE id = $1
    `, [link.id, subscriptionHash(normalized)]);
    await auditImpl('professional.push.activation_completed', {
      actorUserId: link.user_id,
      detail: { professional_id: Number(link.professional_id), activation_link_id: Number(link.id) },
    });
    return { ok: true };
  });

export const requirePushActivationOrigin = (request) => {
  const origin = String(request.headers.origin || '');
  if (origin !== new URL(config.appPublicUrl).origin ||
      String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw activationError('PUSH_ACTIVATION_ORIGIN_INVALID', 403);
  }
};
