// Sincronización Makito -> Supabase.
//   node scripts/run-sync.mjs          -> completa (catálogo, precios, marcaje y stock)
//   node scripts/run-sync.mjs stock    -> solo stock
// En local: node --env-file=.env scripts/run-sync.mjs
import { syncCatalog, syncPrices, syncPrint, syncStock } from '../lib/sync.mjs';
const steps = process.argv[2] === 'stock' ? { syncStock } : { syncCatalog, syncPrices, syncPrint, syncStock };
let failed = false;
for (const [name, fn] of Object.entries(steps)) {
  try { console.log(name, JSON.stringify(await fn())); }
  catch (e) { failed = true; console.error(name, 'ERROR', e.message); }
}
process.exit(failed ? 1 : 0);
