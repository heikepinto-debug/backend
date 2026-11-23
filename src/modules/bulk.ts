// ============================================================
// Pendentes parados (tratamento) e acções em massa (v107)
//
// PARADOS — a gestão tem de dar tratamento a tudo o que está sem
// movimento há mais dias do que o prazo da oficina: ou faz avançar,
// ou justifica (motivo + até quando). A justificação caduca.
//
// EM MASSA — só o dono: fechar ou arquivar vários carros de uma vez
// (limpar o que ficou para trás e já nem está na oficina).
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

export async function bulkRoutes(app: FastifyInstance) {

  // Justificar um pendente parado.
  app.post('/stale/:joId/ack', { preHandler: [guard('os:manage')] }, async (req: any, reply) => {
    const p = z.object({ reason: z.string().trim().min(2).max(80), note: z.string().trim().max(300).nullable().optional(),
      days: z.number().int().min(1).max(14) }).safeParse(req.body)
    if (!p.success) return reply.code(400).send({ error: 'Escolhe o motivo e quando voltar a lembrar.' })
    const d = p.data
    return withTenant(req.user.tid, async (tx) => {
      const [jo] = await tx`select id, number from job_orders where id = ${req.params.joId} and tenant_id = ${req.user.tid}`
      if (!jo) return reply.code(404).send({ error: 'Não encontrado' })
      await tx`insert into stale_acks (tenant_id, job_order_id, user_id, reason, note, snooze_until)
               values (${req.user.tid}, ${jo.id}, ${req.user.sub}, ${d.reason}, ${d.note || null}, now() + make_interval(days => ${d.days}))`
      await audit(tx, req.user.tid, req.user.sub, 'stale.ack', 'job_order', jo.id, { number: jo.number, motivo: d.reason, dias: d.days })
      return reply.send({ ok: true })
    })
  })

  // Acções em massa (só dono): 'deliver' fecha como entregue; 'archive'
  // cancela (sai das listas, fica no histórico). Nada é apagado.
  app.post('/receptions/bulk', { preHandler: [guard('jobdelete:any')] }, async (req: any, reply) => {
    const p = z.object({ ids: z.array(z.string().uuid()).min(1).max(100), action: z.enum(['deliver', 'archive']) }).safeParse(req.body)
    if (!p.success) return reply.code(400).send({ error: 'Selecciona entre 1 e 100 carros.' })
    const { ids, action } = p.data
    const tid = req.user.tid, by = req.user.sub
    return withTenant(tid, async (tx) => {
      const alvo = await tx`select id, number, status from job_orders where tenant_id = ${tid} and id = any(${ids})
                            and status not in ('delivered', 'cancelled')`
      let feitos = 0
      for (const jo of alvo) {
        if (action === 'deliver' && jo.status === 'draft') continue   // um rascunho nunca entrou — só se arquiva
        if (action === 'deliver') {
          // Mesma arrumação do "marcar como finalizada": nada fica pendurado.
          await tx`
            with alvo as (
              select id, status from job_services where job_order_id = ${jo.id} and tenant_id = ${tid} and status not in ('done','not_done') for update
            ), fechados as (
              update job_services s set status = 'done' from alvo where s.id = alvo.id returning s.id, alvo.status as de
            )
            insert into job_service_transitions (tenant_id, job_service_id, from_status, to_status, reason, changed_by)
            select ${tid}, id, de, 'done', 'Fechado em massa pelo dono', ${by} from fechados`
          await tx`update problems set status = 'dismissed', updated_at = now()
                   where job_order_id = ${jo.id} and tenant_id = ${tid} and status not in ('converted','dismissed')`
          if (['diagnosis_review', 'in_diagnosis', 'awaiting_diagnosis'].includes(jo.status))
            await tx`update job_orders set diag_submitted_at = null, diag_submitted_by = null where id = ${jo.id} and tenant_id = ${tid}`
          await tx`update job_orders set status = 'delivered', updated_at = now() where id = ${jo.id} and tenant_id = ${tid}`
        } else {
          await tx`update job_orders set status = 'cancelled', updated_at = now() where id = ${jo.id} and tenant_id = ${tid}`
        }
        await tx`insert into jo_state_log (tenant_id, job_order_id, from_status, to_status, changed_by)
                 values (${tid}, ${jo.id}, ${jo.status}, ${action === 'deliver' ? 'delivered' : 'cancelled'}, ${by})`
        await audit(tx, tid, by, action === 'deliver' ? 'reception.bulk_deliver' : 'reception.bulk_archive', 'job_order', jo.id, { number: jo.number, from: jo.status })
        feitos++
      }
      return reply.send({ ok: true, done: feitos, skipped: ids.length - feitos })
    })
  })
}
