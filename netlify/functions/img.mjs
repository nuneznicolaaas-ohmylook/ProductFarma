// Proxy de imágenes de Makito (requieren token). Cachea en la CDN de Netlify 7 días.
// Uso en la web: /api/img?u=<ruta devuelta por el catálogo, p.ej. /catalog/assets/15246/principal/5246-W.jpg>
import { makito } from '../lib/makito.mjs';
export default async (req) => {
  const u = new URL(req.url).searchParams.get('u') || '';
  const path = u.replace(/^https:\/\/apis\.makito\.es/, '');
  if (!/^\/(catalog|print-config)\/assets\/[\w\-./]+\.(jpe?g|png|webp|gif)$/i.test(path) || path.includes('..')) return new Response('Bad request', { status: 400 });
  try {
    const res = await makito(path, { raw: true });
    return new Response(res.body, { headers: { 'content-type': res.headers.get('content-type') || 'image/jpeg',
      'cache-control': 'public, max-age=86400', 'netlify-cdn-cache-control': 'public, s-maxage=604800, stale-while-revalidate=86400' } });
  } catch { return new Response('Not found', { status: 404 }); }
};
export const config = { path: '/api/img' };
