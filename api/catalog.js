// api/catalog.js
// Vercel Serverless Function — Neon (PostgreSQL serverless)
// GET  /api/catalog              → lista todos os SKUs do catálogo
// PUT  /api/catalog              → atualiza custos de um ou mais SKUs (body: array)

import { neon } from '@neondatabase/serverless'

const sql = neon(process.env.DATABASE_URL)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  process.env.DASHBOARD_URL || '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sync-secret')
  if (req.method === 'OPTIONS') return res.status(200).end()

  // ── LISTAR CATÁLOGO ──
  if (req.method === 'GET') {
    try {
      const rows = await sql`
        select sku, nome, canal_origem, cmv, embalagem, frete_fixo,
               anuncio, imposto_pct, devolucao, margem_minima, ativo
        from catalog
        order by nome asc
      `
      return res.status(200).json({ ok: true, catalog: rows })
    } catch (e) {
      return res.status(500).json({ ok: false, erro: e.message })
    }
  }

  // ── ATUALIZAR CUSTOS ──
  if (req.method === 'PUT') {
    const secret = req.headers['x-sync-secret']
    if (secret !== process.env.SYNC_SECRET) return res.status(401).json({ erro: 'Não autorizado' })

    const { items } = req.body || {}
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, erro: 'Body deve conter { items: [...] }' })
    }

    try {
      let atualizados = 0
      for (const item of items) {
        const { sku, cmv, embalagem, frete_fixo, anuncio, imposto_pct, devolucao, margem_minima } = item
        if (!sku) continue

        await sql`
          update catalog set
            cmv           = ${Number(cmv) || 0},
            embalagem     = ${Number(embalagem) || 0},
            frete_fixo    = ${Number(frete_fixo) || 0},
            anuncio       = ${Number(anuncio) || 0},
            imposto_pct   = ${Number(imposto_pct) || 0},
            devolucao     = ${Number(devolucao) || 0},
            margem_minima = ${Number(margem_minima) || 15},
            atualizado_em = now()
          where sku = ${sku}
        `
        atualizados++
      }
      return res.status(200).json({ ok: true, atualizados })
    } catch (e) {
      return res.status(500).json({ ok: false, erro: e.message })
    }
  }

  return res.status(405).json({ erro: 'Método não permitido' })
}
