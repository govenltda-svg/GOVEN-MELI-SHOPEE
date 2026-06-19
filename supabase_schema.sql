-- ============================================================
--  GOVEN — Schema Neon (PostgreSQL)
--  Execute no SQL Editor do Neon (console.neon.tech → seu projeto → SQL Editor)
--  Ordem: rode tudo de uma vez, top-down
--  100% compatível com PostgreSQL padrão — nada específico do Supabase usado
-- ============================================================

-- ── 1. CATÁLOGO DE SKU ──────────────────────────────────────
create table if not exists catalog (
  sku           text primary key,
  nome          text not null,
  canal_origem  text not null default 'ml',   -- 'ml' | 'sh' | 'az'
  cmv           numeric(10,2) not null default 0,
  embalagem     numeric(10,2) not null default 0,
  frete_fixo    numeric(10,2) not null default 0,
  anuncio       numeric(10,2) not null default 0,
  imposto_pct   numeric(5,2)  not null default 0,
  devolucao     numeric(10,2) not null default 0,
  margem_minima numeric(5,2)  not null default 15,
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- ── 2. PEDIDOS ───────────────────────────────────────────────
create table if not exists pedidos (
  id              bigserial primary key,
  order_id        text not null,
  canal           text not null,
  sku             text not null references catalog(sku),
  nome_produto    text not null,
  data_pedido     date not null,
  hora_pedido     time,
  status          text not null default 'transito',
  quantidade      int  not null default 1,
  preco_unit      numeric(10,2) not null,
  receita         numeric(10,2) not null,
  taxa_plataforma numeric(10,2) not null default 0,
  cmv_override        numeric(10,2),
  embalagem_override  numeric(10,2),
  frete_override      numeric(10,2),
  anuncio_override    numeric(10,2),
  imposto_override    numeric(5,2),
  devolucao_override  numeric(10,2),
  sincronizado_em timestamptz not null default now(),
  criado_em       timestamptz not null default now(),
  unique (order_id, sku, canal)
);

-- ── 3. LOG DE SINCRONIZAÇÃO ─────────────────────────────────
create table if not exists sync_log (
  id          bigserial primary key,
  canal       text not null,
  status      text not null,
  pedidos_novos   int not null default 0,
  pedidos_total   int not null default 0,
  mensagem    text,
  executado_em timestamptz not null default now()
);

-- ── 4. ÍNDICES ───────────────────────────────────────────────
create index if not exists idx_pedidos_data    on pedidos (data_pedido desc);
create index if not exists idx_pedidos_canal   on pedidos (canal);
create index if not exists idx_pedidos_sku     on pedidos (sku);
create index if not exists idx_pedidos_status  on pedidos (status);
create index if not exists idx_pedidos_order   on pedidos (order_id);

-- ── 5. TRIGGER: atualiza atualizado_em no catálogo ──────────
create or replace function set_atualizado_em()
returns trigger language plpgsql as $$
begin
  new.atualizado_em = now();
  return new;
end;
$$;

drop trigger if exists trg_catalog_atualizado on catalog;
create trigger trg_catalog_atualizado
  before update on catalog
  for each row execute function set_atualizado_em();

-- ── 6. VIEW: resumo por SKU (usada pelo dashboard) ──────────
create or replace view v_resumo_sku as
select
  p.sku,
  p.canal,
  c.nome,
  p.data_pedido,
  p.status,
  sum(p.quantidade)      as qtd,
  sum(p.receita)         as receita,
  sum(p.taxa_plataforma) as taxas,
  sum(coalesce(p.cmv_override,       c.cmv)           * p.quantidade) as custo_cmv,
  sum(coalesce(p.embalagem_override, c.embalagem)     * p.quantidade) as custo_emb,
  sum(coalesce(p.frete_override,     c.frete_fixo)    * p.quantidade) as custo_frete,
  sum(coalesce(p.anuncio_override,   c.anuncio)       * p.quantidade) as custo_anuncio,
  sum(coalesce(p.imposto_override,   c.imposto_pct)/100 * p.receita)  as custo_imposto,
  sum(coalesce(p.devolucao_override, c.devolucao)     * p.quantidade) as custo_devolucao,
  sum(p.receita)
    - sum(p.taxa_plataforma)
    - sum(coalesce(p.cmv_override,       c.cmv)           * p.quantidade)
    - sum(coalesce(p.embalagem_override, c.embalagem)     * p.quantidade)
    - sum(coalesce(p.frete_override,     c.frete_fixo)    * p.quantidade)
    - sum(coalesce(p.anuncio_override,   c.anuncio)       * p.quantidade)
    - sum(coalesce(p.imposto_override,   c.imposto_pct)/100 * p.receita)
    - sum(coalesce(p.devolucao_override, c.devolucao)     * p.quantidade)
  as lucro,
  c.margem_minima
from pedidos p
join catalog c on c.sku = p.sku
where p.status != 'cancelado'
group by p.sku, p.canal, c.nome, p.data_pedido, p.status, c.margem_minima;

-- ── 7. SEGURANÇA ─────────────────────────────────────────────
-- Neon não tem RLS por padrão como o Supabase (sem auth embutido).
-- A proteção aqui é por camada de aplicação: a connection string
-- fica só no backend (Vercel API routes), nunca no frontend.
-- Se quiser RLS mesmo assim, Neon suporta — descomente abaixo:
--
-- alter table catalog enable row level security;
-- alter table pedidos enable row level security;
-- create policy "app_full_access" on pedidos for all using (true);

-- ── 8. DADOS INICIAIS DO CATÁLOGO ───────────────────────────
insert into catalog (sku, nome, canal_origem) values
  ('Kit Pano Teka',   'Kit 06 Panos De Prato Atoalhado Chef Teka Premium', 'ml'),
  ('DYURTRANS1',      'Dyuri Plus – Transimeno',    'ml'),
  ('DYURCOMO1',       'Dyuri Plus – Lago Di Como',  'ml'),
  ('DYURGARTA1',      'Dyuri Plus – Lago Di Garda', 'ml'),
  ('DYURORTA1',       'Dyuri Plus – Lago Di Orta',  'ml'),
  ('DYURTWEED1',      'Dyuri Plus – Tweed',         'ml'),
  ('DYURMADRAS1',     'Dyuri Plus – Madras',        'ml'),
  ('DYUROUTROS',      'Dyuri Plus – Outras cores',  'ml'),
  ('LK7BRONZE',       'King Lk7 Jolitex – Bronze',  'ml'),
  ('LK7CINZA',        'King Lk7 Jolitex – Cinza',   'ml'),
  ('LK7OUTROS',       'King Lk7 – Outras cores',    'ml'),
  ('TEK-PAN-001-SH',  'Kit Pano Teka Chef (Shopee)', 'sh'),
  ('COBERTDYUCAS-SH', 'Dyuri Plus Casal (Shopee)',   'sh')
on conflict (sku) do nothing;
