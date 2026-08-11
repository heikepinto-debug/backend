// ============================================================
// QC de saída — controlo de qualidade antes da entrega.
//
// Fecha o buraco que deixou um carro ser entregue sem QC.
// Regra central: não se entrega sem QC aprovado (imposta aqui e
// no endpoint de entrega).
//
// O QC é feito pelo Supervisor (Yury). Login = assinatura.
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

export async function qcRoutes(app: FastifyInstance) {

  // ── Ver/abrir o QC de um carro (com os itens e respostas) ──
  app.get('/os/:joId/qc', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const [jo] = await tx`select id, status, wants_old_parts from job_orders where id = ${joId} and tenant_id = ${req.user.tid}`
      if (!jo) return reply.code(404).send({ error: 'OS não encontrada' })

      // Abre o QC se ainda não existir.
      let [check] = await tx`select id, status, reject_reason, approved_at, approved_by from qc_checks where job_order_id = ${joId} and tenant_id = ${req.user.tid}`
      if (!check) {
        [check] = await tx`insert into qc_checks (tenant_id, job_order_id) values (${req.user.tid}, ${joId})
                           returning id, status, reject_reason, approved_at, approved_by`
      }
      const items = await tx`select id, section, label, required, conditional_old_parts, sort_order from qc_items
                             where tenant_id = ${req.user.tid} and active = true order by sort_order, label`
      const answers = await tx`select qc_item_id, checked, note from qc_answers where qc_check_id = ${check.id}`
      const byItem: any = {}
      for (const a of answers) byItem[a.qc_item_id] = { checked: a.checked, note: a.note }
      const [approver] = check.approved_by
        ? await tx`select full_name from users where id = ${check.approved_by}` : [null]

      return {
        check: { ...check, approved_by_name: approver?.full_name || null },
        wantsOldParts: !!jo?.wants_old_parts,
        // um item condicional torna-se obrigatório se o cliente pediu as peças
        items: items.map((it: any) => ({
          ...it,
          required: it.required || (it.conditional_old_parts && !!jo?.wants_old_parts),
          answer: byItem[it.id] || { checked: false, note: null },
        })),
      }
    })
  })

  // ── Marcar/desmarcar um item ───────────────────────────────
  app.post('/os/:joId/qc/item', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    const b = z.object({ itemId: z.string().uuid(), checked: z.boolean(), note: z.string().max(500).nullable().optional() }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d = b.data
    return withTenant(req.user.tid, async (tx) => {
      const [check] = await tx`select id, status from qc_checks where job_order_id = ${joId} and tenant_id = ${req.user.tid}`
      if (!check) return reply.code(404).send({ error: 'QC não iniciado' })
      await tx`insert into qc_answers (tenant_id, qc_check_id, qc_item_id, checked, note, updated_at)
        values (${req.user.tid}, ${check.id}, ${d.itemId}, ${d.checked}, ${d.note ?? null}, now())
        on conflict (qc_check_id, qc_item_id) do update set checked = ${d.checked}, note = ${d.note ?? null}, updated_at = now()`
      return reply.send({ ok: true })
    })
  })

  // ── Aprovar o QC (só o supervisor / QC) ────────────────────
  // Login = assinatura: fica registado quem aprovou. Exige que os
  // itens obrigatórios estejam todos marcados.
  app.post('/os/:joId/qc/approve', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const [check] = await tx`select id from qc_checks where job_order_id = ${joId} and tenant_id = ${req.user.tid}`
      if (!check) return reply.code(404).send({ error: 'QC não iniciado' })

      // Todos os itens OBRIGATÓRIOS têm de estar marcados.
      const obrig = await tx`select id from qc_items where tenant_id = ${req.user.tid} and active = true and required = true`
      const marcados = await tx`select qc_item_id from qc_answers where qc_check_id = ${check.id} and checked = true`
      const setMarcados = new Set(marcados.map((m: any) => m.qc_item_id))
      let faltam = obrig.filter((i: any) => !setMarcados.has(i.id))

      // Regra CONDICIONAL: se o cliente pediu as peças antigas na
      // entrada (wants_old_parts), o item marcado como
      // conditional_old_parts passa a obrigatório para este carro.
      const [jo] = await tx`select wants_old_parts from job_orders where id = ${joId} and tenant_id = ${req.user.tid}`
      if (jo?.wants_old_parts) {
        const cond = await tx`select id from qc_items where tenant_id = ${req.user.tid} and active = true and conditional_old_parts = true`
        for (const c of cond) {
          if (!setMarcados.has(c.id) && !faltam.some((f: any) => f.id === c.id)) faltam.push(c)
        }
      }
      if (faltam.length) return reply.code(400).send({ error: 'Faltam verificações obrigatórias', missing: faltam.length })

      await tx`update qc_checks set status = 'approved', approved_by = ${req.user.sub}, approved_at = now(), reject_reason = null where id = ${check.id}`
      await audit(tx, req.user.tid, req.user.sub, 'qc.approve', 'qc_check', check.id, { joId, responsabilidadeAssumida: true })
      return reply.send({ ok: true, approved: true })
    })
  })

  // ── Reprovar o QC (volta para correção) ────────────────────
  app.post('/os/:joId/qc/reject', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    const b = z.object({ reason: z.string().min(2).max(500) }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'É preciso indicar o motivo.' })
    return withTenant(req.user.tid, async (tx) => {
      const [check] = await tx`select id from qc_checks where job_order_id = ${joId} and tenant_id = ${req.user.tid}`
      if (!check) return reply.code(404).send({ error: 'QC não iniciado' })
      await tx`update qc_checks set status = 'rejected', reject_reason = ${b.data.reason}, approved_by = null, approved_at = null where id = ${check.id}`
      await audit(tx, req.user.tid, req.user.sub, 'qc.reject', 'qc_check', check.id, { joId, motivo: b.data.reason })
      return reply.send({ ok: true })
    })
  })
}
