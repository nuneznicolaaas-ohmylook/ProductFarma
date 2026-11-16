// Envía a Makito (POST /orders) un pedido pagado o un presupuesto aceptado.
// Uso interno:  POST /api/makito-order  { orderId, express?:false }  cabecera  x-admin-key: <ADMIN_KEY>
// - Makito no permite mezclar líneas con y sin marcaje: se crean hasta 2 pedidos.
// - Envío a domicilio del cliente final (dropshipping). Región = provincia (2 primeros dígitos del CP en España).
// - Con credenciales del modo Sandbox los pedidos NO se procesan: úsalo para probar.
import { withEnv } from '../../lib/env.mjs';
import { db, json } from '../../lib/core.mjs';
import { createOrder } from '../../lib/makito.mjs';

const handler = async (req) => {
  if (req.method !== 'POST' || !process.env.ADMIN_KEY || req.headers.get('x-admin-key') !== process.env.ADMIN_KEY) return json({ error: 'Forbidden' }, 403);
  const { orderId, express = false } = await req.json();
  const { data: o, error } = await db().from('orders').select('*').eq('id', orderId).single();
  if (error || !o) return json({ error: 'Pedido no encontrado' }, 404);
  if (!['paid', 'won'].includes(o.status)) return json({ error: `Estado "${o.status}": solo pedidos pagados o presupuestos aceptados` }, 409);
  const c = o.customer;
  if (!c.street || !c.postalCode || !c.city) return json({ error: 'Falta dirección completa del cliente' }, 422);

  const base = {
    expressDelivery: !!express, completeDelivery: false, allowRepeatCustomer: false, allowPartialOrder: true,
    contact: { name: (c.name || '').slice(0, 35), email: c.email, phoneNumber: (c.phone || '').replace(/\s/g, '').slice(0, 16) },
    shippingAddress: { company: (c.company || c.name).slice(0, 35), name: (c.company || c.name).slice(0, 35), street: c.street,
      postalCode: c.postalCode, city: c.city, region: c.country === 'ES' ? c.postalCode.slice(0, 2) : undefined,
      country: c.country || 'ES', phone: c.phone },
    comments: `ProductFarma ${o.id}`,
  };
  const groups = [
    ['S', o.items.filter((i) => !i.technique)],
    ['P', o.items.filter((i) => i.technique)],
  ].filter(([, items]) => items.length);

  const results = [];
  try {
    for (const [tag, items] of groups) {
      const payload = { ...base, customerOrder: `PF-${o.id.slice(0, 8)}-${tag}`, items: items.map((i) => ({
        variant: i.sku, quantity: i.qty, observations: tag === 'P' ? `${i.technique_name || ''} ${i.colors} col.` : undefined,
        printingJobs: tag === 'P' ? [{ area: i.area, technique: i.technique, attachment: i.logo ? i.logo.split('/').pop() : undefined,
          colors: i.pantones || undefined, doublePass: false }] : undefined })) };
      results.push(await createOrder(payload));
    }
    await db().from('orders').update({ status: 'sent_to_makito', makito_orders: results }).eq('id', o.id);
    return json({ ok: true, makito: results.map((r) => ({ customerOrder: r.customerOrder, documents: r.documents,
      items: r.items?.map((i) => ({ variant: i.variant, status: i.status, availableDate: i.availableDate })) })) });
  } catch (e) {
    if (results.length) await db().from('orders').update({ makito_orders: results }).eq('id', o.id);
    return json({ error: e.message, partial: results.length }, 502);
  }
};

export const onRequest = withEnv(handler);
