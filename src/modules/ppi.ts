// ============================================================
// Módulo PPI — Inspeção Pré-Compra
//   · modelo (secções/pontos/campos) filtrado por nível
//   · iniciar inspeção a partir de uma entrada
//   · guardar respostas CAMPO A CAMPO (autosave — nada se perde)
//   · anexos (foto/ficheiro PDF) via presign, como as fotos da entrada
// O PPI vive à parte da OS: é inspeção, não reparação.
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

// Ordem dos níveis para o filtro cumulativo: um PPI 'premium' mostra
// tudo o que é 'basic', 'standard' e 'premium'.
const LEVEL_RANK: Record<string, number> = { basic: 1, standard: 2, premium: 3 }
const includesLevel = (chosen: string, min: string) =>
  (LEVEL_RANK[chosen] || 1) >= (LEVEL_RANK[min] || 1)

export async function ppiRoutes(app: FastifyInstance) {

  // ── Modelo completo (para gestão e para montar o circuito) ──
  // Devolve secções → pontos → campos. Se vier ?level=, filtra ao nível.
  app.get('/ppi/template', { preHandler: [guard('reception:read')] }, async (req: any) => {
    const level = String(req.query?.level || '')
    return withTenant(req.user.tid, async (tx) => {
      const sections = await tx`
        select id, name, min_level, sort_order from ppi_sections
        where tenant_id = ${req.user.tid} and active = true order by sort_order, name`
      const points = await tx`
        select id, section_id, name, min_level, sort_order from ppi_points
        where tenant_id = ${req.user.tid} and active = true order by sort_order, name`
      const fields = await tx`
        select id, point_id, label, field_type, unit, required, sort_order from ppi_fields
        where tenant_id = ${req.user.tid} and active = true order by sort_order, label`

      // Montar árvore, filtrando por nível se pedido.
      const okSec = (s: any) => !level || includesLevel(level, s.min_level)
      const okPt = (p: any) => !level || includesLevel(level, p.min_level)
      const tree = sections.filter(okSec).map((s: any) => ({
        ...s,
        points: points.filter((p: any) => p.section_id === s.id && okPt(p)).map((p: any) => ({
          ...p,
          fields: fields.filter((f: any) => f.point_id === p.id),
        })),
      })).filter((s: any) => s.points.length > 0)
      return { sections: tree }
    })
  })

  // ── Iniciar (ou obter) a inspeção de uma entrada ────────────
  app.post('/ppi/start', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const body = z.object({
      jobOrderId: z.string().uuid(),
      level: z.enum(['basic', 'standard', 'premium']).default('standard'),
    }).safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const { jobOrderId, level } = body.data
    return withTenant(req.user.tid, async (tx) => {
      // Uma inspeção por entrada — se já existe, devolve-a (não duplica).
      const [existe] = await tx`
        select id, level, status from ppi_inspections
        where job_order_id = ${jobOrderId} and tenant_id = ${req.user.tid} limit 1`
      if (existe) return reply.send(existe)
      // Nível a partir do serviço PPI escolhido na entrada ("PPI — Standard").
      // Se não der para inferir, usa o nível pedido (por omissão, standard).
      const [svc] = await tx`
        select type_name from job_services
        where job_order_id = ${jobOrderId} and type_name ilike '%PPI%' limit 1`
      let lvl = level
      const nome = (svc?.type_name || '').toLowerCase()
      if (nome.includes('premium')) lvl = 'premium'
      else if (nome.includes('básico') || nome.includes('basico')) lvl = 'basic'
      else if (nome.includes('standard')) lvl = 'standard'
      const [insp] = await tx`
        insert into ppi_inspections (tenant_id, job_order_id, level, started_by)
        values (${req.user.tid}, ${jobOrderId}, ${lvl}, ${req.user.sub})
        returning id, level, status`
      await audit(tx, req.user.tid, req.user.sub, 'ppi.start', 'ppi_inspection', insp.id, { level: lvl })
      return reply.send(insp)
    })
  })

  // ── Mudar o nível (upgrade a meio) ──────────────────────────
  app.patch('/ppi/:id/level', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { id } = req.params
    const body = z.object({ level: z.enum(['basic', 'standard', 'premium']) }).safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'Nível inválido' })
    return withTenant(req.user.tid, async (tx) => {
      await tx`update ppi_inspections set level = ${body.data.level} where id = ${id} and tenant_id = ${req.user.tid}`
      await audit(tx, req.user.tid, req.user.sub, 'ppi.level_change', 'ppi_inspection', id, { level: body.data.level })
      return reply.send({ ok: true })
    })
  })

  // ── Obter uma inspeção com as respostas já guardadas ────────
  app.get('/ppi/:id', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { id } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const [insp] = await tx`
        select i.id, i.job_order_id, i.level, i.status, i.started_at, i.done_at,
               jo.number as jo_number, v.plate, v.brand, v.model, c.full_name as customer_name
        from ppi_inspections i
        join job_orders jo on jo.id = i.job_order_id
        join vehicles v on v.id = jo.vehicle_id
        join customers c on c.id = jo.customer_id
        where i.id = ${id} and i.tenant_id = ${req.user.tid}`
      if (!insp) return reply.code(404).send({ error: 'Inspeção não encontrada' })
      const answers = await tx`
        select field_id, point_id, custom_label, value_state, value_number, value_text, value_path
        from ppi_answers where inspection_id = ${id}`
      // URLs assinadas para anexos guardados.
      const withUrls = await Promise.all(answers.map(async (a: any) => {
        let url = null
        if (a.value_path) {
          const { data } = await supabase.storage.from(BUCKET).createSignedUrl(a.value_path, 3600)
          url = data?.signedUrl || null
        }
        return { ...a, value_url: url }
      }))
      return reply.send({ ...insp, answers: withUrls })
    })
  })

  // ── AUTOSAVE de uma resposta (campo a campo) ────────────────
  // O coração do "nada se perde": cada valor sobe assim que se mete.
  // Upsert por (inspection_id, field_id) — a última resposta manda.
  app.put('/ppi/:id/answer', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { id } = req.params
    const body = z.object({
      fieldId: z.string().uuid().optional(),      // ausente = campo aberto
      pointId: z.string().uuid().optional(),
      customLabel: z.string().optional(),          // para campos abertos
      valueState: z.enum(['bom', 'aceitavel', 'mau', 'na']).nullable().optional(),
      valueNumber: z.number().nullable().optional(),
      valueText: z.string().nullable().optional(),
      valuePath: z.string().nullable().optional(), // caminho do anexo já subido
    }).safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d = body.data
    return withTenant(req.user.tid, async (tx) => {
      if (d.fieldId) {
        // Campo do modelo: upsert pela chave única (inspection, field).
        await tx`
          insert into ppi_answers (tenant_id, inspection_id, field_id, point_id, value_state, value_number, value_text, value_path, updated_by, updated_at)
          values (${req.user.tid}, ${id}, ${d.fieldId}, ${d.pointId || null},
                  ${d.valueState ?? null}, ${d.valueNumber ?? null}, ${d.valueText ?? null}, ${d.valuePath ?? null},
                  ${req.user.sub}, now())
          on conflict (inspection_id, field_id) do update set
            value_state = ${d.valueState ?? null}, value_number = ${d.valueNumber ?? null},
            value_text = ${d.valueText ?? null},
            value_path = coalesce(${d.valuePath ?? null}, ppi_answers.value_path),
            updated_by = ${req.user.sub}, updated_at = now()`
      } else {
        // Campo aberto (sem field_id): insere sempre um novo registo.
        await tx`
          insert into ppi_answers (tenant_id, inspection_id, point_id, custom_label, value_state, value_number, value_text, value_path, updated_by)
          values (${req.user.tid}, ${id}, ${d.pointId || null}, ${d.customLabel || null},
                  ${d.valueState ?? null}, ${d.valueNumber ?? null}, ${d.valueText ?? null}, ${d.valuePath ?? null}, ${req.user.sub})`
      }
      return reply.send({ ok: true })
    })
  })

  // ── Presign para anexo (foto ou ficheiro PDF) ───────────────
  app.post('/ppi/:id/attach/presign', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { id } = req.params
    const body = z.object({
      fieldId: z.string().uuid(),
      contentType: z.string().default('image/jpeg'),
    }).safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const ext = body.data.contentType.includes('pdf') ? 'pdf'
      : body.data.contentType.includes('png') ? 'png' : 'jpg'
    const path = `${req.user.tid}/ppi/${id}/${body.data.fieldId}-${Date.now()}.${ext}`
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path)
    if (error) return reply.code(500).send({ error: 'Falha ao preparar upload' })
    return reply.send({ uploadUrl: data.signedUrl, path })
  })

  // ── Concluir a inspeção ─────────────────────────────────────
  app.post('/ppi/:id/done', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { id } = req.params
    return withTenant(req.user.tid, async (tx) => {
      await tx`update ppi_inspections set status = 'done', done_at = now() where id = ${id} and tenant_id = ${req.user.tid}`
      await audit(tx, req.user.tid, req.user.sub, 'ppi.done', 'ppi_inspection', id, {})
      return reply.send({ ok: true })
    })
  })
}
