// Utilidades compartidas: Supabase (servidor) y cálculo de precios.
import { createClient } from '@supabase/supabase-js';

export const db = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

export const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });

const r2 = (n) => Math.round(n * 100) / 100;

/** Tramo aplicable: el de mayor mínimo <= qty (o el primero). */
export const tierFor = (tiers, qty) => { const t = [...(tiers || [])].sort((a, b) => a.min - b.min); return t.filter((x) => qty >= x.min).pop() || t[0]; };

/**
 * Coste de marcaje de venta (misma fórmula en el navegador):
 *  unidad = precio del tramo × nº colores (1 si es cuatricromía/full color)
 *  preparación = setup + addSetup × (colores - 1)
 */
export function printCost(opt, qty, colors) {
  const n = opt.fullColor ? 1 : Math.min(Math.max(1, Number(colors) || 1), opt.maxColors || 1);
  const unit = (opt.tiers?.length ? tierFor(opt.tiers, qty).price : opt.unit || 0) * n;
  const setup = (opt.setup || 0) + (opt.addSetup ?? opt.setup ?? 0) * (n - 1);
  return { n, unit, setup };
}

/** Precio de una línea, SIEMPRE calculado en servidor a partir del catálogo. */
export function priceLine(product, line) {
  const qty = Math.max(1, Math.floor(Number(line.qty) || 0));
  const tiers = [...(product.tiers || [])].sort((a, b) => a.min - b.min);
  if (!tiers.length) throw new Error(`Sin precio para ${product.ref}`);
  if (qty < tiers[0].min) throw new Error(`Mínimo ${tiers[0].min} uds para ${product.ref}`);
  const base = tierFor(tiers, qty).price;
  let pc = { n: 0, unit: 0, setup: 0 }, opt = null;
  if (line.technique) {
    opt = (product.print || []).find((o) => String(o.id) === String(line.technique) || o.technique === line.technique);
    if (!opt) throw new Error(`Técnica no disponible: ${line.technique}`);
    pc = printCost(opt, qty, line.colors);
  }
  const unit = r2(base + pc.unit);
  return { ref: product.ref, sku: line.sku, name: product.name, qty, technique: opt ? String(opt.id ?? opt.technique) : null,
    technique_name: opt?.technique || null, area: line.area || opt?.area || null, colors: pc.n,
    pantones: String(line.pantones || '').slice(0, 60), unit, setup: r2(pc.setup), total: r2(unit * qty + pc.setup), logo: line.logo || null };
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
  const out = { name: s(c.name, 35), company: s(c.company, 35), vat_id: s(c.vat_id, 20), email: s(c.email, 120).toLowerCase(),
    phone: s(c.phone, 16), street: s(c.street, 60), postalCode: s(c.postalCode, 10), city: s(c.city, 40),
    country: s(c.country || 'ES', 2).toUpperCase(), notes: s(c.notes, 2000) };
  if (!out.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email)) throw new Error('Nombre y email válidos son obligatorios');
  return out;
}
