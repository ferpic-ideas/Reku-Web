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
- iPhone/iPad: abrir el portal en Safari o Chrome, usar **Compartir → Agregar a inicio**, dejar **Abrir como app web** activado si aparece, abrir Reku desde el ícono instalado y tocar **Activar en este teléfono**.
- Desde una computadora, el profesional puede enviarse por mail un enlace que abre directamente el proceso de activación en su teléfono.

Los nuevos mails llevan un enlace personal a `/profesional/activar-notificaciones.html#activar=…`.
La activación no requiere iniciar sesión: si el navegador ya tiene permiso, se registra
automáticamente; si falta, muestra **Permitir notificaciones**. El permiso se pide desde
ese botón, como requiere el navegador. Los enlaces genéricos enviados anteriormente
no contienen una credencial: hay que solicitar un mail nuevo después del despliegue.

En iPhone se debe agregar a inicio **desde ese mismo enlace**. El manifiesto de
activación omite `start_url` para que la instalación conserve la URL del documento
(incluido su fragmento); así el ícono nuevo no depende de compartir la sesión de Safari.
La credencial se quita de la URL tras abrir la app instalada o completar la activación.
El permiso y la instalación siguen sujetos a las restricciones de iOS; deben comprobarse
en un iPhone real al desplegar.

Chrome en iPhone permite instalar desde Compartir. Si no aparece esa opción, la
pantalla ofrece **Copiar enlace para Safari**, conservando la credencial personal;
si falla el portapapeles, muestra el enlace para copiarlo manualmente. No intenta
forzar Safari mediante esquemas de URL no documentados.

Si el usuario cierra el aviso sin aceptar, puede volver a intentarlo desde el botón.
Si el permiso quedó bloqueado, debe habilitarlo en la configuración del navegador
(Android: información del sitio → Permisos → Notificaciones) o en Ajustes →
Notificaciones → Reku en iPhone, y tocar **Volver a comprobar**. El enlace no se
consume por pedir o rechazar el permiso: solamente al guardar la suscripción, dentro
de sus 72 horas de vigencia. El portal pide el permiso directamente desde el toque,
antes de esperar al service worker, para conservar la interacción del usuario.

La migración `029_professional_push_activation.sql` almacena únicamente el hash del
enlace, con vencimiento de 72 horas y un solo dispositivo por enlace. La suscripción y
el consumo se guardan en una transacción; reintentar con la misma suscripción es
idempotente. El enlace no inicia una sesión del portal ni permite leer turnos, pacientes,
documentos o administrar otros dispositivos. Se invalida al revocar accesos o cambiar
la versión de sesión, y exige que la cuenta y el profesional sigan activos.

El inicio del portal insiste mientras no exista al menos un teléfono activo. Una vez activado, los dispositivos, la prueba y la baja quedan al final de **Mi perfil**.

## Comportamiento operativo

- La push abre el turno autenticado dentro del portal profesional.
- La pantalla muestra paciente, acuerdo, horario, documentación y un contador rojo de demora, además del acceso a Meet.
- Las suscripciones que respondan `404` o `410` se desactivan automáticamente; el portal volverá a solicitar la activación.
- Los endpoints de Push se consideran datos sensibles: no se incluyen en respuestas del panel, logs ni auditorías.
