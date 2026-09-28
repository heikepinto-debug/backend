// ============================================================
// Lançamentos financeiros (painel de gestão do dono)
//
// Um lançamento é um movimento: despesa, receita ou movimento
// interno (transferência/reforço — não conta no resultado). Tem uma
// CATEGORIA (plano configurável por oficina, com grupo e natureza
// fixo/variável), um DEPARTAMENTO (Oficina/Remaps/Loja) ou é
// TRANSVERSAL, o MEIO de pagamento (banco/caixa/M-Pesa/...) e,
// quando o departamento trabalha em carros, o carro.
//
// Nasce na app (menu "Lançar") ou do extrato (pedaço futuro).
// Tudo financeiro sensível: só pricing:manage (o dono).
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

const METHODS = ['bank', 'cash', 'mpesa', 'emola', 'card'] as const

const entrySchema = z.object({
  entryDate: z.string().optional(),
  categoryId: z.string().uuid(),
  departmentId: z.string().uuid().nullable().optional(),
  isTransversal: z.boolean().optional(),
  paymentMethod: z.enum(METHODS).nullable().optional(),
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

// Regras de coerência entre categoria, departamento e valores.
function validar(cat: any, d: any): string | null {
  const cost = d.cost ?? 0, revenue = d.revenue ?? 0
  if (cost === 0 && revenue === 0) return 'Escreve o valor.'
  if (cost > 0 && revenue > 0) return 'Um lançamento é uma entrada OU uma saída, não as duas.'
  if (cat.flow === 'cost' && revenue > 0) return 'Esta categoria é de despesa.'
  if (cat.flow === 'revenue' && cost > 0) return 'Esta categoria é de receita.'
  if (cat.flow !== 'neutral' && !d.isTransversal && !d.departmentId) return 'Escolhe o departamento (ou marca como transversal).'
  return null
}

export async function ledgerRoutes(app: FastifyInstance) {

  // Departamentos (Oficina/Remaps/Loja) — os mesmos da margem.
  app.get('/ledger/departments', { preHandler: [guard('pricing:manage')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`select id, name, slug, tracks_vehicles from departments
                            where tenant_id = ${req.user.tid} and active = true order by sort_order, name`
      return { departments: rows }
    })
  })

  // Plano de categorias da oficina.
  app.get('/ledger/categories', { preHandler: [guard('pricing:manage')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`select id, flow, group_name, name, nature, counts_in_result from ledger_categories
                            where tenant_id = ${req.user.tid} and active = true order by flow, sort_order, name`
      return { categories: rows }
    })
  })

  // Lançar (Ponta A — no dia-a-dia).
  app.post('/ledger', { preHandler: [guard('pricing:manage')] }, async (req: any, reply) => {
    const p = entrySchema.safeParse(req.body)
    if (!p.success) return reply.code(400).send({ error: 'Escolhe a categoria e escreve o valor.' })
    const d = p.data
    return withTenant(req.user.tid, async (tx) => {
      const [cat] = await tx`select id, flow, name from ledger_categories where id = ${d.categoryId} and tenant_id = ${req.user.tid}`
      if (!cat) return reply.code(400).send({ error: 'Categoria inválida.' })
      const erro = validar(cat, d)
      if (erro) return reply.code(400).send({ error: erro })
      const neutral = cat.flow === 'neutral'
      const transv = !neutral && !!d.isTransversal
      const [e] = await tx`
        insert into ledger_entries (tenant_id, entry_date, department_id, is_transversal, category_id, category,
          payment_method, description, counterparty, job_order_id, plate, make, model, engine,
          cost, revenue, source, created_by)
        values (${req.user.tid}, ${d.entryDate || new Date().toISOString().slice(0, 10)},
          ${neutral || transv ? null : d.departmentId}, ${transv}, ${cat.id}, ${cat.name},
          ${d.paymentMethod ?? null}, ${d.description?.trim() || null}, ${d.counterparty?.trim() || null},
          ${d.jobOrderId ?? null}, ${d.plate?.trim() || null}, ${d.make?.trim() || null}, ${d.model?.trim() || null}, ${d.engine?.trim() || null},
          ${d.cost ?? 0}, ${d.revenue ?? 0}, 'app', ${req.user.sub})
        returning id`
      await audit(tx, req.user.tid, req.user.sub, 'ledger.create', 'ledger_entry', e.id, { categoria: cat.name, cost: d.cost, revenue: d.revenue })
      return reply.send({ ok: true, id: e.id })
    })
  })

  // Listar (por período e departamento). Base do painel e da conciliação.
  app.get('/ledger', { preHandler: [guard('pricing:manage')] }, async (req: any) => {
    const q = req.query as any
    const from = q.from || null, to = q.to || null, dept = q.departmentId || null
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`
        select le.id, le.entry_date, le.department_id, d.name as department, le.is_transversal,
               le.category_id, c.name as category_name, c.group_name, c.flow, c.nature, c.counts_in_result,
               le.payment_method, le.description, le.counterparty,
               le.job_order_id, le.plate, le.make, le.model, le.engine,
               le.cost, le.revenue, le.source, le.reconciled, le.validated, le.ignored, le.created_at
        from ledger_entries le
        left join departments d on d.id = le.department_id
        left join ledger_categories c on c.id = le.category_id
        where le.tenant_id = ${req.user.tid}
          and (${from}::date is null or le.entry_date >= ${from}::date)
          and (${to}::date is null or le.entry_date <= ${to}::date)
          and (${dept}::uuid is null or le.department_id = ${dept}::uuid)
        order by le.entry_date desc, le.created_at desc`
      return { entries: rows }
    })
  })

  // Editar (detalhar, reclassificar, conciliar, validar, ignorar).
  app.patch('/ledger/:id', { preHandler: [guard('pricing:manage')] }, async (req: any, reply) => {
    const p = entrySchema.partial().extend({
      reconciled: z.boolean().optional(), validated: z.boolean().optional(), ignored: z.boolean().optional(),
    }).safeParse(req.body)
    if (!p.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d: any = p.data
    return withTenant(req.user.tid, async (tx) => {
      const [ex] = await tx`select * from ledger_entries where id = ${req.params.id} and tenant_id = ${req.user.tid}`
      if (!ex) return reply.code(404).send({ error: 'Lançamento não encontrado' })
      const v = (key: string, col: string) => d[key] !== undefined ? d[key] : ex[col]
      const catId = v('categoryId', 'category_id')
      const [cat] = catId ? await tx`select id, flow, name from ledger_categories where id = ${catId} and tenant_id = ${req.user.tid}` : [null]
      const merged = {
        cost: Number(v('cost', 'cost')), revenue: Number(v('revenue', 'revenue')),
        departmentId: v('departmentId', 'department_id'), isTransversal: v('isTransversal', 'is_transversal'),
      }
      if (cat) { const erro = validar(cat, merged); if (erro) return reply.code(400).send({ error: erro }) }
      const neutral = cat?.flow === 'neutral'
      const transv = !neutral && !!merged.isTransversal
      await tx`update ledger_entries set
        entry_date = ${v('entryDate', 'entry_date')},
        category_id = ${cat?.id ?? null}, category = ${cat?.name ?? ex.category},
        department_id = ${neutral || transv ? null : merged.departmentId}, is_transversal = ${transv},
        payment_method = ${v('paymentMethod', 'payment_method')},
        description = ${v('description', 'description')}, counterparty = ${v('counterparty', 'counterparty')},
        job_order_id = ${v('jobOrderId', 'job_order_id')},
        plate = ${v('plate', 'plate')}, make = ${v('make', 'make')}, model = ${v('model', 'model')}, engine = ${v('engine', 'engine')},
        cost = ${merged.cost}, revenue = ${merged.revenue},
        reconciled = ${v('reconciled', 'reconciled')}, validated = ${v('validated', 'validated')}, ignored = ${v('ignored', 'ignored')},
        updated_at = now()
        where id = ${req.params.id} and tenant_id = ${req.user.tid}`
      await audit(tx, req.user.tid, req.user.sub, 'ledger.update', 'ledger_entry', req.params.id, {})
      return reply.send({ ok: true })
    })
  })

  // Apagar (engano).
  app.delete('/ledger/:id', { preHandler: [guard('pricing:manage')] }, async (req: any, reply) => {
    return withTenant(req.user.tid, async (tx) => {
      await tx`delete from ledger_entries where id = ${req.params.id} and tenant_id = ${req.user.tid}`
      await audit(tx, req.user.tid, req.user.sub, 'ledger.delete', 'ledger_entry', req.params.id, {})
      return reply.send({ ok: true })
    })
  })
}
