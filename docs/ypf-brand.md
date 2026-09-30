# YPF Obra Social

Identidad optativa del acuerdo: `brand_theme = 'ypf-os'`, con `cobranded = true`.
No se infiere por nombre, slug ni hostname. Los demás acuerdos conservan su presentación.

## Recursos y criterios

- Identificador completo y compacto extraídos del arte del manual **YPF Obra Social, 13.11.23**, página 5; proporciones originales. La imagen completa se muestra a 200-250 px en web (mínimo del manual: 144 px). Mantener aire alrededor del identificador, sin mezclarlo con Reku.
- Azul `#0451E4`, azul oscuro `#001464`, aguamarina `#4AE5C2`, blanco. Colores derivados suaves sólo para superficies e indicadores funcionales; los errores conservan su significado.
- Tipografía DIN en pesos Light, Regular y Medium del recurso público oficial `https://ypf.com/yl-cdn/css/global-fonts.css`, enlazado por `https://ypfos.com/home.html`, recuperado el 30/09/2026. El manual denomina la familia DIN Pro; los archivos del sitio oficial se identifican internamente como DIN. No se incorporan variantes aproximadas de terceros. WOFF2 para web; conversión sin cambio de glifos a TTF para PDFKit. En email se utiliza Arial como alternativa compatible cuando el cliente no tiene DIN.
- Reku se presenta por separado con “Servicio brindado por Reku”.
- Logos y fuentes se destinan a este acuerdo. No se publica el manual de marca.
- La guía conserva las modalidades y condiciones del PDF que ya tenía el acuerdo. Las capturas de la plataforma original permanecen sin recolorear; son contenido explicativo, no marcas del acuerdo. Fuente: PDF anterior `5cde64dc-db7e-4a45-bfb7-d58a5f25892a.pdf`.

## Alcance

Reserva, enlaces de verificación y acceso, gestión de turnos, sala de espera, entrevista previa, correos del paciente e informe PDF. Las consultas toman la identidad actual del acuerdo, incluso para turnos anteriores. Las comunicaciones internas conservan la identidad de Reku.

En admin: Acuerdos → editar → Cobranded + Identidad visual → YPF Obra Social. Los clientes anteriores que omiten `brand_theme` conservan el valor actual al guardar.

## Configuración del acuerdo existente

Luego del respaldo de base, fuentes e imagen Docker y la migración 030:

```sh
node scripts/configure-ypf-brand.mjs --agreement-id=3
node scripts/configure-ypf-brand.mjs --agreement-id=3 --apply
```

El script comprueba ID, slug y subdominio, copia logo y guía a nuevos archivos públicos, actualiza sólo marca/nombre/archivos y registra valores anteriores y nuevos en auditoría. Los archivos anteriores se conservan. No cambia accesos, nómina, costos, profesionales, servicios ni URLs.

La guía se reproduce con `node scripts/build-ypf-guide.mjs` y se revisa con Poppler antes de volver a publicarla. Recursos originales de las capturas y TTF: `assets/ypf-guide/` (sin ruta HTTP pública).
