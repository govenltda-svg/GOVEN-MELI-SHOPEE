// api/auth/ml-refresh.js
// Vercel Serverless Function
// Endpoint: POST /api/auth/ml-refresh
//
// Renova o access_token do ML usando o refresh_token salvo no banco.
// Chamado automaticamente pelo cron (a cada poucas horas) ou manualmente
// pelas rotas de sync, antes de fazer qualquer chamada à API do ML.

import { neon } from '@neondatabase/serverless'

const sql = neon(process.env.DATABASE_URL)

export async function renovarTokenSeNecessario() {
  const rows = await sql`select * from ml_tokens where id = 1`
  if (rows.length === 0) {
    throw new Error('Nenhum token salvo ainda. Faça a autorização inicial via /api/auth/ml-callback')
  }

  const tokenAtual = rows[0]
  const expiraEm = new Date(tokenAtual.expires_at)
  const agora = new Date()
  const margemSeguranca = 10 * 60 * 1000 // renova 10 min antes de expirar

  // Se ainda não está perto de expirar, usa o token atual
  if (expiraEm.getTime() - agora.getTime() > margemSeguranca) {
    return tokenAtual.access_token
  }

  // Sem refresh_token salvo, não há como renovar automaticamente —
  // é necessário reautorizar manualmente via /api/auth/ml-callback
  if (!tokenAtual.refresh_token) {
    throw new Error(
      'Token expirado e não há refresh_token salvo. ' +
      'Reautorize manualmente acessando a URL de autorização do ML novamente.'
    )
  }

  // Renova usando o refresh_token
  const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     process.env.ML_CLIENT_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      refresh_token: tokenAtual.refresh_token,
    }),
  })

  const data = await resp.json()
  if (!resp.ok) {
    throw new Error(`Falha ao renovar token: ${JSON.stringify(data)}`)
  }

  const novoExpiraEm = new Date(Date.now() + data.expires_in * 1000)

  await sql`
    update ml_tokens set
      access_token  = ${data.access_token},
      refresh_token = ${data.refresh_token},
      expires_at    = ${novoExpiraEm.toISOString()},
      atualizado_em = now()
    where id = 1
  `

  return data.access_token
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' })

  const secret = req.headers['x-sync-secret']
  if (secret !== process.env.SYNC_SECRET) return res.status(401).json({ erro: 'Não autorizado' })

  try {
    const token = await renovarTokenSeNecessario()
    return res.status(200).json({ ok: true, mensagem: 'Token válido/renovado', token_preview: token.slice(0, 15) + '...' })
  } catch (e) {
    return res.status(500).json({ ok: false, erro: e.message })
  }
}
