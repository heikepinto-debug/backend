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

const app = Fastify({ logger: { level: process.env.NODE_ENV === 'production' ? 'warn' : 'info' } })

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

app.get('/health', async () => ({ ok: true, product: 'OficinaHub', version: '1.0.0' }))

const port = Number(process.env.PORT) || 3000
await app.listen({ port, host: '0.0.0.0' })
console.log(`\n⚙  OficinaHub API — porta ${port}\n`)
