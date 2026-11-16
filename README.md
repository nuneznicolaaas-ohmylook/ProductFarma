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
   - Empieza con las credenciales del **entorno de pruebas** de Makito (sus pedidos no se procesan).
   - Ajusta `MAKITO_API_BASE` y las rutas `MAKITO_PATH_*` según https://data.makito.es/apis_b2b/index.html
4. Lanza la primera sincronización:
   `curl -X POST https://TU-WEB/.netlify/functions/makito-sync -H "x-sync-key: $SYNC_SECRET"`
5. **Stripe**: crea el webhook a `https://TU-WEB/api/stripe-webhook` con el evento `checkout.session.completed`.
6. Margen: cambia `margin` y `print_margin` en la tabla `settings` (0.45 = +45 %).
7. Cuando todo cuadre, cambia a las credenciales de **producción** de Makito.

## Pendiente de ajustar con la documentación de Makito

`netlify/lib/makito.mjs` y `makito-sync.mjs` están preparados para JSON paginado y prueban varios nombres de campo
(lista `F`). Con la referencia oficial hay que confirmar: URL base, ruta del token, rutas de productos/precios/stock/marcaje
y el formato de creación de pedidos (`makito-order.mjs`).

## Desarrollo local

```bash
npm install
cp .env.example .env   # rellenar
npx netlify dev
node --env-file=.env scripts/run-sync.mjs   # probar la sincronización
```
