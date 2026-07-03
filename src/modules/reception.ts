// ============================================================
// OFICINAHUB — Módulo M1: Recepção blindada
// Clientes · Viaturas · Job Orders · Fotos · Assinatura · Sync
// ============================================================
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant, audit, can, supabase, BUCKET, sql } from '../lib/core.js'

// Guard: exige permissão + módulo M1 activo
function guard(perm: string) {
  return async (req: any, reply: any) => {
    try { await req.jwtVerify() } catch { return reply.code(401).send({ error: 'Não autenticado' }) }
    if (!can(req.user.perms, perm))
      return reply.code(403).send({ error: 'Sem permissão', needed: perm })
    const [m] = await sql`
      select 1 from tenant_modules
      where tenant_id = ${req.user.tid} and module_code = 'M1' and active`
    if (!m) return reply.code(402).send({ error: 'Módulo M1 não activo neste plano' })
  }
}

const ReceptionSchema = z.object({
  offlineId: z.string().optional(),
  businessUnitId: z.string().uuid(),
  source: z.enum(['walkin','phone','whatsapp','website','app','manual']).default('walkin'),
  customer: z.object({
    id: z.string().uuid().optional(),          // cliente existente
    fullName: z.string().min(2).optional(),    // ou novo cliente
    phone: z.string().min(6).optional(),
    email: z.string().email().optional().or(z.literal('')),
    nif: z.string().optional(),
  }),
  vehicle: z.object({
    id: z.string().uuid().optional(),
    plate: z.string().min(3),
    brand: z.string().optional(),
    model: z.string().optional(),
    year: z.number().int().optional(),
    color: z.string().optional(),
  }),
  kmEntry: z.number().int().min(0),
  fuelLevel: z.number().int().min(0).max(8),
  reportedIssues: z.string().optional(),
  declaredValuables: z.string().min(1),        // obrigatório — mesmo "nenhum"
  checklist: z.record(z.boolean()).default({}),
  damageZones: z.array(z.string()).default([]),
  serviceType: z.string().optional(),
  serviceDescription: z.string().min(3),
  priority: z.enum(['normal','urgent']).default('normal'),
  estimatedDelivery: z.string().optional(),
  termsVersion: z.string(),
  termsAcceptedAt: z.string(),
})

export async function receptionRoutes(app: FastifyInstance) {

  // ── CLIENTES ────────────────────────────────────────────────
  app.get('/customers/search', { preHandler: [guard('customer:read')] }, async (req: any) => {
    const q = String((req.query as any).q || '').trim()
    if (q.length < 2) return { data: [] }
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`
        select id, full_name, phone, email,
          (select count(*) from job_orders jo where jo.customer_id = c.id) as visits
        from customers c
        where full_name ilike ${'%' + q + '%'} or phone ilike ${'%' + q + '%'}
        order by full_name limit 10`
      return { data: rows }
    })
  })

  // ── JOB ORDER: criação completa da recepção blindada ───────
  app.post('/receptions', { preHandler: [guard('reception:create')] }, async (req: any, reply) => {
    const body = ReceptionSchema.safeParse(req.body)
    if (!body.success)
      return reply.code(400).send({ error: 'Dados incompletos', details: body.error.flatten() })
    const d = body.data

    return withTenant(req.user.tid, async (tx) => {
      // Idempotência offline: se offlineId já existe, devolve a JO existente
      if (d.offlineId) {
        const [existing] = await tx`
          select id, number from job_orders where offline_id = ${d.offlineId}`
        if (existing) return reply.send({ id: existing.id, number: existing.number, duplicate: true })
      }

      // Cliente: usar existente ou criar
      let customerId = d.customer.id
      if (!customerId) {
        if (!d.customer.fullName || !d.customer.phone)
          return reply.code(400).send({ error: 'Nome e telemóvel do cliente são obrigatórios' })
        const [c] = await tx`
          insert into customers (tenant_id, full_name, phone, email, nif, created_by)
          values (${req.user.tid}, ${d.customer.fullName}, ${d.customer.phone},
                  ${d.customer.email || null}, ${d.customer.nif || null}, ${req.user.sub})
          returning id`
        customerId = c.id
      }
      if (!customerId) return reply.code(400).send({ error: 'Cliente inválido' })

      // Viatura: usar existente, encontrar por matrícula, ou criar
      let vehicleId = d.vehicle.id
      if (!vehicleId) {
        const plate = d.vehicle.plate.toUpperCase().trim()
        const [v] = await tx`
          insert into vehicles (tenant_id, customer_id, plate, brand, model, year, color)
          values (${req.user.tid}, ${customerId}, ${plate},
                  ${d.vehicle.brand || null}, ${d.vehicle.model || null},
                  ${d.vehicle.year || null}, ${d.vehicle.color || null})
          on conflict (tenant_id, plate) do update set customer_id = ${customerId}
          returning id`
        vehicleId = v.id
      }
      if (!vehicleId) return reply.code(400).send({ error: 'Viatura inválida' })

      // Gerar número da JO
      const [{ next_jo_number: number }] = await tx`
        select next_jo_number(${req.user.tid})`

      const [jo] = await tx`
        insert into job_orders (
          tenant_id, business_unit_id, number, customer_id, vehicle_id,
          status, source, km_entry, fuel_level, reported_issues,
          declared_valuables, checklist, damage_zones,
          service_type, service_description, priority, estimated_delivery,
          received_by, offline_id, terms_version, terms_accepted_at
        ) values (
          ${req.user.tid}, ${d.businessUnitId}, ${number}, ${customerId}, ${vehicleId},
          'awaiting_quote', ${d.source}, ${d.kmEntry}, ${d.fuelLevel},
          ${d.reportedIssues || null}, ${d.declaredValuables},
          ${JSON.stringify(d.checklist)}, ${JSON.stringify(d.damageZones)},
          ${d.serviceType || null}, ${d.serviceDescription}, ${d.priority},
          ${d.estimatedDelivery || null}, ${req.user.sub}, ${d.offlineId || null},
          ${d.termsVersion}, ${d.termsAcceptedAt}
        ) returning id, number`

      await audit(tx, req.user.tid, req.user.sub, 'reception.create', 'job_order', jo.id, {
        number: jo.number, source: d.source, km: d.kmEntry,
      })

      return reply.code(201).send({ id: jo.id, number: jo.number })
    })
  })

  // ── FOTOS: gerar URL assinada para upload directo ao Storage ──
  // O tablet faz upload directo para o Supabase Storage (não passa pelo backend
  // — mais rápido, menos carga). O backend só gera a autorização e regista.
  app.post('/receptions/:joId/photos/presign', { preHandler: [guard('reception:create')] },
    async (req: any, reply) => {
      const body = z.object({
        zone: z.string(),
        isRequired: z.boolean().default(false),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        offlineId: z.string().optional(),
        contentType: z.string().default('image/jpeg'),
      }).safeParse(req.body)
      if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' })
      const { joId } = req.params
      const d = body.data

      const path = `${req.user.tid}/${joId}/${d.zone}-${Date.now()}.jpg`
      const { data: signed, error } = await supabase.storage
        .from(BUCKET).createSignedUploadUrl(path)
      if (error) return reply.code(500).send({ error: 'Falha ao preparar upload' })

      // Regista metadados imediatamente (a foto chega directo ao Storage)
      return withTenant(req.user.tid, async (tx) => {
        const [photo] = await tx`
          insert into reception_photos
            (tenant_id, job_order_id, zone, is_required, storage_path,
             latitude, longitude, offline_id)
          values (${req.user.tid}, ${joId}, ${d.zone}, ${d.isRequired}, ${path},
                  ${d.latitude || null}, ${d.longitude || null}, ${d.offlineId || null})
          returning id`
        return reply.send({
          photoId: photo.id,
          uploadUrl: signed.signedUrl,
          token: signed.token,
          path,
        })
      })
    })

  // ── ASSINATURA: guarda o PNG da assinatura e sela a JO ──────
  app.post('/receptions/:joId/sign', { preHandler: [guard('reception:create')] },
    async (req: any, reply) => {
      const body = z.object({
        signatureBase64: z.string().min(100),   // PNG data-url sem prefixo
      }).safeParse(req.body)
      if (!body.success) return reply.code(400).send({ error: 'Assinatura em falta' })
      const { joId } = req.params

      const path = `${req.user.tid}/${joId}/signature-${Date.now()}.png`
      const buffer = Buffer.from(body.data.signatureBase64, 'base64')
      const { error } = await supabase.storage.from(BUCKET)
        .upload(path, buffer, { contentType: 'image/png' })
      if (error) return reply.code(500).send({ error: 'Falha ao guardar assinatura' })

      return withTenant(req.user.tid, async (tx) => {
        // Validação de integridade: exige 6 fotos obrigatórias antes de selar
        const [{ count }] = await tx`
          select count(*) from reception_photos
          where job_order_id = ${joId} and is_required = true`
        if (Number(count) < 6)
          return reply.code(422).send({
            error: `Só ${count} de 6 fotos obrigatórias — a JO não pode ser selada sem elas`,
          })

        await tx`
          update job_orders
          set signature_url = ${path}, signed_at = now()
          where id = ${joId}`

        await audit(tx, req.user.tid, req.user.sub, 'reception.sign', 'job_order', joId, {
          requiredPhotos: Number(count),
        })
        return reply.send({ ok: true, sealed: true })
      })
    })

  // ── LISTAR / DETALHE ───────────────────────────────────────
  app.get('/receptions', { preHandler: [guard('reception:read')] }, async (req: any) => {
    const q = req.query as any
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`
        select jo.id, jo.number, jo.status, jo.priority, jo.source,
               jo.km_entry, jo.received_at, jo.signed_at,
               v.plate, v.brand, v.model,
               c.full_name as customer_name, c.phone as customer_phone,
               u.full_name as received_by_name,
               (select count(*) from reception_photos p where p.job_order_id = jo.id) as photo_count
        from job_orders jo
        join vehicles v on v.id = jo.vehicle_id
        join customers c on c.id = jo.customer_id
        left join users u on u.id = jo.received_by
        where (${q.status || null}::text is null or jo.status = ${q.status || null})
        order by jo.received_at desc
        limit ${Math.min(Number(q.limit) || 30, 100)}`
      return { data: rows }
    })
  })

  app.get('/receptions/:joId', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const [jo] = await tx`
        select jo.*, v.plate, v.brand, v.model, v.year, v.color,
               c.full_name as customer_name, c.phone as customer_phone,
               u.full_name as received_by_name
        from job_orders jo
        join vehicles v on v.id = jo.vehicle_id
        join customers c on c.id = jo.customer_id
        left join users u on u.id = jo.received_by
        where jo.id = ${joId}`
      if (!jo) return reply.code(404).send({ error: 'JO não encontrada' })

      const photos = await tx`
        select id, zone, is_required, storage_path, latitude, longitude, taken_at
        from reception_photos where job_order_id = ${joId} order by taken_at`

      // URLs temporárias de visualização (1h)
      const withUrls = await Promise.all(photos.map(async (p: any) => {
        const { data } = await supabase.storage.from(BUCKET)
          .createSignedUrl(p.storage_path, 3600)
        return { ...p, url: data?.signedUrl }
      }))

      let signatureUrl = null
      if (jo.signature_url) {
        const { data } = await supabase.storage.from(BUCKET)
          .createSignedUrl(jo.signature_url, 3600)
        signatureUrl = data?.signedUrl
      }

      return { ...jo, photos: withUrls, signatureViewUrl: signatureUrl }
    })
  })

  // ── TERMOS ACTIVOS (para o tablet mostrar) ─────────────────
  app.get('/terms/active', { preHandler: [guard('reception:read')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const [t] = await tx`
        select version, content, parking_fee, parking_grace_hours
        from terms_versions where active order by created_at desc limit 1`
      return t || null
    })
  })

  // ── UNIDADES do tenant ─────────────────────────────────────
  app.get('/business-units', { preHandler: [guard('reception:read')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`
        select id, type, name from business_units where active order by name`
      return { data: rows }
    })
  })

  // ── SYNC OFFLINE: recebe lote do tablet ────────────────────
  app.post('/sync/push', { preHandler: [guard('reception:create')] }, async (req: any, reply) => {
    const body = z.object({
      items: z.array(z.object({
        offlineId: z.string(),
        entityType: z.literal('reception'),
        payload: z.record(z.unknown()),
      })).max(50),
    }).safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'Lote inválido' })

    const results: any[] = []
    for (const item of body.data.items) {
      try {
        // Reaproveitar a rota de criação via injecção interna
        const res = await app.inject({
          method: 'POST', url: '/receptions',
          headers: { authorization: req.headers.authorization },
          payload: { ...item.payload, offlineId: item.offlineId },
        })
        const data = res.json()
        results.push({
          offlineId: item.offlineId,
          status: res.statusCode < 300 ? 'ok' : 'error',
          joId: data.id, number: data.number, error: data.error,
        })
      } catch (e: any) {
        results.push({ offlineId: item.offlineId, status: 'error', error: e.message })
      }
    }
    return reply.send({ results })
  })
}
