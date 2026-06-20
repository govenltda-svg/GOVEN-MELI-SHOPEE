// api/auth/ml-callback.js
// Vercel Serverless Function
// Endpoint: GET /api/auth/ml-callback?code=XXXX
//
// Esse é o endpoint que recebe o "code" de autorização do Mercado Livre
// e troca ele por um access_token + refresh_token, salvando ambos no banco.
//
// COMO USAR (uma vez, para autorizar):
// 1. Configure esta URL como "Redirect URI" na sua aplicação ML:
//    https://SEU-PROJETO.vercel.app/api/auth/ml-callback
// 2. Abra no navegador:
//    https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=SEU_CLIENT_ID&redirect_uri=https://SEU-PROJETO.vercel.app/api/auth/ml-callback
// 3. Autorize — o ML redireciona pra cá automaticamente com o "code"
// 4. Esta função troca o code por token e salva tudo no banco sozinha
// 5. Você vê uma mensagem de sucesso na tela, sem precisar copiar nada manualmente

import { neon } from '@neondatabase/serverless'

const sql = neon(process.env.DATABASE_URL)

export default async function handler(req, res) {
  const { code, error } = req.query

  if (error) {
    return res.status(400).send(`
      <h2>Erro na autorização</h2>
      <p>O Mercado Livre retornou um erro: <code>${error}</code></p>
    `)
  }

  if (!code) {
    return res.status(400).send(`
      <h2>Código ausente</h2>
      <p>Esta URL precisa ser acessada através do fluxo de autorização do Mercado Livre, não diretamente.</p>
    `)
  }

  try {
    const redirectUri = `https://${req.headers.host}/api/auth/ml-callback`

    // Troca o code pelo access_token + refresh_token
    const tokenResp = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     process.env.ML_CLIENT_ID,
        client_secret: process.env.ML_CLIENT_SECRET,
        code,
        redirect_uri:  redirectUri,
      }),
    })

    const tokenData = await tokenResp.json()

    if (!tokenResp.ok) {
      return res.status(400).send(`
        <h2>Erro ao trocar código por token</h2>
        <pre>${JSON.stringify(tokenData, null, 2)}</pre>
        <p>Isso geralmente acontece se o código expirou (eles duram poucos minutos).
        Gere um novo código e tente de novo.</p>
      `)
    }

    // Alguns tipos de aplicação do ML não emitem refresh_token (ex: aplicações
    // "Server-Side" sem PKCE configurado corretamente). Sem ele, a renovação
    // automática não vai funcionar e será necessário reautorizar manualmente
    // quando o access_token expirar (a cada ~6h).
    const refreshToken = tokenData.refresh_token || null
    const semRefresh = !refreshToken

    // Salva o token no banco — cria a tabela na primeira vez se não existir
    await sql`
      create table if not exists ml_tokens (
        id            int primary key default 1,
        access_token  text not null,
        refresh_token text,
        user_id       text,
        expires_at    timestamptz not null,
        atualizado_em timestamptz not null default now(),
        constraint single_row check (id = 1)
      )
    `
    // Se a tabela já existia de uma tentativa anterior com a constraint antiga
    // (not null em refresh_token), remove essa restrição agora
    await sql`alter table ml_tokens alter column refresh_token drop not null`

    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000)

    await sql`
      insert into ml_tokens (id, access_token, refresh_token, user_id, expires_at, atualizado_em)
      values (1, ${tokenData.access_token}, ${refreshToken}, ${String(tokenData.user_id)}, ${expiresAt.toISOString()}, now())
      on conflict (id) do update set
        access_token  = excluded.access_token,
        refresh_token = excluded.refresh_token,
        user_id       = excluded.user_id,
        expires_at    = excluded.expires_at,
        atualizado_em = now()
    `

    return res.status(200).send(`
      <html>
      <head><meta charset="utf-8"><title>Autorizado!</title></head>
      <body style="font-family:sans-serif; background:#0f1117; color:#e8eaf6; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;">
        <div style="text-align:center; max-width:520px;">
          <h1>✅ Autorizado com sucesso!</h1>
          <p>O token de acesso ao Mercado Livre foi salvo no banco de dados.</p>
          <p style="color:#8b90a7; font-size:0.9rem;">
            Seller ID: <code>${tokenData.user_id}</code><br>
            Expira em: ${expiresAt.toLocaleString('pt-BR')}
          </p>
          ${semRefresh ? `
          <p style="background:#3a2a0f; color:#ffd88a; padding:12px 16px; border-radius:8px; font-size:0.85rem; text-align:left;">
            ⚠️ <strong>Atenção:</strong> o Mercado Livre não devolveu um refresh_token desta vez.
            Isso significa que a renovação automática não vai funcionar — você precisará
            repetir esta autorização manualmente a cada ~6 horas, ou ajustar o tipo da
            aplicação no DevCenter para uma que emita refresh_token (geralmente aplicações
            "Web" com fluxo Authorization Code completo).
          </p>` : `
          <p style="color:#8b90a7; font-size:0.85rem;">(será renovado automaticamente antes de expirar)</p>
          `}
          <p>Pode fechar esta aba e voltar pro chat.</p>
        </div>
      </body>
      </html>
    `)

  } catch (e) {
    return res.status(500).send(`
      <h2>Erro inesperado</h2>
      <pre>${e.message}</pre>
    `)
  }
}
