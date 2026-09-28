// ============================================================
// Lançamentos financeiros (painel de gestão da Heike)
//
// O coração do painel. Um lançamento é uma transação (custo ou
// receita), por departamento ou transversal, opcionalmente ligada
// a um carro. Nasce na app (menu "Lançar") ou do extrato (futuro).
//
// Tudo aqui é financeiro sensível: só quem tem pricing:manage
// (a dona). A equipa não vê o painel de gestão.
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

const entrySchema = z.object({
  entryDate: z.string().optional(),                 // ISO date; default hoje
  businessUnitId: z.string().uuid().nullable().optional(),
  isTransversal: z.boolean().optional(),
  kind: z.string().max(60).nullable().optional(),
  category: z.string().max(60).nullable().optional(),
  description: z.string().max(400).nullable().optional(),
  counterparty: z.string().max(200).nullable().optional(),
  jobOrderId: z.string().uuid().nullable().optional(),
  plate: z.string().max(40).nullable().optional(),
  make: z.string().max(80).nullable().optional(),
  model: z.string().max(80).nullable().optional(),
  engine: z.string().max(60).nullable().optional(),
  cost: z.number().nonnegative().optional(),
  revenue: z.number().nonnegative().optional(),
})

export async function ledgerRoutes(app: FastifyInstance) {

  // Departamentos, para o formulário de lançar.
  app.get('/ledger/departments', { preHandler: [guard('pricing:manage')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`select id, name, type from business_units
                            where tenant_id = ${req.user.tid} and active = true order by name`
      return { departments: rows }
    })
  })

  // Lançar (Ponta A — no dia-a-dia).
  app.post('/ledger', { preHandler: [guard('pricing:manage')] }, async (req: any, reply) => {
    const p = entrySchema.safeParse(req.body)
    if (!p.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d = p.data
    if (!d.isTransversal && !d.businessUnitId) return reply.code(400).send({ error: 'Escolhe o departamento (ou marca como transversal).' })
    if ((d.cost ?? 0) === 0 && (d.revenue ?? 0) === 0) return reply.code(400).send({ error: 'Escreve um custo ou uma receita.' })
    return withTenant(req.user.tid, async (tx) => {
      const [e] = await tx`
        insert into ledger_entries (tenant_id, entry_date, business_unit_id, is_transversal,
          kind, category, description, counterparty, job_order_id, plate, make, model, engine,
          cost, revenue, source, created_by)
        values (${req.user.tid}, ${d.entryDate || new Date().toISOString().slice(0,10)},
          ${d.isTransversal ? null : d.businessUnitId}, ${d.isTransversal ?? false},
          ${d.kind ?? null}, ${d.category ?? null}, ${d.description?.trim() || null}, ${d.counterparty?.trim() || null},
          ${d.jobOrderId ?? null}, ${d.plate?.trim() || null}, ${d.make?.trim() || null}, ${d.model?.trim() || null}, ${d.engine?.trim() || null},
          ${d.cost ?? 0}, ${d.revenue ?? 0}, 'app', ${req.user.sub})
        returning id`
      await audit(tx, req.user.tid, req.user.sub, 'ledger.create', 'ledger_entry', e.id, { cost: d.cost, revenue: d.revenue })
      return reply.send({ ok: true, id: e.id })
    })
  })

  // Listar (por mês, por departamento). Base do painel e da conciliação.
  app.get('/ledger', { preHandler: [guard('pricing:manage')] }, async (req: any) => {
    const q = req.query as any
    const from = q.from || null    // ISO date
    const to = q.to || null
    const bu = q.businessUnitId || null
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`
        select le.id, le.entry_date, le.business_unit_id, bu.name as department, le.is_transversal,
               le.kind, le.category, le.description, le.counterparty,
               le.job_order_id, le.plate, le.make, le.model, le.engine,
               le.cost, le.revenue, le.source, le.reconciled, le.validated, le.ignored, le.created_at
        from ledger_entries le
        left join business_units bu on bu.id = le.business_unit_id
        where le.tenant_id = ${req.user.tid}
          and (${from}::date is null or le.entry_date >= ${from}::date)
          and (${to}::date is null or le.entry_date <= ${to}::date)
          and (${bu}::uuid is null or le.business_unit_id = ${bu}::uuid)
        order by le.entry_date desc, le.created_at desc`
      return { entries: rows }
    })
  })

  // Editar um lançamento (detalhar, classificar, corrigir).
  app.patch('/ledger/:id', { preHandler: [guard('pricing:manage')] }, async (req: any, reply) => {
    const p = entrySchema.partial().extend({
      reconciled: z.boolean().optional(), validated: z.boolean().optional(), ignored: z.boolean().optional(),
    }).safeParse(req.body)
    if (!p.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d: any = p.data
    return withTenant(req.user.tid, async (tx) => {
      const [ex] = await tx`select * from ledger_entries where id = ${req.params.id} and tenant_id = ${req.user.tid}`
      if (!ex) return reply.code(404).send({ error: 'Lançamento não encontrado' })
      // merge: usa o valor enviado, ou mantém o atual
      const v = (key: string, col: string) => d[key] !== undefined ? d[key] : ex[col]
      await tx`update ledger_entries set
        entry_date = ${v('entryDate','entry_date')},
        business_unit_id = ${d.isTransversal ? null : v('businessUnitId','business_unit_id')},
        is_transversal = ${v('isTransversal','is_transversal')},
        kind = ${v('kind','kind')}, category = ${v('category','category')},
        description = ${v('description','description')}, counterparty = ${v('counterparty','counterparty')},
        job_order_id = ${v('jobOrderId','job_order_id')},
        plate = ${v('plate','plate')}, make = ${v('make','make')}, model = ${v('model','model')}, engine = ${v('engine','engine')},
        cost = ${v('cost','cost')}, revenue = ${v('revenue','revenue')},
        reconciled = ${v('reconciled','reconciled')}, validated = ${v('validated','validated')}, ignored = ${v('ignored','ignored')},
        updated_at = now()
        where id = ${req.params.id} and tenant_id = ${req.user.tid}`
      await audit(tx, req.user.tid, req.user.sub, 'ledger.update', 'ledger_entry', req.params.id, {})
      return reply.send({ ok: true })
    })
  })

  // Apagar um lançamento (engano).
  app.delete('/ledger/:id', { preHandler: [guard('pricing:manage')] }, async (req: any, reply) => {
    return withTenant(req.user.tid, async (tx) => {
      await tx`delete from ledger_entries where id = ${req.params.id} and tenant_id = ${req.user.tid}`
      await audit(tx, req.user.tid, req.user.sub, 'ledger.delete', 'ledger_entry', req.params.id, {})
      return reply.send({ ok: true })
    })
  })
}
