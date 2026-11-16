// Sincroniza Makito -> Supabase usando los "files" de la API B2B.
// Programada (netlify.toml): stock en cada ejecución (cada hora); catálogo, precios y marcaje una vez al día.
// Manual: POST /.netlify/functions/makito-sync  cabecera  x-sync-key: <SYNC_SECRET>  (hace sincronización completa)
// Son solo 5 peticiones por sincronización completa: muy por debajo del límite de 25/min.
import { db } from '../lib/core.mjs';
import { getCatalog, getStock, getPriceList, getPrintPrices, getPrintConfig } from '../lib/makito.mjs';

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const num = (x) => Number(String(x ?? '').replace(',', '.')) || 0;
const pick = (o, ks) => { for (const k of ks) if (o?.[k] !== undefined && o[k] !== '' && o[k] !== null) return o[k]; };
const now = () => new Date().toISOString();
const mm = (v) => (num(v) ? `${num(v) / 10}` : null); // Makito da medidas en mm -> cm

async function upsert(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db().from(table).upsert(rows.slice(i, i + 500), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

// /catalog/files -> products + variants
export async function syncCatalog() {
  const { products = [] } = await getCatalog();
  const P = [], V = [];
  for (const p of products) {
    const ref = String(p.ref ?? '').trim(); if (!ref) continue;
    const dims = [p.length, p.width, p.height].map(mm).filter(Boolean);
    const cats = arr(p.categories).map((c) => (typeof c === 'object' ? pick(c, ['name', 'description', 'category_name_1']) : c)).filter(Boolean);
    P.push({ ref, web_ref: p.web_reference ?? null, name: p.name, description: p.description, brand: p.brand ?? null,
      category: cats[0] ?? null, subcategory: cats[1] ?? null, material: p.material ?? null,
      dims: dims.length ? dims.join(' × ') + ' cm' : (num(p.diameter) ? `Ø${mm(p.diameter)} cm` : null),
      print_code: p.printcode ?? null, is_new: !!p.web_new,
      images: [p.image, ...arr(p.images)].filter(Boolean).map((i) => (typeof i === 'object' ? i.url ?? i.image : i)),
      active: true, updated_at: now() });
    // Variantes: la referencia de variante es el "material" de stock (p. ej. 15246003000)
    for (const v of arr(p.variants ?? p.variant ?? p.colors)) {
      const sku = String(pick(v, ['variant', 'variant_ref', 'material', 'ref', 'refct', 'matnr']) ?? '').trim(); if (!sku) continue;
      V.push({ sku, ref, color: pick(v, ['colour_name', 'color_name', 'colour', 'color', 'description']) ?? null,
        color_hex: pick(v, ['hex', 'colour_hex', 'color_hex']) ?? null, size: pick(v, ['size', 'talla']) ?? null,
        image: pick(v, ['variant_image', 'image']) ?? null, updated_at: now() });
    }
  }
  await upsert('products', P, 'ref');
  await upsert('variants', V, 'sku');
  return { products: P.length, variants: V.length };
}

// /price-list/files -> price_tiers   ({material, baseQuantity, scales:[{quantity, amount}]})
// amount es el importe por "baseQuantity" unidades (verificar con un producto real; ver MAKITO_PRICE_PER_BASE).
export async function syncPrices() {
  const { priceList = [] } = await getPriceList();
  const perBase = process.env.MAKITO_PRICE_PER_BASE !== 'false';
  const T = [];
  for (const p of priceList) {
    const ref = String(p.material ?? '').trim(); if (!ref) continue;
    const base = perBase ? num(p.baseQuantity) || 1 : 1;
    for (const s of arr(p.scales)) T.push({ ref, min_qty: Math.max(1, num(s.quantity)), unit_cost: num(s.amount) / base });
  }
  const { data: known } = await db().from('products').select('ref');
  const ok = new Set((known || []).map((r) => r.ref));
  await upsert('price_tiers', T.filter((t) => ok.has(t.ref) && t.unit_cost > 0), 'ref,min_qty');
  return { tiers: T.length };
}

// /print-price-list/files -> print_techniques   y   /print-config/files -> product_print
export async function syncPrint() {
  const { printPriceList = [] } = await getPrintPrices();
  const tech = printPriceList.map((t) => ({ id: String(t.id), code: t.code, name: t.name, category: t.category,
    setup: num(t.prices?.setupPrice), additional_setup: num(t.prices?.additionalSetupPrice),
    tiers: arr(t.prices?.items).map((i) => ({ min: num(i.threshold), price: num(i.price), type: i.type })).sort((a, b) => a.min - b.min),
    updated_at: now() }));
  await upsert('print_techniques', tech, 'id');

  const { products = [] } = await getPrintConfig();
  const rows = [];
  for (const p of products) {
    const ref = String(pick(p, ['ref', 'reference', 'prodReference', 'product']) ?? '').trim(); if (!ref) continue;
    const areas = arr(p.areas);
    for (const t of arr(p.techniques)) {
      const area = areas.find((a) => arr(a.techniques).some((x) => String(x.id ?? x) === String(t.id))) || areas[0] || {};
      rows.push({ ref, technique_id: String(t.id), label: t.category || t.description, description: t.description,
        area: area.code ?? area.id ?? null, area_name: area.description ?? area.name ?? null,
        max_w_mm: num(area.width ?? area.maxWidth) || null, max_h_mm: num(area.height ?? area.maxHeight) || null,
        max_colors: num(t.maximumColors) || 1, full_color: !!t.fullColor });
    }
  }
  const refs = [...new Set(rows.map((r) => r.ref))];
  for (let i = 0; i < refs.length; i += 300) await db().from('product_print').delete().in('ref', refs.slice(i, i + 300));
  await upsert('product_print', rows.filter((r, i, a) => a.findIndex((x) => x.ref === r.ref && x.technique_id === r.technique_id) === i), 'ref,technique_id');
  return { techniques: tech.length, productPrint: rows.length };
}

// /stock/files -> variants.stock   ({material, quantity, availableDate})
export async function syncStock() {
  const { stocks = [] } = await getStock();
  const agg = new Map();
  for (const s of stocks) {
    const sku = String(s.material ?? '').trim(); if (!sku) continue;
    const cur = agg.get(sku) || { stock: 0, next_arrival: null };
    if (s.availableDate) cur.next_arrival = cur.next_arrival && cur.next_arrival < s.availableDate ? cur.next_arrival : s.availableDate.slice(0, 10);
    else cur.stock += num(s.quantity);
    agg.set(sku, cur);
  }
  const { data } = await db().rpc('apply_stock', { payload: [...agg].map(([sku, v]) => ({ sku, ...v })) });
  return { stock: data ?? agg.size };
}

export default async (req) => {
  const key = req?.headers?.get?.('x-sync-key');
  if (key != null && key !== process.env.SYNC_SECRET) return new Response('Forbidden', { status: 403 });
  const full = key != null || new Date().getUTCHours() === 2;
  const out = {};
  try {
    if (full) Object.assign(out, await syncCatalog(), await syncPrices(), await syncPrint());
    Object.assign(out, await syncStock());
    console.log('makito-sync', out);
    return Response.json({ ok: true, full, ...out });
  } catch (e) {
    console.error('makito-sync', e);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
};
