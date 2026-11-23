// ============================================================
// OFICINAHUB — Rotas de autenticação
// Login devolve tokens + branding do tenant (white-label)
// ============================================================
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, sql, bcrypt, forgetSession } from '../lib/core.js'

export async function authRoutes(app: FastifyInstance) {

  // POST /auth/login — devolve tokens + tudo o que o frontend precisa
  app.post('/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const body = z.object({
      email: z.string().email(),
      password: z.string().min(1),
    }).safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' })

    const auth = await authenticate(body.data.email, body.data.password)
    if (!auth) return reply.code(401).send({ error: 'Email ou password incorrectos' })

    const payload = {
      sub: auth.user.id, tid: auth.tenant.id,
      perms: auth.perms, name: auth.user.name, ep: auth.epoch,
    }
    const accessToken = app.jwt.sign(payload, { expiresIn: process.env.JWT_EXPIRES || '8h' })
    const refreshToken = app.jwt.sign(
      { sub: auth.user.id, typ: 'refresh' },
      { expiresIn: process.env.JWT_REFRESH_EXPIRES || '7d' }
    )

    return reply.send({
      accessToken, refreshToken,
      user: auth.user,
      mustChangePassword: auth.mustChangePassword,
      roles: auth.roles,
      permissions: auth.perms,
      tenant: auth.tenant,     // nome, logo, cores, módulos → white-label
    })
  })

  // POST /auth/refresh
  app.post('/auth/refresh', async (req, reply) => {
    const body = z.object({ refreshToken: z.string() }).safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' })
    try {
      const dec = app.jwt.verify(body.data.refreshToken) as { sub: string; typ: string; iat?: number }
      if (dec.typ !== 'refresh') throw new Error()
      const [u] = await sql`
        select u.id, u.tenant_id, u.full_name, u.active, u.session_epoch, u.sessions_valid_from, t.active as tenant_active
        from users u join tenants t on t.id = u.tenant_id where u.id = ${dec.sub}`
      if (!u?.active || !u.tenant_active) return reply.code(401).send({ error: 'Sessão inválida' })
      // Senha redefinida pelo dono (ou acesso reactivado): as sessões anteriores deixam de valer.
      if (u.sessions_valid_from && (dec.iat || 0) * 1000 < new Date(u.sessions_valid_from).getTime())
        return reply.code(401).send({ error: 'Sessão terminada — entra de novo' })
      const roles = await sql`
        select r.code, r.permissions from user_roles ur join roles r on r.id = ur.role_id
        where ur.user_id = ${u.id}`
      const perms = [...new Set(roles.flatMap((r: any) => r.permissions))]
      const accessToken = app.jwt.sign(
        { sub: u.id, tid: u.tenant_id, perms, name: u.full_name, ep: Number(u.session_epoch || 0) },
        { expiresIn: process.env.JWT_EXPIRES || '8h' }
      )
      return reply.send({ accessToken, permissions: perms, roles: roles.map((r: any) => r.code) })
    } catch {
      return reply.code(401).send({ error: 'Sessão expirada — faz login novamente' })
    }
  })

  // POST /auth/change-password (autenticado)
  app.post('/auth/change-password', { preHandler: [(app as any).auth] }, async (req: any, reply) => {
    const body = z.object({
      current: z.string().min(1),
      next: z.string().min(8, 'Mínimo 8 caracteres'),
    }).safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'Password nova: mínimo 8 caracteres' })

    const [u] = await sql`select password_hash from users where id = ${req.user.sub}`
    if (!await bcrypt.compare(body.data.current, u.password_hash))
      return reply.code(400).send({ error: 'Password actual incorrecta' })

    const hash = await bcrypt.hash(body.data.next, 12)
    await sql`update users set password_hash = ${hash}, must_change_password = false where id = ${req.user.sub}`
    forgetSession(req.user.sub)
    return reply.send({ ok: true })
  })
}
