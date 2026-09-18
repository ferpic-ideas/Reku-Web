import { consultationBotMode } from './consultation-mode.mjs';

const TEST_BASE_URL = 'https://uxc2aw5mv8.execute-api.eu-west-1.amazonaws.com/dev2';
const clean = value => String(value || '').trim();

export const resolveReHubSettings = (env = process.env) => {
  const mode = consultationBotMode(env);
  // The existing REHUB_* set remains test-only. Never fall back to it in production.
  const prefix = mode === 'production' ? 'REHUB_PRODUCTION_' : 'REHUB_';
  const settings = {
    mode,
    baseUrl: clean(env[`${prefix}BASE_URL`] || (mode === 'test' ? TEST_BASE_URL : '')).replace(/\/+$/, ''),
    clientId: clean(env[`${prefix}CLIENT_ID`]),
    publicKeyBase64: clean(env[`${prefix}PUBLIC_KEY_BASE64`]),
    publicKeyPath: clean(env[`${prefix}PUBLIC_KEY_PATH`]),
  };
  if (settings.publicKeyBase64 && settings.publicKeyPath) {
    throw Object.assign(new Error('REHUB_KEY_CONFIG_CONFLICT'), { statusCode: 503 });
  }
  if (settings.baseUrl) {
    let url;
    try { url = new URL(settings.baseUrl); } catch { /* handled below without exposing configuration */ }
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw Object.assign(new Error('REHUB_BASE_URL_INVALID'), { statusCode: 503 });
    }
  }
  return settings;
};
