// ============================================================
// Novidades (changelog do produto)
//
// - GET  /updates          → tudo, para a página de novidades
// - GET  /updates/unseen   → só o que saiu desde a última vez que
//                            este utilizador viu (para o popup)
// - POST /updates/seen     → marca como visto até agora
//
// A tabela é global (do produto). O "até onde vi" é por utilizador.
// ============================================================
import { FastifyInstance } from 'fastify'
import { withTenant } from '../lib/core.js'

const MAX_POPUP = 8   // não inundar quem esteve muito tempo fora

export async function updateRoutes(app: FastifyInstance) {

  const guard = () => async (req: any, reply: any) => {
    try { await req.jwtVerify() } catch { return reply.code(401).send({ error: 'Não autenticado' }) }
  }

  // Lista completa — página de novidades.
  app.get('/updates', { preHandler: [guard()] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`
        select version, released_at, title, items
        from app_updates order by released_at desc limit 100`
      return { updates: rows }
    })
  })

  // Só o que este utilizador ainda não viu — alimenta o popup.
  app.get('/updates/unseen', { preHandler: [guard()] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const [u] = await tx`select updates_seen_at from users where id = ${req.user.sub}`
      const desde = u?.updates_seen_at ?? null
      const rows = desde
        ? await tx`select version, released_at, title, items from app_updates
                   where released_at > ${desde} order by released_at desc limit ${MAX_POPUP}`
        : await tx`select version, released_at, title, items from app_updates
                   order by released_at desc limit ${MAX_POPUP}`
      return { updates: rows, primeiraVez: !desde }
    })
  })

  // Marca tudo como visto até agora.
  app.post('/updates/seen', { preHandler: [guard()] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      await tx`update users set updates_seen_at = now() where id = ${req.user.sub}`
      return { ok: true }
    })
  })
}
