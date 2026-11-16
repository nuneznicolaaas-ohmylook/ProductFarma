# ProductFarma

Tienda B2B de **merchandising personalizado y stands para el sector salud** (farmacias, laboratorios, ferias y
congresos), conectada a la **API B2B de Makito**.

- Portada con dos entradas: **Farmacias** y **Ferias y congresos**, cada una con su página y sus packs.
- **Packs** (kit congresista, kit fidelización farmacia, kit de stand) que se arman solos con productos del catálogo.
- **Stands y gran formato**: formulario de presupuesto de evento (feria, fecha, m², asistentes) que llega como presupuesto.

No se publica todo Makito: solo productos de **farmacia** (pastilleros, botiquines, gel, neceseres, bálsamos,
bienestar, verano…) y **básicos de merchandising** (totebags y bolsas, camisetas, agendas, libretas, bolígrafos) y **congresos** (lanyards, porta-acreditaciones, portadocumentos).
El filtro está en `lib/sync.mjs` y se amplía con
`PHARMA_INCLUDE`, `PHARMA_EXCLUDE` y `PHARMA_REFS` sin tocar código.

- Catálogo, variantes, stock, precios por tramos y técnicas de marcaje sincronizados desde Makito.
- El cliente elige color, técnica, nº de colores y cantidad, sube su logo y ve el precio al momento.
- **Compra directa** con Stripe (hasta `QUOTE_THRESHOLD_EUR`) o **solicitud de presupuesto** con logos adjuntos.
- Los pedidos pagados o presupuestos aceptados se envían a Makito con un clic (`/api/makito-order`), nunca solos.

## Arquitectura (todo en planes gratuitos)

| Parte | Dónde | Archivo |
|---|---|---|
| Web (frontal) | Cloudflare Pages | `public/index.html` |
| API (`/api/*`) | Cloudflare Pages Functions | `functions/api/*` |
| Sincronización Makito | GitHub Actions (cada hora + cada noche) | `.github/workflows/makito-sync.yml`, `lib/sync.mjs` |
| Cliente Makito | JWT + límite 25 pet./min | `lib/makito.mjs` |
| Base de datos y logos | Supabase (Postgres + Storage) | `supabase/schema.sql` |
| Pagos | Stripe Checkout | `functions/api/checkout.js`, `stripe-webhook.js` |

La sincronización va en GitHub Actions y no en Cloudflare porque el plan gratuito de Workers limita el tiempo de CPU
por petición (10 ms) y procesar el catálogo completo de Makito lo supera.

## Seguridad

- Los **costes de Makito nunca llegan al navegador**: la vista `public_catalog` solo expone precios de venta con margen.
- Todos los precios se **recalculan en el servidor** antes de cobrar o guardar un presupuesto.
- Credenciales (Makito, Supabase service role, Stripe) **solo como variables secretas en Cloudflare y GitHub**. Nunca en el repositorio.
- RLS activado en todas las tablas; pedidos y logos solo accesibles con service role.
- Logos en bucket privado, con validación de tipo y tamaño (10 MB).
- Cabeceras de seguridad (CSP, HSTS, X-Frame-Options) en `public/_headers`.
- Envío de pedidos a Makito protegido con `ADMIN_KEY` y solo para pedidos pagados/aceptados.

## Puesta en marcha

1. **Supabase** (gratis): crea un proyecto y ejecuta `supabase/schema.sql` en el SQL Editor.
   Copia la *Project URL* y la clave *service_role* (Project Settings > API).
2. **GitHub > Settings > Secrets and variables > Actions** — añade los secrets:
   `MAKITO_CLIENT_ID`, `MAKITO_CLIENT_SECRET` (empieza con los de **Sandbox**), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
3. **GitHub > Actions > Sincronizar Makito > Run workflow** — primera carga del catálogo de farmacia.
   El resumen muestra cuántos productos entran (`pharmaActive`).
4. **Cloudflare** (gratis): Workers & Pages > Create > Pages > *Connect to Git* > este repositorio.
   - Framework preset: *None*. Build command: `npm install`. Output directory: `public`.
   - Settings > Variables and Secrets: las de `.env.example` (Makito, Supabase, Stripe, `ADMIN_KEY`, `SITE_URL`).
   - Settings > Runtime > Compatibility flags: `nodejs_compat`.
5. **Stripe**: crea el webhook a `https://TU-WEB/api/stripe-webhook` con el evento `checkout.session.completed`.
6. **Márgenes**: tabla `settings` en Supabase (`margin` 0.45 = +45 % producto, `print_margin` 0.35 = +35 % marcaje).
7. **Pedido de prueba a Makito** (Sandbox):
   `curl -X POST https://TU-WEB/api/makito-order -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" -d '{"orderId":"..."}'`
8. Cuando todo cuadre, cambia a las credenciales **Reales** de Makito (en GitHub y en Cloudflare).

## Cómo se usa la API de Makito

| Dato | Endpoint | Frecuencia |
|---|---|---|
| Login (JWT) | `POST /access/auth/login` | se reutiliza hasta caducar |
| Catálogo y variantes | `GET /catalog/files?format=JSON&lang=es` | diaria |
| Precios producto | `GET /price-list/files` | diaria |
| Precios marcaje | `GET /print-price-list/files` | diaria |
| Configuración marcaje | `GET /print-config/files` | diaria |
| Stock | `GET /stock/files` | cada hora |
| Imágenes | `GET /catalog/assets/...` vía `/api/img` (caché CDN 7 días) | bajo demanda |
| Pedidos | `POST /orders` (separa líneas con y sin marcaje) | manual |

Una sincronización completa son 5 peticiones: muy por debajo del límite (100 de golpe, 25/min).

### A verificar con datos reales (primera sincronización en Sandbox)
- Nombre exacto del array de variantes dentro de cada producto del catálogo (`makito-sync.mjs` prueba `variants`, `variant`, `colors`).
- Campo de referencia de producto en `/print-config/files` y cómo se relacionan áreas y técnicas.
- Si `amount` de `/price-list` es por unidad o por `baseQuantity` (`MAKITO_PRICE_PER_BASE`).
- Cómo se sube el archivo de diseño (`attachment`) en pedidos con marcaje: mientras tanto el pedido queda en `PENDING_DESIGN` y se envía el arte a Makito por su canal habitual.

## Desarrollo local

```bash
npm install
cp .env.example .dev.vars          # variables para wrangler (no se sube)
npx wrangler pages dev             # web + API en http://localhost:8788
node --env-file=.dev.vars scripts/run-sync.mjs   # sincronización completa
```
