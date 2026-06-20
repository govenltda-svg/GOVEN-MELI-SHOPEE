// api/cron/sync-all.js
// Vercel Cron Job — configura em vercel.json
// Roda automaticamente todo dia às 06:00 BRT (09:00 UTC)
// Também pode ser chamado manualmente via POST /api/cron/sync-all
//
// Cada chamada às rotas de sync processa só 1 página (até ~8s) e retorna
// "concluido: true/false". Este cron repete a chamada até concluir ou até
// o próprio cron chegar perto do limite de 10s do plano Hobby — o que
// sobrar fica salvo em sync_state e continua automaticamente na PRÓXIMA
// execução do cron (todo dia), sem perder progresso.

export default async function handler(req, res) {
  const authHeader = req.headers['authorization']
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ erro: 'Não autorizado' })
  }

  const inicio = Date.now()
  const LIMIT_TEMPO_CRON_MS = 9000 // margem abaixo do limite de 10s

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000'

  const headers = {
    'Content-Type':   'application/json',
    'x-sync-secret':  process.env.SYNC_SECRET,
  }

  const resultados = { ml: [], sh: [] }

  // Chama a rota ML repetidamente até concluir ou o tempo acabar
  let mlConcluido = false
  while (!mlConcluido && (Date.now() - inicio) < LIMIT_TEMPO_CRON_MS) {
    try {
      const r = await fetch(`${baseUrl}/api/sync/mercadolivre`, { method: 'POST', headers })
      const data = await r.json()
      resultados.ml.push(data)
      mlConcluido = data.concluido !== false // true se concluido=true ou se a rota não suporta paginação parcial
      if (!data.ok) break // erro real, não insiste
    } catch (e) {
      resultados.ml.push({ ok: false, erro: e.message })
      break
    }
  }

  // Shopee só roda se sobrar tempo (e só depois que ela estiver configurada/aprovada)
  if ((Date.now() - inicio) < LIMIT_TEMPO_CRON_MS) {
    try {
      const r = await fetch(`${baseUrl}/api/sync/shopee`, { method: 'POST', headers })
      resultados.sh.push(await r.json())
    } catch (e) {
      resultados.sh.push({ ok: false, erro: e.message })
    }
  } else {
    resultados.sh.push({ ok: false, erro: 'Sem tempo restante nesta execução — tentará no próximo cron' })
  }

  const ultimoML = resultados.ml[resultados.ml.length - 1]
  const ultimoSH = resultados.sh[resultados.sh.length - 1]
  const tudo_ok  = ultimoML?.ok && ultimoSH?.ok

  return res.status(tudo_ok ? 200 : 207).json({
    ok:         tudo_ok,
    executado:  new Date().toISOString(),
    duracao_ms: Date.now() - inicio,
    resultados,
  })
}
