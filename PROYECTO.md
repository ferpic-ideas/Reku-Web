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
- Dominio tecnico del contenedor: redirige de forma permanente al dominio principal.

## Arquitectura

La aplicacion corre como un servicio Node.js con archivos estaticos y APIs
propias. En produccion se levanta con Docker Compose junto a Postgres.

- `web`: Node.js, sirve la web estatica, formularios, admin y API.
- `db`: Postgres 16, solo red interna de Docker.
- `uploads`: volumen bind público usado solo para logos, PDFs informativos e imágenes
  declaradas en la allowlist.
- `private_uploads`: volumen Docker privado sin ninguna ruta HTTP.
- `backups`: carpeta bind en `/docker/reku-web/backups`, usada para dumps manuales.
- Traefik: enruta `www.reku.io`; el apex y el hostname técnico redirigen al hostname
  canónico. Traefik y Node envían HSTS en producción.
- Email: el backend envia mails con proveedor configurable (`EMAIL_PROVIDER=ses|resend`).

## Rutas principales

- `/`: home estatica.
- `/producto.html`: pagina de producto.
- `/evidencia.html`: pagina de evidencia.
- `/agenda/?form=<slug>`: inicio de alta de paciente y reserva para un acuerdo.
- `/agenda/#token=<token>`: link de agenda; el token se canjea por cookie `HttpOnly`
  y se elimina de la URL.
- `/alta-pacientes/?form=<slug>`: redirige a `/agenda/?form=<slug>`.
- `/profesional-turnos/#token=<token>`: link de un solo uso; se canjea por una sesión
  `HttpOnly` corta y se elimina de la URL.
- `/congreso-cokiba`: formulario público de registro del Congreso COKIBA.
- `/admin/`: admin interno.
- `/admin/<modulo>`: deep links del admin para cada módulo, por ejemplo `/admin/turnos`.
- `/api/public/agreements/<slug>`: datos publicos de un acuerdo.
- `/api/admin/*`: API autenticada del admin.
- `/api/booking/*`: API publica de agenda con token firmado.
- `/api/booking/mercado-pago/webhook`: webhook de Mercado Pago.
- `/api/professional/appointments`: API de turnos del profesional autenticada por cookie.
- `/uploads/*`: handler público limitado a carpetas y extensiones explícitas. No sirve
  el storage privado ni SVG subidos.

Si `/agenda/?form=<slug>` recibe un slug que no existe o esta borrado,
devuelve 404.

## Estructura de archivos

```text
.
|-- index.html                  # Web publica principal
|-- producto.html               # Pagina producto
|-- evidencia.html              # Pagina evidencia
|-- alta-pacientes/index.html   # Formulario legado; la ruta redirige a agenda
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
|   |-- authorization.mjs       # Matriz default-deny de rutas, roles y permisos
|   |-- booking-api.mjs         # Servicios, profesionales, slots, turnos y pagos
|   |-- booking-links.mjs       # Links firmados por 48h para agenda
|   |-- config.mjs              # Configuracion y validaciones de arranque
|   |-- csv.mjs                 # Parser CSV para nominas
|   |-- db.mjs                  # Pool Postgres, esquema legado y helpers
|   |-- email.mjs               # Envio por SES/Resend y dry-run
|   |-- forms.mjs               # Procesamiento de formularios publicos
|   |-- http.mjs                # Helpers HTTP, headers y static serving
|   |-- mercado-pago.mjs        # Checkout Pro, consulta de pagos y webhook signature
|   |-- migrations.mjs          # Ejecutor transaccional de migraciones versionadas
|   |-- professional-api.mjs    # API publica de turnos para profesionales
|   |-- professional-links.mjs  # Links firmados para profesionales
|   |-- rate-limit.mjs          # Rate limit distribuido/persistente en Postgres
|   |-- security.mjs            # Sesiones, CSRF, password hashing y rate limit
|   |-- templates.mjs           # Templates configurables de mails
|   `-- uploads.mjs             # Multipart, logos, PDFs y CSV uploads
|-- server.mjs                  # Router principal y arranque
|-- migrations/                 # Evoluciones SQL versionadas
|-- test/                       # Pruebas de controles de seguridad
|-- docker-compose.yml          # Produccion VPS
|-- Dockerfile                  # Imagen Node
|-- scripts/secrets_check.sh    # Check basico anti-secretos
|-- .env.example                # Variables documentadas sin secretos
`-- images/                     # Assets publicos
```

## Admin

El admin vive en `/admin/` y requiere login.

No existe un usuario hardcodeado. El bootstrap sólo se usa como recuperación de
primer arranque si no hay ningún admin activo y ambas variables
`BOOTSTRAP_ADMIN_EMAIL` y `BOOTSTRAP_ADMIN_PASSWORD` están definidas. Una vez que
existe un admin activo, reiniciar nunca reactiva, promueve ni cambia claves.

Funciones actuales:

- CRUD Acuerdos.
- Acuerdos con `name`, `slug`, `logo`, `pdf`, `cobranded`, `type`, links de pago y template de mail.
- Opcion "Get URL" para copiar la URL del formulario por acuerdo.
- Registro de altas recibidas, con filtro por acuerdo.
- Registro de contactos recibidos.
- Borrado de altas/contactos sólo con permiso `records.delete`.
- CRUD manual de nominas.
- Import CSV de nominas.
- Filtro de nominas por acuerdo.
- Dashboard con metricas de contactos, altas, turnos, facturacion, servicios,
  profesionales y bloqueos.
- CRUD de servicios y profesionales.
- Bloqueo de horarios por profesional.
- Probar agenda con link firmado de 48h.
- Configuración de Mercado Pago y auditoría sólo para usuarios autorizados.
- Permisos de API declarados en una matriz default-deny. El rol `user` es de sólo
  lectura sobre dashboard, acuerdos, servicios, profesionales, bloqueos y turnos.
- Permisos adicionales opcionales almacenados en `users.permissions`.
- Revocación desde el admin de todos los links y sesiones de un profesional.

## Modelo de datos

Tablas principales:

- `users`: usuarios admin, password hash, rol, permisos explícitos, estado y versión de sesión.
- `agreements`: acuerdos, co-branding, PDF, links de pago y templates.
- `nomina_entries`: registros de nomina asociados a acuerdos tipo `Nomina`.
- `patient_intakes`: altas iniciadas desde `/agenda/?form=<slug>`.
- `contacts`: contactos enviados desde la web principal.
- `congreso_cokiba_registrations`: registros del formulario del Congreso COKIBA.
- `services`: servicios reservables con duracion, costo y link fallback.
- `professionals`: profesionales, foto, mail, estado.
- `professional_services`: servicios que atiende cada profesional.
- `professional_availability`: dias y franjas horarias regulares.
- `schedule_blocks`: bloqueos puntuales de agenda.
- `booking_access_links`: tokens firmados/hasheados para abrir agenda por 48h.
- `professional_access_links`: tokens firmados/hasheados para vista de turnos del profesional.
- `professional_sessions`: sesiones cortas, revocables y separadas del link de email.
- `patient_intake_verifications`: verificaciones de email de un solo uso.
- `public_rate_limits`: buckets persistentes de rate limit, sin IPs/emails en claro.
- `schema_migrations`: migraciones SQL ya aplicadas.
- `appointments`: turnos, estado de pago y referencias Mercado Pago.
- `app_settings`: configuraciones internas como credenciales Mercado Pago.
- `audit_events`: eventos relevantes del admin.

Notas:

- Los acuerdos se borran con `deleted_at`, no con delete fisico desde el admin.
- `nomina_entries.identificador_normalized` evita duplicados case-insensitive.
- Los uploads públicos guardan rutas relativas en DB y archivos reales en
  `uploads/`. El volumen `private_uploads` está montado por separado y nunca se resuelve
  desde una URL.

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

El mail agrega automáticamente:

- Link al PDF "Como funciona", si el acuerdo tiene PDF.
- Link de verificación de email. Al canjearlo se crea el acceso de agenda por 48h
  y se guarda únicamente en una cookie `HttpOnly`.

## Agenda y Mercado Pago

Los links de agenda usan un token en el fragmento URL sólo durante el primer
canje. El servidor valida su hash, entrega una cookie `HttpOnly` con scope
`/api/booking` y el browser limpia el fragmento. El retorno de Mercado Pago no
incluye credenciales.

Flujo de reserva:

1. El alta siempre inserta una fila nueva y devuelve `202` sin IDs ni tokens.
2. El paciente verifica la casilla desde el link recibido por email.
3. El link de un solo uso crea la cookie de agenda.
4. El paciente elige servicio, profesional, fecha y horario.
5. El backend crea un turno `pending_payment` y una preferencia de Checkout Pro.
6. Mercado Pago redirige de vuelta a `/agenda/`.
7. El backend consulta el pago y confirma el turno sólo si el estado es `approved`.

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
- Link de un solo uso a `/profesional-turnos/#token=<token>`. Vence a las 24h,
  crea una sesión de 12h y puede revocarse desde el admin.

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

El `Webhook Secret` es obligatorio para recibir notificaciones. Sin secreto el
endpoint responde `503`; una firma inválida o con timestamp fuera de la ventana
de cinco minutos se rechaza. No desplegar esta versión hasta configurarlo en
Mercado Pago y en el admin.

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
- `PUBLIC_UPLOAD_ROOT`
- `PRIVATE_UPLOAD_ROOT`
- `UPLOAD_MAX_BYTES`
- `CSV_UPLOAD_MAX_BYTES`
- `BOOKING_ACCESS_COOKIE_NAME`
- `PROFESSIONAL_LINK_TTL_HOURS`
- `PROFESSIONAL_SESSION_TTL_SECONDS`
- `PROFESSIONAL_SESSION_COOKIE_NAME`
- `MP_WEBHOOK_MAX_AGE_SECONDS`
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
- syntax check de los clientes JS.
- pruebas con `node --test`.
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
  --exclude 'private-uploads' \
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
curl -fsSI https://www.reku.io/agenda/
curl -fsSI https://www.reku.io/admin/
curl -sSI https://reku.io/admin/
```

Resultado esperado:

- `www.reku.io` responde `200`.
- `/agenda/` responde `200`.
- `/alta-pacientes/?form=<slug>` responde redirect `308` hacia `/agenda/?form=<slug>`.
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
