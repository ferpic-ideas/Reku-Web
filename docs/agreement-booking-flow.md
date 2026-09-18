# Reserva por acuerdo y orden médica

Estado: implementado y probado localmente; pendiente de publicación.

## Configuración

En Admin → Acuerdos, cada acuerdo tiene:

El slug y el prefijo se editan como un único campo **Slug (subdominio)**. El servidor guarda el slug normalizado también en `subdomain_prefix`, aplicando las restricciones DNS (hasta 63 caracteres y sin nombres reservados). El campo interno `subdomain_prefix` se conserva por compatibilidad con las rutas y respuestas existentes; no se acepta como una configuración independiente en altas/ediciones del admin. No se reescriben automáticamente los acuerdos existentes. Cambiar el slug cambia la dirección pública; el formulario advierte si un registro antiguo tenía un prefijo distinto.

- `direct_treatment`: por defecto `false` (mantiene el recorrido con selección de práctica y profesional). Si se activa, el administrador selecciona explícitamente el servicio de tratamiento en `treatment_service_id`; debe estar activo.
- `medical_order_required`: por defecto `false`. La orden se solicita siempre al final de Tus datos, con el texto obligatorio u opcional correspondiente.
- `identifier_label`: nombre del identificador para acuerdos de Nómina (por ejemplo, DNI, número de cliente o legajo). Se configura como texto libre de hasta 80 caracteres; los acuerdos existentes sin valor siguen mostrando «Identificador». Se expone en las respuestas internas de acuerdos/agenda y se usa también en el alta de pacientes. No cambia la columna `identificador` ni el formato del CSV de nómina. Requiere la migración `025_agreement_identifier_label.sql`.

El modo directo saltea práctica y profesional, usa la disponibilidad combinada de los profesionales habilitados para ese servicio y acuerdo, y abre el primer día disponible. Busca inicialmente en el mes actual y los dos siguientes; el paciente puede navegar otros meses y elegir el horario. El profesional se asigna al confirmar, con la misma protección transaccional contra superposición que el flujo existente.

Esta configuración se aplica a la agenda pública y a la API de partners v1.2. No cambia el trabajo manual del admin. El modo normal no certifica por sí mismo que haya ocurrido una consulta previa. La API informa estos requisitos en `GET /agreement`; ver `integraciones/api/index.html` y `openapi.json`.

## API de partners (Pago y Nómina)

- Ambos tipos permiten emitir/revocar credenciales desde Admin → Acuerdos → API. No se habilita un endpoint público de consulta masiva de la nómina.
- En Nómina, `patient.identifier` es obligatorio al confirmar y debe existir en la nómina del acuerdo autenticado (comparación sin distinguir mayúsculas). Se conserva en `appointments.patient_identifier` mediante la migración `026_partner_patient_identifier.sql` y aparece también en el admin.
- Nómina crea turnos confirmados con monto cero, estado/proveedor `nomina`, sin pago externo ni liquidación facturable. Las liquidaciones siguen siendo exclusivas de Pago; se excluyen reservas con snapshot Nómina incluso si el acuerdo luego cambia de tipo.
- En tratamiento directo, `/services` sólo ofrece la práctica configurada. Disponibilidad y holds permiten omitir `service_id` y asignan profesional automáticamente, ignorando `professional_id`. En PATCH se conserva el profesional previo salvo cambio explícito por la integración; siempre debe estar habilitado para esa práctica/acuerdo.
- `POST /appointments` conserva JSON y agrega multipart: campo `payload` con el mismo JSON y archivo `medical_order`. Si la orden es obligatoria se rechaza la confirmación sin archivo válido. Se guarda en almacenamiento privado, visible para admin/fisio y sin URL clínica en la respuesta del partner. Un fallo de transacción limpia el archivo.
- La idempotencia incluye la huella del archivo; reintentar no duplica orden ni reserva. Para conocer el estado actual después de un replay, hacer GET del turno.
- Las respuestas incluyen `consultation_status` (`pending`, `started`, `completed`) y `medical_order.required/received`. No exponen el PDF clínico ni la URL interna de ReHub; los mails mantienen los enlaces al bot y sala del acuerdo.
- PATCH no permite reemplazar email/identificador del paciente: cancelar y crear otro turno evita transferir enlaces privados, documentación o informes. Se mantiene el tipo económico original del turno aunque el acuerdo cambie después.
- Aplicar migraciones 024, 025 y 026 junto con el código. Implementación local, no publicada todavía.

## Orden médica

- Un archivo PDF, JPG, PNG o WebP de hasta 10 MB, validado por tipo y firma en el servidor.
- Se almacena fuera del directorio público en `PRIVATE_UPLOAD_ROOT/intakes/…`, con una referencia privada en `patient_intake_medical_orders`.
- Se conserva durante la confirmación del mail. Al reservar, se asocia transaccionalmente a `appointment_documents` como `purpose = medical_order`.
- El admin y el profesional asignado la ven como **Orden médica · nombre del archivo** en la documentación del turno, usando las rutas privadas existentes. La sala profesional por enlace privado también permite abrirla. Otro profesional no tiene acceso.
- La obligatoriedad se vuelve a verificar al reservar, incluso si se intenta usar un enlace de agenda creado sin alta/orden. No se acepta una URL externa ni un identificador de documento aportado por el cliente como sustituto del archivo.
- `appointments.medical_order_required` conserva la condición de la reserva. No se permite borrar desde la sala del paciente la orden obligatoria de ese turno. Los estudios comunes siguen siendo eliminables como antes.
- Una orden de alta puede respaldar varios turnos; al eliminar una referencia opcional no se borra el archivo si otro turno o el alta todavía lo utiliza.
- La carga no equivale a una validación clínica automática: el profesional abre el documento y evalúa su contenido.

## Publicación pendiente

Aplicar la migración `024_agreement_booking_and_medical_orders.sql` junto con el código. No habilitar el acceso directo sin elegir el tratamiento correcto y tener profesionales asociados al acuerdo y al servicio. Los acuerdos existentes conservan el flujo anterior y la orden opcional.

Verificación: pruebas unitarias del formulario/recorrido y validaciones; integración HTTP/PostgreSQL de configuración, carga, confirmación del mail, reserva, permisos de lectura y protección de la orden obligatoria. Todas usan datos sintéticos y correo en modo dry run.
