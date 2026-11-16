// POST /api/checkout  { items:[{ref,sku,qty,technique,colors,logo}], customer:{...} }
// Recalcula precios en servidor, guarda el pedido y abre Stripe Checkout.
import { withEnv } from '../../lib/env.mjs';
import Stripe from 'stripe';
import { db, json, priceCart, cleanCustomer } from '../../lib/core.mjs';
const handler = async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
  try {
    const body = await req.json();
    const customer = cleanCustomer(body.customer);
    const cart = await priceCart(body.items || []);
    if (cart.total > Number(process.env.QUOTE_THRESHOLD_EUR || 1500) * 1.21)
      return json({ error: 'quote_required', message: 'Para este importe te preparamos un presupuesto con mejor precio.' }, 409);
    const { data: order, error } = await db().from('orders')
      .insert({ kind: 'order', customer, items: cart.items, subtotal: cart.subtotal, vat: cart.vat, total: cart.total })
      .select('id').single();
    if (error) throw error;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
    const session = await stripe.checkout.sessions.create({
      mode: 'payment', customer_email: customer.email, locale: 'es',
      line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: Math.round(cart.total * 100),
        product_data: { name: `Pedido ProductFarma (${cart.items.length} líneas, IVA incl.)` } } }],
      metadata: { order_id: order.id },
      success_url: `${process.env.SITE_URL}/#gracias`, cancel_url: `${process.env.SITE_URL}/#carrito`,
    });
    await db().from('orders').update({ stripe_session: session.id }).eq('id', order.id);
    return json({ url: session.url });
  } catch (e) { return json({ error: e.message }, 400); }
};

export const onRequest = withEnv(handler);
