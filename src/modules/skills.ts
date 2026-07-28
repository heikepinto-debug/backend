// ============================================================
// Competências (skills)
//
// - Gerir as competências da oficina (dono)
// - Definir as competências de cada trabalhador
// - Ligar a competência exigida a um tipo de serviço
// - Ao atribuir um serviço, listar candidatos com quem SABE
//   fazer primeiro — mas sem proibir os outros.
//
// Encaminha, não tranca. Quem atribui fica no registo.
// ============================================================
import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant, audit, can } from '../lib/core.js'

function guard(perm: string) {
  return async (req: any, reply: any) => {
    try { await req.jwtVerify() } catch { return reply.code(401).send({ error: 'Não autenticado' }) }
    if (!can(req.user.perms, perm)) return reply.code(403).send({ error: 'Sem permissão', needed: perm })
  }
}
// Ler é aberto a quem opera; gerir é do dono.
function auth() {
  return async (req: any, reply: any) => {
    try { await req.jwtVerify() } catch { return reply.code(401).send({ error: 'Não autenticado' }) }
  }
}

export async function skillRoutes(app: FastifyInstance) {

  // ── Lista de competências ─────────────────────────────────
  app.get('/skills', { preHandler: [auth()] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`select id, name, sort_order, active from skills
        where tenant_id = ${req.user.tid} order by sort_order, name`
      return { skills: rows }
    })
  })

  // ── Equipa com as suas competências (para o ecrã de gestão) ─
  app.get('/skills/team', { preHandler: [guard('config:manage')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const users = await tx`
        select u.id, u.full_name,
          coalesce(array_agg(us.skill_id) filter (where us.skill_id is not null), '{}') as skill_ids
        from users u
        left join user_skills us on us.user_id = u.id
        where u.tenant_id = ${req.user.tid} and u.active = true
        group by u.id, u.full_name order by u.full_name`
      return { team: users }
    })
  })

  app.post('/skills', { preHandler: [guard('config:manage')] }, async (req: any, reply) => {
    const b = z.object({ name: z.string().min(1).max(80), sortOrder: z.number().int().default(0) }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    return withTenant(req.user.tid, async (tx) => {
      const [row] = await tx`insert into skills (tenant_id, name, sort_order)
        values (${req.user.tid}, ${b.data.name.trim()}, ${b.data.sortOrder})
        on conflict (tenant_id, name) do nothing
        returning id, name, sort_order, active`
      if (!row) return reply.code(409).send({ error: 'Já existe uma competência com esse nome' })
      await audit(tx, req.user.tid, req.user.sub, 'skill.create', 'skill', row.id, { nome: row.name })
      return reply.send(row)
    })
  })

  app.patch('/skills/:id', { preHandler: [guard('config:manage')] }, async (req: any, reply) => {
    const b = z.object({ name: z.string().min(1).max(80).optional(), sortOrder: z.number().int().optional(),
                         active: z.boolean().optional() }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d = b.data
    return withTenant(req.user.tid, async (tx) => {
      await tx`update skills set
        name = coalesce(${d.name?.trim() ?? null}, name),
        sort_order = coalesce(${d.sortOrder ?? null}, sort_order),
        active = coalesce(${d.active ?? null}, active)
        where id = ${req.params.id} and tenant_id = ${req.user.tid}`
      await audit(tx, req.user.tid, req.user.sub, 'skill.edit', 'skill', req.params.id, d)
      return reply.send({ ok: true })
    })
  })

  // ── Definir as competências de um trabalhador ─────────────
  app.put('/skills/user/:userId', { preHandler: [guard('config:manage')] }, async (req: any, reply) => {
    const b = z.object({ skillIds: z.array(z.string().uuid()) }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const { userId } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const [u] = await tx`select id from users where id = ${userId} and tenant_id = ${req.user.tid}`
      if (!u) return reply.code(404).send({ error: 'Utilizador não encontrado' })
      await tx`delete from user_skills where user_id = ${userId} and tenant_id = ${req.user.tid}`
      for (const sid of b.data.skillIds) {
        await tx`insert into user_skills (tenant_id, user_id, skill_id)
          values (${req.user.tid}, ${userId}, ${sid}) on conflict do nothing`
      }
      await audit(tx, req.user.tid, req.user.sub, 'skill.user_set', 'user', userId, { skills: b.data.skillIds.length })
      return reply.send({ ok: true })
    })
  })

  // ── Ligar competência exigida a um tipo de serviço ────────
  app.patch('/skills/service-type/:id', { preHandler: [guard('config:manage')] }, async (req: any, reply) => {
    const b = z.object({ requiredSkillId: z.string().uuid().nullable() }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    return withTenant(req.user.tid, async (tx) => {
      await tx`update service_types set required_skill_id = ${b.data.requiredSkillId}
        where id = ${req.params.id} and tenant_id = ${req.user.tid}`
      return reply.send({ ok: true })
    })
  })

  // ── Candidatos para atribuir um serviço ───────────────────
  // Devolve a equipa, marcando quem TEM a competência exigida.
  app.get('/skills/candidates/:serviceId', { preHandler: [auth()] }, async (req: any) => {
    const { serviceId } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const [svc] = await tx`
        select s.id, s.type_name, st.required_skill_id, sk.name as skill_name
        from job_services s
        left join service_types st on st.id = s.service_type_id
        left join skills sk on sk.id = st.required_skill_id
        where s.id = ${serviceId} and s.tenant_id = ${req.user.tid}`
      if (!svc) return { candidates: [], requiredSkill: null }

      const team = await tx`
        select u.id, u.full_name,
          case when ${svc.required_skill_id}::uuid is null then true
               when exists (select 1 from user_skills us where us.user_id = u.id and us.skill_id = ${svc.required_skill_id}) then true
               else false end as has_skill
        from users u
        where u.tenant_id = ${req.user.tid} and u.active = true
        order by has_skill desc, u.full_name`
      return { candidates: team, requiredSkill: svc.skill_name || null }
    })
  })
}
