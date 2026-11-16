# ProductFarma

Tienda B2B de productos promocionales personalizados, conectada a la **API B2B de Makito**.

- Catálogo, variantes, stock, precios por tramos y técnicas de marcaje sincronizados desde Makito.
- El cliente elige color, técnica, nº de colores y cantidad, sube su logo y ve el precio al momento.
- **Compra directa** con Stripe (hasta `QUOTE_THRESHOLD_EUR`) o **solicitud de presupuesto** con logos adjuntos.
- Los pedidos pagados o presupuestos aceptados se envían a Makito con un clic (`/api/makito-order`), nunca solos.

## Arquitectura

| Parte | Tecnología | Archivo |
|---|---|---|
| Web (frontal) | HTML + JS sin dependencias | `public/index.html` |
| API y tareas | Netlify Functions | `netlify/functions/*` |
| Cliente Makito | OAuth2 + límite 25 pet./min | `netlify/lib/makito.mjs` |
| Base de datos y logos | Supabase (Postgres + Storage) | `supabase/schema.sql` |
| Pagos | Stripe Checkout | `checkout.mjs`, `stripe-webhook.mjs` |

## Seguridad

- Los **costes de Makito nunca llegan al navegador**: la vista `public_catalog` solo expone precios de venta con margen.
- Todos los precios se **recalculan en el servidor** antes de cobrar o guardar un presupuesto.
- Credenciales (Makito, Supabase service role, Stripe) **solo como variables de entorno en Netlify**. Nunca en el repositorio.
- RLS activado en todas las tablas; pedidos y logos solo accesibles con service role.
- Logos en bucket privado, con validación de tipo y tamaño (10 MB).
- Cabeceras de seguridad (CSP, HSTS, X-Frame-Options) en `netlify.toml`.
- Envío de pedidos a Makito protegido con `ADMIN_KEY` y solo para pedidos pagados/aceptados.

## Puesta en marcha

1. **Supabase**: crea un proyecto y ejecuta `supabase/schema.sql` en el SQL Editor.
2. **Netlify**: importa este repositorio (build: ninguno, publish: `public`).
3. En Netlify > Site settings > Environment variables, añade las de `.env.example`:
   - Empieza con las credenciales **Sandbox** de Makito (sus pedidos no se procesan).
   - Genera `SYNC_SECRET` y `ADMIN_KEY` largas y aleatorias (p. ej. `openssl rand -hex 32`).
4. Lanza la primera sincronización:
   `curl -X POST https://TU-WEB/.netlify/functions/makito-sync -H "x-sync-key: $SYNC_SECRET"`
5. **Stripe**: crea el webhook a `https://TU-WEB/api/stripe-webhook` con el evento `checkout.session.completed`.
6. Margen: cambia `margin` y `print_margin` en la tabla `settings` (0.45 = +45 %).
7. Envía un pedido de prueba a Makito: `curl -X POST https://TU-WEB/api/makito-order -H "x-admin-key: $ADMIN_KEY" -d '{"orderId":"..."}'`
8. Cuando todo cuadre, cambia a las credenciales **Reales** de Makito.

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

Una sincronización completa son 6 peticiones: muy por debajo del límite (100 de golpe, 25/min).

### A verificar con datos reales (primera sincronización en Sandbox)
- Nombre exacto del array de variantes dentro de cada producto del catálogo (`makito-sync.mjs` prueba `variants`, `variant`, `colors`).
- Campo de referencia de producto en `/print-config/files` y cómo se relacionan áreas y técnicas.
- Si `amount` de `/price-list` es por unidad o por `baseQuantity` (`MAKITO_PRICE_PER_BASE`).
- Cómo se sube el archivo de diseño (`attachment`) en pedidos con marcaje: mientras tanto el pedido queda en `PENDING_DESIGN` y se envía el arte a Makito por su canal habitual.

## Desarrollo local

```bash
npm install
cp .env.example .env   # rellenar
npx netlify dev
node --env-file=.env scripts/run-sync.mjs   # probar la sincronización
```
