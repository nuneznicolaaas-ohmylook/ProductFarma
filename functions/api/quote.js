// POST /api/quote  multipart: data (JSON {items, customer}) + logo_<n> (archivos)
// Guarda la solicitud de presupuesto y los logos en Supabase Storage (bucket privado).
import { withEnv } from '../../lib/env.mjs';
import { db, json, priceCart, cleanCustomer } from '../../lib/core.mjs';
const OK = ['image/png', 'image/jpeg', 'image/svg+xml', 'application/pdf', 'application/postscript'];
const handler = async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
  try {
    const form = await req.formData();
    const body = JSON.parse(form.get('data'));
    const customer = cleanCustomer(body.customer);
    const sb = db();
    const items = body.items || [];
    for (const [i, it] of items.entries()) {
      const f = form.get(`logo_${i}`);
      if (f && f.size) {
        if (f.size > 10 * 1024 * 1024 || !OK.includes(f.type)) throw new Error('Logo: PNG, JPG, SVG, PDF o AI de hasta 10 MB');
        const path = `${Date.now()}-${i}-${f.name.replace(/[^\w.-]/g, '_')}`;
        const { error } = await sb.storage.from('logos').upload(path, f, { contentType: f.type });
        if (error) throw error;
        it.logo = path;
      }
    }
    const cart = await priceCart(items).catch(() => ({ items, subtotal: null, vat: null, total: null }));
    const { data, error } = await sb.from('orders').insert({ kind: 'quote', status: 'pending', customer, items: cart.items,
      subtotal: cart.subtotal, vat: cart.vat, total: cart.total, notes: customer.notes }).select('id').single();
    if (error) throw error;
    return json({ ok: true, id: data.id });
  } catch (e) { return json({ error: e.message }, 400); }
};

export const onRequest = withEnv(handler);
