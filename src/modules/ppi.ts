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
import { generatePpiReport } from '../lib/pdf.js'

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

// Monta os dados do relatório (modelo + respostas) para uma inspeção.
// Partilhado pelo endpoint /report e pela geração de PDF.
async function buildPpiReportData(tenantId: string, id: string) {
  return withTenant(tenantId, async (tx) => {
    const [insp] = await tx`
      select i.id, i.job_order_id, i.level, i.status, i.started_at, i.done_at,
             jo.number as jo_number, jo.km_entry, v.plate, v.brand, v.model, v.year,
             c.full_name as customer_name, c.phone as customer_phone
      from ppi_inspections i
      join job_orders jo on jo.id = i.job_order_id
      join vehicles v on v.id = jo.vehicle_id
      join customers c on c.id = jo.customer_id
      where i.id = ${id} and i.tenant_id = ${tenantId}`
    if (!insp) return null
    const sections = await tx`select id, name, min_level, sort_order from ppi_sections where tenant_id = ${tenantId} and active = true order by sort_order, name`
    const points = await tx`select id, section_id, name, min_level, sort_order from ppi_points where tenant_id = ${tenantId} and active = true order by sort_order, name`
    const fields = await tx`select id, point_id, label, field_type, unit, sort_order from ppi_fields where tenant_id = ${tenantId} and active = true order by sort_order, label`
    const answers = await tx`select field_id, point_id, custom_label, value_state, value_number, value_text, value_path from ppi_answers where inspection_id = ${id}`
    const ansByField: Record<string, any> = {}
    const openByPoint: Record<string, any[]> = {}
    for (const a of answers) { if (a.field_id) ansByField[a.field_id] = a; else if (a.point_id) (openByPoint[a.point_id] ||= []).push(a) }
    const signUrl = async (p: string | null) => {
      if (!p) return null
      const { data } = await supabase.storage.from(BUCKET).createSignedUrl(p, 3600)
      return data?.signedUrl || null
    }
    const tree = []
    for (const s of sections) {
      const pts = []
      for (const p of points.filter((x: any) => x.section_id === s.id)) {
        const respostas = []
        let tem = false
        for (const f of fields.filter((x: any) => x.point_id === p.id)) {
          const a = ansByField[f.id]
          const ok = a && (a.value_state || a.value_number != null || a.value_text || a.value_path)
          if (ok) tem = true
          respostas.push({ label: f.label, type: f.field_type, unit: f.unit,
            state: a?.value_state ?? null, number: a?.value_number ?? null, text: a?.value_text ?? null,
            url: a?.value_path ? await signUrl(a.value_path) : null })
        }
        for (const o of (openByPoint[p.id] || [])) {
          tem = true
          respostas.push({ label: o.custom_label || 'Nota', type: 'open', unit: null,
            state: o.value_state ?? null, number: o.value_number ?? null, text: o.value_text ?? null,
            url: o.value_path ? await signUrl(o.value_path) : null })
        }
        if (tem) pts.push({ name: p.name, respostas })
      }
      if (pts.length) tree.push({ name: s.name, points: pts })
    }
    return { inspection: insp, sections: tree }
  })
}

export async function ppiRoutes(app: FastifyInstance) {

  // ══ ROTA PÚBLICA — relatório partilhado (SEM autenticação) ══
  // Acesso por token aleatório. Verifica expiração. Devolve APENAS
  // dados seguros: estado do carro e fotos — NUNCA dados pessoais
  // do cliente (nome, telefone). É um link partilhável.
  app.get('/public/ppi/:token', async (req: any, reply) => {
    const { token } = req.params
    if (!token || token.length < 16) return reply.code(404).send({ error: 'Link inválido' })
    // Descobrir a inspeção pelo token. As tabelas têm RLS por tenant,
    // por isso usamos o cliente service-role (ignora RLS) só para
    // resolver token → tenant. O token aleatório é a credencial.
    const { data: inspRow } = await supabase
      .from('ppi_inspections')
      .select('id, tenant_id, level, status, done_at, started_at, share_expires_at, job_order_id')
      .eq('share_token', token)
      .maybeSingle()
    if (!inspRow) return reply.code(404).send({ error: 'Relatório não encontrado' })
    if (!inspRow.share_expires_at || new Date(inspRow.share_expires_at) < new Date())
      return reply.code(410).send({ error: 'Este link expirou', expired: true })

    // Já com o tenant conhecido, o resto corre dentro do tenant (RLS ok).
    const insp: any = inspRow

    // Montar a árvore de resultados (dentro do tenant, para o RLS).
    return withTenant(insp.tenant_id, async (tx) => {
      const [extra] = await tx`
        select v.plate, v.brand, v.model, v.year, jo.km_entry,
               t.name as tenant_name, t.brand_primary_color as brand_primary, t.logo_url
        from job_orders jo
        join vehicles v on v.id = jo.vehicle_id
        join tenants t on t.id = jo.tenant_id
        where jo.id = ${insp.job_order_id}`
      Object.assign(insp, extra || {})
      const sections = await tx`select id, name, sort_order from ppi_sections where tenant_id = ${insp.tenant_id} and active = true order by sort_order, name`
      const points = await tx`select id, section_id, name, sort_order from ppi_points where tenant_id = ${insp.tenant_id} and active = true order by sort_order, name`
      const fields = await tx`select id, point_id, label, field_type, unit, sort_order from ppi_fields where tenant_id = ${insp.tenant_id} and active = true order by sort_order, label`
      const answers = await tx`select field_id, point_id, custom_label, value_state, value_number, value_text, value_path from ppi_answers where inspection_id = ${insp.id}`
      const ansByField: Record<string, any> = {}
      const openByPoint: Record<string, any[]> = {}
      for (const a of answers) { if (a.field_id) ansByField[a.field_id] = a; else if (a.point_id) (openByPoint[a.point_id] ||= []).push(a) }
      const signUrl = async (p: string | null) => {
        if (!p) return null
        const { data } = await supabase.storage.from(BUCKET).createSignedUrl(p, 3600)
        return data?.signedUrl || null
      }
      const tree = []
      for (const s of sections) {
        const pts = []
        for (const p of points.filter((x: any) => x.section_id === s.id)) {
          const respostas = []
          let tem = false
          for (const f of fields.filter((x: any) => x.point_id === p.id)) {
            const a = ansByField[f.id]
            const ok = a && (a.value_state || a.value_number != null || a.value_text || a.value_path)
            if (ok) tem = true
            respostas.push({ label: f.label, type: f.field_type, unit: f.unit,
              state: a?.value_state ?? null, number: a?.value_number ?? null, text: a?.value_text ?? null,
              url: a?.value_path ? await signUrl(a.value_path) : null })
          }
          for (const o of (openByPoint[p.id] || [])) {
            tem = true
            respostas.push({ label: o.custom_label || 'Nota', type: 'open', unit: null,
              state: o.value_state ?? null, number: o.value_number ?? null, text: o.value_text ?? null,
              url: o.value_path ? await signUrl(o.value_path) : null })
          }
          if (tem) pts.push({ name: p.name, respostas })
        }
        if (pts.length) tree.push({ name: s.name, points: pts })
      }
      // Só dados seguros — nada de cliente.
      return reply.send({
        vehicle: { plate: insp.plate, brand: insp.brand, model: insp.model, year: insp.year, km: insp.km_entry },
        level: insp.level, status: insp.status,
        date: insp.done_at || insp.started_at,
        tenant: { name: insp.tenant_name, brand: insp.brand_primary, logo: insp.logo_url },
        sections: tree,
      })
    })
  })


  // ── Modelo completo (para gestão e para montar o circuito) ──
  // Devolve secções → pontos → campos. Se vier ?level=, filtra ao nível.
  app.get('/ppi/template', { preHandler: [guard('reception:read')] }, async (req: any) => {
    const level = String(req.query?.level || '')
    return withTenant(req.user.tid, async (tx) => {
      const sections = await tx`
        select id, name, min_level, sort_order from ppi_sections
        where tenant_id = ${req.user.tid} and active = true order by sort_order, name`
      const points = await tx`
        select id, section_id, name, min_level, hint, sort_order from ppi_points
        where tenant_id = ${req.user.tid} and active = true order by sort_order, name`
      const fields = await tx`
        select id, point_id, label, field_type, unit, required, hint, sort_order from ppi_fields
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

  // ── Lista de todas as inspeções (o menu de PPIs) ────────────
  app.get('/ppi', { preHandler: [guard('reception:read')] }, async (req: any) => {
    const filtro = String(req.query?.status || '')  // '', 'in_progress', 'done'
    return withTenant(req.user.tid, async (tx) => {
      const base = tx`
        select i.id, i.job_order_id, i.level, i.status, i.started_at, i.done_at,
               jo.number as jo_number, v.plate, v.brand, v.model,
               c.full_name as customer_name,
               (select count(*) from ppi_answers a where a.inspection_id = i.id
                  and (a.value_state is not null or a.value_number is not null
                       or a.value_text is not null or a.value_path is not null)) as answered
        from ppi_inspections i
        join job_orders jo on jo.id = i.job_order_id
        join vehicles v on v.id = jo.vehicle_id
        join customers c on c.id = jo.customer_id
        where i.tenant_id = ${req.user.tid}`
      const rows = (filtro === 'in_progress' || filtro === 'done')
        ? await tx`
            select i.id, i.job_order_id, i.level, i.status, i.started_at, i.done_at,
                   jo.number as jo_number, v.plate, v.brand, v.model,
                   c.full_name as customer_name
            from ppi_inspections i
            join job_orders jo on jo.id = i.job_order_id
            join vehicles v on v.id = jo.vehicle_id
            join customers c on c.id = jo.customer_id
            where i.tenant_id = ${req.user.tid} and i.status = ${filtro}
            order by i.started_at desc`
        : await tx`
            select i.id, i.job_order_id, i.level, i.status, i.started_at, i.done_at,
                   jo.number as jo_number, v.plate, v.brand, v.model,
                   c.full_name as customer_name
            from ppi_inspections i
            join job_orders jo on jo.id = i.job_order_id
            join vehicles v on v.id = jo.vehicle_id
            join customers c on c.id = jo.customer_id
            where i.tenant_id = ${req.user.tid}
            order by (i.status = 'done'), i.started_at desc`
      return { inspections: rows }
    })
  })

  // ── Obter uma inspeção com as respostas já guardadas ────────
  app.get('/ppi/:id', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { id } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const [insp] = await tx`
        select i.id, i.job_order_id, i.level, i.status, i.started_at, i.done_at,
               i.share_token, i.share_expires_at,
               i.fuel_type, i.drivetrain, i.gearbox, i.characterised_at,
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
  // ── Caracterização do veículo (primeiro passo do workflow) ──
  app.put('/ppi/:id/characterise', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { id } = req.params
    const body = z.object({
      fuelType: z.enum(['gasolina', 'diesel', 'hibrido', 'eletrico']).nullable().optional(),
      drivetrain: z.enum(['2wd', '4x4']).nullable().optional(),
      gearbox: z.enum(['manual', 'automatica']).nullable().optional(),
    }).safeParse(req.body || {})
    if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d = body.data
    return withTenant(req.user.tid, async (tx) => {
      const [insp] = await tx`select id from ppi_inspections where id = ${id} and tenant_id = ${req.user.tid}`
      if (!insp) return reply.code(404).send({ error: 'Inspeção não encontrada' })
      await tx`
        update ppi_inspections set
          fuel_type = ${d.fuelType ?? null},
          drivetrain = ${d.drivetrain ?? null},
          gearbox = ${d.gearbox ?? null},
          characterised_at = now()
        where id = ${id}`
      return reply.send({ ok: true })
    })
  })

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
  // ── Relatório estruturado (modelo + respostas) para o cliente ─
  // Junta a árvore secções→pontos→campos com as respostas, já com
  // URLs de fotos/anexos, e só os pontos que têm alguma resposta —
  // é o que se apresenta ao comprador.
  app.get('/ppi/:id/report', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { id } = req.params
    const data = await buildPpiReportData(req.user.tid, id)
    if (!data) return reply.code(404).send({ error: 'Inspeção não encontrada' })
    return reply.send(data)
  })

  // ── Gerar o PDF do relatório e devolver o link ──────────────
  app.get('/ppi/:id/pdf', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { id } = req.params
    const reportData = await buildPpiReportData(req.user.tid, id)
    if (!reportData) return reply.code(404).send({ error: 'Inspeção não encontrada' })
    try {
      const path = await generatePpiReport(req.user.tid, id, reportData)
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600)
      if (error || !data) return reply.code(500).send({ error: 'Falha ao obter o PDF' })
      return reply.send({ url: data.signedUrl })
    } catch (e: any) {
      req.log?.error({ err: e }, 'ppi pdf falhou')
      return reply.code(500).send({ error: 'Falha ao gerar o relatório', detail: String(e?.message || e) })
    }
  })

  // ── Gerar (ou obter) o link público de partilha ────────────
  app.post('/ppi/:id/share', { preHandler: [guard('config:manage')] }, async (req: any, reply) => {
    const { id } = req.params
    const body = z.object({ days: z.number().min(1).max(365).default(30) }).safeParse(req.body || {})
    const days = body.success ? body.data.days : 30
    return withTenant(req.user.tid, async (tx) => {
      const [insp] = await tx`select id, share_token from ppi_inspections where id = ${id} and tenant_id = ${req.user.tid}`
      if (!insp) return reply.code(404).send({ error: 'Inspeção não encontrada' })
      // Token aleatório longo e não adivinhável.
      const token = insp.share_token || (await import('crypto')).randomBytes(24).toString('base64url')
      const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
      await tx`update ppi_inspections set share_token = ${token}, share_expires_at = ${expires} where id = ${id}`
      await audit(tx, req.user.tid, req.user.sub, 'ppi.share', 'ppi_inspection', id, { days })
      return reply.send({ token, expiresAt: expires })
    })
  })

  // ── Revogar o link público ──────────────────────────────────
  app.delete('/ppi/:id/share', { preHandler: [guard('config:manage')] }, async (req: any, reply) => {
    const { id } = req.params
    return withTenant(req.user.tid, async (tx) => {
      await tx`update ppi_inspections set share_token = null, share_expires_at = null where id = ${id} and tenant_id = ${req.user.tid}`
      return reply.send({ ok: true })
    })
  })

  app.post('/ppi/:id/done', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { id } = req.params
    return withTenant(req.user.tid, async (tx) => {
      await tx`update ppi_inspections set status = 'done', done_at = now() where id = ${id} and tenant_id = ${req.user.tid}`
      await audit(tx, req.user.tid, req.user.sub, 'ppi.done', 'ppi_inspection', id, {})
      return reply.send({ ok: true })
    })
  })
}
