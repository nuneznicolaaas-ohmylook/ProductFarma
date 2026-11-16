-- ProductFarma · Tienda de productos personalizados conectada a Makito
-- Ejecutar en Supabase > SQL Editor (o como migración).

create extension if not exists pgcrypto;

-- ---------- CATÁLOGO (lo rellena la función makito-sync) ----------
create table if not exists products (
  ref           text primary key,          -- referencia Makito (reftc / ref)
  name          text not null,
  description   text,
  category      text,
  subcategory   text,
  brand         text,
  images        jsonb default '[]',        -- URLs de imagen de Makito
  dims          text,
  material      text,
  active        boolean default true,
  updated_at    timestamptz default now()
);

create table if not exists variants (
  sku         text primary key,            -- ref + color/talla (matnr Makito)
  ref         text references products(ref) on delete cascade,
  color       text,
  color_hex   text,
  size        text,
  image       text,
  stock       integer default 0,
  next_arrival date,
  updated_at  timestamptz default now()
);
create index if not exists variants_ref_idx on variants(ref);

-- Precio de coste Makito por tramos de cantidad
create table if not exists price_tiers (
  ref        text references products(ref) on delete cascade,
  min_qty    integer not null,
  unit_cost  numeric(10,4) not null,       -- coste distribuidor (NUNCA se expone al público)
  primary key (ref, min_qty)
);

-- Técnicas y áreas de marcaje disponibles por producto
create table if not exists print_options (
  id           uuid primary key default gen_random_uuid(),
  ref          text references products(ref) on delete cascade,
  technique    text not null,              -- serigrafía, tampografía, láser, bordado, DTF...
  area         text,                       -- "frontal", "lateral"...
  max_w_mm     numeric, max_h_mm numeric,
  max_colors   integer default 1,
  setup_cost   numeric(10,2) default 0,    -- coste fijo (pantalla/cliché) por color
  unit_cost    numeric(10,4) default 0     -- coste por unidad y color
);
create index if not exists print_options_ref_idx on print_options(ref);

-- ---------- VISTA PÚBLICA (precios con margen, sin costes) ----------
create table if not exists settings (key text primary key, value jsonb);
insert into settings values ('margin', '0.45'::jsonb) on conflict do nothing;      -- +45 %
insert into settings values ('print_margin', '0.35'::jsonb) on conflict do nothing;

create or replace view public_catalog as
select p.ref, p.name, p.description, p.category, p.subcategory, p.images, p.dims, p.material,
  (select jsonb_agg(jsonb_build_object('sku',v.sku,'color',v.color,'hex',v.color_hex,'size',v.size,'image',v.image,'stock',v.stock) order by v.color)
     from variants v where v.ref = p.ref) as variants,
  (select jsonb_agg(jsonb_build_object('min',t.min_qty,'price',
       round(t.unit_cost * (1 + (select (value)::text::numeric from settings where key='margin')), 2)) order by t.min_qty)
     from price_tiers t where t.ref = p.ref) as tiers,
  (select jsonb_agg(jsonb_build_object('technique',o.technique,'area',o.area,'maxColors',o.max_colors,
       'setup', round(o.setup_cost * (1 + (select (value)::text::numeric from settings where key='print_margin')), 2),
       'unit',  round(o.unit_cost  * (1 + (select (value)::text::numeric from settings where key='print_margin')), 4)))
     from print_options o where o.ref = p.ref) as print
from products p where p.active;

-- ---------- PEDIDOS Y PRESUPUESTOS ----------
create table if not exists orders (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('order','quote')),
  status        text not null default 'pending',  -- pending, paid, in_production, shipped, quoted, won, lost
  customer      jsonb not null,                   -- nombre, empresa, CIF, email, teléfono, dirección
  items         jsonb not null,                   -- líneas calculadas en servidor
  subtotal      numeric(10,2), vat numeric(10,2), total numeric(10,2),
  stripe_session text,
  notes         text,
  created_at    timestamptz default now()
);

-- ---------- SEGURIDAD (RLS) ----------
alter table products     enable row level security;
alter table variants     enable row level security;
alter table price_tiers  enable row level security;   -- sin políticas = solo service_role
alter table print_options enable row level security;
alter table orders       enable row level security;   -- sin políticas = solo service_role
alter table settings     enable row level security;

create policy "catálogo visible" on products for select using (active);
create policy "variantes visibles" on variants for select using (true);
-- La vista se ejecuta con permisos del propietario: expone precios de venta, nunca costes.
grant select on public_catalog to anon, authenticated;

-- Bucket privado para logos de clientes (se sube vía función con service_role)
insert into storage.buckets (id, name, public) values ('logos','logos', false) on conflict do nothing;
