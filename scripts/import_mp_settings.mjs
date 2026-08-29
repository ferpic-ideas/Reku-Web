import { stdin } from "node:process";
import { initDb } from "../src/db.mjs";
import {
  publicMercadoPagoSettings,
  saveMercadoPagoSettings,
} from "../src/mercado-pago.mjs";

const chunks = [];
for await (const chunk of stdin) chunks.push(chunk);

const settings = JSON.parse(Buffer.concat(chunks).toString("utf8"));

await initDb();
const saved = await saveMercadoPagoSettings(settings);
const publicSettings = publicMercadoPagoSettings(saved);

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
