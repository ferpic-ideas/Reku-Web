// Run inside the Reku container. Generated access details go to a private file, never stdout.
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { one, query, pool } from '../src/db.mjs';
import { config, privateUploadRoot } from '../src/config.mjs';
import { hashPassword } from '../src/security.mjs';
import { encryptSecret } from '../src/secret-envelope.mjs';
import { createAgreementApiCredential } from '../src/agreement-api.mjs';

try {
  if (!process.argv.includes('--enable')) throw new Error('Use --enable to provision the protected Artro demo.');
  const existing = await one("SELECT value FROM app_settings WHERE key = 'artro_api_demo'");
  if (existing?.value?.enabled) throw new Error('Demo already enabled; refusing to rotate credentials implicitly.');
  const agreement = await one("SELECT id FROM agreements WHERE slug = 'artro' AND deleted_at IS NULL");
  if (!agreement) throw new Error('Artro agreement not found.');
  const password = randomBytes(18).toString('base64url');
  const passwordHash = await hashPassword(password);
  // Validate encryption material before creating a credential.
  encryptSecret('preflight', { material: config.settingsEncryptionKey });
  const { credential, token } = await createAgreementApiCredential({ agreementId: agreement.id, name: 'Demo protegida reku.io/test', userId: null });
  const value = { enabled: true, credential_id: credential.id, password_hash: passwordHash,
    token_encrypted: encryptSecret(token, { material: config.settingsEncryptionKey, context: 'artro-api-demo:credential' }) };
  await writeFile(join(privateUploadRoot, 'artro-demo-access.txt'),
    `Demo Artro / Reku\nURL: ${config.appPublicUrl}/test\nClave de acceso: ${password}\n\nCrea turnos reales de prueba en Reku. No realiza cobros.\nCompartir sólo con el equipo autorizado. No es la clave de la API.\n`, { mode: 0o600, flag: 'wx' });
  await query("INSERT INTO app_settings (key, value) VALUES ('artro_api_demo', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()", [value]);
  console.log(JSON.stringify({ enabled: true, credential_id: credential.id, access_file: 'private storage / artro-demo-access.txt' }));
} finally { await pool.end(); }
