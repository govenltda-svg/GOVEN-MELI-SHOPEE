// api/cron/sync-all.js
// Vercel Cron Job — configura em vercel.json
// Roda automaticamente todo dia às 06:00 BRT (09:00 UTC)
// Também pode ser chamado manualmente via POST /api/cron/sync-all
//
// ATENÇÃO: no plano Hobby (gratuito) da Vercel, toda função serverless
// tem limite de 10s de execução. Como este endpoint chama duas outras
// rotas (ML + Shopee) que paginam muitos pedidos, ele pode estourar esse
// limite se o catálogo crescer muito. Nesse caso, é necessário plano Pro
// (limite de até 300s) ou dividir a sincronização em duas rotas separadas
// chamadas pelo cron em horários diferentes.

export default async function handler(req, res) {
  // Vercel Cron envia header Authorization com o cron secret
  const authHeader = req.headers['authorization']
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ erro: 'Não autorizado' })
  }

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000'

  const headers = {
    'Content-Type':    'application/json',
    'x-sync-secret':  process.env.SYNC_SECRET,
  }

  const resultados = {}

  // Sincroniza ML
  try {
    const r = await fetch(`${baseUrl}/api/sync/mercadolivre`, { method: 'POST', headers })
    resultados.ml = await r.json()
  } catch (e) {
    resultados.ml = { ok: false, erro: e.message }
  }

  // Sincroniza Shopee
  try {
    const r = await fetch(`${baseUrl}/api/sync/shopee`, { method: 'POST', headers })
    resultados.sh = await r.json()
  } catch (e) {
    resultados.sh = { ok: false, erro: e.message }
  }

  const tudo_ok = resultados.ml?.ok && resultados.sh?.ok

  return res.status(tudo_ok ? 200 : 207).json({
    ok:         tudo_ok,
    executado:  new Date().toISOString(),
    resultados,
  })
}
