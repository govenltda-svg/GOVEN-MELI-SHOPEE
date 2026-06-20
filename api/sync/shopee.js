// api/sync/shopee.js
// Vercel Serverless Function — Neon (PostgreSQL serverless)
// Endpoint: POST /api/sync/shopee

import { neon } from '@neondatabase/serverless'

const sql = neon(process.env.DATABASE_URL)

const COMISSAO_SHOPEE = 0.14  // ajuste após conferir extrato real

const STATUS_MAP = {
  COMPLETED:          'concluido',
  SHIPPED:            'transito',
  TO_CONFIRM_RECEIVE: 'transito',
  READY_TO_SHIP:      'enviar',
  UNPAID:             'enviar',
  CANCELLED:          'cancelado',
}

function normalizarSkuShopee(itemSku, itemNome) {
  const s = (itemSku || '').toUpperCase()
  const n = (itemNome || '').toLowerCase()
  if (s === 'COBERTDYUCAS' || n.includes('cobertor')) return 'COBERTDYUCAS-SH'
  if (s === 'TEK-PAN-001'  || n.includes('pano'))     return 'TEK-PAN-001-SH'
  return s || 'SKU_SH_DESCONHECIDO'
}

async function fetchListaShopee(orderStatus, cursor = '') {
  const body = { order_status: orderStatus, page_size: 50, ...(cursor ? { cursor } : {}) }
  const resp = await fetch('https://marketplaces.tiops.com.br/api/shopee/orders/list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.TIOPS_API_KEY}` },
    body: JSON.stringify(body),
  })
  if (!resp.ok) throw new Error(`Shopee list erro ${resp.status}`)
  const data = await resp.json()
  return {
    orderSns:   (data.response?.order_list || []).map(o => o.order_sn),
    nextCursor: data.response?.next_cursor || '',
  }
}

async function fetchDetalhesShopee(orderSns) {
  if (orderSns.length === 0) return []
  const resp = await fetch('https://marketplaces.tiops.com.br/api/shopee/orders/detail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.TIOPS_API_KEY}` },
    body: JSON.stringify({ order_sn_list: orderSns }),
  })
  if (!resp.ok) throw new Error(`Shopee detail erro ${resp.status}`)
  const data = await resp.json()
  return data.response?.order_list || []
}

async function gravarPedidosShopee(orders, statusInterno) {
  let novos = 0
  const skusJaGarantidos = new Set()

  for (const order of orders) {
    if (order.order_status === 'CANCELLED') continue
    const dt         = new Date(order.create_time * 1000)
    const dataPedido = dt.toISOString().slice(0, 10)
    const horaPedido = dt.toTimeString().slice(0, 8)
    const statusFinal = STATUS_MAP[order.order_status] || statusInterno

    for (const item of order.item_list || []) {
      const sku     = normalizarSkuShopee(item.item_sku, item.item_name)
      const qtd     = item.model_quantity_purchased
      const preco   = item.model_discounted_price
      const receita = parseFloat((preco * qtd).toFixed(2))
      const taxa    = parseFloat((receita * COMISSAO_SHOPEE).toFixed(2))

      // Garante que o SKU existe no catálogo antes de inserir o pedido
      if (!skusJaGarantidos.has(sku)) {
        await sql`
          insert into catalog (sku, nome, canal_origem)
          values (${sku}, ${item.item_name.slice(0,200)}, 'sh')
          on conflict (sku) do nothing
        `
        skusJaGarantidos.add(sku)
      }

      await sql`
        insert into pedidos (
          order_id, canal, sku, nome_produto, data_pedido, hora_pedido,
          status, quantidade, preco_unit, receita, taxa_plataforma, sincronizado_em
        ) values (
          ${order.order_sn}, 'sh', ${sku}, ${item.item_name.slice(0,200)}, ${dataPedido}, ${horaPedido},
          ${statusFinal}, ${qtd}, ${preco}, ${receita}, ${taxa}, now()
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

async function sincronizarStatus(statusShopee) {
  let cursor = ''
  let totalNovos = 0
  let iteracoes = 0

  do {
    const { orderSns, nextCursor } = await fetchListaShopee(statusShopee, cursor)
    if (orderSns.length > 0) {
      const detalhes = await fetchDetalhesShopee(orderSns)
      totalNovos += await gravarPedidosShopee(detalhes, STATUS_MAP[statusShopee])
    }
    cursor = nextCursor
    iteracoes++
    if (iteracoes > 40) break
  } while (cursor)

  return totalNovos
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ erro: 'Método não permitido' })
  }

  const secret = req.headers['x-sync-secret'] || req.query.secret
  if (secret !== process.env.SYNC_SECRET) return res.status(401).json({ erro: 'Não autorizado' })

  const inicio = Date.now()
  let totalNovos = 0
  const STATUSES = ['COMPLETED', 'SHIPPED', 'TO_CONFIRM_RECEIVE', 'READY_TO_SHIP']

  try {
    for (const status of STATUSES) {
      totalNovos += await sincronizarStatus(status)
    }

    await sql`
      insert into sync_log (canal, status, pedidos_novos, pedidos_total, mensagem)
      values ('sh', 'ok', ${totalNovos}, ${totalNovos}, ${`Status: ${STATUSES.join(', ')}`})
    `

    return res.status(200).json({ ok: true, pedidos_novos: totalNovos, duracao_ms: Date.now() - inicio })
  } catch (e) {
    await sql`
      insert into sync_log (canal, status, mensagem) values ('sh', 'erro', ${e.message})
    `.catch(() => {})
    return res.status(500).json({ ok: false, erro: e.message })
  }
}
