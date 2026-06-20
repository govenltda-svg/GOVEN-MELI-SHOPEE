// api/sync/mercadolivre.js
// Vercel Serverless Function — agora usando Neon (PostgreSQL serverless)
// Endpoint: POST /api/sync/mercadolivre

import { neon } from '@neondatabase/serverless'
import { renovarTokenSeNecessario } from '../auth/ml-refresh.js'

const sql = neon(process.env.DATABASE_URL)

// ── Normaliza título do produto para SKU canônico ────────────
function normalizarSku(titulo) {
  const t = titulo.toLowerCase()
  if (t.includes('pano') || t.includes('teka'))       return 'Kit Pano Teka'
  if (t.includes('transimeno'))                        return 'DYURTRANS1'
  if (t.includes('lago di como'))                      return 'DYURCOMO1'
  if (t.includes('lago di garda'))                     return 'DYURGARTA1'
  if (t.includes('lago di orta'))                      return 'DYURORTA1'
  if (t.includes('tweed'))                             return 'DYURTWEED1'
  if (t.includes('madras'))                            return 'DYURMADRAS1'
  if (t.includes('lk7') && t.includes('bronze'))      return 'LK7BRONZE'
  if (t.includes('lk7') && t.includes('cinza'))       return 'LK7CINZA'
  if (t.includes('lk7'))                               return 'LK7OUTROS'
  if (t.includes('cobertor') || t.includes('dyuri'))  return 'DYUROUTROS'
  return 'SKU_DESCONHECIDO'
}

function normalizarStatus(status) {
  const map = { paid: 'transito', delivered: 'concluido', cancelled: 'cancelado', pending: 'enviar' }
  return map[status] || 'transito'
}

async function fetchPaginaML(limit, offset, accessToken, sellerId) {
  const resp = await fetch(
    `https://api.mercadolibre.com/orders/search?seller=${sellerId}&sort=date_desc&limit=${limit}&offset=${offset}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!resp.ok) throw new Error(`ML API erro ${resp.status}: ${await resp.text()}`)
  const data = await resp.json()
  return { orders: data.results || [], total: data.paging?.total || 0 }
}

// ── Grava pedidos via UPSERT em SQL puro (Neon não tem .upsert() pronto) ──
async function gravarPedidos(orders) {
  let novos = 0
  const skusJaGarantidos = new Set() // evita repetir o insert no catálogo pro mesmo SKU

  for (const order of orders) {
    if (order.status === 'cancelled') continue

    const dataPedido = order.date_created.slice(0, 10)
    const horaPedido = order.date_created.slice(11, 19)
    const status     = normalizarStatus(order.status)

    for (const item of order.order_items || []) {
      const titulo  = item.item.title
      const sku     = normalizarSku(titulo)
      const qtd     = item.quantity
      const preco   = item.unit_price
      const taxa    = item.sale_fee || 0
      const receita = parseFloat((preco * qtd).toFixed(2))
      const taxaTot = parseFloat((taxa * qtd).toFixed(2))

      // Garante que o SKU existe no catálogo antes de inserir o pedido
      // (evita erro de foreign key se for um produto novo/não mapeado)
      if (!skusJaGarantidos.has(sku)) {
        await sql`
          insert into catalog (sku, nome, canal_origem)
          values (${sku}, ${titulo.slice(0,200)}, 'ml')
          on conflict (sku) do nothing
        `
        skusJaGarantidos.add(sku)
      }

      // ON CONFLICT faz o papel do upsert do Supabase
      await sql`
        insert into pedidos (
          order_id, canal, sku, nome_produto, data_pedido, hora_pedido,
          status, quantidade, preco_unit, receita, taxa_plataforma, sincronizado_em
        ) values (
          ${String(order.id)}, 'ml', ${sku}, ${titulo.slice(0,200)}, ${dataPedido}, ${horaPedido},
          ${status}, ${qtd}, ${preco}, ${receita}, ${taxaTot}, now()
        )
        on conflict (order_id, sku, canal)
        do update set
          status          = excluded.status,
          quantidade      = excluded.quantidade,
          receita         = excluded.receita,
          taxa_plataforma = excluded.taxa_plataforma,
          sincronizado_em = now()
      `
      novos++
    }
  }
  return novos
}

export default async function handler(req, res) {
  // Aceita POST (uso programático, com header) ou GET (uso manual, com
  // ?secret=... na URL — só para facilitar testes pelo navegador)
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ erro: 'Método não permitido' })
  }

  const secret = req.headers['x-sync-secret'] || req.query.secret
  if (secret !== process.env.SYNC_SECRET) return res.status(401).json({ erro: 'Não autorizado' })

  const inicio = Date.now()
  const LIMIT_TEMPO_MS = 8000 // margem de segurança abaixo do limite de 10s do plano Hobby
  const PAGE_SIZE = 50

  try {
    // Tabela de controle de progresso — permite retomar de onde parou
    await sql`
      create table if not exists sync_state (
        canal  text primary key,
        offset_atual int not null default 0,
        total_api    int,
        atualizado_em timestamptz not null default now()
      )
    `

    // Renova o token automaticamente se necessário, e busca o seller_id salvo
    const accessToken = await renovarTokenSeNecessario()
    const tokenRow     = await sql`select user_id from ml_tokens where id = 1`
    const sellerId     = tokenRow[0]?.user_id
    if (!sellerId) throw new Error('seller_id não encontrado — refaça a autorização inicial')

    // Recupera o progresso salvo (ou começa do zero)
    const estadoRows = await sql`select * from sync_state where canal = 'ml'`
    let offset   = estadoRows[0]?.offset_atual ?? 0
    let totalAPI = estadoRows[0]?.total_api ?? Infinity

    let totalNovos = 0
    let totalProcessados = 0
    let paginasNestaExecucao = 0

    // Processa páginas até estourar o tempo seguro ou terminar tudo
    while (offset < totalAPI && (Date.now() - inicio) < LIMIT_TEMPO_MS) {
      const { orders, total } = await fetchPaginaML(PAGE_SIZE, offset, accessToken, sellerId)
      totalAPI = total

      const novos = await gravarPedidos(orders)
      totalNovos       += novos
      totalProcessados += orders.length
      offset           += PAGE_SIZE
      paginasNestaExecucao++

      // Se a API não retornou mais nada, considera concluído mesmo que offset < total
      if (orders.length === 0) break
    }

    const concluido = offset >= totalAPI

    // Salva o progresso (zera quando concluído, para recomeçar do zero na próxima sync completa)
    await sql`
      insert into sync_state (canal, offset_atual, total_api, atualizado_em)
      values ('ml', ${concluido ? 0 : offset}, ${totalAPI}, now())
      on conflict (canal) do update set
        offset_atual  = excluded.offset_atual,
        total_api     = excluded.total_api,
        atualizado_em = now()
    `

    await sql`
      insert into sync_log (canal, status, pedidos_novos, pedidos_total, mensagem)
      values ('ml', 'ok', ${totalNovos}, ${totalProcessados},
        ${concluido
          ? `Sincronização completa: ${paginasNestaExecucao} página(s) nesta chamada`
          : `Parcial: parou em offset ${offset}/${totalAPI} (tempo esgotado) — próxima chamada continua daqui`})
    `

    return res.status(200).json({
      ok: true,
      concluido,
      pedidos_novos: totalNovos,
      pedidos_processados_nesta_chamada: totalProcessados,
      offset_atual: concluido ? 0 : offset,
      total_api: totalAPI,
      paginas_nesta_execucao: paginasNestaExecucao,
      duracao_ms: Date.now() - inicio,
      aviso: concluido
        ? null
        : 'Sincronização parcial — chame este endpoint de novo para continuar de onde parou.',
    })

  } catch (e) {
    await sql`
      insert into sync_log (canal, status, mensagem)
      values ('ml', 'erro', ${e.message})
    `.catch(() => {})
    return res.status(500).json({ ok: false, erro: e.message })
  }
}
