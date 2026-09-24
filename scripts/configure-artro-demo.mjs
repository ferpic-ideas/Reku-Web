// Run inside the Reku container. The API credential stays encrypted server-side.
import { one, query, pool } from '../src/db.mjs';
import { config } from '../src/config.mjs';
import { encryptSecret } from '../src/secret-envelope.mjs';
import { createAgreementApiCredential } from '../src/agreement-api.mjs';

try {
  if (!process.argv.includes('--enable')) throw new Error('Use --enable to provision the public Artro demo.');
  const existing = await one("SELECT value FROM app_settings WHERE key = 'artro_api_demo'");
  if (existing?.value?.enabled) throw new Error('Demo already enabled; refusing to rotate credentials implicitly.');
  const agreement = await one("SELECT id FROM agreements WHERE slug = 'artro' AND deleted_at IS NULL");
  if (!agreement) throw new Error('Artro agreement not found.');
  // Validate encryption material before creating a credential.
  encryptSecret('preflight', { material: config.settingsEncryptionKey });
  const { credential, token } = await createAgreementApiCredential({ agreementId: agreement.id, name: 'Demo reku.io/test', userId: null });
  const value = { enabled: true, credential_id: credential.id,
    token_encrypted: encryptSecret(token, { material: config.settingsEncryptionKey, context: 'artro-api-demo:credential' }) };
  await query("INSERT INTO app_settings (key, value) VALUES ('artro_api_demo', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()", [value]);
  console.log(JSON.stringify({ enabled: true, credential_id: credential.id, public_access: true }));
} finally { await pool.end(); }
