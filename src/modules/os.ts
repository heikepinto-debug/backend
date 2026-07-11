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
    if (!can(req.user.perms, perm)) return reply.code(403).send({ error: 'Sem permissão' })
  }
}

async function logState(tx: any, tid: string, joId: string, from: string | null, to: string, by: string) {
  await tx`insert into jo_state_log (tenant_id, job_order_id, from_status, to_status, changed_by)
    values (${tid}, ${joId}, ${from}, ${to}, ${by})`
}

export async function osRoutes(app: FastifyInstance) {
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

  // ── Iniciar OS a partir de uma recepção ─────────────────────
  app.post('/os/start/:joId', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const [jo] = await tx`select id, number, status, intentions, os_opened_at from job_orders where id = ${joId}`
      if (!jo) return reply.code(404).send({ error: 'Recepção não encontrada' })
      if (jo.os_opened_at) return reply.code(409).send({ error: 'OS já foi iniciada' })
      if (jo.status === 'draft') return reply.code(400).send({ error: 'Recepção ainda é rascunho' })

      // puxa as queixas do cliente como problemas iniciais
      const intentions = typeof jo.intentions === 'string' ? JSON.parse(jo.intentions) : (jo.intentions || [])
      let order = 0
      for (const it of intentions) {
        await tx`insert into problems (tenant_id, job_order_id, description, origin, sort_order, created_by)
          values (${req.user.tid}, ${joId}, ${it}, 'customer', ${order++}, ${req.user.sub})`
      }
      await tx`update job_orders set status = 'in_diagnosis', os_opened_at = now(), os_opened_by = ${req.user.sub}, updated_at = now() where id = ${joId}`
      await logState(tx, req.user.tid, joId, jo.status, 'in_diagnosis', req.user.sub)
      await audit(tx, req.user.tid, req.user.sub, 'os.start', 'job_order', joId, { number: jo.number })
      return reply.code(201).send({ ok: true })
    })
  })

  // ── Ver a OS (dados + lista de problemas) ───────────────────
  app.get('/os/:joId', { preHandler: [guard('reception:read')] }, async (req: any) => {
    const { joId } = req.params
    return withTenant(req.user.tid, async (tx) => {
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
        where jo.id = ${joId}`
      if (!jo) return { error: 'não encontrada' }
      const problems = await tx`select * from problems where job_order_id = ${joId} order by sort_order, created_at`
      // fotos por problema
      for (const p of problems as any[]) {
        const photos = await tx`select id, path from problem_photos where problem_id = ${p.id}`
        p.photos = []
        for (const ph of photos as any[]) {
          const { data } = await supabase.storage.from(BUCKET).createSignedUrl(ph.path, 3600)
          p.photos.push({ id: ph.id, url: data?.signedUrl })
        }
      }
      const [tenant] = await tx`select diag_authorization_on from tenants where id = ${req.user.tid}`
      return { jo, problems, diagAuthorizationOn: tenant?.diag_authorization_on ?? true }
    })
  })

  // ── Adicionar um problema (achado da equipa) ────────────────
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
        if (!b.signature) return reply.code(400).send({ error: 'Assinatura obrigatória' })
        await tx`update job_orders set status = 'awaiting_quote',
          diag_authorized_at = now(), diag_authorized_by = ${req.user.sub},
          diag_auth_signature = ${b.signature}, updated_at = now() where id = ${joId}`
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
