// Prueba local de la sincronización:  node --env-file=.env scripts/run-sync.mjs
import { syncCatalog, syncPrices, syncStock, syncPrint } from '../netlify/functions/makito-sync.mjs';
for (const [n, f] of Object.entries({ syncCatalog, syncPrices, syncPrint, syncStock })) {
  try { console.log(n, await f()); } catch (e) { console.error(n, 'ERROR', e.message); }
}
