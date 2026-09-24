# Demo de integración Artro → Reku

URL: `https://www.reku.io/test` (`reku.io/test` redirige al dominio canónico).

Landing ficticia inspirada visualmente en Artro Digital. No modifica el sitio ni
la agenda de Artro. **Usa la API real y crea turnos en Reku**, dentro del acuerdo
`artro`. No es un sandbox con una agenda separada.

## Qué se simula y qué es real

- La cuenta registrada y el email validado son supuestos de la demo. Los campos
  editables representan los datos que el backend del integrador obtendría de su
  sesión autenticada. No hay alta ni OTP de Reku.
- El pago externo se simula: no se llama a una pasarela ni se cobra. La referencia
  lleva `DEMO-NO-COBRAR:`. La API guarda su estado habitual de pago externo y
  liquidación; **excluir estos turnos de cualquier liquidación real** o cancelarlos
  después de probar.
- Disponibilidad, pre-reserva, confirmación, reprogramación y cancelación son reales.
- Se mantiene el funcionamiento habitual de Reku: ReHub en segundo plano,
  sincronización de calendario y notificaciones conforme a la configuración del
  acuerdo. Si comunica Reku, usar un email propio para recibir los correos.
- No se ofrece el bot en este flujo API. La sala de espera y la gestión de la
  reserva son las páginas alojadas en Reku, con el co-branding del acuerdo.
- Las imágenes públicas de referencia se cargan desde Artro con `no-referrer`.

## Recorrido y endpoints

| Paso | API de Reku | Uso |
| --- | --- | --- |
| Configuración | `GET /agreement` | Reglas, inicio directo, orden requerida, comunicaciones |
| Prácticas | `GET /services` | Prácticas habilitadas para Artro |
| Profesionales | `GET /professionals?service_id=…` | Opcional; omitido para inicio directo |
| Agenda | `GET /availability?service_id=…&from=…&to=…` | Ventanas de 7 días y profesional opcional |
| Pre-reserva | `POST /holds` | Bloqueo temporal, vigencia indicada por `expires_at` |
| Confirmación | `POST /appointments` | Datos de usuario, hold, referencia externa y orden opcional |
| Consulta | `GET /appointments/{id}` | Estado actualizado de cada turno propio |
| Reprogramación | `PATCH /appointments/{id}` | Nueva fecha/hora; no se crea un hold previo |
| Cancelación | `POST /appointments/{id}/cancel` | Cancelación del turno propio |

Base real: `/api/partners/v1`. Escrituras con `Idempotency-Key`. La orden se envía
como multipart: campo JSON `payload` y archivo `medical_order`. El integrador debe
guardar `manage_url`, `waiting_room_url` y `expires_at` de la respuesta de creación;
GET/PATCH no vuelven a emitir esos enlaces. El panel técnico muestra método,
endpoint y estado, sin secretos ni cuerpos con datos de pacientes.

## Confirmaciones y recordatorios del integrador

Configurar **Acceso: API** y **Comunicación: Integrador**
(`access_mode=api`, `communication_sender=integrator`) en el acuerdo. En ese modo,
el integrador envía confirmaciones, recordatorios, reprogramaciones y cancelaciones
al paciente; Reku no duplica esos correos. Se mantienen los avisos al profesional
y los correos de seguridad del portal.

1. Guardar la respuesta de `POST /appointments` en el backend: `data.id`,
   `data.external_id`, `data.patient`, `data.service`, `data.professional` y
   `data.schedule` (`date`, `start_time`, `end_time`, `timezone`). Con esos datos se
   arma el mail y se programa el recordatorio en la zona horaria del turno.
2. Guardar `data.links.manage_url`, `data.links.waiting_room_url` y
   `data.links.expires_at`, asociados al turno y al usuario validado. Usarlos para
   “Gestionar mi turno” e “Ingresar a la videollamada”. Protegerlos como accesos
   privados: nunca registrarlos en logs ni analytics. GET, PATCH y el listado no
   los devuelven; el replay de creación conserva los enlaces y el vencimiento
   originales, no los renueva.
3. Antes de enviar un recordatorio, consultar `GET /appointments/{id}` y enviarlo
   sólo si `status=confirmed` y el turno sigue siendo futuro. Si se reprogramó,
   actualizar el horario y la programación; si se canceló, cancelar el recordatorio.
   Registrar los envíos para evitar duplicados.
4. **Todavía no hay webhooks.** Consultar periódicamente el detalle de los turnos
   guardados o `GET /appointments` con paginación para detectar cambios desde Reku.
   Comparar `status`, `schedule`, `professional` y `updated_at`. Un replay de
   creación no refleja el estado actual.

**Limitación actual: renovación de enlaces pendiente.** Reprogramar con PATCH no
renueva ni devuelve los enlaces originales. Si la nueva fecha queda después de
`data.links.expires_at`, los enlaces pueden vencer antes de la consulta. Hoy no hay
un endpoint de renovación: no enviar enlaces vencidos ni prometer acceso para esa
nueva fecha sin resolverlo con Reku. Repetir el POST original con la misma
`Idempotency-Key` tampoco renueva el vencimiento.

Esta demo **no implementa un servicio de mails ni un programador de recordatorios
del integrador**. Si el acuerdo tiene Comunicación: Reku, los mails recibidos son
los habituales de Reku. El integrador debe implementar sus propios envíos y guardar
datos y enlaces de forma persistente, no sólo durante la sesión de prueba. No
enviar recordatorios del bot: las nuevas reservas por API no tienen cuestionario.

La misma información se publica en `/api/docs/#comunicaciones-integrador` y en
`/test`, dentro de “Para el equipo técnico”.

## Código del ejemplo

- `artro-demo/index.html`, `styles.css`, `app.js`: interfaz sin frameworks.
- `src/artro-api-demo.mjs`: backend intermedio (BFF), no proxy abierto.
- `migrations/028_artro_api_demo.sql`: sesiones y objetos propios de cada sesión.
- `integration/artro-demo-flow.mjs`: ciclo real HTTP y aislamiento de sesiones.

El navegador sólo llama a `/test/api`. El BFF añade el Bearer desde el servidor y
consume **las rutas HTTP reales de la API**, no inserta reservas directamente en la
base. La dirección upstream es fija y no sigue redirecciones. Nunca copiar la API
key a JavaScript, WordPress público, HTML, localStorage o parámetros de URL.

### Seguridad de la demo

Acceso libre, sin clave de entrada. La página inicia o recupera automáticamente
una sesión anónima con `POST /test/api/session`, validando Origin y el encabezado
propio de la demo. Recargar conserva la misma sesión y sus turnos. Usa una cookie
HttpOnly/Secure/SameSite=Strict con vigencia de 8 horas y CSRF en las escrituras.
La creación de sesiones tiene límites por IP y globales; las escrituras tienen
límites por sesión, por IP y globales para que abrir otra sesión no reinicie el
presupuesto de operaciones. El token de la API y las respuestas guardadas (incluidos enlaces
privados) están cifrados con `SETTINGS_ENCRYPTION_KEY`. Cada sesión puede consultar
y modificar únicamente sus propios holds/turnos; no se publica el listado global
de pacientes de Artro. Reiniciar la demo borra su asociación de sesión, **no cancela
los turnos**. Las sesiones vencidas se depuran al iniciar nuevas sesiones.

La sesión anónima no representa autenticación real de un paciente ni debe
reutilizarse como mecanismo de identificación en producción. Cualquier visitante
puede crear turnos de prueba; esta apertura es intencional durante la beta.

## Habilitación y apagado

La demo falla cerrada hasta tener configuración. Dentro del contenedor Reku:

```sh
node scripts/configure-artro-demo.mjs --enable
```

El script sólo acepta el acuerdo `artro`, crea una credencial dedicada, cifra el
token en `app_settings.artro_api_demo`. No genera contraseñas de acceso ni
imprime secretos y no
cambia la configuración del acuerdo. Se niega a rotar una demo ya habilitada.

Para apagarla, revocar en el admin la credencial **Demo reku.io/test** (en la
instalación original figura como **Demo protegida reku.io/test**);
el BFF comprueba su vigencia en cada solicitud. También puede ponerse `enabled`
en `false` en esa configuración. No rotar `SETTINGS_ENCRYPTION_KEY` para apagarla.

## Qué debe reemplazar Artro para producción

1. Sesión anónima y datos editables → sesión autenticada de su usuario y email
   validado por ellos. Comprobar autorización en su backend en cada operación.
2. Referencia simulada → validación server-to-server del pago o cobertura real.
3. Asociación por sesión demo → asociación persistente del turno al usuario.
4. Credencial de demo → credencial propia del integrador, sólo en su servidor.
5. Definir quién envía las comunicaciones en el acuerdo. No duplicar correos.
6. Conservar idempotencia, control de expiración, autorización por paciente,
   cifrado de enlaces privados y soporte para `409`, `422`, `429` y reintentos.

Contrato completo: `/api/docs/` y su OpenAPI. No se agregaron endpoints públicos
al contrato de partners: `/test/api` es exclusivamente el adaptador de esta demo.
