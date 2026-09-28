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

// ── Pagamento de um carro → lançamento automático ────────────
// Chamado pelo pagar/desmarcar da OS (mesma transação). Apaga os
// lançamentos 'os' do carro e, se há valor, recria-os repartidos pelos
// departamentos dos serviços (proporcional ao preço). Assim o painel
// tem uma só fonte de verdade e nada se conta duas vezes.
const METHOD_FROM_OS: Record<string, string> = { mpesa: 'mpesa', emola: 'emola', transfer: 'bank', cash: 'cash', pos: 'card' }
export async function syncCarPaymentToLedger(tx: any, tid: string, joId: string, by: string, amount: number | null, method: string | null) {
  await tx`delete from ledger_entries where tenant_id = ${tid} and job_order_id = ${joId} and source = 'os'`
  if (!amount || amount <= 0) return
  const [jo] = await tx`
    select jo.number, v.plate, v.brand, v.model, c.full_name as customer
    from job_orders jo left join vehicles v on v.id = jo.vehicle_id left join customers c on c.id = jo.customer_id
    where jo.id = ${joId} and jo.tenant_id = ${tid}`
  if (!jo) return
  const svcs = await tx`
    select s.department_id,
      coalesce(s.price,0) + coalesce((select sum(coalesce(i.price,0)) from job_service_items i where i.job_service_id = s.id),0) as w
    from job_services s where s.job_order_id = ${joId} and s.tenant_id = ${tid} and s.status <> 'not_done'`
  const depts = await tx`select id, slug from departments where tenant_id = ${tid} and active = true order by sort_order, name`
  if (!depts.length) return
  const fallback = (svcs.find((x: any) => x.department_id)?.department_id) || depts[0].id
  const pesos = new Map<string, number>()
  for (const x of svcs) { const d = x.department_id || fallback; pesos.set(d, (pesos.get(d) || 0) + Number(x.w || 0)) }
  const totalW = [...pesos.values()].reduce((a, b) => a + b, 0)
  const partes: [string, number][] = totalW > 0 ? [...pesos.entries()].filter(([, w]) => w > 0) : [[fallback, 1]]
  const somaW = partes.reduce((a, [, w]) => a + w, 0)
  const cats = await tx`select id, name from ledger_categories where tenant_id = ${tid} and flow = 'revenue' and active = true order by sort_order`
  let resto = Math.round(amount * 100)
  for (let k = 0; k < partes.length; k++) {
    const [deptId, w] = partes[k]
    const cent = k === partes.length - 1 ? resto : Math.round(amount * 100 * w / somaW)
    resto -= cent
    const slug = depts.find((d: any) => d.id === deptId)?.slug
    const cat = cats.find((c: any) => c.name === (slug === 'remaps' ? 'Programação e tuning' : 'Mão de obra e serviços')) || cats[0]
    await tx`
      insert into ledger_entries (tenant_id, entry_date, department_id, is_transversal, category_id, category,
        payment_method, description, counterparty, job_order_id, plate, make, model, cost, revenue, source, created_by)
      values (${tid}, current_date, ${deptId}, false, ${cat?.id ?? null}, ${cat?.name ?? null},
        ${method ? (METHOD_FROM_OS[method] || null) : null}, ${'Pagamento ' + jo.number}, ${jo.customer ?? null},
        ${joId}, ${jo.plate ?? null}, ${jo.brand ?? null}, ${jo.model ?? null}, 0, ${cent / 100}, 'os', ${by})`
  }
}

export async function ledgerRoutes(app: FastifyInstance) {

  // ── Resumo do mês (o painel) ────────────────────────────────
  app.get('/ledger/summary', { preHandler: [guard('pricing:manage')] }, async (req: any, reply) => {
    const q = req.query as any
    const month = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : new Date().toISOString().slice(0, 7)
    const from = month + '-01'
    return withTenant(req.user.tid, async (tx) => {
      const tid = req.user.tid
      const [{ to }] = await tx`select (${from}::date + interval '1 month')::date::text as to`
      const depts = await tx`select id, name, slug, overhead_share from departments where tenant_id = ${tid} and active = true order by sort_order, name`
      const rows = await tx`
        select le.department_id, le.is_transversal, le.cost, le.revenue, le.payment_method, le.validated,
               c.nature, c.group_name, coalesce(c.counts_in_result, true) as counts
        from ledger_entries le left join ledger_categories c on c.id = le.category_id
        where le.tenant_id = ${tid} and le.ignored = false
          and le.entry_date >= ${from}::date and le.entry_date < ${to}::date`

      let receitas = 0, despesas = 0, transv = 0, fixos = 0, variaveis = 0, semNatureza = 0, internos = 0
      let caixaN = 0, caixaV = 0
      const porDept = new Map<string, { receitas: number; despesas: number }>()
      const porGrupo = new Map<string, number>()
      for (const r of rows) {
        const rev = Number(r.revenue) || 0, cost = Number(r.cost) || 0
        if (r.payment_method === 'cash' && !r.validated) { caixaN++; caixaV += rev + cost }
        if (!r.counts) { internos += rev + cost; continue }
        receitas += rev; despesas += cost
        if (cost > 0) {
          if (r.nature === 'fixed') fixos += cost; else if (r.nature === 'variable') variaveis += cost; else semNatureza += cost
          const g = r.group_name || 'Sem categoria'; porGrupo.set(g, (porGrupo.get(g) || 0) + cost)
        }
        if (r.is_transversal || !r.department_id) { transv += cost - rev; continue }
        const d = porDept.get(r.department_id) || { receitas: 0, despesas: 0 }
        d.receitas += rev; d.despesas += cost; porDept.set(r.department_id, d)
      }
      const shares = depts.map((d: any) => d.overhead_share)
      const somaShares = shares.reduce((a: number, x: any) => a + (x == null ? 0 : Number(x)), 0)
      const divisaoDefinida = shares.every((x: any) => x != null) && Math.abs(somaShares - 100) < 0.01
      const departamentos = depts.map((d: any) => {
        const v = porDept.get(d.id) || { receitas: 0, despesas: 0 }
        const parteTransv = divisaoDefinida ? transv * Number(d.overhead_share) / 100 : 0
        return { id: d.id, name: d.name, share: d.overhead_share == null ? null : Number(d.overhead_share),
          receitas: v.receitas, despesas: v.despesas, margemDireta: v.receitas - v.despesas,
          transversal: parteTransv, resultado: v.receitas - v.despesas - parteTransv }
      })

      // Últimos 6 meses (resultado)
      const hist = await tx`
        select to_char(le.entry_date, 'YYYY-MM') as m, sum(le.revenue) as rev, sum(le.cost) as cost
        from ledger_entries le left join ledger_categories c on c.id = le.category_id
        where le.tenant_id = ${tid} and le.ignored = false and coalesce(c.counts_in_result, true)
          and le.entry_date >= (${from}::date - interval '5 months') and le.entry_date < ${to}::date
        group by 1`
      const meses: any[] = []
      const [yy, mm] = month.split('-').map(Number)
      for (let k = 5; k >= 0; k--) {
        const dt = new Date(Date.UTC(yy, mm - 1 - k, 1)); const key = dt.toISOString().slice(0, 7)
        const h = hist.find((x: any) => x.m === key)
        meses.push({ month: key, resultado: h ? Number(h.rev) - Number(h.cost) : 0, temDados: !!h })
      }

      // Por receber: prontos / em QC / entregues com valor e sem pagamento
      const porReceber = await tx`
        select * from (
          select jo.id, jo.number, jo.status, v.plate, v.brand, v.model,
            coalesce((select sum(coalesce(s.price,0)) from job_services s where s.job_order_id = jo.id and s.status <> 'not_done'),0)
            + coalesce((select sum(coalesce(i.price,0)) from job_service_items i join job_services s on s.id = i.job_service_id
                        where s.job_order_id = jo.id and s.status <> 'not_done'),0) as total
          from job_orders jo left join vehicles v on v.id = jo.vehicle_id
          where jo.tenant_id = ${tid} and jo.status in ('ready','quality_check','delivered')
            and coalesce(jo.payment_status, 'unpaid') <> 'paid'
        ) x where total > 0 order by total desc`
      const [{ n: naOficina }] = await tx`select count(*)::int as n from job_orders where tenant_id = ${tid}
        and status not in ('delivered','cancelled','draft')`

      // Serviços com mais margem (carros pagos neste mês). Custo = custos EXTERNOS
      // (fornecimentos internos entre departamentos anulam-se dentro de casa).
      const servicos = await tx`
        select s.type_name as nome, count(*)::int as n,
          sum(coalesce(s.price,0) + coalesce((select sum(coalesce(i.price,0)) from job_service_items i where i.job_service_id = s.id),0)) as receita,
          sum(coalesce((select sum(sc.amount) from service_costs sc where sc.job_service_id = s.id and sc.supplier_department_id is null),0)) as custo
        from job_services s join job_orders jo on jo.id = s.job_order_id
        where jo.tenant_id = ${tid} and jo.paid_at >= ${from}::date and jo.paid_at < ${to}::date and s.status <> 'not_done'
        group by s.type_name`
      const topServicos = servicos.map((x: any) => ({ nome: x.nome, n: x.n, receita: Number(x.receita), custo: Number(x.custo),
          margem: Number(x.receita) - Number(x.custo) }))
        .filter((x: any) => x.receita > 0 || x.custo > 0).sort((a: any, b: any) => b.margem - a.margem).slice(0, 8)

      return {
        month, receitas, despesas, resultado: receitas - despesas,
        fixos, variaveis, semNatureza, internos,
        transversais: transv, divisaoDefinida, departamentos,
        grupos: [...porGrupo.entries()].map(([nome, v]) => ({ nome, valor: v })).sort((a, b) => b.valor - a.valor),
        caixaPorValidar: { n: caixaN, valor: caixaV },
        meses, porReceber: porReceber.map((x: any) => ({ ...x, total: Number(x.total) })),
        totalPorReceber: porReceber.reduce((a: number, x: any) => a + Number(x.total), 0),
        naOficina, topServicos,
      }
    })
  })

  // ── Divisão dos custos transversais por departamento (%) ────
  app.put('/ledger/overhead-shares', { preHandler: [guard('pricing:manage')] }, async (req: any, reply) => {
    const p = z.object({ shares: z.array(z.object({ departmentId: z.string().uuid(), share: z.number().min(0).max(100).nullable() })) }).safeParse(req.body)
    if (!p.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const lista = p.data.shares
    const todosVazios = lista.every(x => x.share == null)
    const soma = lista.reduce((a, x) => a + (x.share ?? 0), 0)
    if (!todosVazios && (lista.some(x => x.share == null) || Math.abs(soma - 100) > 0.01))
      return reply.code(400).send({ error: `As percentagens têm de somar 100% (estão a somar ${soma.toLocaleString('pt-PT')}%).` })
    return withTenant(req.user.tid, async (tx) => {
      for (const x of lista) await tx`update departments set overhead_share = ${x.share} where id = ${x.departmentId} and tenant_id = ${req.user.tid}`
      await audit(tx, req.user.tid, req.user.sub, 'ledger.overhead_shares', 'tenant', req.user.tid, { shares: lista })
      return reply.send({ ok: true })
    })
  })

  // Departamentos (Oficina/Remaps/Loja) — os mesmos da margem.
  app.get('/ledger/departments', { preHandler: [guard('pricing:manage')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`select id, name, slug, tracks_vehicles, overhead_share from departments
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
