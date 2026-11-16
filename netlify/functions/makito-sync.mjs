// Sincroniza el catálogo de Makito (webservice XML) con Supabase.
// Programada en netlify.toml: stock cada hora; catálogo, precios y marcaje una vez al día (a las 03:15).
// Ejecutar a mano: POST /.netlify/functions/makito-sync  con cabecera  x-sync-key: <SYNC_SECRET>
// Fuente: API B2B de Makito (JSON, OAuth). Se conserva el lector de XML por si se usan los feeds clásicos.
import { XMLParser } from 'fast-xml-parser';
import { db } from '../lib/core.mjs';
import { makitoAll, paths } from '../lib/makito.mjs';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: true, trimValues: true });
const USE_API = () => !!process.env.MAKITO_CLIENT_ID;

// Los nombres de campo de Makito pueden variar según el feed: se prueban varios.
// Si alguno no cuadra, ajusta SOLO estas listas tras ver un XML real.
const F = {
  ref:      ['ref', 'reftc', 'reference', 'id'],
  sku:      ['matnr', 'refct', 'sku', 'ean'],
  name:     ['name', 'nombre', 'title'],
  desc:     ['extendedinfo', 'description', 'descripcion', 'otherinfo'],
  category: ['category_name_1', 'category', 'categoria'],
  subcat:   ['category_name_2', 'subcategory'],
  material: ['composition', 'material'],
  dims:     ['item_long', 'dimensions', 'medidas'],
  color:    ['colour', 'color', 'colorname'],
  hex:      ['hex', 'colour_hex', 'rgb'],
  size:     ['size', 'talla'],
  image:    ['imagemain', 'image', 'img', 'image500px'],
  stock:    ['stock', 'quantity', 'qty'],
  arrival:  ['available', 'date', 'nextarrival'],
};
const pick = (o, keys) => { for (const k of keys) if (o?.[k] !== undefined && o[k] !== '') return o[k]; return undefined; };
const arr = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const num = (x) => Number(String(x ?? '').replace(',', '.')) || 0;

// Encuentra la lista de registros dentro del XML sea cual sea el envoltorio
function records(xml, names) {
  const doc = parser.parse(xml);
  const walk = (o) => {
    if (!o || typeof o !== 'object') return null;
    for (const n of names) if (o[n]) return arr(o[n]);
    for (const v of Object.values(o)) { const r = walk(v); if (r) return r; }
    return null;
  };
  return walk(doc) || [];
}

async function feed(pathVar) {
  const key = process.env.MAKITO_API_KEY;
  const url = process.env.MAKITO_BASE_URL + process.env[pathVar].replace('{key}', encodeURIComponent(key));
  const res = await fetch(url, { headers: { 'user-agent': 'ProductFarma-sync/1.0' } });
  if (!res.ok) throw new Error(`${pathVar}: HTTP ${res.status}`);
  return res.text();
}

async function upsert(table, rows, conflict) {
  const sb = db();
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from(table).upsert(rows.slice(i, i + 500), { onConflict: conflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

export async function syncCatalog() {
  const items = USE_API() ? await makitoAll(paths().products) : records(await feed('MAKITO_PRODUCTS_PATH'), ['product', 'item', 'producto']);
  const products = [], variants = [];
  for (const p of items) {
    const ref = String(pick(p, F.ref) ?? '').trim();
    if (!ref) continue;
    const imgs = arr(p.images?.image ?? p.images ?? p.pictures).map((i) => (typeof i === 'object' ? pick(i, F.image) : i)).filter(Boolean);
    products.push({ ref, name: pick(p, F.name), description: pick(p, F.desc), category: pick(p, F.category),
      subcategory: pick(p, F.subcat), material: pick(p, F.material), dims: pick(p, F.dims),
      images: imgs.length ? imgs : [pick(p, F.image)].filter(Boolean), active: true, updated_at: new Date().toISOString() });
    for (const v of arr(p.variants?.variant ?? p.variants ?? p.colors ?? p.colours)) {
      const sku = String(pick(v, F.sku) ?? '').trim();
      if (sku) variants.push({ sku, ref, color: pick(v, F.color), color_hex: pick(v, F.hex), size: pick(v, F.size), image: pick(v, F.image) });
    }
  }
  await upsert('products', products, 'ref');
  await upsert('variants', variants, 'sku');
  return { products: products.length, variants: variants.length };
}

export async function syncPrices() {
  const items = USE_API() ? await makitoAll(paths().prices) : records(await feed('MAKITO_PRICES_PATH'), ['product', 'item']);
  const tiers = [];
  for (const p of items) {
    const ref = String(pick(p, F.ref) ?? '').trim();
    // Makito publica tramos como section1/price1, section2/price2... o como <price min="" value="">
    for (let i = 1; i <= 8; i++) {
      const min = p[`section${i}`] ?? p[`min${i}`], price = p[`price${i}`];
      if (min !== undefined && price !== undefined && num(price) > 0) tiers.push({ ref, min_qty: Math.max(1, num(min)), unit_cost: num(price) });
    }
    for (const t of arr(p.prices?.price ?? p.prices ?? p.priceRanges)) tiers.push({ ref, min_qty: num(t.min ?? t.qty), unit_cost: num(t.value ?? t['#text']) });
  }
  await upsert('price_tiers', tiers.filter((t) => t.ref && t.unit_cost > 0), 'ref,min_qty');
  return { tiers: tiers.length };
}

export async function syncStock() {
  const items = USE_API() ? await makitoAll(paths().stock) : records(await feed('MAKITO_STOCK_PATH'), ['product', 'item', 'stock']);
  const rows = items.map((s) => ({ sku: String(pick(s, F.sku) ?? '').trim(), stock: num(pick(s, F.stock)),
    next_arrival: pick(s, F.arrival) || null, updated_at: new Date().toISOString() })).filter((r) => r.sku);
  const { data: known } = await db().from('variants').select('sku');
  const ok = new Set((known || []).map((v) => v.sku));
  const upd = rows.filter((r) => ok.has(r.sku));
  for (const r of upd) await db().from('variants').update(r).eq('sku', r.sku);
  return { stock: upd.length };
}

export async function syncPrint() {
  const items = USE_API() ? await makitoAll(paths().print) : records(await feed('MAKITO_PRINT_PATH'), ['product', 'item']);
  const rows = [];
  for (const p of items) {
    const ref = String(pick(p, F.ref) ?? '').trim();
    for (const t of arr(p.printjobs?.printjob ?? p.techniques?.technique ?? p.techniques ?? p.printing)) {
      rows.push({ ref, technique: t.name ?? t.technique ?? t.teccode, area: t.area ?? t.areaname,
        max_w_mm: num(t.maxwidth ?? t.width) || null, max_h_mm: num(t.maxheight ?? t.height) || null,
        max_colors: num(t.maxcolour ?? t.maxcolors) || 1, setup_cost: num(t.cliche ?? t.setup), unit_cost: num(t.price ?? t.unitprice) });
    }
  }
  const sb = db();
  const refs = [...new Set(rows.map((r) => r.ref))];
  if (refs.length) await sb.from('print_options').delete().in('ref', refs);
  await upsert('print_options', rows, 'id');
  return { print: rows.length };
}

export default async (req) => {
  // Llamada programada (sin cuerpo) o manual protegida por clave
  const manual = req?.headers?.get?.('x-sync-key');
  if (manual !== null && manual !== undefined && manual !== process.env.SYNC_SECRET) return new Response('Forbidden', { status: 403 });
  const full = manual !== null && manual !== undefined ? true : new Date().getUTCHours() === 2; // 03:15 en Madrid (invierno)
  const out = {};
  try {
    if (full) Object.assign(out, await syncCatalog(), await syncPrices(), await syncPrint());
    Object.assign(out, await syncStock());
    console.log('makito-sync', out);
    return new Response(JSON.stringify({ ok: true, ...out }), { headers: { 'content-type': 'application/json' } });
  } catch (e) {
    console.error('makito-sync error', e);
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500 });
  }
};
