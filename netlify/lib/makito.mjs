// Cliente de la API B2B de Makito (data.makito.es/apis_b2b).
// - Autenticación OAuth2 client_credentials con caché de token.
// - Limitador token-bucket propio: 100 de capacidad, 25 peticiones/min (límites de Makito).
// - Reintento automático en 429/5xx.
// Las rutas exactas se configuran en variables de entorno para ajustarlas a la documentación sin tocar código.
const env = (k, d) => process.env[k] ?? d;
const BASE = () => env('MAKITO_API_BASE');                 // p. ej. https://data.makito.es/apis_b2b  (pruebas o producción)
const PATHS = () => ({
  token:    env('MAKITO_PATH_TOKEN', '/oauth/token'),
  products: env('MAKITO_PATH_PRODUCTS', '/products'),
  prices:   env('MAKITO_PATH_PRICES', '/prices'),
  stock:    env('MAKITO_PATH_STOCK', '/stock'),
  print:    env('MAKITO_PATH_PRINT', '/printing'),
  orders:   env('MAKITO_PATH_ORDERS', '/orders'),
});

// ---- limitador ----
const bucket = { tokens: 100, cap: 100, perMs: 25 / 60000, last: Date.now() };
async function take() {
  for (;;) {
    const now = Date.now();
    bucket.tokens = Math.min(bucket.cap, bucket.tokens + (now - bucket.last) * bucket.perMs);
    bucket.last = now;
    if (bucket.tokens >= 1) { bucket.tokens -= 1; return; }
    await new Promise((r) => setTimeout(r, Math.ceil((1 - bucket.tokens) / bucket.perMs)));
  }
}

// ---- token OAuth ----
let tok = { value: null, exp: 0 };
async function token() {
  if (tok.value && Date.now() < tok.exp - 60000) return tok.value;
  await take();
  const res = await fetch(BASE() + PATHS().token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials',
      client_id: env('MAKITO_CLIENT_ID'), client_secret: env('MAKITO_CLIENT_SECRET') }),
  });
  if (!res.ok) throw new Error(`Makito auth HTTP ${res.status}`);
  const j = await res.json();
  tok = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return tok.value;
}

export async function makito(path, { method = 'GET', query, body, retries = 3 } = {}) {
  const url = new URL(BASE() + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined) url.searchParams.set(k, v);
  for (let i = 0; ; i++) {
    await take();
    const res = await fetch(url, { method, headers: { authorization: `Bearer ${await token()}`, accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401 && i < retries) { tok = { value: null, exp: 0 }; continue; }
    if ((res.status === 429 || res.status >= 500) && i < retries) {
      await new Promise((r) => setTimeout(r, Number(res.headers.get('retry-after') || 5) * 1000 * (i + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Makito ${method} ${path}: HTTP ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
    return res.status === 204 ? null : res.json();
  }
}

// Recorre todas las páginas de un listado (soporta page/limit y next links)
export async function makitoAll(path, query = {}) {
  const out = []; let page = 1;
  for (;;) {
    const j = await makito(path, { query: { ...query, page, limit: 500 } });
    const rows = Array.isArray(j) ? j : j.data ?? j.items ?? j.results ?? [];
    out.push(...rows);
    const more = j.next || j.links?.next || (j.meta && j.meta.current_page < j.meta.last_page) || (j.totalPages && page < j.totalPages);
    if (!more || !rows.length) return out;
    page++;
  }
}

export const paths = PATHS;
