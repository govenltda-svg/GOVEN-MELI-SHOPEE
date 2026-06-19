# Goven — Deploy no Neon + Vercel

## Passo a passo (20 minutos)

---

### 1. Neon (banco de dados)

1. Acesse [neon.tech](https://neon.tech) → **Create a project**
2. Nome do projeto: `goven` | Região: escolha a mais próxima (ex: `AWS South America - São Paulo`, se disponível, senão `US East`)
3. Aguarde o projeto iniciar (~10 seg — Neon é instantâneo)
4. Vá em **SQL Editor** (menu lateral) → cole todo o conteúdo de `supabase_schema.sql` → **Run**
5. Confirme que as tabelas aparecem em **Tables**: `catalog`, `pedidos`, `sync_log`
6. Vá em **Connection Details** (no Dashboard do projeto) e copie a **Pooled connection string**:
   - Algo como `postgresql://usuario:senha@ep-xxxx-pooler.sa-east-1.aws.neon.tech/goven?sslmode=require`
   - Essa é sua `DATABASE_URL` — guarde, é a única variável de banco que você precisa

> **Por que "Pooled connection"?** Funções serverless da Vercel abrem e fecham conexões constantemente.
> A connection pooled do Neon evita esgotar o limite de conexões simultâneas do Postgres.

---

### 2. Vercel (hospedagem + API)

1. Acesse [vercel.com](https://vercel.com) → **Add New Project**
2. Conecte ao GitHub e faça upload desta pasta (ou crie um repositório)
3. Em **Environment Variables**, adicione:
   - `DATABASE_URL` → a connection string do Neon
   - `ML_SELLER_ID`
   - `ML_ACCESS_TOKEN`
   - `TIOPS_API_KEY`
   - `SYNC_SECRET` → gere com `openssl rand -hex 32`
   - `DASHBOARD_URL` → ex: `https://goven.vercel.app`
4. Clique em **Deploy**

> **Dica:** a Vercel tem uma integração nativa com Neon (marketplace de integrações).
> Se preferir, em vez de copiar a string manualmente, você pode clicar em
> **Storage → Connect Database → Neon** dentro do próprio painel da Vercel,
> e ele preenche o `DATABASE_URL` sozinho.

---

### 3. Primeira sincronização manual

```bash
curl -X POST https://goven.vercel.app/api/sync/mercadolivre \
  -H "x-sync-secret: SEU_SYNC_SECRET"

curl -X POST https://goven.vercel.app/api/sync/shopee \
  -H "x-sync-secret: SEU_SYNC_SECRET"
```

Ou clique no botão **Sincronizar** do dashboard.

---

### 4. Cron automático

O `vercel.json` já configura sincronização automática todo dia às **06:00 BRT (09:00 UTC)**.
Verifique em Vercel → seu projeto → **Settings → Cron Jobs**.

---

### 5. Atualizar o token do ML

O `ML_ACCESS_TOKEN` expira a cada 6 horas. Renove manualmente em
developers.mercadolivre.com.br quando o sync falhar, ou implemente
refresh automático via `refresh_token` (próximo passo de evolução).

---

### 6. Como me ajudar a manter os dados atualizados

Com Vercel + Neon no ar, me passe:
- A URL da sua API: `https://goven.vercel.app`
- O `SYNC_SECRET`

E eu consigo chamar `/api/sync/mercadolivre`, `/api/sync/shopee` e
consultar `/api/pedidos` diretamente — sem precisar reescrever HTML.

---

### Estrutura de arquivos

```
goven/
├── api/
│   ├── pedidos.js              ← leitura pelo dashboard (SQL puro via Neon)
│   ├── sync/
│   │   ├── mercadolivre.js     ← sincroniza ML (paginação completa)
│   │   └── shopee.js           ← sincroniza Shopee (todos os status)
│   └── cron/
│       └── sync-all.js         ← executado automaticamente todo dia
├── supabase_schema.sql         ← rode uma vez no SQL Editor do Neon
├── vercel.json                 ← cron jobs e configurações
├── .env.example                ← variáveis necessárias
└── README.md                   ← este arquivo
```

---

### O que mudou do Supabase para o Neon

| Antes (Supabase) | Agora (Neon) |
|---|---|
| `@supabase/supabase-js` | `@neondatabase/serverless` |
| `.from('pedidos').upsert(...)` | SQL puro com `ON CONFLICT ... DO UPDATE` |
| 3 chaves (`URL`, `anon`, `service_role`) | 1 única `DATABASE_URL` |
| RLS (Row Level Security) por padrão | Proteção via camada de aplicação (connection string só no backend) |
| ~500MB grátis com vários limites (auth, storage, realtime) | 0.5GB grátis, focado só em banco — sem outros limites colidindo |

O schema SQL é idêntico — Neon é PostgreSQL puro, sem extensões proprietárias do Supabase.
