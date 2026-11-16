// Envía a Makito un pedido pagado/aceptado (dropshipping de producto liso o con marcaje).
// Se llama desde el panel interno: POST /api/makito-order { orderId } con cabecera x-admin-key.
// Por seguridad NO se envía automáticamente: tú revisas arte y márgenes y luego lo lanzas.
import { db, json } from '../lib/core.mjs';
import { makito, paths } from '../lib/makito.mjs';
export default async (req) => {
  if (req.method !== 'POST' || req.headers.get('x-admin-key') !== process.env.ADMIN_KEY) return json({ error: 'Forbidden' }, 403);
  const { orderId } = await req.json();
  const { data: o, error } = await db().from('orders').select('*').eq('id', orderId).single();
  if (error || !o) return json({ error: 'Pedido no encontrado' }, 404);
  if (!['paid', 'won'].includes(o.status)) return json({ error: `Estado ${o.status}: solo pedidos pagados o presupuestos aceptados` }, 409);
  // Formato orientativo; ajustar a la referencia de la API B2B de Makito.
  const payload = { externalReference: o.id, deliveryAddress: o.customer.address, contactEmail: o.customer.email,
    lines: o.items.map((i) => ({ reference: i.sku, quantity: i.qty, printing: i.technique ? { technique: i.technique, colors: i.colors } : undefined })) };
  try {
    const res = await makito(paths().orders, { method: 'POST', body: payload });
    await db().from('orders').update({ status: 'in_production', notes: `${o.notes || ''}\nMakito: ${JSON.stringify(res).slice(0, 500)}` }).eq('id', o.id);
    return json({ ok: true, makito: res });
  } catch (e) { return json({ error: e.message }, 502); }
};
export const config = { path: '/api/makito-order' };
