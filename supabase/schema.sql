-- ProductFarma · Tienda de productos personalizados conectada a la API B2B de Makito
-- Ejecutar en Supabase > SQL Editor (o como migración).

create extension if not exists pgcrypto;

-- ---------- CATÁLOGO (lo rellena makito-sync) ----------
create table if not exists products (
  ref          text primary key,            -- campo "ref" de /catalog/files
  web_ref      text,
  name         text not null,
  description  text,
  brand        text,
  category     text,
  subcategory  text,
  material     text,
  dims         text,
  print_code   text,
  is_new       boolean default false,
  images       jsonb default '[]',          -- rutas /catalog/assets/... (se sirven por /api/img)
  active       boolean default true,
  updated_at   timestamptz default now()
);

create table if not exists variants (
  sku          text primary key,            -- referencia de variante = "material" de /stock/files
  ref          text references products(ref) on delete cascade,
  color        text,
  color_hex    text,
  size         text,
  image        text,
  stock        integer default 0,
  next_arrival date,
  updated_at   timestamptz default now()
);
create index if not exists variants_ref_idx on variants(ref);

-- Coste de producto por tramos (/price-list/files). NUNCA se expone al público.
create table if not exists price_tiers (
  ref        text references products(ref) on delete cascade,
  min_qty    integer not null,
  unit_cost  numeric(12,5) not null,
  primary key (ref, min_qty)
);

-- Técnicas de marcaje y su coste (/print-price-list/files)
create table if not exists print_techniques (
  id                text primary key,         -- p. ej. 100111
  code              text,
  name              text,
  category          text,
  setup             numeric(10,2) default 0,  -- preparación 1er color
  additional_setup  numeric(10,2) default 0,  -- preparación por color adicional
  tiers             jsonb default '[]',       -- [{min, price, type}] coste por unidad
  updated_at        timestamptz default now()
);

-- Técnicas aplicables a cada producto (/print-config/files)
create table if not exists product_print (
  ref           text references products(ref) on delete cascade,
  technique_id  text references print_techniques(id) on delete cascade,
  label         text,
  description   text,
  area          text, area_name text,
  max_w_mm      numeric, max_h_mm numeric,
  max_colors    integer default 1,
  full_color    boolean default false,
  primary key (ref, technique_id)
);

-- ---------- MÁRGENES ----------
create table if not exists settings (key text primary key, value numeric not null);
insert into settings values ('margin', 0.45), ('print_margin', 0.35) on conflict do nothing;
create or replace function m(k text) returns numeric language sql stable as $$ select value from settings where key = k $$;

-- ---------- VISTA PÚBLICA: precios de venta, nunca costes ----------
create or replace view public_catalog as
select p.ref, p.name, p.description, p.brand, p.category, p.subcategory, p.dims, p.material, p.is_new,
  (select jsonb_agg('/api/img?u=' || x) from jsonb_array_elements_text(p.images) x) as images,
  (select jsonb_agg(jsonb_build_object('sku', v.sku, 'color', v.color, 'hex', v.color_hex, 'size', v.size,
      'image', case when v.image is not null then '/api/img?u=' || v.image end,
      'stock', v.stock, 'next', v.next_arrival) order by v.sku)
     from variants v where v.ref = p.ref) as variants,
  (select jsonb_agg(jsonb_build_object('min', t.min_qty, 'price', round(t.unit_cost * (1 + m('margin')), 3)) order by t.min_qty)
     from price_tiers t where t.ref = p.ref) as tiers,
  (select jsonb_agg(jsonb_build_object('id', pp.technique_id, 'technique', coalesce(pp.label, pt.name), 'area', pp.area_name,
      'maxColors', case when pp.full_color then 1 else pp.max_colors end, 'fullColor', pp.full_color,
      'setup', round(pt.setup * (1 + m('print_margin')), 2),
      'addSetup', round(pt.additional_setup * (1 + m('print_margin')), 2),
      'tiers', (select jsonb_agg(jsonb_build_object('min', (i->>'min')::int, 'price', round((i->>'price')::numeric * (1 + m('print_margin')), 4)) order by (i->>'min')::int)
                from jsonb_array_elements(pt.tiers) i)))
     from product_print pp join print_techniques pt on pt.id = pp.technique_id where pp.ref = p.ref) as print
from products p
where p.active and exists (select 1 from price_tiers t where t.ref = p.ref);

-- Actualización masiva de stock (la llama makito-sync con service_role)
create or replace function apply_stock(payload jsonb) returns integer language plpgsql security definer as $$
declare n integer;
begin
  with s as (select x->>'sku' sku, (x->>'stock')::int stock, nullif(x->>'next_arrival','')::date next_arrival
             from jsonb_array_elements(payload) x)
  update variants v set stock = s.stock, next_arrival = s.next_arrival, updated_at = now() from s where v.sku = s.sku;
  get diagnostics n = row_count; return n;
end $$;
revoke execute on function apply_stock(jsonb) from public, anon, authenticated;

-- ---------- PEDIDOS Y PRESUPUESTOS ----------
create table if not exists orders (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('order','quote')),
  status         text not null default 'pending',  -- pending, paid, won, lost, sent_to_makito
  customer       jsonb not null,
  items          jsonb not null,
  subtotal       numeric(10,2), vat numeric(10,2), total numeric(10,2),
  stripe_session text,
  makito_orders  jsonb default '[]',               -- respuestas de POST /orders (documentNumber, link)
  notes          text,
  created_at     timestamptz default now()
);

-- ---------- SEGURIDAD (RLS) ----------
-- El navegador NO consulta Supabase: todo pasa por /api/* con service_role. Sin políticas = acceso cerrado.
alter table products         enable row level security;
alter table variants         enable row level security;
alter table price_tiers      enable row level security;
alter table print_techniques enable row level security;
alter table product_print    enable row level security;
alter table orders           enable row level security;
alter table settings         enable row level security;
revoke all on public_catalog from anon, authenticated;

insert into storage.buckets (id, name, public) values ('logos', 'logos', false) on conflict do nothing;
