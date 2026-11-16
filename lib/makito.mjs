// Cliente de la API B2B de Makito — https://apis.makito.es (v0.02)
// - Login: POST /access/auth/login {clientId, clientSecret} -> {token} (JWT, se reutiliza hasta su caducidad)
// - Límite de Makito: token bucket de 100 peticiones, recarga 25/min. Lo respetamos aquí.
// - Reintentos en 401 (renueva token), 429 y 5xx.
const BASE = () => process.env.MAKITO_API_BASE || 'https://apis.makito.es';

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

let jwt = { value: null, exp: 0 };
function jwtExp(t) {
  try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).exp * 1000; } catch { return Date.now() + 30 * 60000; }
}
async function token() {
  if (jwt.value && Date.now() < jwt.exp - 60000) return jwt.value;
  await take();
  const res = await fetch(BASE() + '/access/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: process.env.MAKITO_CLIENT_ID, clientSecret: process.env.MAKITO_CLIENT_SECRET }),
  });
  if (!res.ok) throw new Error(`Makito login HTTP ${res.status}`);
  const { token: t } = await res.json();
  jwt = { value: t, exp: jwtExp(t) };
  return t;
}

/** Llamada genérica. raw=true devuelve la Response (imágenes, ZIP). */
export async function makito(path, { method = 'GET', query, body, raw = false, retries = 3 } = {}) {
  const url = new URL(BASE() + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  for (let i = 0; ; i++) {
    await take();
    const res = await fetch(url, { method, body: body ? JSON.stringify(body) : undefined, headers: {
      authorization: `Bearer ${await token()}`, accept: raw ? '*/*' : 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}) } });
    if (res.status === 401 && i < retries) { jwt = { value: null, exp: 0 }; continue; }
    if ((res.status === 429 || res.status >= 500) && i < retries) {
      await new Promise((r) => setTimeout(r, Number(res.headers.get('retry-after') || 10) * 1000 * (i + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Makito ${method} ${path}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
    return raw ? res : res.status === 204 ? null : res.json();
  }
}

const LANG = () => process.env.MAKITO_LANG || 'es';
export const getCatalog      = () => makito('/catalog/files', { query: { format: 'JSON', lang: LANG() } });
export const getStock        = () => makito('/stock/files', { query: { format: 'JSON' } });
export const getPriceList    = () => makito('/price-list/files', { query: { format: 'JSON' } });
export const getPrintPrices  = () => makito('/print-price-list/files', { query: { format: 'JSON' } });
export const getPrintConfig  = () => makito('/print-config/files', { query: { format: 'JSON', lang: LANG() } });
export const getRegions      = () => makito('/orders/regions');
export const createOrder     = (payload) => makito('/orders', { method: 'POST', body: payload });
export const getOrders       = (query) => makito('/orders/sales-order', { query });
