# Directorio y agenda profesional

Cambios de la versión del 18/09/2026.

## Pacientes

`GET /api/professional/patients?q=...` incluye pacientes con al menos un turno confirmado del profesional autenticado, aunque todavía no exista una ficha canónica activa. En ese caso usa los datos guardados en el turno, sin crear, reactivar ni modificar fichas. Nunca agrupa personas por nombre o teléfono.

- Las fichas activas conservan su `id` numérico.
- Las filas obtenidas de turnos sin ficha activa devuelven `id: null`.
- Todas las filas incluyen `directory_key` (`patient:<id>` o `appointment:<id>`), que identifica la fila para abrir su detalle. No es una credencial ni habilita acceso a otros recursos.
- `next_appointment` contiene el turno confirmado más cercano que aún no terminó, usando la zona horaria de Buenos Aires, o `null`. Sus fechas se devuelven como `YYYY-MM-DD`.
- Los informes, documentos y búsquedas siguen limitados a los turnos del profesional autenticado.
- La tabla ya no muestra la columna Triaje. El estado del cuestionario y su PDF siguen disponibles en la ficha. Los campos existentes de la API se conservan.
- El directorio se actualiza al entrar a Pacientes y al buscar.

## Agenda

El filtro local empieza en **Próximos**: turnos confirmados futuros o en curso, ordenados del más cercano al más lejano. **Todos** incluye también los finalizados, cancelados y pendientes de pago, en orden cronológico descendente. La búsqueda por nombre se combina con el filtro seleccionado, que se conserva durante las actualizaciones automáticas.

Sin migraciones, cambios de configuración ni modificación de la API pública de acuerdos.
