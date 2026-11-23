// ============================================================
// "Hoje" — o ecrã de entrada (v105).
//
// Em vez de um painel igual para todos, responde a uma pergunta:
// «o que está à minha espera?». Cada bloco só aparece a quem o pode
// resolver (pelas permissões do papel, nunca pelo nome do papel —
// cada oficina configura os seus papéis).
// ============================================================
import { FastifyInstance } from 'fastify'
import { withTenant, can } from '../lib/core.js'

export async function todayRoutes(app: FastifyInstance) {
  app.get('/today', async (req: any, reply) => {
    try { await req.jwtVerify() } catch { return reply.code(401).send({ error: 'Não autenticado' }) }
    const perms = req.user.perms
    if (!can(perms, 'reception:read')) return reply.code(403).send({ error: 'Sem permissão', needed: 'reception:read' })
    const tid = req.user.tid, me = req.user.sub
    const dono = can(perms, 'pricing:manage')

    return withTenant(tid, async (tx) => {
      // Carros na oficina, já com a fase "humana" calculada.
      const cars = await tx`
        select jo.id, jo.number, jo.status, jo.payment_status, jo.diag_submitted_by,
               v.plate, v.brand, v.model, c.full_name as customer,
               (qc.status = 'approved') as qc_ok,
               greatest(jo.updated_at,
                 coalesce((select max(l.changed_at) from jo_state_log l where l.job_order_id = jo.id), jo.updated_at),
                 coalesce((select max(t.changed_at) from job_service_transitions t
                           join job_services s on s.id = t.job_service_id where s.job_order_id = jo.id), jo.updated_at)
               ) as last_move
        from job_orders jo
        left join vehicles v on v.id = jo.vehicle_id
        left join customers c on c.id = jo.customer_id
        left join qc_checks qc on qc.job_order_id = jo.id and qc.tenant_id = jo.tenant_id
        where jo.tenant_id = ${tid} and jo.status not in ('draft','delivered','cancelled')
        order by jo.received_at`

      const fase = (r: any) =>
        ['awaiting_diagnosis', 'in_diagnosis', 'diagnosis_review', 'reception'].includes(r.status) ? 'diagnosis'
        : ['awaiting_quote', 'quote_sent'].includes(r.status) ? 'quote'
        : ['approved', 'in_progress'].includes(r.status) ? 'working'
        : r.status === 'quality_check' || (r.status === 'ready' && !r.qc_ok) ? 'qc'
        : 'ready'
      const pipeline: Record<string, number> = { diagnosis: 0, quote: 0, working: 0, qc: 0, ready: 0 }
      for (const r of cars) pipeline[fase(r)]++

      const mini = (r: any) => ({ id: r.id, plate: r.plate, brand: r.brand, model: r.model })
      const needs: any[] = []
      const add = (key: string, lista: any[], extra: any = {}) => {
        if (lista.length) needs.push({ key, count: lista.length, cars: lista.slice(0, 3).map(mini), ...extra })
      }

      // Dar preço ao orçamento — só quem define preços.
      if (dono) add('price', cars.filter((r: any) => r.status === 'awaiting_quote'))

      // Autorizar diagnósticos submetidos por outra pessoa.
      if (can(perms, 'os:manage'))
        add('authorize', cars.filter((r: any) => r.status === 'diagnosis_review' && r.diag_submitted_by !== me))

      // Controlo de qualidade por fazer.
      if (can(perms, 'qc:approve')) add('qc', cars.filter((r: any) => fase(r) === 'qc'))

      // Prontos e por cobrar.
      if (can(perms, 'payment:register')) {
        const lista = cars.filter((r: any) => fase(r) === 'ready' && r.payment_status !== 'paid')
        let total: number | null = null
        if (lista.length) {
          const ids = lista.map((r: any) => r.id)
          const [t] = await tx`
            select coalesce((select sum(coalesce(s.price,0)) from job_services s
                             where s.job_order_id = any(${ids}) and s.tenant_id = ${tid} and s.status <> 'not_done'),0)
                 + coalesce((select sum(coalesce(i.price,0)) from job_service_items i join job_services s on s.id = i.job_service_id
                             where s.job_order_id = any(${ids}) and s.tenant_id = ${tid} and s.status <> 'not_done'),0) as total`
          total = Number(t?.total || 0)
        }
        add('collect', lista, { total })
      }

      // Lançamentos da equipa por validar — só o dono.
      if (dono) {
        const [p] = await tx`select count(*)::int as n from ledger_entries where tenant_id = ${tid} and pending_review = true`
        if (p?.n) needs.push({ key: 'ledger', count: p.n, cars: [] })
      }

      // Recepção: marcações de hoje (ou em atraso) e entradas por acabar.
      if (can(perms, 'reception:create')) {
        const [b] = await tx`
          select count(*) filter (where booking_date is not null and coalesce(booking_status,'') <> 'cancelled'
                                    and booking_date::date <= current_date)::int as bookings,
                 count(*) filter (where booking_date is null)::int as drafts
          from job_orders where tenant_id = ${tid} and status = 'draft'`
        if (b?.bookings) needs.push({ key: 'bookings', count: b.bookings, cars: [] })
        if (b?.drafts) needs.push({ key: 'drafts', count: b.drafts, cars: [] })
      }

      // Os meus serviços por fazer (quem está atribuído ao trabalho).
      const meus = await tx`
        select distinct jo.id, v.plate, v.brand, v.model
        from job_service_workers w
        join job_services s on s.id = w.job_service_id
        join job_orders jo on jo.id = s.job_order_id
        left join vehicles v on v.id = jo.vehicle_id
        where w.tenant_id = ${tid} and w.user_id = ${me}
          and s.status not in ('done','not_done')
          and jo.status not in ('draft','delivered','cancelled','ready')`
      if (meus.length) needs.push({ key: 'mine', count: meus.length, cars: meus.slice(0, 3).map(mini) })

      // ── PENDENTES PARADOS ──────────────────────────────────────
      // Carros, marcações e entradas por acabar sem movimento há mais dias
      // do que o prazo da oficina. Cada um precisa de tratamento: avançar
      // ou ser justificado (a justificação caduca). Só para quem gere.
      let stale: any = null
      if (can(perms, 'os:manage')) {
        const [{ stale_days: prazo }] = await tx`select stale_days from tenants where id = ${tid}`
        const agora = Date.now()
        const dias = (d: any) => Math.floor((agora - new Date(d).getTime()) / 86400000)
        const drafts = await tx`
          select jo.id, jo.number, jo.booking_date, jo.updated_at, v.plate, v.brand, v.model, c.full_name as customer
          from job_orders jo left join vehicles v on v.id = jo.vehicle_id left join customers c on c.id = jo.customer_id
          where jo.tenant_id = ${tid} and jo.status = 'draft' and coalesce(jo.booking_status, '') <> 'cancelled'`
        const todos = [
          ...cars.map((r: any) => ({ ...mini(r), number: r.number, customer: r.customer, status: r.status, kind: 'car', days: dias(r.last_move), since: r.last_move })),
          ...drafts.map((r: any) => r.booking_date
            ? { ...mini(r), number: r.number, customer: r.customer, status: 'draft', kind: 'booking', days: dias(r.booking_date), since: r.booking_date }
            : { ...mini(r), number: r.number, customer: r.customer, status: 'draft', kind: 'draft', days: dias(r.updated_at), since: r.updated_at }),
        ].filter((r: any) => r.days >= prazo)
        const acks = todos.length ? await tx`
          select distinct on (a.job_order_id) a.job_order_id, a.reason, a.note, a.snooze_until, a.created_at, u.full_name as by_name
          from stale_acks a left join users u on u.id = a.user_id
          where a.tenant_id = ${tid} and a.job_order_id = any(${todos.map((r: any) => r.id)}) and a.snooze_until > now()
          order by a.job_order_id, a.created_at desc` : []
        const porId = new Map<string, any>(acks.map((a: any) => [a.job_order_id, a] as [string, any]))
        const untreated: any[] = [], treated: any[] = []
        for (const r of todos.sort((a: any, b: any) => b.days - a.days)) {
          const a: any = porId.get(r.id)
          // só vale a justificação dada DEPOIS do último movimento
          if (a && new Date(a.created_at).getTime() >= new Date(r.since).getTime())
            treated.push({ ...r, reason: a.reason, note: a.note, until: a.snooze_until, by: a.by_name })
          else untreated.push(r)
        }
        stale = { days: prazo, untreated, treated }
      }

      return { inShop: cars.length, pipeline, needs, stale }
    })
  })
}
