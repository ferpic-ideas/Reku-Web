# Estrategia de pruebas de Reku

`npm run check` ejecuta los chequeos rápidos de sintaxis, seguridad, secretos y las pruebas unitarias/contractuales.

`npm run test:api` ejecuta el flujo HTTP completo de la API de acuerdos contra una base PostgreSQL descartable. Requiere `TEST_DATABASE_URL` y se niega a limpiar una base cuyo nombre no contenga `test`.

La prueba de integración cubre:

- autenticación y revocación de credenciales;
- descubrimiento de acuerdo, prácticas, profesionales y disponibilidad;
- alta, consulta, listado, reprogramación y cancelación de turnos;
- idempotencia y conflictos por reutilización de claves;
- competencia simultánea por el mismo horario;
- aislamiento estricto entre acuerdos;
- validación de JSON, tipo de contenido, tamaño y campos;
- límites persistentes de solicitudes;
- invariantes finales en base, notificaciones y liquidación.

GitHub Actions levanta PostgreSQL 16 y ejecuta `npm run check:ci` en cada push a `main` y en cada pull request. Ninguna prueba usa pacientes, pagos ni credenciales reales.
