# Estudios enviados por el paciente

Estado al 2026-09-18: publicado en producción con autorización del usuario (código `ef084ea`). Verificado junto con la suite completa: 412 pruebas unitarias y 26 de integración aprobadas.

La gestión del turno y la sala de espera abiertas desde el mail muestran «Estudios enviados» por fuera del formulario colapsado. Los archivos muestran su nombre y los enlaces su URL; ambos tienen acción para abrir y un tachito con confirmación antes de eliminar. «Enviar más estudios» conserva lo ya enviado. Después de una subida exitosa se actualiza la lista y se colapsa el formulario; los errores conservan el borrador. No se modifican los PDFs del bot.

## API y seguridad

- La respuesta de gestión del turno incluye `documents`, sin rutas de almacenamiento.
- Los archivos se sirven por `GET/HEAD /api/booking/manage/documents/:id`, usando exclusivamente el turno de la sesión privada del paciente, con `private, no-store` y visualización inline. Los links apuntan a la URL HTTPS previamente validada.
- `DELETE` en esa misma ruta exige sesión privada, origen autorizado, pertenencia al turno, `uploaded_by=patient` y turno confirmado. No permite borrar documentos cargados por profesionales o administradores.
- La eliminación de la fila y su auditoría se hacen en una transacción. En archivos se elimina luego el archivo privado; los links sólo se quitan del turno, sin intentar borrar el recurso externo. La auditoría guarda identificadores, no contenido clínico ni URL.
- Las descargas toleran que el archivo sea eliminado al mismo tiempo: una falla de lectura no derriba el proceso.

Sin migraciones ni cambios de configuración. Pruebas con archivos sintéticos y base PostgreSQL local aislada: listado, subida, lectura GET/HEAD, borrado, aislamiento entre turnos, sesión obligatoria, control de origen y documentos de otros roles. Pruebas de interfaz cubren ambas pantallas, agregar más, confirmación de eliminación y errores.
