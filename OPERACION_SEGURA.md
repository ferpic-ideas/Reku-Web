# Operacion segura del proyecto

Este documento deja reglas practicas para operar Reku Web sin repetir errores de
quoting, consultas remotas fragiles o exposicion accidental de secretos.

## Regla principal

Cuando haya que ejecutar algo complejo en el VPS, evitar comandos con muchas
capas de comillas entre `ssh`, `docker compose exec`, `sh -lc`, SQL y patrones
como `%`.

Preferir una de estas opciones:

- Un script versionado en `scripts/`.
- Node dentro del contenedor `web`.
- Un heredoc claro y autocontenido.
- `psql` solo para consultas simples sin interpolacion rara.

## Consultas a la DB del VPS

Preferido: usar Node dentro del contenedor `web`, porque ya tiene acceso a
`DATABASE_URL` y evita pelearse con comillas de `psql`.

```bash
ssh ferpic-ideas 'cd /docker/reku-web && docker compose exec -T web node --input-type=module -' <<'REMOTE'
import { initDb, query } from './src/db.mjs';

await initDb();
const result = await query(
  "SELECT COUNT(*)::int AS count FROM services WHERE name LIKE 'mp-e2e-%'",
);
console.log(JSON.stringify({ ok: true, count: result.rows[0].count }));
REMOTE
```

Usar `psql` solamente para consultas muy simples:

```bash
ssh ferpic-ideas 'cd /docker/reku-web && docker compose exec -T db sh -lc '"'"'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT 1"'"'"''
```

Si una consulta necesita strings con `%`, JSON, arrays, varias sentencias o
parametros, usar Node o crear un script.

## Scripts para tareas repetibles

Si una tarea puede repetirse, crear un script versionado. Ejemplo actual:

```text
scripts/import_mp_settings.mjs
```

Ese script importa configuracion de Mercado Pago desde JSON por `stdin`, guarda
en `app_settings` y solo imprime flags booleanos, no secretos.

Patron recomendado:

```bash
node scripts/generar_payload_local.mjs \
  | ssh ferpic-ideas 'cd /docker/reku-web && docker compose exec -T web node scripts/script_remoto.mjs'
```

## Secretos

Nunca imprimir ni commitear:

- `.env`
- Access tokens
- API keys
- passwords
- webhook secrets
- archivos locales como `reku-mp.txt` o `ses-key.txt`

Para verificar carga de credenciales, imprimir solo estado redacted:

```json
{
  "ok": true,
  "mode": "production",
  "production_access_token_set": true
}
```

No imprimir prefijos/sufijos de secretos en logs finales si no hace falta.

## Archivos ignorados

Mantener ignorados los archivos locales sensibles:

```text
.env
ses-key.txt
reku-admin-password.txt
reku-mp.txt
private-uploads/
```

El check `npm run secrets:check` debe seguir pasando antes de commit.

## Comandos destructivos o rechazables

Evitar comandos de limpieza agresivos en una sola linea:

- `rm -f`
- `docker compose down -v`
- `docker system prune`
- `git reset --hard`
- `git checkout --`

Si hace falta limpiar datos temporales, hacerlo con una query/script acotado,
por ID o por label temporal, y mostrar conteos de verificacion.

## Deploy

Deploy normal:

```bash
npm run check
npm run build

rsync -az --delete \
  --exclude '.git' \
  --exclude '.env' \
  --exclude 'node_modules' \
  --exclude 'uploads' \
  --exclude 'private-uploads' \
  --exclude 'backups' \
  --exclude 'logs' \
  ./ ferpic-ideas:/docker/reku-web/

ssh ferpic-ideas 'cd /docker/reku-web && docker compose up -d --build'
```

Antes de deploy:

```bash
git status --short --branch
npm run check
git diff --check
POSTGRES_PASSWORD=<valor-temporal> \
SESSION_SECRET=<valor-temporal-de-32-caracteres> \
docker compose config --quiet
```

Además:

1. Confirmar que el backup de Postgres es recuperable.
2. Confirmar en el admin, sin imprimir el valor, que el `webhook_secret` del modo
   activo está cargado.
3. Configurar el mismo webhook en Mercado Pago para
   `https://www.reku.io/api/booking/mercado-pago/webhook`.
4. No desplegar si alguno de los dos lados no está listo: esta versión falla
   cerrado con `503`.
5. Conservar el volumen Docker `private_uploads`; nunca copiar su contenido
   dentro del árbol público.
6. Revisar que `BOOTSTRAP_ADMIN_EMAIL` y `BOOTSTRAP_ADMIN_PASSWORD` estén vacíos
   si ya existe un admin activo.

Despues de deploy:

```bash
ssh ferpic-ideas 'cd /docker/reku-web && docker compose ps'
ssh ferpic-ideas 'cd /docker/reku-web && docker compose logs --no-color --tail=80 web'
curl -fsSI https://www.reku.io/
curl -fsSI https://www.reku.io/admin/
curl -fsSI https://www.reku.io/turnos/
curl -fsS https://www.reku.io/health
```

## Healthchecks

- `GET /health`: readiness pública del Admin. Devuelve `200` cuando PostgreSQL,
  el bundle estático y los volúmenes de almacenamiento están disponibles; ante
  cualquier fallo devuelve `503`.
- `GET /healthz`: liveness mínima utilizada por el healthcheck del contenedor.

## Pruebas con datos temporales

Cuando se creen datos temporales para pruebas:

- Usar un prefijo unico, por ejemplo `mp-e2e-<timestamp>`.
- Guardar IDs creados en el script.
- Limpiar por ID en `finally`.
- Verificar despues que el prefijo quedo en cero.

Ejemplo de verificacion segura:

```bash
ssh ferpic-ideas 'cd /docker/reku-web && docker compose exec -T web node --input-type=module -' <<'REMOTE'
import { initDb, query } from './src/db.mjs';

await initDb();
const result = await query(
  "SELECT COUNT(*)::int AS count FROM services WHERE name LIKE 'mp-e2e-%'",
);
console.log(JSON.stringify({ ok: true, temp_services: result.rows[0].count }));
REMOTE
```

## Mercado Pago

Para Checkout Pro:

- Crear preferencias desde backend, no desde el browser.
- Guardar token y client secret en `app_settings`, nunca en archivos versionados.
- Usar `notification_url` HTTPS:

```text
https://www.reku.io/api/booking/mercado-pago/webhook
```

- Confirmar turno solo cuando el pago quede `approved`.
- Exigir `webhook_secret`, firma válida y timestamp fresco. Sin secreto el webhook
  responde `503` y no consulta pagos ni modifica turnos.

## Evidencia sobre secretos históricos (24/07/2026)

El relevamiento de sólo lectura dio resultado negativo en:

- URLs públicas actuales de `.env`, `reku-admin-password.txt`, `ses-key.txt` y
  `reku-mp.txt`.
- filesystem de la imagen actualmente desplegada.
- nombres y contenido alcanzable del historial Git local/remoto.

La imagen anterior ya no estaba disponible en el host y el build cache no permite
reconstruir con certeza su contenido. Por eso la conclusión correcta es: no hay
evidencia de exposición en los artefactos disponibles, pero no puede demostrarse
que una imagen histórica ya eliminada nunca los haya contenido. La rotación
preventiva de credenciales queda como decisión operativa separada y no debe
imprimir valores durante la verificación.

## Checklist mental antes de ejecutar

1. Estoy en el repo correcto: `/Users/ferpic/Documents/reku-web`.
2. El comando apunta solo a `/docker/reku-web`.
3. No voy a imprimir secretos.
4. Si hay SQL con `%` o JSON, uso Node/script.
5. Si hay datos temporales, hay limpieza en `finally`.
6. Corri `npm run check` y `git diff --check`.
7. Valide rutas publicas despues del deploy.
