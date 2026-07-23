// ============================================================
// OFICINAHUB API — servidor
// ============================================================
import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import { authRoutes } from './modules/auth.js'
import { receptionRoutes } from './modules/reception.js'
import { taskRoutes } from './modules/tasks.js'
import { osRoutes } from './modules/os.js'
import { serviceTypeRoutes } from './modules/service-types.js'
import { ppiRoutes } from './modules/ppi.js'
import { updateRoutes } from './modules/updates.js'
import { sql } from './lib/core.js'

const app = Fastify({ logger: { level: process.env.NODE_ENV === 'production' ? 'warn' : 'info' } })

// Handler global de erros: devolve a mensagem real (não o stack) e regista
// o erro na tabela error_logs, para diagnóstico remoto de outras oficinas.
app.setErrorHandler(async (error, req, reply) => {
  app.log.error(error)
  const status = (error as any).statusCode && (error as any).statusCode >= 400 ? (error as any).statusCode : 500

  // Regista só erros de servidor (500+); os 4xx são do cliente e não interessam.
  if (status >= 500) {
    try {
      const u: any = (req as any).user || {}
      // rota sem query string (evita vazar dados sensíveis nos parâmetros)
      const route = (req.url || '').split('?')[0]
      // Versão do cliente: sem isto não se sabe que código gerou o erro,
      // e um telemóvel preso numa versão antiga passa despercebido.
      const appVer = String((req.headers as any)['x-app-version'] || '').slice(0, 40) || null
      await sql`
        insert into error_logs (tenant_id, user_id, method, route, status_code, message, error_code, app_version)
        values (${u.tid || null}, ${u.sub || null}, ${req.method || null}, ${route || null},
                ${status}, ${(error.message || '').slice(0, 500)}, ${(error as any).code || null}, ${appVer})`
    } catch { /* nunca deixar o logging rebentar a resposta */ }
  }

  reply.code(status).send({ error: error.message || 'Erro interno', code: (error as any).code })
})

await app.register(cors, {
  origin: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(','),
  credentials: true,
})
await app.register(jwt, { secret: process.env.JWT_SECRET! })
await app.register(rateLimit, { max: 300, timeWindow: '1 minute' })

app.decorate('auth', async (req: any, reply: any) => {
  try { await req.jwtVerify() } catch { reply.code(401).send({ error: 'Não autenticado' }) }
})

await app.register(authRoutes)
await app.register(receptionRoutes, { prefix: '/api/v1' })
await app.register(taskRoutes, { prefix: '/api/v1' })
await app.register(osRoutes, { prefix: '/api/v1' })
await app.register(serviceTypeRoutes, { prefix: '/api/v1' })
await app.register(ppiRoutes, { prefix: '/api/v1' })
await app.register(updateRoutes, { prefix: '/api/v1' })

app.get('/health', async () => ({ ok: true, product: 'OficinaHub', version: '1.0.0' }))

const port = Number(process.env.PORT) || 3000
await app.listen({ port, host: '0.0.0.0' })
console.log(`\n⚙  OficinaHub API — porta ${port}\n`)
