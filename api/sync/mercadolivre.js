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
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' })

  const secret = req.headers['x-sync-secret']
  if (secret !== process.env.SYNC_SECRET) return res.status(401).json({ erro: 'Não autorizado' })

  const inicio = Date.now()
  let totalNovos = 0
  let totalProcessados = 0

  try {
    // Renova o token automaticamente se necessário, e busca o seller_id salvo
    const accessToken = await renovarTokenSeNecessario()
    const tokenRow     = await sql`select user_id from ml_tokens where id = 1`
    const sellerId     = tokenRow[0]?.user_id

    if (!sellerId) throw new Error('seller_id não encontrado — refaça a autorização inicial')

    const LIMIT = 50
    let offset = 0
    let totalAPI = Infinity

    while (offset < totalAPI) {
      const { orders, total } = await fetchPaginaML(LIMIT, offset, accessToken, sellerId)
      totalAPI = total

      const novos = await gravarPedidos(orders)
      totalNovos       += novos
      totalProcessados += orders.length
      offset           += LIMIT

      if (offset > 2000) break // segurança
    }

    await sql`
      insert into sync_log (canal, status, pedidos_novos, pedidos_total, mensagem)
      values ('ml', 'ok', ${totalNovos}, ${totalProcessados}, ${`Paginação completa: ${Math.ceil(totalAPI / LIMIT)} páginas`})
    `

    return res.status(200).json({
      ok: true, pedidos_novos: totalNovos, pedidos_total: totalProcessados,
      total_api: totalAPI, duracao_ms: Date.now() - inicio,
    })

  } catch (e) {
    await sql`
      insert into sync_log (canal, status, mensagem)
      values ('ml', 'erro', ${e.message})
    `.catch(() => {})
    return res.status(500).json({ ok: false, erro: e.message })
  }
}
