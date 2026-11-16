// Utilidades compartidas: Supabase (servidor) y cálculo de precios.
import { createClient } from '@supabase/supabase-js';

export const db = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

export const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Precio de una línea, SIEMPRE calculado en servidor a partir del catálogo.
 * product: fila de public_catalog. line: { ref, sku, qty, technique, colors }
 */
export function priceLine(product, line) {
  const qty = Math.max(1, Math.floor(Number(line.qty) || 0));
  const tiers = [...(product.tiers || [])].sort((a, b) => a.min - b.min);
  if (!tiers.length) throw new Error(`Sin precio para ${product.ref}`);
  const tier = tiers.filter((t) => qty >= t.min).pop() || tiers[0];
  const minQty = tiers[0].min;
  if (qty < minQty) throw new Error(`Mínimo ${minQty} uds para ${product.ref}`);

  let printUnit = 0, setup = 0, opt = null;
  if (line.technique && line.technique !== 'none') {
    opt = (product.print || []).find((o) => o.technique === line.technique);
    if (!opt) throw new Error(`Técnica no disponible: ${line.technique}`);
    const colors = Math.min(Math.max(1, Number(line.colors) || 1), opt.maxColors || 1);
    printUnit = opt.unit * colors;
    setup = opt.setup * colors;
  }
  const unit = r2(tier.price + printUnit);
  return { ref: product.ref, sku: line.sku, name: product.name, qty, technique: opt?.technique || null,
    colors: line.colors || 0, unit, setup: r2(setup), total: r2(unit * qty + setup), logo: line.logo || null };
}

export async function priceCart(lines) {
  const refs = [...new Set(lines.map((l) => l.ref))];
  const { data, error } = await db().from('public_catalog').select('*').in('ref', refs);
  if (error) throw error;
  const map = Object.fromEntries(data.map((p) => [p.ref, p]));
  const items = lines.map((l) => {
    const p = map[l.ref];
    if (!p) throw new Error(`Producto no encontrado: ${l.ref}`);
    const v = (p.variants || []).find((x) => x.sku === l.sku);
    if (!v) throw new Error(`Variante no encontrada: ${l.sku}`);
    return { ...priceLine(p, l), color: v.color, stock: v.stock };
  });
  const subtotal = r2(items.reduce((s, i) => s + i.total, 0));
  const vat = r2(subtotal * Number(process.env.VAT_RATE || 0.21));
  return { items, subtotal, vat, total: r2(subtotal + vat) };
}

// Validación básica de datos de cliente
export function cleanCustomer(c = {}) {
  const s = (v, n = 200) => String(v ?? '').trim().slice(0, n);
  const out = { name: s(c.name), company: s(c.company), vat_id: s(c.vat_id, 20), email: s(c.email, 120).toLowerCase(),
    phone: s(c.phone, 30), address: s(c.address, 300), notes: s(c.notes, 2000) };
  if (!out.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email)) throw new Error('Nombre y email válidos son obligatorios');
  return out;
}
