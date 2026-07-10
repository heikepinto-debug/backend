// ============================================================
// Módulo de Tarefas (to-do list hierárquica)
// Regras: cada pessoa só atribui a quem está ABAIXO na cadeia.
// Guarda was_on_time para a futura avaliação de desempenho.
// ============================================================
import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant, audit, can, supabase, BUCKET } from '../lib/core.js'

function guard(perm: string) {
  return async (req: any, reply: any) => {
    if (!can(req.user.perms, perm)) return reply.code(403).send({ error: 'Sem permissão' })
  }
}

// Nível hierárquico do utilizador = o MENOR nível entre os seus roles
async function myLevel(tx: any, userId: string): Promise<number> {
  const rows = await tx`
    select min(r.hierarchy_level) as lvl
    from user_roles ur join roles r on r.id = ur.role_id
    where ur.user_id = ${userId}`
  return rows[0]?.lvl ?? 5
}

const TaskSchema = z.object({
  title: z.string().min(2),
  description: z.string().optional(),
  assignedTo: z.string().uuid(),
  dueDate: z.string().optional(),
  priority: z.enum(['normal', 'high']).default('normal'),
  weight: z.enum(['normal', 'important', 'critical']).default('normal'),
  isPersonal: z.boolean().default(false),
  jobOrderId: z.string().uuid().optional(),
  requiresConfirmation: z.boolean().default(false),
  requiresAttachment: z.boolean().default(false),
  recurrence: z.enum(['daily', 'weekly', 'monthly']).optional(),
  recurrenceEnd: z.string().optional(),
})

export async function taskRoutes(app: FastifyInstance) {
  // ── Quem posso atribuir tarefas (só ABAIXO do meu nível) ────
  app.get('/tasks/assignable', { preHandler: [(app as any).auth] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const lvl = await myLevel(tx, req.user.sub)
      const rows = await tx`
        select distinct u.id, u.full_name,
          (select min(r.hierarchy_level) from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = u.id) as level,
          (select r.name from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = u.id order by r.hierarchy_level limit 1) as role_name
        from users u
        where u.tenant_id = ${req.user.tid} and u.id <> ${req.user.sub} and u.active
      `
      // só quem está estritamente abaixo (nível maior que o meu)
      const assignable = rows.filter((u: any) => (u.level ?? 5) > lvl)
      return { data: assignable }
    })
  })

  // ── Anexo de tarefa: pedir URL de upload ────────────────────
  app.post('/tasks/:id/attachment-url', { preHandler: [(app as any).auth] }, async (req: any, reply) => {
    const { id } = req.params
    const ext = String((req.body as any).ext || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase()
    if (!['jpg', 'jpeg', 'png', 'pdf'].includes(ext))
      return reply.code(400).send({ error: 'Só fotos ou PDF' })
    return withTenant(req.user.tid, async (tx) => {
      const [t] = await tx`select assigned_to from tasks where id = ${id}`
      if (!t) return reply.code(404).send({ error: 'Tarefa não encontrada' })
      if (t.assigned_to !== req.user.sub) return reply.code(403).send({ error: 'Sem permissão' })
      const path = `${req.user.tid}/tasks/${id}.${ext}`
      const { data: signed, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path)
      if (error) return reply.code(500).send({ error: 'Erro ao preparar upload' })
      await tx`update tasks set attachment_path = ${path} where id = ${id}`
      return reply.send({ uploadUrl: signed.signedUrl, path })
    })
  })

  // ── Criar tarefa ────────────────────────────────────────────
  app.post('/tasks', { preHandler: [(app as any).auth] }, async (req: any, reply) => {
    const body = TaskSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'Dados inválidos', details: body.error.flatten() })
    const d = body.data
    const isSelf = d.assignedTo === req.user.sub
    return withTenant(req.user.tid, async (tx) => {
      // Tarefa pessoal (para si próprio) é sempre permitida.
      // Caso contrário, valida hierarquia: o responsável tem de estar abaixo.
      if (!isSelf) {
        const myLvl = await myLevel(tx, req.user.sub)
        const targetLvl = await myLevel(tx, d.assignedTo)
        if (targetLvl <= myLvl)
          return reply.code(403).send({ error: 'Só podes atribuir tarefas a quem está abaixo de ti na equipa.' })
      }
      // O peso só o dono o define; de outros vem sempre 'normal'.
      const isOwner = can(req.user.perms, 'jobdelete:any')
      const weight = isOwner ? d.weight : 'normal'
      // Tarefa pessoal: nunca exige confirmação (seria confirmar a si próprio)
      const requiresConfirmation = isSelf ? false : d.requiresConfirmation

      const [t] = await tx`
        insert into tasks (
          tenant_id, title, description, assigned_to, assigned_by, due_date, priority,
          weight, is_personal, job_order_id, requires_confirmation, requires_attachment,
          recurrence, recurrence_end
        ) values (
          ${req.user.tid}, ${d.title}, ${d.description || null}, ${d.assignedTo}, ${req.user.sub},
          ${d.dueDate || null}, ${d.priority}, ${weight}, ${isSelf}, ${d.jobOrderId || null},
          ${requiresConfirmation}, ${d.requiresAttachment}, ${d.recurrence || null}, ${d.recurrenceEnd || null}
        ) returning id`
      await audit(tx, req.user.tid, req.user.sub, 'task.create', 'task', t.id, { title: d.title, to: d.assignedTo, personal: isSelf })
      return reply.code(201).send({ id: t.id })
    })
  })

  // ── As minhas tarefas + as que atribuí ──────────────────────
  app.get('/tasks', { preHandler: [(app as any).auth] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const mine = await tx`
        select t.*, ub.full_name as assigned_by_name, jo.number as jo_number, v.plate as jo_plate
        from tasks t join users ub on ub.id = t.assigned_by
        left join job_orders jo on jo.id = t.job_order_id
        left join vehicles v on v.id = jo.vehicle_id
        where t.tenant_id = ${req.user.tid} and t.assigned_to = ${req.user.sub}
        order by (t.status = 'done'), t.due_date nulls last, t.created_at desc`
      const assigned = await tx`
        select t.*, ua.full_name as assigned_to_name, jo.number as jo_number, v.plate as jo_plate
        from tasks t join users ua on ua.id = t.assigned_to
        left join job_orders jo on jo.id = t.job_order_id
        left join vehicles v on v.id = jo.vehicle_id
        where t.tenant_id = ${req.user.tid} and t.assigned_by = ${req.user.sub} and t.assigned_to <> ${req.user.sub}
        order by (t.status = 'done'), (t.status <> 'awaiting_confirmation'), t.due_date nulls last, t.created_at desc`
      return { mine, assigned }
    })
  })

  // ── Relatório semanal (só dono) ─────────────────────────────
  app.get('/tasks/weekly-report', { preHandler: [guard('jobdelete:any')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
      const completed = await tx`
        select t.title, t.completed_at, t.was_on_time, t.weight, ua.full_name as who
        from tasks t join users ua on ua.id = t.assigned_to
        where t.tenant_id = ${req.user.tid} and t.status = 'done'
          and t.is_personal = false and t.completed_at >= ${weekAgo}
        order by t.completed_at desc`
      const late = await tx`
        select t.title, t.due_date, ua.full_name as who
        from tasks t join users ua on ua.id = t.assigned_to
        where t.tenant_id = ${req.user.tid} and t.status <> 'done'
          and t.is_personal = false and t.due_date < now()
        order by t.due_date asc`
      const awaiting = await tx`
        select t.title, t.completed_at, ua.full_name as who
        from tasks t join users ua on ua.id = t.assigned_to
        where t.tenant_id = ${req.user.tid} and t.status = 'awaiting_confirmation'
          and t.is_personal = false
        order by t.completed_at desc`
      return { completed, late, awaiting }
    })
  })

  // ── Mudar estado de uma tarefa ──────────────────────────────
  app.post('/tasks/:id/status', { preHandler: [(app as any).auth] }, async (req: any, reply) => {
    const { id } = req.params
    const status = String((req.body as any).status || '')
    if (!['pending', 'in_progress', 'done'].includes(status))
      return reply.code(400).send({ error: 'Estado inválido' })
    return withTenant(req.user.tid, async (tx) => {
      const [t] = await tx`select assigned_to, assigned_by, due_date, requires_confirmation, requires_attachment, attachment_path from tasks where id = ${id}`
      if (!t) return reply.code(404).send({ error: 'Tarefa não encontrada' })
      if (t.assigned_to !== req.user.sub && t.assigned_by !== req.user.sub)
        return reply.code(403).send({ error: 'Sem permissão sobre esta tarefa' })

      if (status === 'done') {
        // exige anexo, se configurado
        if (t.requires_attachment && !t.attachment_path)
          return reply.code(400).send({ error: 'Esta tarefa exige um anexo antes de concluir.' })
        const onTime = t.due_date ? new Date() <= new Date(t.due_date) : true
        // se exige confirmação de quem criou, vai para awaiting_confirmation
        if (t.requires_confirmation && req.user.sub === t.assigned_to) {
          await tx`update tasks set status = 'awaiting_confirmation', completed_at = now(), was_on_time = ${onTime}, updated_at = now() where id = ${id}`
          return reply.send({ ok: true, status: 'awaiting_confirmation' })
        }
        await tx`update tasks set status = 'done', completed_at = now(), was_on_time = ${onTime}, updated_at = now() where id = ${id}`
      } else {
        await tx`update tasks set status = ${status}, completed_at = null, was_on_time = null, updated_at = now() where id = ${id}`
      }
      return reply.send({ ok: true, status })
    })
  })

  // ── Confirmar tarefa (só quem a atribuiu) ───────────────────
  app.post('/tasks/:id/confirm', { preHandler: [(app as any).auth] }, async (req: any, reply) => {
    const { id } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const [t] = await tx`select assigned_by, status from tasks where id = ${id}`
      if (!t) return reply.code(404).send({ error: 'Tarefa não encontrada' })
      if (t.assigned_by !== req.user.sub) return reply.code(403).send({ error: 'Só quem atribuiu pode confirmar' })
      if (t.status !== 'awaiting_confirmation') return reply.code(409).send({ error: 'Tarefa não aguarda confirmação' })
      await tx`update tasks set status = 'done', confirmed_by = ${req.user.sub}, confirmed_at = now(), updated_at = now() where id = ${id}`
      await audit(tx, req.user.tid, req.user.sub, 'task.confirm', 'task', id, {})
      return reply.send({ ok: true })
    })
  })

  // ── Apagar tarefa (só quem a atribuiu) ──────────────────────
  app.delete('/tasks/:id', { preHandler: [(app as any).auth] }, async (req: any, reply) => {
    const { id } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const [t] = await tx`select assigned_by from tasks where id = ${id}`
      if (!t) return reply.code(404).send({ error: 'Tarefa não encontrada' })
      if (t.assigned_by !== req.user.sub) return reply.code(403).send({ error: 'Só quem atribuiu pode apagar' })
      await tx`delete from tasks where id = ${id}`
      return reply.send({ ok: true })
    })
  })

  // ── Aviso de desempenho (mostra só a 1ª vez) ────────────────
  app.get('/tasks/perf-notice', { preHandler: [(app as any).auth] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const [u] = await tx`select perf_notice_seen from users where id = ${req.user.sub}`
      return { seen: u?.perf_notice_seen ?? true }
    })
  })
  app.post('/tasks/perf-notice/seen', { preHandler: [(app as any).auth] }, async (req: any, reply) => {
    return withTenant(req.user.tid, async (tx) => {
      await tx`update users set perf_notice_seen = true where id = ${req.user.sub}`
      return reply.send({ ok: true })
    })
  })
}
