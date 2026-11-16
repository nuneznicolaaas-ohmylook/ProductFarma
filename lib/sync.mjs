// Sincronización Makito -> Supabase (se ejecuta en GitHub Actions, ver .github/workflows/makito-sync.yml)
// Son 6 peticiones por sincronización completa: muy por debajo del límite de Makito (25/min).
import { db } from './core.mjs';
import { getCatalog, getStock, getPriceList, getPrintPrices, getPrintConfig } from './makito.mjs';

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const num = (x) => Number(String(x ?? '').replace(',', '.')) || 0;
const pick = (o, ks) => { for (const k of ks) if (o?.[k] !== undefined && o[k] !== '' && o[k] !== null) return o[k]; };
const now = () => new Date().toISOString();
// ---- Filtro de catálogo: productos de FARMACIA + básicos de merchandising ----
// (totebags y bolsas, camisetas, agendas y libretas, bolígrafos y escritura)
// Se puede ampliar sin tocar código con PHARMA_INCLUDE / PHARMA_EXCLUDE (palabras separadas por comas)
// y forzar referencias concretas con PHARMA_REFS (p. ej. "11011,15246").
const norm = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const INCLUDE = [
  'pastillero', 'pildora', 'botiquin', 'primeros auxilios', 'tirita', 'apósito', 'aposito', 'mascarilla', 'gel hidroalcoholico',
  'higienizante', 'desinfect', 'antibacteria', 'termometro', 'neceser', 'cosmetic', 'cosmetica', 'aseo', 'manicura',
  'lima de uñas', 'lima de unas', 'espejo', 'balsamo', 'labial', 'protector solar', 'crema', 'toallita', 'pañuelo', 'panuelo',
  'cepillo de dientes', 'dental', 'salud', 'bienestar', 'relax', 'masaje', 'antiestres', 'anti estres', 'cuidado personal',
  'farmacia', 'bolsa papel', 'bolsa de papel', 'bolsa farmacia', 'dispensador', 'pulsera repelente', 'antimosquito',
  'repelente', 'tapones', 'antifaz', 'bolsa termica', 'gel frio', 'frio-calor', 'frio calor', 'cuentagotas', 'pastilla',
  'kit de viaje', 'viaje aseo', 'spray', 'atomizador', 'perfumero', 'jabon', 'sanitizer', 'first aid', 'pill',
  // Básicos de merchandising
  'tote', 'bolsa', 'camiseta', 't-shirt', 'agenda', 'libreta', 'cuaderno', 'bloc', 'notas adhesivas', 'boligrafo',
  'lapiz', 'portaminas', 'rotulador', 'marcador', 'subrayador',
];
const EXCLUDE = ['bolsa de deporte', 'bolsa nevera', 'nevera', 'bolsa de playa', 'bolsa para botellas', 'botellero', 'cerveza', 'vino', 'cocktail', 'coctel', 'cigarr', 'mechero', 'encendedor', 'cuchillo', 'navaja', 'bebida alcoh', 'abrebotellas'];
const list = (k, d) => (process.env[k] ? process.env[k].split(',').map((x) => norm(x.trim())).filter(Boolean) : []).concat(d.map(norm));
export function isPharma(p, cats) {
  const forced = (process.env.PHARMA_REFS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (forced.includes(String(p.ref))) return true;
  const txt = norm([p.name, p.description, ...cats].join(' '));
  if (list('PHARMA_EXCLUDE', EXCLUDE).some((w) => txt.includes(w))) return false;
  return list('PHARMA_INCLUDE', INCLUDE).some((w) => txt.includes(w));
}
// Categoría de la tienda (la de Makito no está pensada para farmacia)
const SECTIONS = [
  ['Botiquín y salud', ['botiquin', 'primeros auxilios', 'tirita', 'aposito', 'termometro', 'mascarilla', 'pastillero', 'pildora', 'pill', 'first aid', 'gel frio', 'frio-calor', 'frio calor']],
  ['Higiene', ['gel hidroalcoholico', 'higienizante', 'desinfect', 'antibacteria', 'toallita', 'panuelo', 'jabon', 'dispensador', 'sanitizer', 'dental', 'cepillo de dientes']],
  ['Cuidado personal', ['neceser', 'cosmetic', 'manicura', 'lima de', 'espejo', 'balsamo', 'labial', 'protector solar', 'crema', 'atomizador', 'perfumero']],
  ['Bienestar', ['relax', 'masaje', 'antiestres', 'anti estres', 'antifaz', 'tapones', 'bienestar']],
  ['Verano', ['repelente', 'antimosquito', 'bolsa termica', 'solar']],
  ['Textil', ['camiseta', 't-shirt']],
  ['Escritura y oficina', ['boligrafo', 'lapiz', 'portaminas', 'rotulador', 'marcador', 'subrayador', 'agenda', 'libreta', 'cuaderno', 'bloc', 'notas adhesivas']],
  ['Bolsas', ['tote', 'bolsa', 'farmacia']],
];
export const sectionOf = (p, cats) => { const t = norm([p.name, ...cats].join(' ')); return (SECTIONS.find(([, ws]) => ws.some((w) => t.includes(w))) || ['Otros'])[0]; };

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
    const pharma = isPharma(p, cats);
    P.push({ ref, web_ref: p.web_reference ?? null, name: p.name, description: p.description, brand: p.brand ?? null,
      category: sectionOf(p, cats), subcategory: cats[0] ?? null, material: p.material ?? null,
      dims: dims.length ? dims.join(' × ') + ' cm' : (num(p.diameter) ? `Ø${mm(p.diameter)} cm` : null),
      print_code: p.printcode ?? null, is_new: !!p.web_new,
      images: [p.image, ...arr(p.images)].filter(Boolean).map((i) => (typeof i === 'object' ? i.url ?? i.image : i)),
      active: pharma, updated_at: now() });
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
  return { products: P.length, pharmaActive: P.filter((x) => x.active).length, variants: V.length };
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

