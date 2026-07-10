// ============================================================
// Módulo de Tarefas (to-do list hierárquica)
// Regras: cada pessoa só atribui a quem está ABAIXO na cadeia.
// Guarda was_on_time para a futura avaliação de desempenho.
// ============================================================
import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant, audit, can } from '../lib/core.js'

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

  // ── Criar tarefa ────────────────────────────────────────────
  app.post('/tasks', { preHandler: [(app as any).auth] }, async (req: any, reply) => {
    const body = TaskSchema.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'Dados inválidos', details: body.error.flatten() })
    const d = body.data
    return withTenant(req.user.tid, async (tx) => {
      // valida hierarquia: o responsável tem de estar abaixo de quem atribui
      const myLvl = await myLevel(tx, req.user.sub)
      const targetLvl = await myLevel(tx, d.assignedTo)
      if (targetLvl <= myLvl)
        return reply.code(403).send({ error: 'Só podes atribuir tarefas a quem está abaixo de ti na equipa.' })

      const [t] = await tx`
        insert into tasks (tenant_id, title, description, assigned_to, assigned_by, due_date, priority)
        values (${req.user.tid}, ${d.title}, ${d.description || null}, ${d.assignedTo}, ${req.user.sub}, ${d.dueDate || null}, ${d.priority})
        returning id`
      await audit(tx, req.user.tid, req.user.sub, 'task.create', 'task', t.id, { title: d.title, to: d.assignedTo })
      return reply.code(201).send({ id: t.id })
    })
  })

  // ── As minhas tarefas + as que atribuí ──────────────────────
  app.get('/tasks', { preHandler: [(app as any).auth] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const mine = await tx`
        select t.*, ub.full_name as assigned_by_name
        from tasks t join users ub on ub.id = t.assigned_by
        where t.tenant_id = ${req.user.tid} and t.assigned_to = ${req.user.sub}
        order by (t.status = 'done'), t.due_date nulls last, t.created_at desc`
      const assigned = await tx`
        select t.*, ua.full_name as assigned_to_name
        from tasks t join users ua on ua.id = t.assigned_to
        where t.tenant_id = ${req.user.tid} and t.assigned_by = ${req.user.sub} and t.assigned_to <> ${req.user.sub}
        order by (t.status = 'done'), t.due_date nulls last, t.created_at desc`
      return { mine, assigned }
    })
  })

  // ── Mudar estado de uma tarefa ──────────────────────────────
  app.post('/tasks/:id/status', { preHandler: [(app as any).auth] }, async (req: any, reply) => {
    const { id } = req.params
    const status = String((req.body as any).status || '')
    if (!['pending', 'in_progress', 'done'].includes(status))
      return reply.code(400).send({ error: 'Estado inválido' })
    return withTenant(req.user.tid, async (tx) => {
      const [t] = await tx`select assigned_to, assigned_by, due_date from tasks where id = ${id}`
      if (!t) return reply.code(404).send({ error: 'Tarefa não encontrada' })
      // só o responsável ou quem atribuiu podem mexer
      if (t.assigned_to !== req.user.sub && t.assigned_by !== req.user.sub)
        return reply.code(403).send({ error: 'Sem permissão sobre esta tarefa' })

      if (status === 'done') {
        const onTime = t.due_date ? new Date() <= new Date(t.due_date) : true
        await tx`update tasks set status = 'done', completed_at = now(), was_on_time = ${onTime}, updated_at = now() where id = ${id}`
      } else {
        await tx`update tasks set status = ${status}, completed_at = null, was_on_time = null, updated_at = now() where id = ${id}`
      }
      return reply.send({ ok: true, status })
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
