# Hardening de seguridad — 24/07/2026

## Estado

Implementado y validado localmente. No se hizo commit, push, rsync, deploy,
rotación de credenciales ni cambio en Mercado Pago/VPS.

## Cambios implementados

- Static serving con allowlist de archivos, directorios y extensiones.
- `/src`, archivos de deploy, dotfiles y nombres secretos fuera de alcance HTTP.
- Build context sin `.env*`, `*.txt`, Compose, documentación, tests ni uploads.
- SVG eliminado de uploads; todos los logos se decodifican y convierten a WebP.
- PDF validado por MIME, extensión y magic bytes.
- POST público genérico limitado a `/`.
- Webhook de Mercado Pago fail-closed sin secreto, HMAC timing-safe y timestamp
  con ventana máxima de cinco minutos.
- Rate limiting persistente en Postgres por IP, email, acuerdo/ID y topes globales.
- Alta de paciente insert-only, respuesta uniforme `202`, sin IDs ni tokens.
- Verificación de email de un solo uso antes de crear el acceso de agenda.
- Token de agenda canjeado por cookie `HttpOnly`; no queda en query,
  `sessionStorage` ni retorno de Mercado Pago.
- Autorización admin con matriz default-deny por método y ruta.
- Rol `user` de sólo lectura no sensible y permisos adicionales explícitos en DB.
- Borrado sensible ligado a `records.delete`, sin comparación de email.
- Bootstrap sin valores default y sólo si no existe ningún admin activo.
- Links profesionales de 24h, un solo uso, sesiones `HttpOnly` de 12h y revocación
  total desde el admin.
- Storage público y volumen privado separados; no existe handler para el privado.
- PDFs públicos informativos sin cache; imágenes públicas con nombres UUID
  conservan cache inmutable.
- HSTS en Node y Traefik.
- Hostname técnico y apex redirigidos al hostname canónico.
- Migraciones SQL versionadas con lock asesor y transacciones.
- Pruebas automatizadas para autorización, static serving, cookies, firma de
  webhook, SVG y PDF.

## Validaciones locales

- `npm run build`: OK.
- `npm run check`: OK.
- `node --test`: 13/13 OK.
- `scripts/secrets_check.sh`: OK.
- `git diff --check`: OK.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilidades.
- `docker compose config --quiet` con secretos dummy: OK.
- Smoke HTTP local:
  - `/`: 200.
  - `/healthz`: 200.
  - `/src/admin-api.mjs`: 404.
  - `/docker-compose.yml`: 404.
  - `/reku-admin-password.txt`: 404.
  - `/uploads/agreements/payload.svg`: 404.
  - `POST /unexpected`: 405.
- Header HSTS en configuración de producción: `max-age=31536000`.

No se pudo construir la imagen ni ejecutar las migraciones contra un Postgres
local porque Docker Desktop no estaba iniciado y no hay binarios PostgreSQL
locales. La sintaxis de Compose, JavaScript y los controles unitarios sí quedó
validada.

## Gate obligatorio antes de desplegar

Producción tiene el access token de Mercado Pago activo, pero al momento del
relevamiento el `webhook_secret` de producción no estaba cargado. Esta versión
rechaza el webhook con `503` en ese estado.

Antes de desplegar:

1. Crear/configurar Webhooks de pagos en Mercado Pago y obtener el secreto.
2. Cargar ese secreto en el bloque de producción del admin sin imprimirlo.
3. Confirmar sólo el booleano `webhook_secret_set`.
4. Tomar y verificar backup de Postgres.
5. Ejecutar build de imagen y migraciones en un entorno de prueba o durante un
   rollout controlado.
6. Mantener vacías las variables bootstrap si ya existe un admin activo.
7. Recién entonces desplegar y ejecutar las pruebas post-deploy.

## Verificación post-deploy

- Los cuatro paths sensibles deben seguir devolviendo 404.
- El hostname técnico y el apex deben redirigir a `https://www.reku.io`.
- `Strict-Transport-Security` debe estar presente.
- Un webhook sin firma debe devolver 401; sin configuración, 503.
- Un alta válida debe devolver siempre 202 y enviar verificación, sin token.
- El link de verificación debe funcionar una sola vez.
- Un link profesional debe desaparecer de la URL y crear cookie `HttpOnly`.
- Revocar accesos desde el admin debe invalidar link y sesión.
- Un usuario `role=user` no debe poder leer pacientes/contactos/nóminas ni mutar.

## Evidencia histórica de secretos

No se encontró evidencia en URLs actuales, la imagen desplegada actual ni el
historial Git alcanzable. La imagen anterior ya no estaba disponible y el cache
de build no permite demostrar qué archivos contenía; por eso no es correcto
afirmar certeza histórica total. La rotación preventiva sigue siendo una decisión
operativa posible, independiente de este parche.
