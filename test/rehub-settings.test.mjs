import assert from 'node:assert/strict';
import test from 'node:test';
import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { resolveReHubSettings } from '../src/rehub-settings.mjs';
import { consultationBotMode } from '../src/consultation-bot-access.mjs';
import { isReHubConfigured, requestPatientTriage } from '../src/rehub.mjs';

const env = {
  APP_ENV: 'production', CONSULTATION_BOT_MODE: 'test',
  REHUB_BASE_URL: 'https://test.example.test/dev2', REHUB_CLIENT_ID: 'synthetic-test', REHUB_PUBLIC_KEY_BASE64: 'test-key',
  REHUB_PRODUCTION_BASE_URL: 'https://production.example.test/api', REHUB_PRODUCTION_CLIENT_ID: 'synthetic-production', REHUB_PRODUCTION_PUBLIC_KEY_BASE64: 'production-key',
};
test('the exact bot switch selects complete and isolated ReHub sets', () => {
  for (const mode of ['test', 'production']) {
    const current = { ...env, CONSULTATION_BOT_MODE: mode };
    const settings = resolveReHubSettings(current);
    assert.equal(settings.mode, consultationBotMode(current));
    assert.equal(settings.clientId, `synthetic-${mode}`);
    assert.equal(settings.publicKeyBase64, `${mode}-key`);
    assert.equal(new URL(settings.baseUrl).hostname, `${mode}.example.test`);
    assert.ok(isReHubConfigured(settings));
  }
});
test('production never borrows test credentials or endpoint when incomplete', async () => {
  for (const missing of ['BASE_URL', 'CLIENT_ID', 'PUBLIC_KEY_BASE64']) {
    const settings = resolveReHubSettings({ ...env, CONSULTATION_BOT_MODE: 'production', [`REHUB_PRODUCTION_${missing}`]: '' });
    assert.equal(isReHubConfigured(settings), false);
    await assert.rejects(requestPatientTriage({ settings, patientExternalId: 'synthetic', center: 'test', fetchImpl: () => assert.fail('must not send') }), /REHUB_NOT_CONFIGURED/);
  }
});
test('invalid mode and ambiguous or unsafe key/endpoint configuration fail closed', () => {
  for (const mode of ['prod', '', 'anything']) assert.throws(() => resolveReHubSettings({ ...env, CONSULTATION_BOT_MODE: mode }), /BOT_ACCESS_MODE_INVALID/);
  assert.equal(resolveReHubSettings({ ...env, CONSULTATION_BOT_MODE: undefined }).mode, 'production');
  assert.throws(() => resolveReHubSettings({ ...env, REHUB_PUBLIC_KEY_PATH: '/key.pem' }), /REHUB_KEY_CONFIG_CONFLICT/);
  for (const url of ['http://example.test', 'https://user:password@example.test', 'https://example.test?key=secret', 'invalid']) {
    assert.throws(() => resolveReHubSettings({ ...env, REHUB_BASE_URL: url }), /REHUB_BASE_URL_INVALID/);
  }
});
test('test keeps its existing default endpoint and key-path support', () => {
  const settings = resolveReHubSettings({ REHUB_CLIENT_ID: 'synthetic', REHUB_PUBLIC_KEY_PATH: '/key.pem' });
  assert.match(settings.baseUrl, /\/dev2$/);
  assert.equal(settings.publicKeyPath, '/key.pem');
  assert.ok(isReHubConfigured(settings));
});
test('confirmed production base generates the exact /pro assignment endpoint', async () => {
  const settings = resolveReHubSettings({ ...env, CONSULTATION_BOT_MODE: 'production',
    REHUB_PRODUCTION_BASE_URL: 'https://f8dheiojk4.execute-api.eu-west-1.amazonaws.com/pro' });
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  await requestPatientTriage({ settings, publicKey, patientExternalId: 'synthetic', center: 'cokiba', fetchImpl: async url => {
    assert.equal(url.toString(), 'https://f8dheiojk4.execute-api.eu-west-1.amazonaws.com/pro/patient/triage/assign');
    return { ok: true, json: async () => ({ url: 'https://patient.rehub.cloud/opentriage/synthetic' }) };
  } });
  assert.equal(resolveReHubSettings(env).mode, 'test');
});
test('switching environments uses the matching RSA key, client and URL without stale cache', async () => {
  const keys = Object.fromEntries(['test', 'production'].map(mode => [mode, generateKeyPairSync('rsa', { modulusLength: 3072 })]));
  const keyEnv = { ...env,
    REHUB_PUBLIC_KEY_BASE64: Buffer.from(keys.test.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64'),
    REHUB_PRODUCTION_PUBLIC_KEY_BASE64: Buffer.from(keys.production.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64'),
  };
  for (const mode of ['test', 'production', 'test']) {
    const settings = resolveReHubSettings({ ...keyEnv, CONSULTATION_BOT_MODE: mode });
    await requestPatientTriage({ settings, patientExternalId: 'synthetic', center: 'agreement-slug', fetchImpl: async (url, options) => {
      assert.equal(url.origin, `https://${mode}.example.test`);
      assert.equal(options.headers['client-id'], `synthetic-${mode}`);
      assert.equal(options.redirect, 'error');
      const payload = JSON.parse(privateDecrypt({ key: keys[mode].privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(JSON.parse(options.body).data, 'hex')));
      assert.equal(payload.data.center, 'agreement-slug');
      assert.equal(payload.data.patientExternalId, 'synthetic');
      return { ok: true, json: async () => ({ url: 'https://patient.rehub.cloud/opentriage/synthetic' }) };
    } });
  }
});
