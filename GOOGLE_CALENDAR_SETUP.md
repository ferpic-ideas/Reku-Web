# Activación de Google Calendar y Meet

La integración está implementada del lado de Reku, pero permanece deshabilitada
hasta cargar credenciales OAuth. Cada profesional conecta su propia cuenta Google
personal; Reku usa el calendario `primary`, consulta sólo ocupado/libre y crea un
evento con un Meet nuevo por turno.

## 1. Proyecto de Google Cloud

Crear dos proyectos separados, uno de prueba y otro de producción, bajo una
cuenta institucional de Reku. En cada proyecto:

1. Habilitar **Google Calendar API**.
2. Configurar la pantalla de consentimiento como **External**.
3. Completar nombre de aplicación, email de soporte y datos de contacto.
4. Agregar `reku.io` como dominio autorizado.
5. Declarar estos scopes:
   - `openid`
   - `email`
   - `https://www.googleapis.com/auth/calendar.events.owned`
   - `https://www.googleapis.com/auth/calendar.freebusy`
6. Mientras la app esté en modo Testing, agregar como test users las cuentas
   personales de los profesionales del piloto.

La publicación para usuarios que no sean testers puede requerir la verificación
de Google. Antes de solicitarla, confirmar que estén desplegadas las URLs públicas
definitivas que explican el uso y la eliminación de datos de Google:

- `https://www.reku.io/privacidad/`
- `https://www.reku.io/terminos/`
- soporte: `hola@reku.io`

## 2. Cliente OAuth web

Crear credenciales **OAuth client ID > Web application**.

Producción:

```text
Authorized redirect URI:
https://www.reku.io/api/professional/integrations/google/callback
```

Desarrollo local, sólo en el proyecto de prueba:

```text
http://localhost:3000/api/professional/integrations/google/callback
```

El flujo es server-side, usa `state` de un solo uso, PKCE S256 y solicita refresh
token con acceso offline. El client secret nunca se envía al browser.

## 3. Variables de entorno

Cargar directamente en el `.env` del entorno correspondiente; no pegar los
valores en chats, tickets o commits.

```env
GOOGLE_OAUTH_CLIENT_ID=<client-id>
GOOGLE_OAUTH_CLIENT_SECRET=<client-secret>
GOOGLE_OAUTH_REDIRECT_URI=https://www.reku.io/api/professional/integrations/google/callback
GOOGLE_INTEGRATION_ENCRYPTION_KEY=<secreto-aleatorio-exclusivo-de-32-o-mas-caracteres>
GOOGLE_CALENDAR_TIME_ZONE=America/Argentina/Buenos_Aires
GOOGLE_CALENDAR_REQUIRED=false
```

Generar la clave de cifrado dentro del servidor o del gestor de secretos. Debe
ser independiente de `SESSION_SECRET`. Los access/refresh tokens se guardan
cifrados con AES-256-GCM.

Mantener `GOOGLE_CALENDAR_REQUIRED=false` durante el piloto. Al cambiarlo a
`true`, sólo aparecen como reservables los profesionales que hayan conectado una
cuenta Google. Si esa conexión queda temporalmente en estado de error, el
profesional sigue siendo reservable usando exclusivamente la disponibilidad
interna de Reku: horarios, bloqueos y turnos vigentes. Las conexiones revocadas o
nunca realizadas continúan excluidas.

La consulta `freeBusy` y la creación del bloqueo previo a un pago son de mejor
esfuerzo. Si Google no responde, la reserva y el pago continúan con la agenda
interna, se registra el evento de auditoría correspondiente y la sincronización
queda marcada como fallida para su posterior reintento. Cuando Google responde,
sus eventos ocupados siguen quitándose normalmente de la oferta de turnos.
Los mails de confirmación al paciente y al profesional tampoco se bloquean por
una falla de Google; el acceso privado del paciente muestra el Meet cuando la
sincronización logra completarse.

## 4. Prueba de aceptación

Para cada profesional piloto:

1. Crear la ficha y el usuario con rol `Profesional` desde el admin.
2. Ingresar a `/profesional/` y conectar la cuenta Google personal.
3. Crear un evento personal que ocupe una franja y comprobar que Reku no la ofrece.
4. Reservar un turno sin pago y verificar:
   - un único evento en el calendario primario;
   - un Meet nuevo;
   - invitación Google al paciente;
   - email branded de Reku con el mismo Meet.
5. Probar un turno pago en sandbox y repetir la verificación al aprobarse el pago.
6. Cancelar desde el portal y comprobar actualización Google, email Reku y
   reembolso total cuando corresponda.
7. Repetir webhook, retorno y cancelación para confirmar que no se duplican
   evento, Meet, email ni devolución.

## 5. Rollout

Empezar con una o dos cuentas Gmail personales. Revisar `audit_events`,
`google_sync_status`, `google_sync_error`, `refund_status` y `refund_error` antes
de sumar profesionales. Activar `GOOGLE_CALENDAR_REQUIRED=true` sólo cuando todas
las cuentas que deban recibir reservas estén conectadas.
