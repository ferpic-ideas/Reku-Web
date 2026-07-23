import { stdin } from "node:process";
import { initDb, one, query } from "../src/db.mjs";
import { publicMercadoPagoSettings } from "../src/mercado-pago.mjs";

const chunks = [];
for await (const chunk of stdin) chunks.push(chunk);

const settings = JSON.parse(Buffer.concat(chunks).toString("utf8"));

await initDb();
await query(
  `
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('mercado_pago', $1::jsonb, NOW())
    ON CONFLICT (key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `,
  [JSON.stringify(settings)],
);

const row = await one("SELECT value FROM app_settings WHERE key = 'mercado_pago'");
const publicSettings = publicMercadoPagoSettings(row.value);

console.log(
  JSON.stringify({
    ok: true,
    mode: publicSettings.mode,
    development_access_token_set: publicSettings.development.access_token_set,
    production_access_token_set: publicSettings.production.access_token_set,
    production_client_secret_set: publicSettings.production.client_secret_set,
    production_webhook_secret_set: publicSettings.production.webhook_secret_set,
  }),
);
