// ============================================================
// Fornecedores e terceirização de serviços
//
// O custo do fornecedor é financeiro sensível: só quem tem
// finance:read o vê. A equipa (Yury/Edgar) gere a operação —
// fornecedor e estado — mas não o custo.
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

const OUT_STATES = ['none', 'sent', 'at_supplier', 'returned']

export async function supplierRoutes(app: FastifyInstance) {

  // ── Fornecedores: listar ───────────────────────────────────
  app.get('/suppliers', { preHandler: [guard('reception:read')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`select id, name, contact, notes, active from suppliers
                            where tenant_id = ${req.user.tid} and active = true order by name`
      return { suppliers: rows }
    })
  })

  // ── Fornecedores: criar (só quem configura) ────────────────
  app.post('/suppliers', { preHandler: [guard('config:manage')] }, async (req: any, reply) => {
    const b = z.object({ name: z.string().min(1).max(160), contact: z.string().max(160).nullable().optional(),
                         notes: z.string().max(500).nullable().optional() }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    return withTenant(req.user.tid, async (tx) => {
      const [row] = await tx`insert into suppliers (tenant_id, name, contact, notes)
        values (${req.user.tid}, ${b.data.name.trim()}, ${b.data.contact ?? null}, ${b.data.notes ?? null})
        returning id, name, contact, notes, active`
      await audit(tx, req.user.tid, req.user.sub, 'supplier.create', 'supplier', row.id, { nome: row.name })
      return reply.send(row)
    })
  })

  // ── Fornecedores: editar / desativar ───────────────────────
  app.patch('/suppliers/:id', { preHandler: [guard('config:manage')] }, async (req: any, reply) => {
    const b = z.object({ name: z.string().min(1).max(160).optional(), contact: z.string().max(160).nullable().optional(),
                         notes: z.string().max(500).nullable().optional(), active: z.boolean().optional() }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d = b.data
    return withTenant(req.user.tid, async (tx) => {
      await tx`update suppliers set
        name = coalesce(${d.name?.trim() ?? null}, name),
        active = coalesce(${d.active ?? null}, active)
        where id = ${req.params.id} and tenant_id = ${req.user.tid}`
      if (d.contact !== undefined) await tx`update suppliers set contact = ${d.contact} where id = ${req.params.id}`
      if (d.notes !== undefined) await tx`update suppliers set notes = ${d.notes} where id = ${req.params.id}`
      return reply.send({ ok: true })
    })
  })

  // ── Marcar/atualizar terceirização de um serviço ───────────
  // O custo só é ACEITE de quem tem finance:read. Se quem edita
  // não tem essa permissão, o custo enviado é ignorado (não se
  // apaga o que lá está).
  app.post('/os/services/:sid/outsource', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { sid } = req.params
    const b = z.object({
      outsourced: z.boolean(),
      supplierId: z.string().uuid().nullable().optional(),
      cost: z.number().nullable().optional(),
      status: z.enum(OUT_STATES as [string, ...string[]]).optional(),
    }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d = b.data
    const podeCusto = can(req.user.perms, 'finance:read')
    return withTenant(req.user.tid, async (tx) => {
      const [svc] = await tx`select id from job_services where id = ${sid} and tenant_id = ${req.user.tid}`
      if (!svc) return reply.code(404).send({ error: 'Serviço não encontrado' })

      await tx`update job_services set
        outsourced = ${d.outsourced},
        outsource_status = ${d.status ?? (d.outsourced ? 'sent' : 'none')}
        where id = ${sid}`
      if (d.supplierId !== undefined) {
        await tx`update job_services set supplier_id = ${d.supplierId ?? null} where id = ${sid} and tenant_id = ${req.user.tid}`
      }
      // O custo só se toca se quem edita pode ver finanças.
      if (podeCusto && d.cost !== undefined) {
        await tx`update job_services set supplier_cost = ${d.cost} where id = ${sid} and tenant_id = ${req.user.tid}`
      }
      await audit(tx, req.user.tid, req.user.sub, 'job_service.outsource', 'job_service', sid,
        { outsourced: d.outsourced, status: d.status, custoAlterado: podeCusto && d.cost !== undefined })
      return reply.send({ ok: true })
    })
  })
}
