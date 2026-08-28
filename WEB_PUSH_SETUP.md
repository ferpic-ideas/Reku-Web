# Web Push para profesionales

Reku puede avisar al profesional en sus teléfonos cuando un paciente está esperando para una videollamada. El mail de aviso sigue funcionando como respaldo.

## Configuración del servidor

1. Generar un único par de claves VAPID y guardarlo en el `.env` local:

   ```bash
   npm run web-push:keys -- --write-env
   ```

   Si ya existen claves, el comando no las reemplaza. La opción `--force` debe usarse solamente si se pretende rotarlas y volver a activar todos los dispositivos.

2. Copiar las tres variables del `.env` local al `.env` privado del VPS. La clave privada no debe guardarse en Git ni exponerse al navegador.

3. Recrear el contenedor web para aplicar la configuración y la migración `015_professional_push_notifications.sql`.

Las mismas claves deben conservarse entre despliegues. Si se reemplazan, los profesionales deberán volver a activar las notificaciones.

## Activación del profesional

- Android: abrir el portal en Chrome y tocar **Activar en este teléfono**.
- iPhone/iPad: abrir el portal en Safari, usar **Compartir → Agregar a inicio**, abrir Reku desde el ícono instalado y tocar **Activar en este teléfono**.
- Desde una computadora, el profesional puede enviarse por mail un enlace que abre directamente el proceso de activación en su teléfono.

El inicio del portal insiste mientras no exista al menos un teléfono activo. Una vez activado, los dispositivos, la prueba y la baja quedan al final de **Mi perfil**.

## Comportamiento operativo

- La push abre el turno autenticado dentro del portal profesional.
- La pantalla muestra paciente, acuerdo, horario, documentación y un contador rojo de demora, además del acceso a Meet.
- Las suscripciones que respondan `404` o `410` se desactivan automáticamente; el portal volverá a solicitar la activación.
- Los endpoints de Push se consideran datos sensibles: no se incluyen en respuestas del panel, logs ni auditorías.
