// Cloudflare Pages pasa las variables en context.env; las copiamos a process.env para reutilizar la misma lógica.
export const withEnv = (handler) => async (ctx) => {
  globalThis.process ??= { env: {} };
  globalThis.process.env ??= {};
  for (const [k, v] of Object.entries(ctx.env || {})) if (typeof v === 'string') globalThis.process.env[k] = v;
  try { return await handler(ctx.request, ctx); }
  catch (e) { console.error(e); return Response.json({ error: 'Error interno' }, { status: 500 }); }
};
