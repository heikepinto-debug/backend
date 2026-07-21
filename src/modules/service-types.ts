// ============================================================
// Módulo Tipos de Serviço — catálogo configurável por oficina
//   · listar tipos activos (para a entrada escolher)
//   · gerir tipos (criar, editar, desactivar) — só gestão
//   · desactivar NÃO apaga: o histórico mantém-se intacto
// Primeira peça do painel de gestão. O padrão aqui — base semeada
// mas tudo editável — é o que vai reger todo o painel.
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

const TypeSchema = z.object({
  name: z.string().min(2, 'Nome demasiado curto'),
  clientPresence: z.enum(['waits', 'leaves']).default('leaves'),
  allowsQuickEntry: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
})

export async function serviceTypeRoutes(app: FastifyInstance) {
  // ── Listar ──────────────────────────────────────────────────
  // Por defeito só os activos (é o que a entrada precisa). Com
  // ?all=1, a gestão vê também os desactivados.
  app.get('/service-types', { preHandler: [guard('reception:read')] }, async (req: any) => {
    const all = req.query?.all === '1' || req.query?.all === 'true'
    return withTenant(req.user.tid, async (tx) => {
      const rows = all
        ? await tx`select id, name, client_presence, allows_quick_entry, sort_order, active
                   from service_types where tenant_id = ${req.user.tid}
                   order by active desc, sort_order, name`
        : await tx`select id, name, client_presence, allows_quick_entry, sort_order, active
                   from service_types where tenant_id = ${req.user.tid} and active = true
                   order by sort_order, name`
      return { data: rows }
    })
  })

  // ── Criar ───────────────────────────────────────────────────
  app.post('/service-types', { preHandler: [guard('config:manage')] }, async (req: any, reply) => {
    const body = TypeSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'Dados inválidos', details: body.error.flatten() })
    const d = body.data
    return withTenant(req.user.tid, async (tx) => {
      // Ordem: a seguir ao maior, se não vier definida.
      const [{ prox }] = await tx`
        select coalesce(max(sort_order), 0) + 1 as prox
        from service_types where tenant_id = ${req.user.tid}`
      const [t] = await tx`
        insert into service_types (tenant_id, name, client_presence, allows_quick_entry, sort_order, created_by)
        values (${req.user.tid}, ${d.name.trim()}, ${d.clientPresence}, ${d.allowsQuickEntry ?? false},
                ${d.sortOrder ?? prox}, ${req.user.sub})
        returning id, name, client_presence, allows_quick_entry, sort_order, active`
      await audit(tx, req.user.tid, req.user.sub, 'service_type.create', 'service_type', t.id, { name: d.name })
      return reply.send(t)
    })
  })

  // ── Editar ──────────────────────────────────────────────────
  app.patch('/service-types/:id', { preHandler: [guard('config:manage')] }, async (req: any, reply) => {
    const { id } = req.params
    const body = TypeSchema.partial().extend({ active: z.boolean().optional() }).safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d = body.data
    return withTenant(req.user.tid, async (tx) => {
      const [existe] = await tx`select id from service_types where id = ${id} and tenant_id = ${req.user.tid}`
      if (!existe) return reply.code(404).send({ error: 'Tipo não encontrado' })
      await tx`
        update service_types set
          name = coalesce(${d.name?.trim() ?? null}, name),
          client_presence = coalesce(${d.clientPresence ?? null}, client_presence),
          allows_quick_entry = coalesce(${d.allowsQuickEntry ?? null}, allows_quick_entry),
          sort_order = coalesce(${d.sortOrder ?? null}, sort_order),
          active = coalesce(${d.active ?? null}, active)
        where id = ${id}`
      await audit(tx, req.user.tid, req.user.sub, 'service_type.edit', 'service_type', id, { campos: Object.keys(d) })
      return reply.send({ ok: true })
    })
  })

  // Nota: não há DELETE. Desactivar (active=false) tira o tipo da lista
  // de escolha, mas os serviços que já o usaram mantêm-se — o nome fica
  // copiado em job_services.type_name. Nunca se reescreve o passado.
}
