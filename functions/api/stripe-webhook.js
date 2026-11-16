// Marca el pedido como pagado cuando Stripe confirma el pago.
import { withEnv } from '../../lib/env.mjs';
import Stripe from 'stripe';
import { db } from '../../lib/core.mjs';
const handler = async (req) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
  let event;
  try { event = await stripe.webhooks.constructEventAsync(await req.text(), req.headers.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET, undefined, Stripe.createSubtleCryptoProvider()); }
  catch (e) { return new Response(`Firma no válida: ${e.message}`, { status: 400 }); }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    await db().from('orders').update({ status: 'paid' }).eq('id', s.metadata.order_id);
  }
  return new Response('ok');
};

export const onRequest = withEnv(handler);
