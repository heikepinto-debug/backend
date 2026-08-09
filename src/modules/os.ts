// ============================================================
// Módulo Ordem de Serviço — Fatia 1: Diagnóstico e Lista de Problemas
//   · iniciar OS a partir de uma recepção (puxa queixas como problemas)
//   · gerir a lista de problemas (adicionar achados, diagnosticar)
//   · submeter diagnóstico → autorização (Edgar) → autoriza/recusa
//   · tudo configurável (etapa de autorização liga/desliga por oficina)
// ============================================================
import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant, audit, can, supabase, BUCKET } from '../lib/core.js'

function guard(perm: string) {
  return async (req: any, reply: any) => {
    try { await req.jwtVerify() } catch { return reply.code(401).send({ error: 'Não autenticado' }) }
    if (!can(req.user.perms, perm)) return reply.code(403).send({ error: 'Sem permissão', needed: perm })
  }
}

async function logState(tx: any, tid: string, joId: string, from: string | null, to: string, by: string) {
  await tx`insert into jo_state_log (tenant_id, job_order_id, from_status, to_status, changed_by)
    values (${tid}, ${joId}, ${from}, ${to}, ${by})`
}

export async function osRoutes(app: FastifyInstance) {
  // ── Resumo para o painel inicial (números de relance) ───────
  app.get('/dashboard/summary', { preHandler: [guard('reception:read')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const [counts] = await tx`
        select
          count(*) filter (where status not in ('draft','delivered','cancelled'))::int as in_shop,
          count(*) filter (where status in ('awaiting_diagnosis','in_diagnosis','diagnosis_review'))::int as diagnosing,
          count(*) filter (where status in ('awaiting_quote','quote_sent','approved','in_progress','quality_check'))::int as working,
          count(*) filter (where status = 'ready')::int as ready,
          count(*) filter (where status = 'draft')::int as drafts
        from job_orders where tenant_id = ${req.user.tid}`
      // marcações de hoje + em atraso
      const [book] = await tx`
        select count(*)::int as n from job_orders
        where tenant_id = ${req.user.tid} and status = 'draft'
          and booking_date is not null and coalesce(booking_status,'') <> 'cancelled'
          and booking_date::date <= current_date`
      // diagnósticos à espera de autorização (que não submeti eu)
      const [auth] = await tx`
        select count(*)::int as n from job_orders
        where tenant_id = ${req.user.tid} and status = 'diagnosis_review'
          and (diag_submitted_by is null or diag_submitted_by <> ${req.user.sub})`
      // entregues hoje
      const [del] = await tx`
        select count(*)::int as n from job_orders
        where tenant_id = ${req.user.tid} and status = 'delivered'
          and updated_at::date = current_date`
      return {
        inShop: counts?.in_shop || 0,
        diagnosing: counts?.diagnosing || 0,
        working: counts?.working || 0,
        ready: counts?.ready || 0,
        drafts: counts?.drafts || 0,
        bookingsToday: book?.n || 0,
        pendingAuth: auth?.n || 0,
        deliveredToday: del?.n || 0,
      }
    })
  })

  // ── Logs de erro recentes (só dono) — diagnóstico ───────────
  app.get('/error-logs', { preHandler: [guard('jobdelete:any')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`
        select id, method, route, status_code, message, error_code, created_at, user_id
        from error_logs
        where tenant_id = ${req.user.tid} or tenant_id is null
        order by created_at desc limit 100`
      return { data: rows }
    })
  })

  // ── Lista de diagnósticos a aguardar autorização ────────────
  // (para o cartão do autorizador — ex: Edgar). Exclui os que ele
  // próprio submeteu, pois não pode autorizar o seu próprio diagnóstico.
  app.get('/os/awaiting-authorization', { preHandler: [guard('reception:read')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`
        select jo.id, jo.number, jo.diag_submitted_at,
               v.plate, v.brand, v.model,
               c.full_name as customer_name,
               us.full_name as submitted_by_name
        from job_orders jo
        join vehicles v on v.id = jo.vehicle_id
        join customers c on c.id = jo.customer_id
        left join users us on us.id = jo.diag_submitted_by
        where jo.tenant_id = ${req.user.tid}
          and jo.status = 'diagnosis_review'
          and (jo.diag_submitted_by is null or jo.diag_submitted_by <> ${req.user.sub})
        order by jo.diag_submitted_at asc`
      return { data: rows }
    })
  })

  // ── Carros à espera de QC de saída ─────────────────────────
  // Prontos, mas sem QC aprovado. É o que CHAMA o Yury para o QC —
  // em vez de ele ter de se lembrar de o abrir carro a carro.
  app.get('/os/awaiting-qc', { preHandler: [guard('reception:read')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`
        select jo.id, jo.number, jo.updated_at,
               v.plate, v.brand, v.model, c.full_name as customer_name,
               qc.status as qc_status
        from job_orders jo
        join vehicles v on v.id = jo.vehicle_id
        join customers c on c.id = jo.customer_id
        left join qc_checks qc on qc.job_order_id = jo.id
        where jo.tenant_id = ${req.user.tid}
          and jo.status = 'ready'
          and (qc.status is null or qc.status <> 'approved')
        order by jo.updated_at asc`
      return { data: rows }
    })
  })

  // ── Departamentos (centros de receita) ─────────────────────
  app.get('/departments', { preHandler: [guard('reception:read')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`select id, name, code, sort_order from departments
        where tenant_id = ${req.user.tid} and active = true order by sort_order, name`
      return { data: rows }
    })
  })

  // ── Definir preço + departamento de um serviço ─────────────
  // Só quem tem pricing:manage. Guarda o preço ao cliente (sem IVA).
  app.post('/os/services/:sid/pricing', { preHandler: [guard('pricing:manage')] }, async (req: any, reply) => {
    const { sid } = req.params
    const b = z.object({
      price: z.number().nullable().optional(),
      departmentId: z.string().uuid().nullable().optional(),
    }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d = b.data
    return withTenant(req.user.tid, async (tx) => {
      const [svc] = await tx`select id from job_services where id = ${sid} and tenant_id = ${req.user.tid}`
      if (!svc) return reply.code(404).send({ error: 'Serviço não encontrado' })
      if (d.price !== undefined) await tx`update job_services set price = ${d.price} where id = ${sid} and tenant_id = ${req.user.tid}`
      if (d.departmentId !== undefined) await tx`update job_services set department_id = ${d.departmentId} where id = ${sid} and tenant_id = ${req.user.tid}`
      await audit(tx, req.user.tid, req.user.sub, 'job_service.pricing', 'job_service', sid, { price: d.price, departmentId: d.departmentId })
      return reply.send({ ok: true })
    })
  })

  // ── Orçamento do carro: preços + totais por departamento ───
  // ── Iniciar OS a partir de uma recepção ─────────────────────
  app.post('/os/start/:joId', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    try {
      return await withTenant(req.user.tid, async (tx) => {
        const [jo] = await tx`select id, number, status, intentions, os_opened_at, entry_pending_reason, entry_completed_at from job_orders where id = ${joId}`
        if (!jo) return reply.code(404).send({ error: 'Recepção não encontrada' })
        if (jo.os_opened_at) return reply.code(409).send({ error: 'OS já foi iniciada' })
        if (jo.status === 'draft') return reply.code(400).send({ error: 'Recepção ainda é rascunho' })
        // Portão: a entrada podia fechar sem o KM (o cliente não espera pela
        // bateria), mas o carro não avança para OS sem isso resolvido.
        if (jo.entry_pending_reason && !jo.entry_completed_at)
          return reply.code(409).send({
            error: 'Entrada incompleta: falta o KM e as fotos do painel. Completa a entrada antes de iniciar a OS.',
            code: 'ENTRY_INCOMPLETE',
          })

        // puxa as queixas do cliente como problemas iniciais
        const intentions = typeof jo.intentions === 'string' ? JSON.parse(jo.intentions) : (jo.intentions || [])
        let order = 0
        for (const it of intentions) {
          const text = typeof it === 'string' ? it : (it?.text || it?.description || String(it))
          await tx`insert into problems (tenant_id, job_order_id, description, origin, sort_order, created_by)
            values (${req.user.tid}, ${joId}, ${text}, 'customer', ${order++}, ${req.user.sub})`
        }
        await tx`update job_orders set status = 'in_diagnosis', os_opened_at = now(), os_opened_by = ${req.user.sub}, updated_at = now() where id = ${joId}`
        await logState(tx, req.user.tid, joId, jo.status, 'in_diagnosis', req.user.sub)
        await audit(tx, req.user.tid, req.user.sub, 'os.start', 'job_order', joId, { number: jo.number })
        return reply.code(201).send({ ok: true })
      })
    } catch (e: any) {
      app.log.error({ err: e, joId }, 'os start failed')
      return reply.code(500).send({ error: `Erro ao iniciar OS: ${e?.message || 'desconhecido'}` })
    }
  })

  // ── Ver a OS (dados + lista de problemas) ───────────────────
  app.get('/os/:joId', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    try {
      return await withTenant(req.user.tid, async (tx) => {
        const [jo] = await tx`
          select jo.*, v.plate, v.brand, v.model, c.full_name as customer_name,
                 uo.full_name as os_opened_by_name,
                 us.full_name as diag_submitted_by_name,
                 ua.full_name as diag_authorized_by_name
          from job_orders jo
          join vehicles v on v.id = jo.vehicle_id
          join customers c on c.id = jo.customer_id
          left join users uo on uo.id = jo.os_opened_by
          left join users us on us.id = jo.diag_submitted_by
          left join users ua on ua.id = jo.diag_authorized_by
          left join users ur on ur.id = jo.responsible_id
          where jo.id = ${joId}`
        if (!jo) return reply.code(404).send({ error: 'não encontrada' })
        const problems = await tx`select p.*, s.type_name as service_name, s.status as service_status
          from problems p
          left join job_services s on s.id = p.resolved_service_id
          where p.job_order_id = ${joId} order by p.sort_order, p.created_at`
        // fotos por problema (protegido — uma falha de storage não deita a OS abaixo)
        for (const p of problems as any[]) {
          p.photos = []
          try {
            const photos = await tx`select id, path from problem_photos where problem_id = ${p.id}`
            for (const ph of photos as any[]) {
              try {
                const { data } = await supabase.storage.from(BUCKET).createSignedUrl(ph.path, 3600)
                p.photos.push({ id: ph.id, url: data?.signedUrl })
              } catch { /* foto indisponível — segue */ }
            }
          } catch { /* sem fotos — segue */ }
        }
        const [tenant] = await tx`select diag_authorization_on from tenants where id = ${req.user.tid}`
        // Serviços do carro, cada um com o seu estado e quem o trata.
        const podeCusto = can(req.user.perms, 'finance:read')
        const podePreco = can(req.user.perms, 'pricing:manage')
        const services = await tx`
          select s.id, s.type_name, s.status, s.status_note, s.assigned_to, s.notes,
                 s.source, s.from_problem_id,
                 s.outsourced, s.supplier_id, s.outsource_status,
                 ${podeCusto ? tx`s.supplier_cost` : tx`null::numeric`} as supplier_cost,
                 ${podePreco ? tx`s.price` : tx`null::numeric`} as price,
                 ${podePreco ? tx`s.department_id` : tx`null::uuid`} as department_id,
                 u.full_name as assigned_name, sup.name as supplier_name
          from job_services s
          left join users u on u.id = s.assigned_to
          left join suppliers sup on sup.id = s.supplier_id
          where s.job_order_id = ${joId} order by s.created_at`
        // Executantes de cada serviço.
        const workers = await tx`
          select w.job_service_id, w.user_id, w.is_helper, u.full_name
          from job_service_workers w join users u on u.id = w.user_id
          where w.tenant_id = ${req.user.tid}
            and w.job_service_id in (select id from job_services where job_order_id = ${joId})`
        for (const s of services) {
          (s as any).workers = workers.filter((w: any) => w.job_service_id === s.id)
            .map((w: any) => ({ userId: w.user_id, name: w.full_name, isHelper: w.is_helper }))
        }
        // Equipa disponível para escolher (responsável / ajudas).
        const team = await tx`select id, full_name from users where tenant_id = ${req.user.tid} and active = true order by full_name`
        return { jo, problems, services, team, diagAuthorizationOn: tenant?.diag_authorization_on ?? true }
      })
    } catch (e: any) {
      app.log.error({ err: e, joId }, 'os load failed')
      return reply.code(500).send({ error: `Erro ao carregar OS: ${e?.message || 'desconhecido'}` })
    }
  })

  // ── Adicionar um problema (achado da equipa) ────────────────
  // ── Mudar o estado de um serviço (grava transição) ─────────
  // ── Responsável do carro (um) ──────────────────────────────
  // ── Marcar o carro como pronto (confirmado pelo utilizador) ─
  // Sugerido pela app quando todos os serviços fecham, mas é sempre
  // uma decisão humana — a app não muda a fase do carro sozinha.
  app.post('/os/:joId/mark-ready', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const [jo] = await tx`select id, number, status from job_orders where id = ${joId} and tenant_id = ${req.user.tid}`
      if (!jo) return reply.code(404).send({ error: 'OS não encontrada' })
      if (['ready', 'delivered'].includes(jo.status)) return reply.code(409).send({ error: 'O carro já está pronto ou entregue' })
      const anterior = jo.status
      await tx`update job_orders set status = 'ready', updated_at = now() where id = ${joId}`
      await logState(tx, req.user.tid, joId, anterior, 'ready', req.user.sub)
      await audit(tx, req.user.tid, req.user.sub, 'os.mark_ready', 'job_order', joId, { number: jo.number, de: anterior })
      return reply.send({ ok: true })
    })
  })

  // ── Departamentos (centros de receita) ─────────────────────
  app.get('/departments', { preHandler: [guard('reception:read')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`select id, name, slug, sort_order from departments
        where tenant_id = ${req.user.tid} and active = true order by sort_order, name`
      return { data: rows }
    })
  })

  // ── Pôr preço + departamento num serviço (só a dona) ───────
  app.post('/os/services/:sid/pricing', { preHandler: [guard('pricing:manage')] }, async (req: any, reply) => {
    const b = z.object({
      price: z.number().nullable().optional(),
      departmentId: z.string().uuid().nullable().optional(),
    }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d = b.data
    return withTenant(req.user.tid, async (tx) => {
      const [svc] = await tx`select id from job_services where id = ${req.params.sid} and tenant_id = ${req.user.tid}`
      if (!svc) return reply.code(404).send({ error: 'Serviço não encontrado' })
      if (d.price !== undefined) await tx`update job_services set price = ${d.price} where id = ${req.params.sid} and tenant_id = ${req.user.tid}`
      if (d.departmentId !== undefined) await tx`update job_services set department_id = ${d.departmentId} where id = ${req.params.sid} and tenant_id = ${req.user.tid}`
      await audit(tx, req.user.tid, req.user.sub, 'job_service.pricing', 'job_service', req.params.sid, d)
      return reply.send({ ok: true })
    })
  })

  // ── Totais do orçamento por departamento (só a dona) ───────
  // A visão de gestão: quanto cada departamento gera neste carro.
  app.get('/os/:joId/budget', { preHandler: [guard('pricing:manage')] }, async (req: any) => {
    const { joId } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const services = await tx`
        select js.id, js.type_name, js.price, js.department_id, d.name as dept_name, d.slug as dept_slug
        from job_services js
        left join departments d on d.id = js.department_id
        where js.job_order_id = ${joId} and js.tenant_id = ${req.user.tid}
        order by js.created_at`
      const items = await tx`
        select jsi.job_service_id, jsi.kind, jsi.label, jsi.qty, jsi.unit, jsi.price
        from job_service_items jsi
        join job_services js on js.id = jsi.job_service_id
        where js.job_order_id = ${joId} and jsi.tenant_id = ${req.user.tid}`
      const costs = await tx`
        select sc.id, sc.job_service_id, sc.department_id, sc.category, sc.label, sc.amount,
               sc.supplier_department_id, sc.parent_cost_id,
               dd.name as dept_name, sd.name as supplier_dept_name
        from service_costs sc
        join job_services js on js.id = sc.job_service_id
        left join departments dd on dd.id = sc.department_id
        left join departments sd on sd.id = sc.supplier_department_id
        where js.job_order_id = ${joId} and sc.tenant_id = ${req.user.tid}
        order by sc.created_at`

      const departments = await tx`select id, name, slug from departments where tenant_id = ${req.user.tid} and active = true order by sort_order`

      // ── Margem por departamento ────────────────────────────
      // Receita de um dep = preço dos serviços que possui + itens
      //   desses serviços + fornecimentos internos que prestou.
      // Custo de um dep = todos os service_costs com department_id = dep.
      const dept: Record<string, { id: string; name: string; receita: number; custo: number }> = {}
      const D = (id: string, name: string) => (dept[id] = dept[id] || { id, name, receita: 0, custo: 0 })

      let precoCliente = 0  // o que o cliente paga (receita externa, sem contar fornecimentos internos)
      for (const s of services) {
        const v = Number(s.price || 0)
        precoCliente += v
        if (s.department_id) D(s.department_id, s.dept_name).receita += v
      }
      for (const it of items) {
        const v = Number(it.price || 0)
        precoCliente += v
        const parent = services.find((s: any) => s.id === it.job_service_id)
        if (parent?.department_id) D(parent.department_id, parent.dept_name).receita += v
      }
      // custos e fornecimentos internos
      for (const c of costs) {
        const v = Number(c.amount || 0)
        if (c.department_id) D(c.department_id, c.dept_name).custo += v
        // fornecimento interno: é receita no departamento fornecedor
        if (c.supplier_department_id) D(c.supplier_department_id, c.supplier_dept_name).receita += v
      }

      const porDepartamento = Object.values(dept).map(d => ({
        ...d, margem: d.receita - d.custo,
      }))

      return {
        services, items, costs, departments,
        precoCliente,                                   // total que o cliente paga (sem IVA)
        porDepartamento,                                // receita, custo e margem de cada departamento
        margemTotal: porDepartamento.reduce((a, d) => a + d.margem, 0),
      }
    })
  })

  // ── Custos de um serviço (CRUD) — só a dona nesta fase ─────
  app.get('/os/services/:sid/costs', { preHandler: [guard('pricing:manage')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`
        select sc.id, sc.department_id, sc.category, sc.label, sc.amount,
               sc.supplier_department_id, sc.parent_cost_id,
               d.name as dept_name, sd.name as supplier_dept_name
        from service_costs sc
        left join departments d on d.id = sc.department_id
        left join departments sd on sd.id = sc.supplier_department_id
        where sc.job_service_id = ${req.params.sid} and sc.tenant_id = ${req.user.tid}
        order by sc.created_at`
      return { data: rows }
    })
  })

  app.post('/os/services/:sid/costs', { preHandler: [guard('pricing:manage')] }, async (req: any, reply) => {
    const b = z.object({
      departmentId: z.string().uuid().nullable().optional(),
      category: z.enum(['labour', 'material', 'file', 'outsource', 'other']).default('other'),
      label: z.string().min(1).max(160),
      amount: z.number(),
      supplierDepartmentId: z.string().uuid().nullable().optional(),
      parentCostId: z.string().uuid().nullable().optional(),
    }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d = b.data
    return withTenant(req.user.tid, async (tx) => {
      const [svc] = await tx`select id, department_id from job_services where id = ${req.params.sid} and tenant_id = ${req.user.tid}`
      if (!svc) return reply.code(404).send({ error: 'Serviço não encontrado' })
      // por defeito o custo pertence ao departamento dono do serviço
      const deptId = d.departmentId !== undefined ? d.departmentId : svc.department_id
      const [row] = await tx`
        insert into service_costs (tenant_id, job_service_id, department_id, category, label, amount, supplier_department_id, parent_cost_id, created_by)
        values (${req.user.tid}, ${req.params.sid}, ${deptId}, ${d.category}, ${d.label.trim()}, ${d.amount},
                ${d.supplierDepartmentId ?? null}, ${d.parentCostId ?? null}, ${req.user.sub})
        returning id`
      await audit(tx, req.user.tid, req.user.sub, 'service_cost.create', 'service_cost', row.id, { label: d.label, amount: d.amount, interno: !!d.supplierDepartmentId })
      return reply.send({ ok: true, id: row.id })
    })
  })

  app.delete('/os/costs/:cid', { preHandler: [guard('pricing:manage')] }, async (req: any, reply) => {
    return withTenant(req.user.tid, async (tx) => {
      await tx`delete from service_costs where id = ${req.params.cid} and tenant_id = ${req.user.tid}`
      await audit(tx, req.user.tid, req.user.sub, 'service_cost.delete', 'service_cost', req.params.cid, {})
      return reply.send({ ok: true })
    })
  })


  // ── Itens de acompanhamento aceites num serviço ────────────
  // Materiais e consumíveis que a equipa confirmou ao adicionar o
  // serviço. Alimenta o orçamento. O preço só de pricing:manage.
  app.post('/os/services/:sid/items', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { sid } = req.params
    const b = z.object({
      items: z.array(z.object({
        kind: z.enum(['material', 'consumable']),
        label: z.string().min(1).max(160),
        qty: z.number().nullable().optional(),
        unit: z.string().max(20).nullable().optional(),
        price: z.number().nullable().optional(),
      })),
    }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const podePreco = can(req.user.perms, 'pricing:manage')
    return withTenant(req.user.tid, async (tx) => {
      const [svc] = await tx`select id from job_services where id = ${sid} and tenant_id = ${req.user.tid}`
      if (!svc) return reply.code(404).send({ error: 'Serviço não encontrado' })
      for (const it of b.data.items) {
        await tx`insert into job_service_items (tenant_id, job_service_id, kind, label, qty, unit, price)
          values (${req.user.tid}, ${sid}, ${it.kind}, ${it.label.trim()}, ${it.qty ?? null}, ${it.unit ?? null},
                  ${podePreco ? (it.price ?? null) : null})`
      }
      await audit(tx, req.user.tid, req.user.sub, 'job_service.items_add', 'job_service', sid, { n: b.data.items.length })
      return reply.send({ ok: true })
    })
  })

  app.post('/os/:joId/responsible', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    const b = z.object({ userId: z.string().uuid().nullable() }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    return withTenant(req.user.tid, async (tx) => {
      const [jo] = await tx`select id from job_orders where id = ${joId} and tenant_id = ${req.user.tid}`
      if (!jo) return reply.code(404).send({ error: 'OS não encontrada' })
      await tx`update job_orders set responsible_id = ${b.data.userId} where id = ${joId}`
      await audit(tx, req.user.tid, req.user.sub, 'os.responsible', 'job_order', joId, { userId: b.data.userId })
      return reply.send({ ok: true })
    })
  })

  // ── Executantes de um serviço (vários) ─────────────────────
  app.post('/os/services/:sid/workers', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { sid } = req.params
    const b = z.object({ userId: z.string().uuid(), isHelper: z.boolean().default(false) }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    return withTenant(req.user.tid, async (tx) => {
      const [svc] = await tx`select id from job_services where id = ${sid} and tenant_id = ${req.user.tid}`
      if (!svc) return reply.code(404).send({ error: 'Serviço não encontrado' })
      await tx`insert into job_service_workers (tenant_id, job_service_id, user_id, is_helper)
        values (${req.user.tid}, ${sid}, ${b.data.userId}, ${b.data.isHelper})
        on conflict (job_service_id, user_id) do update set is_helper = ${b.data.isHelper}`
      await audit(tx, req.user.tid, req.user.sub, 'job_service.worker_add', 'job_service', sid, { userId: b.data.userId, isHelper: b.data.isHelper })
      return reply.send({ ok: true })
    })
  })

  app.delete('/os/services/:sid/workers/:uid', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { sid, uid } = req.params
    return withTenant(req.user.tid, async (tx) => {
      await tx`delete from job_service_workers where job_service_id = ${sid} and user_id = ${uid} and tenant_id = ${req.user.tid}`
      return reply.send({ ok: true })
    })
  })

  app.post('/os/services/:sid/status', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { sid } = req.params
    const ESTADOS = ['awaiting_diagnosis','pending','in_progress','awaiting_approval','awaiting_part','on_hold','done','not_done']
    const b = z.object({
      status: z.enum(ESTADOS as [string, ...string[]]),
      reason: z.string().max(500).nullable().optional(),
      assignedTo: z.string().uuid().nullable().optional(),
    }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d = b.data
    return withTenant(req.user.tid, async (tx) => {
      const [svc] = await tx`select id, status from job_services where id = ${sid} and tenant_id = ${req.user.tid}`
      if (!svc) return reply.code(404).send({ error: 'Serviço não encontrado' })

      // "Não feito" e os recuos devem ter motivo — mas não travamos:
      // avisamos no frontend. Aqui só registamos com fidelidade.
      await tx`update job_services set
        status = ${d.status},
        status_note = ${d.reason ?? null}
        where id = ${sid}`
      if (d.assignedTo !== undefined) {
        await tx`update job_services set assigned_to = ${d.assignedTo ?? null} where id = ${sid} and tenant_id = ${req.user.tid}`
      }

      // A transição só cresce — nunca se reescreve. É o filme completo.
      await tx`insert into job_service_transitions
        (tenant_id, job_service_id, from_status, to_status, reason, changed_by)
        values (${req.user.tid}, ${sid}, ${svc.status}, ${d.status}, ${d.reason ?? null}, ${req.user.sub})`

      await audit(tx, req.user.tid, req.user.sub, 'job_service.status', 'job_service', sid,
        { de: svc.status, para: d.status, motivo: d.reason ?? null })
      return reply.send({ ok: true, status: d.status })
    })
  })

  // ── Histórico de transições de um serviço ──────────────────
  app.get('/os/services/:sid/history', { preHandler: [guard('reception:read')] }, async (req: any) => {
    const { sid } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`
        select t.from_status, t.to_status, t.reason, t.changed_at, u.full_name as by_name
        from job_service_transitions t
        left join users u on u.id = t.changed_by
        where t.job_service_id = ${sid} and t.tenant_id = ${req.user.tid}
        order by t.changed_at`
      return { history: rows }
    })
  })

  // ── Converter um achado em serviço a fazer ─────────────────
  app.post('/os/problems/:pid/to-service', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { pid } = req.params
    const b = z.object({
      typeName: z.string().min(2).max(160).optional(),   // nome do serviço; por defeito usa a descrição do achado
    }).safeParse(req.body || {})
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    return withTenant(req.user.tid, async (tx) => {
      const [p] = await tx`select id, job_order_id, description, resolved_service_id from problems where id = ${pid} and tenant_id = ${req.user.tid}`
      if (!p) return reply.code(404).send({ error: 'Achado não encontrado' })
      if (p.resolved_service_id) return reply.code(409).send({ error: 'Este achado já foi convertido em serviço' })

      const nome = (b.data.typeName || p.description).trim().slice(0, 160)
      // Cria o serviço, marcado como vindo do diagnóstico e ligado ao achado.
      const [svc] = await tx`
        insert into job_services (tenant_id, job_order_id, type_name, status, source, from_problem_id, created_by)
        values (${req.user.tid}, ${p.job_order_id}, ${nome}, 'pending', 'diagnosis', ${pid}, ${req.user.sub})
        returning id`
      // Primeira transição do serviço (histórico começa aqui).
      await tx`insert into job_service_transitions (tenant_id, job_service_id, from_status, to_status, reason, changed_by)
        values (${req.user.tid}, ${svc.id}, null, 'pending', 'Criado a partir do diagnóstico', ${req.user.sub})`
      // Marca o achado como convertido e liga-o ao serviço.
      await tx`update problems set status = 'converted', resolved_service_id = ${svc.id}, updated_at = now() where id = ${pid}`
      await audit(tx, req.user.tid, req.user.sub, 'os.problem_to_service', 'problem', pid, { serviceId: svc.id, nome })
      return reply.send({ ok: true, serviceId: svc.id })
    })
  })

  // ── Dispensar um achado (não se faz), com motivo ───────────
  app.post('/os/problems/:pid/dismiss', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { pid } = req.params
    const b = z.object({ reason: z.string().min(2).max(500) }).safeParse(req.body || {})
    if (!b.success) return reply.code(400).send({ error: 'É preciso um motivo para dispensar.' })
    return withTenant(req.user.tid, async (tx) => {
      const [p] = await tx`select id, resolved_service_id from problems where id = ${pid} and tenant_id = ${req.user.tid}`
      if (!p) return reply.code(404).send({ error: 'Achado não encontrado' })
      if (p.resolved_service_id) return reply.code(409).send({ error: 'Este achado já virou serviço — não se pode dispensar' })
      await tx`update problems set status = 'dismissed', dismiss_reason = ${b.data.reason}, updated_at = now() where id = ${pid}`
      await audit(tx, req.user.tid, req.user.sub, 'os.problem_dismiss', 'problem', pid, { motivo: b.data.reason })
      return reply.send({ ok: true })
    })
  })

  // ── Reabrir um achado dispensado (volta a decidir) ─────────
  app.post('/os/problems/:pid/reopen', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { pid } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const [p] = await tx`select id, resolved_service_id from problems where id = ${pid} and tenant_id = ${req.user.tid}`
      if (!p) return reply.code(404).send({ error: 'Achado não encontrado' })
      if (p.resolved_service_id) return reply.code(409).send({ error: 'Já virou serviço' })
      await tx`update problems set status = 'diagnosed', dismiss_reason = null, updated_at = now() where id = ${pid}`
      await audit(tx, req.user.tid, req.user.sub, 'os.problem_reopen', 'problem', pid, {})
      return reply.send({ ok: true })
    })
  })

  app.post('/os/:joId/problems', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    const schema = z.object({ description: z.string().min(2), origin: z.enum(['customer', 'team']).default('team') })
    const b = schema.safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    return withTenant(req.user.tid, async (tx) => {
      const [{ n }] = await tx`select count(*)::int as n from problems where job_order_id = ${joId}`
      const [p] = await tx`insert into problems (tenant_id, job_order_id, description, origin, sort_order, created_by)
        values (${req.user.tid}, ${joId}, ${b.data.description}, ${b.data.origin}, ${n}, ${req.user.sub}) returning id`
      await audit(tx, req.user.tid, req.user.sub, 'os.problem_add', 'job_order', joId, { origin: b.data.origin })
      return reply.code(201).send({ id: p.id })
    })
  })

  // ── Actualizar um problema (diagnóstico, estado) ────────────
  app.post('/os/problems/:pid', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { pid } = req.params
    const b = req.body as any
    return withTenant(req.user.tid, async (tx) => {
      const [p] = await tx`select id, job_order_id from problems where id = ${pid}`
      if (!p) return reply.code(404).send({ error: 'Problema não encontrado' })
      await tx`update problems set
        description = coalesce(${b.description ?? null}, description),
        diagnosis = coalesce(${b.diagnosis ?? null}, diagnosis),
        status = coalesce(${b.status ?? null}, status),
        updated_at = now() where id = ${pid}`
      await audit(tx, req.user.tid, req.user.sub, 'os.problem_update', 'problem', pid, {
        job_order_id: p.job_order_id, fields: Object.keys(b),
      })
      return reply.send({ ok: true })
    })
  })

  // ── Apagar um problema ──────────────────────────────────────
  app.delete('/os/problems/:pid', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { pid } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const [p] = await tx`select job_order_id, description from problems where id = ${pid}`
      if (!p) return reply.code(404).send({ error: 'Problema não encontrado' })
      await tx`delete from problems where id = ${pid}`
      await audit(tx, req.user.tid, req.user.sub, 'os.problem_delete', 'problem', pid, {
        job_order_id: p.job_order_id, description: p.description,
      })
      return reply.send({ ok: true })
    })
  })

  // ── Foto de evidência de um problema: URL de upload ─────────
  app.post('/os/problems/:pid/photo-url', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { pid } = req.params
    const ext = String((req.body as any).ext || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase()
    if (!['jpg', 'jpeg', 'png'].includes(ext)) return reply.code(400).send({ error: 'Só fotos' })
    return withTenant(req.user.tid, async (tx) => {
      const path = `${req.user.tid}/problems/${pid}-${Date.now()}.${ext}`
      const { data: signed, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path)
      if (error) return reply.code(500).send({ error: 'Erro no upload' })
      await tx`insert into problem_photos (tenant_id, problem_id, path) values (${req.user.tid}, ${pid}, ${path})`
      await audit(tx, req.user.tid, req.user.sub, 'os.problem_photo', 'problem', pid, {})
      return reply.send({ uploadUrl: signed.signedUrl, path })
    })
  })

  // ── Submeter diagnóstico ────────────────────────────────────
  // Se a autorização está ligada → vai para diagnosis_review (Edgar).
  // Se está desligada → avança direto para awaiting_quote.
  // ── RETIRAR A SUBMISSÃO DO DIAGNÓSTICO ─────────────────────
  // Submeter tranca a lista de problemas — e bem: não se muda o que
  // está a ser autorizado nas costas de quem autoriza. Mas quem submeteu
  // por engano (ou com um duplicado) ficava preso à espera de outra
  // pessoa recusar. Aqui puxa de volta o que é seu, enquanto ninguém agiu.
  app.post('/os/:joId/withdraw-diagnosis', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const [jo] = await tx`
        select id, number, status, diag_submitted_by from job_orders
        where id = ${joId} and tenant_id = ${req.user.tid}`
      if (!jo) return reply.code(404).send({ error: 'OS não encontrada' })
      if (jo.status !== 'diagnosis_review')
        return reply.code(409).send({ error: 'O diagnóstico não está à espera de autorização.' })
      if (jo.diag_submitted_by !== req.user.sub)
        return reply.code(403).send({ error: 'Só quem submeteu pode retirar a submissão.' })

      await tx`
        update job_orders set status = 'in_diagnosis',
          diag_submitted_by = null, diag_submitted_at = null, updated_at = now()
        where id = ${joId}`
      await logState(tx, req.user.tid, joId, 'diagnosis_review', 'in_diagnosis', req.user.sub)
      await audit(tx, req.user.tid, req.user.sub, 'os.diagnosis_withdraw', 'job_order', joId, { number: jo.number })
      return reply.send({ ok: true })
    })
  })

  app.post('/os/:joId/submit-diagnosis', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    const notes = String((req.body as any).notes || '')
    return withTenant(req.user.tid, async (tx) => {
      const [jo] = await tx`select number, status from job_orders where id = ${joId}`
      if (!jo) return reply.code(404).send({ error: 'OS não encontrada' })
      if (jo.status !== 'in_diagnosis') return reply.code(409).send({ error: 'OS não está em diagnóstico' })
      const [{ n }] = await tx`select count(*)::int as n from problems where job_order_id = ${joId}`
      if (n === 0) return reply.code(400).send({ error: 'Adiciona pelo menos um problema antes de submeter' })

      const [tenant] = await tx`select diag_authorization_on from tenants where id = ${req.user.tid}`
      const authOn = tenant?.diag_authorization_on ?? true
      const next = authOn ? 'diagnosis_review' : 'awaiting_quote'
      await tx`update job_orders set status = ${next}, diagnosis_notes = ${notes || null},
        diag_submitted_at = now(), diag_submitted_by = ${req.user.sub}, updated_at = now() where id = ${joId}`
      await logState(tx, req.user.tid, joId, 'in_diagnosis', next, req.user.sub)
      await audit(tx, req.user.tid, req.user.sub, 'os.diagnosis_submit', 'job_order', joId, { number: jo.number, authOn })
      return reply.send({ ok: true, status: next })
    })
  })

  // ── Autorizar o diagnóstico (Edgar, ou quem a oficina definir) ──
  app.post('/os/:joId/authorize-diagnosis', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    const b = req.body as any
    return withTenant(req.user.tid, async (tx) => {
      const [jo] = await tx`select number, status, diag_submitted_by from job_orders where id = ${joId}`
      if (!jo) return reply.code(404).send({ error: 'OS não encontrada' })
      if (jo.status !== 'diagnosis_review') return reply.code(409).send({ error: 'Diagnóstico não aguarda autorização' })
      // quem submeteu não pode autorizar o próprio diagnóstico
      if (jo.diag_submitted_by === req.user.sub)
        return reply.code(403).send({ error: 'Não podes autorizar o teu próprio diagnóstico' })

      if (b.approve === true) {
        // Ato interno entre pessoas com conta: o login é a assinatura.
        // Autoria, momento, auditoria e a regra de "não autorizas o teu
        // próprio diagnóstico" já garantem a prova — assinatura seria
        // redundante. (A assinatura do CLIENTE, na entrada, mantém-se.)
        await tx`update job_orders set status = 'awaiting_quote',
          diag_authorized_at = now(), diag_authorized_by = ${req.user.sub},
          updated_at = now() where id = ${joId}`
        await logState(tx, req.user.tid, joId, 'diagnosis_review', 'awaiting_quote', req.user.sub)
        await audit(tx, req.user.tid, req.user.sub, 'os.diagnosis_authorize', 'job_order', joId, { number: jo.number })
        return reply.send({ ok: true, approved: true })
      } else {
        const note = String(b.note || '')
        if (!note) return reply.code(400).send({ error: 'Motivo da recusa obrigatório' })
        await tx`update job_orders set status = 'in_diagnosis', diag_rejected_note = ${note},
          diag_submitted_at = null, updated_at = now() where id = ${joId}`
        await logState(tx, req.user.tid, joId, 'diagnosis_review', 'in_diagnosis', req.user.sub)
        await audit(tx, req.user.tid, req.user.sub, 'os.diagnosis_reject', 'job_order', joId, { number: jo.number, note })
        return reply.send({ ok: true, approved: false })
      }
    })
  })
}
