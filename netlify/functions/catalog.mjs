// GET /api/catalog            -> catálogo completo (cache 10 min en CDN)
// GET /api/catalog?ref=XXXX   -> un producto
import { db, json } from '../lib/core.mjs';
export default async (req) => {
  const ref = new URL(req.url).searchParams.get('ref');
  let q = db().from('public_catalog').select('*');
  if (ref) q = q.eq('ref', ref);
  const { data, error } = await q.order('category').limit(5000);
  if (error) return json({ error: error.message }, 500);
  return json(ref ? data[0] || null : data, 200, { 'cache-control': 'public, max-age=60, s-maxage=600' });
};
export const config = { path: '/api/catalog' };
