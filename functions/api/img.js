// Proxy de imágenes de Makito (requieren token JWT).
// Cachea cada imagen 7 días en el edge de Cloudflare (Cache API), así Makito solo recibe la primera petición.
// Uso: /api/img?u=/catalog/assets/15246/principal/5246-W.jpg
import { withEnv } from '../../lib/env.mjs';
import { makito } from '../../lib/makito.mjs';

const handler = async (req, ctx) => {
  const u = new URL(req.url).searchParams.get('u') || '';
  const path = u.replace(/^https:\/\/apis\.makito\.es/, '');
  if (!/^\/(catalog|print-config)\/assets\/[\w\-./]+\.(jpe?g|png|webp|gif)$/i.test(path) || path.includes('..')) return new Response('Bad request', { status: 400 });

  const cache = globalThis.caches?.default;
  const key = new Request(new URL(`/api/img?u=${encodeURIComponent(path)}`, req.url));
  const hit = cache && (await cache.match(key));
  if (hit) return hit;

  try {
    const res = await makito(path, { raw: true });
    const out = new Response(res.body, { headers: { 'content-type': res.headers.get('content-type') || 'image/jpeg',
      'cache-control': 'public, max-age=604800, stale-while-revalidate=86400' } });
    if (cache) ctx.waitUntil(cache.put(key, out.clone()));
    return out;
  } catch { return new Response('Not found', { status: 404 }); }
};

export const onRequest = withEnv(handler);
