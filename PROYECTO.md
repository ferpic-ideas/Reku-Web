# Reku Web - Guia del proyecto

Este repo contiene la web publica de Reku, el formulario de alta de pacientes y
un admin basico para acuerdos, nominas y registros recibidos.

## Ubicaciones

- Repo local: `/Users/ferpic/Documents/reku-web`
- Repo GitHub: `https://github.com/ferpic-ideas/Reku-Web`
- VPS: `ferpic-ideas`
- Path en VPS: `/docker/reku-web`
- Dominio principal: `https://www.reku.io`
- Redirect apex: `https://reku.io` redirige a `https://www.reku.io`
- Dominio tecnico del contenedor: `https://reku-web.srv1699600.hstgr.cloud`

## Arquitectura

La aplicacion corre como un servicio Node.js con archivos estaticos y APIs
propias. En produccion se levanta con Docker Compose junto a Postgres.

- `web`: Node.js, sirve la web estatica, formularios, admin y API.
- `db`: Postgres 16, solo red interna de Docker.
- `uploads`: volumen bind en `/docker/reku-web/uploads`, usado para logos, PDFs e imagenes cargadas desde el admin.
- `backups`: carpeta bind en `/docker/reku-web/backups`, usada para dumps manuales.
- Traefik: enruta `www.reku.io`, `reku.io` y el dominio tecnico hacia el servicio `web`.
- Email: el backend envia mails con proveedor configurable (`EMAIL_PROVIDER=ses|resend`).

## Rutas principales

- `/`: home estatica.
- `/producto.html`: pagina de producto.
- `/evidencia.html`: pagina de evidencia.
- `/alta-pacientes/`: formulario generico de alta.
- `/alta-pacientes/?form=<slug>`: formulario asociado a un acuerdo.
- `/agenda/?token=<token>`: agenda mobile para reservar turno con link firmado.
- `/profesional-turnos/?token=<token>`: vista simple para que un profesional vea sus turnos próximos.
- `/admin/`: admin interno.
- `/admin/<modulo>`: deep links del admin para cada módulo, por ejemplo `/admin/turnos`.
- `/api/public/agreements/<slug>`: datos publicos de un acuerdo.
- `/api/admin/*`: API autenticada del admin.
- `/api/booking/*`: API publica de agenda con token firmado.
- `/api/booking/mercado-pago/webhook`: webhook de Mercado Pago.
- `/api/professional/appointments`: API publica de turnos del profesional con token firmado.
- `/uploads/*`: logos y PDFs cargados desde el admin.

Si `/alta-pacientes/?form=<slug>` recibe un slug que no existe o esta borrado,
devuelve 404.

## Estructura de archivos

```text
.
|-- index.html                  # Web publica principal
|-- producto.html               # Pagina producto
|-- evidencia.html              # Pagina evidencia
|-- alta-pacientes/index.html   # Formulario de alta de pacientes
|-- admin/
|   |-- index.html              # Shell del admin
|   |-- app.js                  # UI y llamadas API del admin
|   `-- styles.css              # Layout admin: sidebar, mobile, tablas, modales
|-- agenda/
|   |-- index.html              # Shell publico de agenda mobile
|   |-- app.js                  # Flujo de reserva y pago Checkout Pro
|   `-- styles.css              # UI mobile-first de agenda
|-- profesional-turnos/
|   |-- index.html              # Vista publica de turnos para profesionales
|   |-- app.js                  # Carga turnos por token
|   `-- styles.css              # UI mobile-first de turnos
|-- src/
|   |-- admin-api.mjs           # Auth y endpoints del admin
|   |-- appointment-notifications.mjs # Mails al profesional por turnos confirmados
|   |-- booking-api.mjs         # Servicios, profesionales, slots, turnos y pagos
|   |-- booking-links.mjs       # Links firmados por 48h para agenda
|   |-- config.mjs              # Configuracion y validaciones de arranque
|   |-- csv.mjs                 # Parser CSV para nominas
|   |-- db.mjs                  # Pool Postgres, migracion inicial y helpers
|   |-- email.mjs               # Envio por SES/Resend y dry-run
|   |-- forms.mjs               # Procesamiento de formularios publicos
|   |-- http.mjs                # Helpers HTTP, headers y static serving
|   |-- mercado-pago.mjs        # Checkout Pro, consulta de pagos y webhook signature
|   |-- professional-api.mjs    # API publica de turnos para profesionales
|   |-- professional-links.mjs  # Links firmados para profesionales
|   |-- security.mjs            # Sesiones, CSRF, password hashing y rate limit
|   |-- templates.mjs           # Templates configurables de mails
|   `-- uploads.mjs             # Multipart, logos, PDFs y CSV uploads
|-- server.mjs                  # Router principal y arranque
|-- docker-compose.yml          # Produccion VPS
|-- Dockerfile                  # Imagen Node
|-- scripts/secrets_check.sh    # Check basico anti-secretos
|-- .env.example                # Variables documentadas sin secretos
`-- images/                     # Assets publicos
```

## Admin

El admin vive en `/admin/` y requiere login.

Usuario inicial:

- Email: `ferpic@gmail.com`
- La clave temporal esta fuera del repo, en el archivo local:
  `/Users/ferpic/Desktop/reku-admin-password.txt`

Funciones actuales:

- CRUD Acuerdos.
- Acuerdos con `name`, `slug`, `logo`, `pdf`, `cobranded`, `type`, links de pago y template de mail.
- Opcion "Get URL" para copiar la URL del formulario por acuerdo.
- Registro de altas recibidas, con filtro por acuerdo.
- Registro de contactos recibidos.
- Delete de altas/contactos solo para `ferpic@gmail.com`.
- CRUD manual de nominas.
- Import CSV de nominas.
- Filtro de nominas por acuerdo.
- Dashboard con metricas de contactos, altas, turnos, facturacion, servicios,
  profesionales y bloqueos.
- CRUD de servicios y profesionales.
- Bloqueo de horarios por profesional.
- Probar agenda con link firmado de 48h.
- Configuracion de Mercado Pago Checkout Pro solo para `ferpic@gmail.com`.
- Auditoria solo para `ferpic@gmail.com`.

## Modelo de datos

Tablas principales:

- `users`: usuarios admin, password hash, rol, estado y version de sesion.
- `agreements`: acuerdos, co-branding, PDF, links de pago y templates.
- `nomina_entries`: registros de nomina asociados a acuerdos tipo `Nomina`.
- `patient_intakes`: altas enviadas desde `/alta-pacientes/`.
- `contacts`: contactos enviados desde la web principal.
- `services`: servicios reservables con duracion, costo y link fallback.
- `professionals`: profesionales, foto, mail, estado.
- `professional_services`: servicios que atiende cada profesional.
- `professional_availability`: dias y franjas horarias regulares.
- `schedule_blocks`: bloqueos puntuales de agenda.
- `booking_access_links`: tokens firmados/hasheados para abrir agenda por 48h.
- `professional_access_links`: tokens firmados/hasheados para vista de turnos del profesional.
- `appointments`: turnos, estado de pago y referencias Mercado Pago.
- `app_settings`: configuraciones internas como credenciales Mercado Pago.
- `audit_events`: eventos relevantes del admin.

Notas:

- Los acuerdos se borran con `deleted_at`, no con delete fisico desde el admin.
- `nomina_entries.identificador_normalized` evita duplicados case-insensitive.
- Los uploads guardan rutas relativas en DB y archivos reales en `uploads/`.

## Templates de mail

Cada acuerdo puede configurar asunto y cuerpo del mail de alta. El backend valida
el template antes de guardar para evitar variables rotas.

Variables permitidas:

```text
{{patient.nombre}}
{{patient.apellido}}
{{patient.telefono}}
{{patient.email}}
{{patient.identificador}}
{{agreement.name}}
{{agreement.type}}
```

El mail agrega automaticamente:

- Link al PDF "Como funciona", si el acuerdo tiene PDF.
- Link de pago de consulta/evaluacion, si el acuerdo no es `Nomina` y tiene link.
- Link de pago de tratamiento, si el acuerdo no es `Nomina` y tiene link.
- Link de agenda de 48h para reservar turno.

## Agenda y Mercado Pago

La agenda vive en `/agenda/?token=<token>`. El token nunca se guarda plano: se
guarda su hash en `booking_access_links` y vence a las 48h.

Flujo de reserva:

1. El paciente elige servicio.
2. Elige profesional.
3. Elige fecha y horario disponible.
4. El backend crea un turno `pending_payment` y una preferencia de Checkout Pro.
5. Mercado Pago redirige de vuelta a `/agenda/`.
6. El backend consulta el pago y confirma el turno solo si el estado es `approved`.

Estados relevantes:

- `appointments.status = pending_payment`: horario reservado temporalmente.
- `appointments.status = confirmed`: turno confirmado.
- `appointments.status = payment_failed`: pago rechazado/cancelado o error.
- `appointments.payment_status`: estado crudo recibido de Mercado Pago.

Los turnos `pending_payment` bloquean el horario por 30 minutos para evitar doble
reserva durante el checkout.

Cuando un turno pasa a `confirmed`, el backend envia un mail al profesional con:

- Fecha, horario y servicio.
- Datos de contacto del paciente.
- Link firmado a `/profesional-turnos/?token=<token>` para ver todos sus turnos
  confirmados desde la fecha actual hacia adelante.

El mail no se envia cuando el turno esta `pending_payment`; se dispara al confirmar
un pago `approved` por webhook/retorno de Mercado Pago o al crear un turno sin
costo. `appointments.professional_notified_at` evita duplicados si llegan webhook
y retorno casi al mismo tiempo.

Credenciales:

- Se cargan desde `/admin/` > menu de usuario > `Configurar`.
- Hay bloques separados para `Desarrollo` y `Produccion`.
- Solo se muestra si un secreto esta cargado; no se devuelven tokens al browser.
- En VPS debe quedar activo el modo `Produccion`.

Webhook a configurar en Mercado Pago:

```text
https://www.reku.io/api/booking/mercado-pago/webhook
```

Evento a activar: `Payments`.

Si Mercado Pago provee `Webhook Secret`, cargarlo en el admin para validar
`x-signature`. Si no esta cargado, el webhook igual consulta el pago por API
antes de tocar un turno.

## Variables de entorno

Usar `.env.example` como referencia. El `.env` real no se commitea.

Variables clave:

- `APP_ENV`
- `APP_PUBLIC_URL`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `SESSION_SECRET`
- `SESSION_SECURE`
- `BOOTSTRAP_ADMIN_EMAIL`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `UPLOAD_ROOT`
- `UPLOAD_MAX_BYTES`
- `CSV_UPLOAD_MAX_BYTES`
- `CONTACT_TO_EMAIL`
- `PATIENT_INTAKE_TO_EMAIL`
- `EMAIL_PROVIDER`
- `EMAIL_FROM`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_SESSION_TOKEN`
- `AWS_REGION`
- `SES_FROM_EMAIL`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `EMAIL_DRY_RUN`

En produccion, `SESSION_SECRET` y `POSTGRES_PASSWORD` son obligatorios. No
imprimir ni pegar el `.env` en chats, commits o logs.

Para usar Resend temporalmente mientras SES esta en sandbox:

```env
EMAIL_PROVIDER=resend
EMAIL_FROM=Reku <hola@reku.io>
RESEND_FROM_EMAIL=Reku <hola@reku.io>
RESEND_API_KEY=<api-key-en-.env-del-vps>
```

`hola@reku.io` debe estar habilitado/verificado en Resend. Para volver a SES,
cambiar `EMAIL_PROVIDER=ses`.

## Desarrollo local

Instalar dependencias:

```bash
npm install
```

Crear `.env` desde `.env.example` y ajustar valores locales. Para probar sin DB,
dejar `DATABASE_URL` vacio; la web estatica y formularios genericos siguen
levantando, pero el admin y acuerdos no quedan disponibles.

Arrancar:

```bash
npm start
```

Validar:

```bash
npm run build
npm run check
```

`npm run check` ejecuta:

- syntax check de `server.mjs`.
- syntax check de `src/*.mjs`.
- syntax check de `admin/app.js`.
- `scripts/secrets_check.sh`.

## Operacion segura

Antes de hacer consultas remotas, importar credenciales, probar datos temporales
o desplegar, revisar `OPERACION_SEGURA.md`. Ese archivo documenta los patrones
seguros para evitar errores de quoting con `ssh`/`psql`, no imprimir secretos y
validar el VPS sin tocar otros contenedores.

## Deploy al VPS

El deploy actual es manual por `rsync` + `docker compose up -d --build`.
No hay Netlify.

Desde el repo local:

```bash
cd /Users/ferpic/Documents/reku-web

npm run build
npm run check

rsync -az --delete \
  --exclude '.git' \
  --exclude '.env' \
  --exclude 'node_modules' \
  --exclude 'uploads' \
  --exclude 'backups' \
  --exclude 'logs' \
  ./ ferpic-ideas:/docker/reku-web/

ssh ferpic-ideas 'cd /docker/reku-web && docker compose up -d --build'
```

Validar despues del deploy:

```bash
ssh ferpic-ideas 'cd /docker/reku-web && docker compose ps'
ssh ferpic-ideas 'cd /docker/reku-web && docker compose logs --no-color --tail=100 web'

curl -fsSI https://www.reku.io/
curl -fsSI https://www.reku.io/alta-pacientes/
curl -fsSI https://www.reku.io/admin/
curl -sSI https://reku.io/admin/
```

Resultado esperado:

- `www.reku.io` responde `200`.
- `/alta-pacientes/` responde `200`.
- `/admin/` responde `200` y `x-robots-tag: noindex, nofollow`.
- `reku.io` responde redirect `308` hacia `www.reku.io`.

Evitar:

- No usar `docker compose down -v`.
- No borrar `postgres_data`.
- No borrar `/docker/reku-web/uploads`.
- No imprimir `.env`.
- No reiniciar Traefik salvo que el cambio sea de routing global.

## Consultar la DB en el VPS

La DB no expone puerto publico. Se consulta entrando por SSH y ejecutando `psql`
dentro del contenedor `db`.

Modo interactivo:

```bash
ssh ferpic-ideas
cd /docker/reku-web
docker compose exec db sh
psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

Una query puntual desde local:

```bash
ssh ferpic-ideas 'cd /docker/reku-web && docker compose exec -T db sh -lc '\''psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'\''' <<'SQL'
SELECT id, name, slug, type, cobranded, created_at
FROM agreements
WHERE deleted_at IS NULL
ORDER BY id DESC;
SQL
```

Listar ultimas altas:

```bash
ssh ferpic-ideas 'cd /docker/reku-web && docker compose exec -T db sh -lc '\''psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'\''' <<'SQL'
SELECT
  p.id,
  p.created_at,
  p.nombre,
  p.apellido,
  p.email,
  p.telefono,
  COALESCE(a.name, p.agreement_name_snapshot, '') AS agreement
FROM patient_intakes p
LEFT JOIN agreements a ON a.id = p.agreement_id
ORDER BY p.created_at DESC
LIMIT 20;
SQL
```

Contar contactos:

```bash
ssh ferpic-ideas 'cd /docker/reku-web && docker compose exec -T db sh -lc '\''psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'\''' <<'SQL'
SELECT count(*) FROM contacts;
SQL
```

Ver acuerdos tipo nomina:

```bash
ssh ferpic-ideas 'cd /docker/reku-web && docker compose exec -T db sh -lc '\''psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'\''' <<'SQL'
SELECT id, name, slug
FROM agreements
WHERE type = 'Nomina'
  AND deleted_at IS NULL
ORDER BY name;
SQL
```

Exportar altas a CSV local:

```bash
ssh ferpic-ideas 'cd /docker/reku-web && docker compose exec -T db sh -lc '\''psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'\''' <<'SQL' > altas-pacientes.csv
\copy (
  SELECT
    p.id,
    p.created_at,
    p.nombre,
    p.apellido,
    p.email,
    p.telefono,
    COALESCE(a.name, p.agreement_name_snapshot, '') AS agreement
  FROM patient_intakes p
  LEFT JOIN agreements a ON a.id = p.agreement_id
  ORDER BY p.created_at DESC
) TO STDOUT WITH CSV HEADER
SQL
```

## Backups manuales

Crear dump dentro del VPS:

```bash
ssh ferpic-ideas
cd /docker/reku-web
mkdir -p backups
docker compose exec -T db sh -lc 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > "backups/reku_web_$(date +%F_%H%M).sql"
```

Copiar un backup a la maquina local:

```bash
rsync -av ferpic-ideas:/docker/reku-web/backups/ ./backups/
```

Restaurar un dump requiere bajar o pisar datos; hacerlo solo con una decision
explicita y backup previo. No usar `down -v` para restaurar.

## Troubleshooting

Estado de contenedores:

```bash
ssh ferpic-ideas 'cd /docker/reku-web && docker compose ps'
```

Logs web:

```bash
ssh ferpic-ideas 'cd /docker/reku-web && docker compose logs --no-color --tail=100 web'
```

Logs DB:

```bash
ssh ferpic-ideas 'cd /docker/reku-web && docker compose logs --no-color --tail=100 db'
```

Probar routing sin depender de DNS local:

```bash
curl --resolve www.reku.io:443:2.24.124.183 -fsSI https://www.reku.io/
curl --resolve reku.io:443:2.24.124.183 -sSI https://reku.io/
```

DNS publico:

```bash
dig @1.1.1.1 www.reku.io +short
dig @1.1.1.1 reku.io +short
```

Si el web no arranca, revisar primero:

- `.env` en `/docker/reku-web`.
- `SESSION_SECRET` configurado en produccion.
- `POSTGRES_PASSWORD` configurado.
- `docker compose logs web`.
- `docker compose logs db`.

Si los uploads no se ven:

- Confirmar que exista `/docker/reku-web/uploads`.
- Confirmar que `web` tenga el volumen `./uploads:/app/uploads`.
- Revisar permisos de la carpeta.

## Flujo recomendado de cambios

```bash
cd /Users/ferpic/Documents/reku-web
git status --short --branch
npm run build
npm run check

# editar, probar y deployar

git add <archivos>
git commit -m "<mensaje>"
git push origin main
```

Despues de pushear, el VPS no se actualiza solo. Hay que correr el deploy manual
descripto arriba.
