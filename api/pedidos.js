// api/pedidos.js
// Vercel Serverless Function — Neon (PostgreSQL serverless)
// Endpoint: GET /api/pedidos?de=2026-06-01&ate=2026-06-30&canal=all

import { neon } from '@neondatabase/serverless'

const sql = neon(process.env.DATABASE_URL)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  process.env.DASHBOARD_URL || '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ erro: 'Método não permitido' })

  const { de, ate, canal } = req.query

  if (!de || !ate) {
    return res.status(400).json({ erro: 'Parâmetros "de" e "ate" são obrigatórios (formato YYYY-MM-DD)' })
  }

  try {
    // Neon (driver @neondatabase/serverless) não tem query builder tipo
    // Supabase — usamos SQL puro com template strings (auto-parametrizado,
    // protegido contra SQL injection pelo próprio driver)
    const rows = canal && canal !== 'all'
      ? await sql`
          select
            p.id, p.order_id, p.canal, p.sku, p.nome_produto,
            p.data_pedido, p.hora_pedido, p.status,
            p.quantidade, p.preco_unit, p.receita, p.taxa_plataforma,
            p.cmv_override, p.embalagem_override, p.frete_override,
            p.anuncio_override, p.imposto_override, p.devolucao_override,
            c.nome as catalog_nome, c.cmv, c.embalagem, c.frete_fixo,
            c.anuncio, c.imposto_pct, c.devolucao, c.margem_minima
          from pedidos p
          join catalog c on c.sku = p.sku
          where p.data_pedido >= ${de}
            and p.data_pedido <= ${ate}
            and p.status != 'cancelado'
            and p.canal = ${canal}
          order by p.data_pedido desc, p.hora_pedido desc
        `
      : await sql`
          select
            p.id, p.order_id, p.canal, p.sku, p.nome_produto,
            p.data_pedido, p.hora_pedido, p.status,
            p.quantidade, p.preco_unit, p.receita, p.taxa_plataforma,
            p.cmv_override, p.embalagem_override, p.frete_override,
            p.anuncio_override, p.imposto_override, p.devolucao_override,
            c.nome as catalog_nome, c.cmv, c.embalagem, c.frete_fixo,
            c.anuncio, c.imposto_pct, c.devolucao, c.margem_minima
          from pedidos p
          join catalog c on c.sku = p.sku
          where p.data_pedido >= ${de}
            and p.data_pedido <= ${ate}
            and p.status != 'cancelado'
          order by p.data_pedido desc, p.hora_pedido desc
        `

    // Calcula lucro server-side para consistência
    const pedidos = rows.map(p => {
      const cmv = p.cmv_override        ?? p.cmv
      const emb = p.embalagem_override  ?? p.embalagem
      const frt = p.frete_override      ?? p.frete_fixo
      const anu = p.anuncio_override    ?? p.anuncio
      const imp = p.imposto_override    ?? p.imposto_pct
      const dev = p.devolucao_override  ?? p.devolucao

      const custoTotal =
        (Number(cmv) + Number(emb) + Number(frt) + Number(anu)) * p.quantidade +
        (Number(imp) / 100) * Number(p.receita) +
        Number(dev) * p.quantidade

      const lucro  = Number(p.receita) - Number(p.taxa_plataforma) - custoTotal
      const margem = p.receita > 0 ? (lucro / Number(p.receita)) * 100 : 0

      return {
        id: p.id, order_id: p.order_id, canal: p.canal, sku: p.sku,
        nome_produto: p.nome_produto, data_pedido: p.data_pedido,
        hora_pedido: p.hora_pedido, status: p.status,
        quantidade: p.quantidade, preco_unit: Number(p.preco_unit),
        receita: Number(p.receita), taxa_plataforma: Number(p.taxa_plataforma),
        custos_usados: { cmv: Number(cmv), emb: Number(emb), frt: Number(frt), anu: Number(anu), imp: Number(imp), dev: Number(dev) },
        lucro:         parseFloat(lucro.toFixed(2)),
        margem:        parseFloat(margem.toFixed(2)),
        margem_minima: Number(p.margem_minima),
        alerta_margem: margem < Number(p.margem_minima),
      }
    })

    const totais = pedidos.reduce((acc, p) => ({
      pedidos:    acc.pedidos    + 1,
      receita:    acc.receita    + p.receita,
      taxas:      acc.taxas      + p.taxa_plataforma,
      lucro:      acc.lucro      + p.lucro,
      quantidade: acc.quantidade + p.quantidade,
    }), { pedidos: 0, receita: 0, taxas: 0, lucro: 0, quantidade: 0 })

    totais.margem = totais.receita > 0
      ? parseFloat(((totais.lucro / totais.receita) * 100).toFixed(2))
      : 0

    return res.status(200).json({ ok: true, pedidos, totais })

  } catch (e) {
    return res.status(500).json({ ok: false, erro: e.message })
  }
}
