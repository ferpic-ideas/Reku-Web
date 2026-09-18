# Entornos de ReHub y bot

Un único selector de servidor, `CONSULTATION_BOT_MODE`, controla el acceso al bot y el juego de credenciales usado para solicitar nuevas URLs de formulario a ReHub.

| Modo | Bot | ReHub |
| --- | --- | --- |
| `test` | Demostración pública | Variables actuales `REHUB_BASE_URL`, `REHUB_CLIENT_ID` y clave pública `REHUB_PUBLIC_KEY_BASE64` o `REHUB_PUBLIC_KEY_PATH` |
| `production` | Enlace privado de un turno confirmado y uso único | Variables independientes `REHUB_PRODUCTION_BASE_URL`, `REHUB_PRODUCTION_CLIENT_ID` y `REHUB_PRODUCTION_PUBLIC_KEY_BASE64` o `REHUB_PRODUCTION_PUBLIC_KEY_PATH` |

En producción no hay respaldo automático a las credenciales ni al endpoint de test. Si faltan datos, no se envía ninguna solicitud a ReHub. Un modo inválido se rechaza. Si el selector está ausente, `APP_ENV=production` elige producción; en desarrollo el predeterminado es test. Mantener `test` explícito durante las pruebas.

Endpoint de producción confirmado por Fernando el 2026-09-14: `https://f8dheiojk4.execute-api.eu-west-1.amazonaws.com/pro/patient/triage/assign`. Configurar `REHUB_PRODUCTION_BASE_URL=https://f8dheiojk4.execute-api.eu-west-1.amazonaws.com/pro`: el cliente agrega `/patient/triage/assign` una sola vez. No se deduce reemplazando `/dev2`. La clave pública es RSA para cifrar el sobre OAEP SHA-256 y el identificador se envía sólo en el header `client-id`; no se sigue una redirección HTTP que pudiera reenviar la credencial. Las claves se mantienen en el `.env` privado, nunca en código, navegador, Git o logs. `.env.rehub.example` contiene endpoints públicos y campos de credenciales vacíos.

Docker Compose ya carga `.env` mediante `env_file`; las nuevas variables de producción no necesitan agregarse al mapa `environment`. Cambiar el selector requiere recrear el servicio `web`. Antes de habilitar producción deben estar verificados el endpoint y sus credenciales, la integración del bot con el alta/turno y la clave de cifrado de informes.

El cambio afecta solicitudes nuevas. Las URLs ya asignadas y guardadas en turnos no se regeneran ni migran automáticamente; revisar turnos de prueba antes de la salida a producción.

## Comprobaciones

2026-09-14: endpoint guardado en el `.env` local; `CONSULTATION_BOT_MODE=test` se mantuvo sin cambios y no se modificó el despliegue. Prueba real con las credenciales de producción y el identificador ficticio `REKU-CREDENTIAL-CHECK-20260914`, usando `center=cokiba`: HTTP 404, JSON `Error unknown center cokiba`. Fernando confirmó después los centros de producción `ypf` y `artro`. Se hizo una solicitud por centro con identificadores ficticios distintos (`REKU-PROBE-20260914-ypf` y `REKU-PROBE-20260914-artro`); ambas devolvieron HTTP 404, JSON `Error creating triage`. No se obtuvo URL de formulario ni se completó ningún cuestionario. El cambio de mensaje sugiere que superan la validación del centro, pero no confirma que el flujo funcione ni permite determinar la causa de creación fallida. ReHub debe revisar sus logs; no repetir asignaciones indiscriminadamente ni activar producción hasta resolverlo. El cliente actual etiqueta genéricamente los 404 como `REHUB_CLIENT_NOT_FOUND`, pero las respuestas del proveedor no indicaron un error de client-id.

- `node --test test/rehub*.test.mjs test/consultation-bot-access.test.mjs`: aislamiento de juegos, selector compartido, ausencia de fallback, claves RSA distintas y caché al alternar modos, payload con `center`, redirects bloqueados.
- Prueba de credenciales reales: sólo contra un endpoint confirmado, con un identificador y nombre ficticios. `/patient/triage/assign` puede crear una asignación en ReHub; no usar pacientes reales para comprobar autenticación ni completar el cuestionario. No registrar la credencial ni la URL privada devuelta.
- La validación local del formato RSA o una prueba con proveedor simulado no demuestran que el servicio acepte las credenciales.
