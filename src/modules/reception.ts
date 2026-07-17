// ============================================================
// OFICINAHUB — Módulo M1: Recepção blindada
// Clientes · Viaturas · Job Orders · Fotos · Assinatura · Sync
// ============================================================
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant, audit, can, supabase, BUCKET, sql } from '../lib/core.js'
import { generateEntryPdf } from '../lib/pdf.js'

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
    vin: z.string().optional(),               // identidade permanente do carro
  }),
  isNonRunner: z.boolean().default(false),    // entrou sem funcionar
  kmEntry: z.number().int().min(0).optional(),          // pode ficar pendente (bateria em baixo)
  entryPendingReason: z.string().min(3).optional(),    // porquê — obrigatório se o KM ficar por registar
  fuelLevel: z.number().int().min(0).max(8),
  reportedIssues: z.string().optional(),
  declaredValuables: z.string().min(1),        // obrigatório — mesmo "nenhum"
  checklist: z.record(z.boolean()).default({}),
  batteryReference: z.string().optional(),                  // referência da bateria
  systemsCheck: z.record(z.enum(['ok','fail','untested'])).default({}),  // verificação de sistemas
  wantsOldParts: z.boolean().optional(),                    // quer as peças antigas
  damageZones: z.array(z.object({
    id: z.string(),                 // liga à foto do dano (zone = 'damage-<id>')
    area: z.string(),               // ex: 'Porta esquerda', 'Jante diant. dir.'
    note: z.string().optional(),
  })).default([]),
  // Intenção do cliente: várias, livres, sem trancar sector.
  // O serviço "a sério" define-se depois no diagnóstico.
  intentions: z.array(z.string().min(1)).min(1),   // ex: ['Barulho na frente','Quer Stage 2']
  serviceDescription: z.string().optional(),        // notas gerais adicionais
  priority: z.enum(['normal','urgent']).default('normal'),
  estimatedDelivery: z.string().optional(),
  bookingDate: z.string().optional(),               // marcação do cliente (opcional)
  termsVersion: z.string(),
  termsAcceptedAt: z.string(),
})

// Rascunho: só cliente + viatura são obrigatórios; o resto é livre.
const DraftSchema = z.object({
  draftId: z.string().uuid().optional(),            // se existe, actualiza
  businessUnitId: z.string().uuid(),
  source: z.enum(['walkin','phone','whatsapp','website','app','manual']).default('walkin'),
  customer: z.object({
    id: z.string().uuid().optional(),
    fullName: z.string().min(2).optional(),
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
    vin: z.string().optional(),               // identidade permanente do carro
  }),
  isNonRunner: z.boolean().default(false),    // entrou sem funcionar
  entryPendingReason: z.string().min(3).optional(),   // km/painel por registar
  kmEntry: z.number().int().min(0).optional(),
  fuelLevel: z.number().int().min(0).max(8).optional(),
  declaredValuables: z.string().optional(),
  checklist: z.record(z.boolean()).default({}),
  batteryReference: z.string().optional(),
  systemsCheck: z.record(z.enum(['ok','fail','untested'])).default({}),
  wantsOldParts: z.boolean().optional(),
  damageZones: z.array(z.object({
    id: z.string(), area: z.string(), note: z.string().optional(),
  })).default([]),
  intentions: z.array(z.string()).default([]),
  serviceDescription: z.string().optional(),
  bookingDate: z.string().optional(),
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

  // ── VIATURAS de um cliente (atalho p/ cliente recorrente) ──
  app.get('/customers/:customerId/vehicles', { preHandler: [guard('customer:read')] },
    async (req: any) => {
      const { customerId } = req.params
      return withTenant(req.user.tid, async (tx) => {
        const rows = await tx`
          select v.id, v.plate, v.brand, v.model, v.year, v.color,
            (select max(jo.received_at) from job_orders jo where jo.vehicle_id = v.id) as last_visit
          from vehicles v
          where v.customer_id = ${customerId}
          order by last_visit desc nulls last`
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

      // Finalizar um rascunho existente? (mantém o mesmo registo e número)
      const draftId = (req.body as any).draftId as string | undefined

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
          insert into vehicles (tenant_id, customer_id, plate, brand, model, year, color, vin)
          values (${req.user.tid}, ${customerId}, ${plate},
                  ${d.vehicle.brand || null}, ${d.vehicle.model || null},
                  ${d.vehicle.year || null}, ${d.vehicle.color || null},
                  ${d.vehicle.vin || null})
          on conflict (tenant_id, plate) do update set customer_id = ${customerId},
            vin = coalesce(excluded.vin, vehicles.vin)
          returning id`
        vehicleId = v.id
      }
      if (!vehicleId) return reply.code(400).send({ error: 'Viatura inválida' })

      // Caso A: finalizar um rascunho existente → actualiza e sela
      if (draftId) {
        const [existing] = await tx`
          select id, number, status from job_orders where id = ${draftId}`
        if (existing && existing.status === 'draft') {
          const [jo] = await tx`
            update job_orders set
              business_unit_id = ${d.businessUnitId}, customer_id = ${customerId}, vehicle_id = ${vehicleId},
              status = 'awaiting_diagnosis', source = ${d.source},
              km_entry = ${d.kmEntry}, fuel_level = ${d.fuelLevel},
              declared_valuables = ${d.declaredValuables},
              checklist = ${JSON.stringify(d.checklist)}, damage_zones = ${JSON.stringify(d.damageZones)},
              battery_reference = ${d.batteryReference || null}, systems_check = ${JSON.stringify(d.systemsCheck)},
              wants_old_parts = ${d.wantsOldParts ?? null},
              is_non_runner = ${d.isNonRunner},
              non_runner_accepted_at = ${d.isNonRunner ? new Date().toISOString() : null},
              entry_pending_reason = ${d.entryPendingReason || null},
              intentions = ${JSON.stringify(d.intentions)}, service_description = ${d.serviceDescription || null},
              priority = ${d.priority}, booking_date = ${d.bookingDate || null},
              received_by = ${req.user.sub}, received_at = now(),
              terms_version = ${d.termsVersion}, terms_accepted_at = ${d.termsAcceptedAt},
              updated_at = now()
            where id = ${draftId}
            returning id, number, draft_created_by`
          await audit(tx, req.user.tid, req.user.sub, 'reception.finalize_draft', 'job_order', jo.id, {
            number: jo.number, started_by: jo.draft_created_by, finalized_by: req.user.sub,
          })
          return reply.code(201).send({ id: jo.id, number: jo.number })
        }
      }

      // Caso B: nova entrada de raiz
      const [{ next_jo_number: number }] = await tx`
        select next_jo_number(${req.user.tid})`

      const [jo] = await tx`
        insert into job_orders (
          tenant_id, business_unit_id, number, customer_id, vehicle_id,
          status, source, km_entry, fuel_level, reported_issues,
          declared_valuables, checklist, damage_zones,
          battery_reference, systems_check, wants_old_parts,
          intentions, service_description, priority, estimated_delivery,
          booking_date, received_by, offline_id, terms_version, terms_accepted_at,
          is_non_runner, non_runner_accepted_at, entry_pending_reason
        ) values (
          ${req.user.tid}, ${d.businessUnitId}, ${number}, ${customerId}, ${vehicleId},
          'awaiting_diagnosis', ${d.source}, ${d.kmEntry}, ${d.fuelLevel},
          ${d.reportedIssues || null}, ${d.declaredValuables},
          ${JSON.stringify(d.checklist)}, ${JSON.stringify(d.damageZones)},
          ${d.batteryReference || null}, ${JSON.stringify(d.systemsCheck)}, ${d.wantsOldParts ?? null},
          ${JSON.stringify(d.intentions)}, ${d.serviceDescription || null}, ${d.priority},
          ${d.estimatedDelivery || null}, ${d.bookingDate || null}, ${req.user.sub}, ${d.offlineId || null},
          ${d.termsVersion}, ${d.termsAcceptedAt},
          ${d.isNonRunner}, ${d.isNonRunner ? new Date().toISOString() : null},
          ${d.entryPendingReason || null}
        ) returning id, number`

      await audit(tx, req.user.tid, req.user.sub, 'reception.create', 'job_order', jo.id, {
        number: jo.number, source: d.source, km: d.kmEntry,
      })

      return reply.code(201).send({ id: jo.id, number: jo.number })
    })
  })

  // ── GUARDAR RASCUNHO (cliente+viatura mínimo; resto livre) ──
  app.post('/receptions/draft', { preHandler: [guard('reception:create')] }, async (req: any, reply) => {
    const body = DraftSchema.safeParse(req.body)
    if (!body.success)
      return reply.code(400).send({ error: 'Cliente e viatura são o mínimo para guardar', details: body.error.flatten() })
    const d = body.data
    return withTenant(req.user.tid, async (tx) => {
      // Cliente
      let customerId = d.customer.id
      if (!customerId) {
        if (!d.customer.fullName || !d.customer.phone)
          return reply.code(400).send({ error: 'Nome e telemóvel do cliente são obrigatórios' })
        const [c] = await tx`
          insert into customers (tenant_id, full_name, phone, email, created_by)
          values (${req.user.tid}, ${d.customer.fullName}, ${d.customer.phone}, ${d.customer.email || null}, ${req.user.sub})
          returning id`
        customerId = c.id
      }
      // Viatura
      let vehicleId = d.vehicle.id
      if (!vehicleId) {
        const plate = d.vehicle.plate.toUpperCase().trim()
        const [v] = await tx`
          insert into vehicles (tenant_id, customer_id, plate, brand, model, year, vin)
          values (${req.user.tid}, ${customerId}, ${plate}, ${d.vehicle.brand || null}, ${d.vehicle.model || null}, ${d.vehicle.year || null}, ${d.vehicle.vin || null})
          on conflict (tenant_id, plate) do update set customer_id = ${customerId},
            vin = coalesce(excluded.vin, vehicles.vin)
          returning id`
        vehicleId = v.id
      }

      // Actualiza rascunho existente ou cria novo
      if (d.draftId) {
        const [existing] = await tx`select id, number, status from job_orders where id = ${d.draftId}`
        if (existing && existing.status === 'draft') {
          await tx`
            update job_orders set
              business_unit_id = ${d.businessUnitId}, customer_id = ${customerId}, vehicle_id = ${vehicleId},
              source = ${d.source}, km_entry = ${d.kmEntry ?? null}, fuel_level = ${d.fuelLevel ?? 4},
              declared_valuables = ${d.declaredValuables || ''},
              checklist = ${JSON.stringify(d.checklist)}, damage_zones = ${JSON.stringify(d.damageZones)},
              battery_reference = ${d.batteryReference || null}, systems_check = ${JSON.stringify(d.systemsCheck)},
              wants_old_parts = ${d.wantsOldParts ?? null},
              is_non_runner = ${d.isNonRunner ?? false},
              entry_pending_reason = ${d.entryPendingReason || null},
              intentions = ${JSON.stringify(d.intentions)}, service_description = ${d.serviceDescription || null},
              booking_date = ${d.bookingDate || null}, updated_at = now()
            where id = ${d.draftId}`
          return reply.send({ id: existing.id, number: existing.number, draft: true })
        }
      }
      const [{ next_jo_number: number }] = await tx`select next_jo_number(${req.user.tid})`
      const [jo] = await tx`
        insert into job_orders (
          tenant_id, business_unit_id, number, customer_id, vehicle_id, status, source,
          km_entry, fuel_level, declared_valuables, checklist, damage_zones,
          battery_reference, systems_check, wants_old_parts,
          is_non_runner, entry_pending_reason,
          intentions, service_description, booking_date, draft_created_by, draft_created_at
        ) values (
          ${req.user.tid}, ${d.businessUnitId}, ${number}, ${customerId}, ${vehicleId}, 'draft', ${d.source},
          ${d.kmEntry ?? null}, ${d.fuelLevel ?? 4}, ${d.declaredValuables || ''},
          ${JSON.stringify(d.checklist)}, ${JSON.stringify(d.damageZones)},
          ${d.batteryReference || null}, ${JSON.stringify(d.systemsCheck)}, ${d.wantsOldParts ?? null},
          ${d.isNonRunner ?? false}, ${d.entryPendingReason || null},
          ${JSON.stringify(d.intentions)}, ${d.serviceDescription || null}, ${d.bookingDate || null},
          ${req.user.sub}, now()
        ) returning id, number`
      if (d.bookingDate) await tx`update job_orders set booking_status = 'scheduled' where id = ${jo.id}`
      await audit(tx, req.user.tid, req.user.sub, 'reception.draft_save', 'job_order', jo.id, { number: jo.number })
      return reply.send({ id: jo.id, number: jo.number, draft: true })
    })
  })

  // ── CARREGAR RASCUNHO para retomar ──────────────────────────
  app.get('/receptions/:joId/draft', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const [jo] = await tx`
        select j.*, c.id as customer_id, c.full_name as customer_name, c.phone as customer_phone, c.email as customer_email,
          v.id as vehicle_id, v.plate, v.brand, v.model, v.year
        from job_orders j
        join customers c on c.id = j.customer_id
        join vehicles v on v.id = j.vehicle_id
        where j.id = ${joId}`
      if (!jo) return reply.code(404).send({ error: 'Rascunho não encontrado' })

      // Fotos já carregadas neste rascunho. Sem isto, quem retoma não sabe
      // o que já fez e volta a fotografar tudo (ou perde o trabalho todo).
      const photos = await tx`
        select id, zone, storage_path, is_required from reception_photos
        where job_order_id = ${joId}`
      const comUrl = await Promise.all(photos.map(async (p: any) => {
        const { data } = await supabase.storage.from(BUCKET).createSignedUrl(p.storage_path, 3600)
        return { id: p.id, zone: p.zone, isRequired: p.is_required, url: data?.signedUrl || null }
      }))
      return reply.send({ data: jo, photos: comUrl })
    })
  })

  // ── MUDAR ESTADO MANUALMENTE — só o dono (temporário) ───────
  app.post('/receptions/:joId/status', { preHandler: [guard('jobdelete:any')] }, async (req: any, reply) => {
    const { joId } = req.params
    const status = String((req.body as any).status || '')
    const allowed = ['awaiting_diagnosis','awaiting_quote','quote_sent','approved','in_progress','quality_check','ready','delivered']
    if (!allowed.includes(status)) return reply.code(400).send({ error: 'Estado inválido' })
    return withTenant(req.user.tid, async (tx) => {
      const [jo] = await tx`select number, status from job_orders where id = ${joId}`
      if (!jo) return reply.code(404).send({ error: 'Entrada não encontrada' })
      await tx`update job_orders set status = ${status}::jo_status, updated_at = now() where id = ${joId}`
      await audit(tx, req.user.tid, req.user.sub, 'reception.status_change', 'job_order', joId, { from: jo.status, to: status })
      return reply.send({ ok: true, status })
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
        // Uma zona = uma foto. Se já houver foto nesta zona (rascunho retomado
        // e refotografado), a nova substitui — senão acumulavam-se duplicados
        // e o retomar não saberia qual mostrar.
        const antigas = await tx`
          select id, storage_path from reception_photos
          where job_order_id = ${joId} and zone = ${d.zone}`
        if (antigas.length) {
          await tx`delete from reception_photos where job_order_id = ${joId} and zone = ${d.zone}`
          // Limpa também o ficheiro, para não deixar lixo no Storage.
          const paths = antigas.map((a: any) => a.storage_path).filter(Boolean)
          if (paths.length) await supabase.storage.from(BUCKET).remove(paths).catch(() => {})
        }
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
  // ── BI: verificar se já temos este número na base ───────────
  app.get('/identity/:biNumber', { preHandler: [guard('reception:create')] }, async (req: any) => {
    const biNumber = String(req.params.biNumber || '').trim()
    if (!biNumber) return { found: false }
    return withTenant(req.user.tid, async (tx) => {
      const [doc] = await tx`select full_name, doc_path from identity_docs
        where bi_number = ${biNumber} limit 1`
      return doc ? { found: true, fullName: doc.full_name, hasPhoto: !!doc.doc_path } : { found: false }
    })
  })

  app.post('/receptions/:joId/sign', { preHandler: [guard('reception:create')] },
    async (req: any, reply) => {
      const body = z.object({
        signatureBase64: z.string().min(100),   // PNG data-url sem prefixo
        signerIsOwner: z.boolean().default(true),
        signerName: z.string().optional(),
        signerRelation: z.string().optional(),
        signerBiNumber: z.string().optional(),
      }).safeParse(req.body)
      if (!body.success) return reply.code(400).send({ error: 'Assinatura em falta' })
      const { joId } = req.params

      const path = `${req.user.tid}/${joId}/signature-${Date.now()}.png`
      const buffer = Buffer.from(body.data.signatureBase64, 'base64')
      const { error } = await supabase.storage.from(BUCKET)
        .upload(path, buffer, { contentType: 'image/png' })
      if (error) return reply.code(500).send({ error: 'Falha ao guardar assinatura' })

      return withTenant(req.user.tid, async (tx) => {
        // Validação de integridade: exige as fotos obrigatórias antes de selar.
        // O frontend já garante todas as fotos; isto é uma rede de segurança
        // contra selar uma JO sem fotos nenhumas.
        const [{ count }] = await tx`
          select count(*) from reception_photos
          where job_order_id = ${joId} and is_required = true`
        if (Number(count) < 9)
          return reply.code(422).send({
            error: `Só ${count} fotos obrigatórias — a JO não pode ser selada sem elas`,
          })

        await tx`
          update job_orders
          set signature_url = ${path}, signed_at = now(),
              signer_is_owner = ${body.data.signerIsOwner},
              signer_name = ${body.data.signerName || null},
              signer_relation = ${body.data.signerRelation || null},
              signer_bi_number = ${body.data.signerBiNumber || null}
          where id = ${joId}`

        await audit(tx, req.user.tid, req.user.sub, 'reception.sign', 'job_order', joId, {
          requiredPhotos: Number(count), signerIsOwner: body.data.signerIsOwner,
        })
        // O PDF de entrada é gerado sob procura (quando alguém o abre), não aqui —
        // gerá-lo agora obrigava a descarregar as 14 fotos e bloqueava a finalização
        // durante muito tempo. A resposta volta imediatamente após selar a assinatura.
        return reply.send({ ok: true, sealed: true })
      })
    })

  // ── FOTO DO DOCUMENTO DE IDENTIFICAÇÃO ─────────────────────
  app.post('/receptions/:joId/id-document', { preHandler: [guard('reception:create')] },
    async (req: any, reply) => {
      const body = z.object({
        imageBase64: z.string().min(100),
        biNumber: z.string().optional(),
        fullName: z.string().optional(),
      }).safeParse(req.body)
      if (!body.success) return reply.code(400).send({ error: 'Imagem em falta' })
      const { joId } = req.params
      const path = `${req.user.tid}/${joId}/id-document-${Date.now()}.jpg`
      const buffer = Buffer.from(body.data.imageBase64, 'base64')
      const { error } = await supabase.storage.from(BUCKET)
        .upload(path, buffer, { contentType: 'image/jpeg' })
      if (error) return reply.code(500).send({ error: 'Falha ao guardar documento' })
      return withTenant(req.user.tid, async (tx) => {
        await tx`update job_orders set id_document_path = ${path} where id = ${joId}`
        // guarda na base de BIs (uma vez por número), se veio o número
        if (body.data.biNumber) {
          await tx`insert into identity_docs (tenant_id, bi_number, full_name, doc_path)
            values (${req.user.tid}, ${body.data.biNumber}, ${body.data.fullName || ''}, ${path})
            on conflict (tenant_id, bi_number) do update set doc_path = excluded.doc_path,
              full_name = case when identity_docs.full_name = '' then excluded.full_name else identity_docs.full_name end`
        }
        await audit(tx, req.user.tid, req.user.sub, 'reception.id_document', 'job_order', joId, {})
        return reply.send({ ok: true })
      })
    })

  // ── EXPORTAR / DESCARREGAR O PDF DE ENTRADA ────────────────
  app.get('/receptions/:joId/pdf', { preHandler: [guard('reception:read')] },
    async (req: any, reply) => {
      const { joId } = req.params
      return withTenant(req.user.tid, async (tx) => {
        const [jo] = await tx`select entry_pdf_path from job_orders where id = ${joId}`
        let path = jo?.entry_pdf_path
        if (!path) {                                  // ainda não gerado — gera agora
          try { path = await generateEntryPdf(req.user.tid, joId) }
          catch { return reply.code(500).send({ error: 'Falha ao gerar o PDF' }) }
        }
        const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600)
        if (error || !data) return reply.code(500).send({ error: 'Falha ao obter o PDF' })
        return reply.send({ url: data.signedUrl })
      })
    })

  // ── LISTAR / DETALHE ───────────────────────────────────────
  app.get('/receptions', { preHandler: [guard('reception:read')] }, async (req: any) => {
    const q = req.query as any
    const search = String(q.search || '').trim()
    const like = search ? `%${search}%` : null
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`
        select jo.id, jo.number, jo.status, jo.priority, jo.source,
               jo.km_entry, jo.received_at, jo.signed_at, jo.deletion_status,
               jo.is_non_runner, jo.entry_pending_reason, jo.entry_completed_at,
               jo.deletion_reason,
               jo.priority_level, jo.priority_reason, jo.priority_rank,
               jo.os_opened_at,
               v.plate, v.brand, v.model,
               c.full_name as customer_name, c.phone as customer_phone,
               u.full_name as received_by_name,
               ur.full_name as deletion_requested_by_name,
               (select count(*) from reception_photos p where p.job_order_id = jo.id) as photo_count
        from job_orders jo
        join vehicles v on v.id = jo.vehicle_id
        join customers c on c.id = jo.customer_id
        left join users u on u.id = jo.received_by
        left join users ur on ur.id = jo.deletion_requested_by
        where jo.status <> 'cancelled'
          and (${q.status || null}::text is null or jo.status = ${q.status || null})
          and (${like}::text is null
               or v.plate ilike ${like}
               or c.full_name ilike ${like}
               or jo.number ilike ${like})
        order by jo.received_at desc
        limit ${Math.min(Number(q.limit) || 50, 100)}`
      return { data: rows }
    })
  })

  // ── APAGAR entrada — só o dono ─────────────────────────────
  // Modo seguro (default): marca como cancelada, fica no audit trail.
  // Modo definitivo (?hard=true): remove mesmo da base de dados.
  app.delete('/receptions/:joId', { preHandler: [guard('jobdelete:any')] },
    async (req: any, reply) => {
      const { joId } = req.params
      const hard = String((req.query as any).hard || '') === 'true'
      return withTenant(req.user.tid, async (tx) => {
        const [jo] = await tx`select number, entry_pdf_path from job_orders where id = ${joId}`
        if (!jo) return reply.code(404).send({ error: 'Entrada não encontrada' })

        if (hard) {
          // apaga fotos do storage
          const photos = await tx`select storage_path from reception_photos where job_order_id = ${joId}`
          const paths = photos.map((p: any) => p.storage_path).filter(Boolean)
          if (jo.entry_pdf_path) paths.push(jo.entry_pdf_path)
          if (paths.length) { try { await supabase.storage.from(BUCKET).remove(paths) } catch {} }
          await tx`delete from reception_photos where job_order_id = ${joId}`
          await tx`delete from job_orders where id = ${joId}`
          await audit(tx, req.user.tid, req.user.sub, 'reception.hard_delete', 'job_order', joId, { number: jo.number })
        } else {
          await tx`update job_orders set status = 'cancelled', updated_at = now() where id = ${joId}`
          await audit(tx, req.user.tid, req.user.sub, 'reception.cancel', 'job_order', joId, { number: jo.number })
        }
        return reply.send({ ok: true, deleted: hard })
      })
    })

  // ── MARCAÇÕES: lista os rascunhos com data de marcação ──────
  app.get('/bookings', { preHandler: [guard('reception:read')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`
        select jo.id, jo.number, jo.booking_date, jo.booking_status, jo.status,
               jo.cancel_reason, jo.intentions,
               v.plate, v.brand, v.model,
               c.full_name as customer_name, c.phone as customer_phone
        from job_orders jo
        join vehicles v on v.id = jo.vehicle_id
        join customers c on c.id = jo.customer_id
        where jo.tenant_id = ${req.user.tid}
          and jo.booking_date is not null
          and jo.status = 'draft'
          and coalesce(jo.booking_status, '') <> 'cancelled'
        order by jo.booking_date asc`
      return { data: rows }
    })
  })

  // ── MARCAÇÕES: remarcar (mudar a data) ──────────────────────
  app.post('/bookings/:joId/reschedule', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    const newDate = String((req.body as any).bookingDate || '')
    if (!newDate) return reply.code(400).send({ error: 'Nova data em falta' })
    return withTenant(req.user.tid, async (tx) => {
      const [jo] = await tx`select number, booking_date from job_orders where id = ${joId} and status = 'draft'`
      if (!jo) return reply.code(404).send({ error: 'Marcação não encontrada' })
      await tx`update job_orders set booking_date = ${newDate}, booking_status = 'scheduled', updated_at = now() where id = ${joId}`
      await audit(tx, req.user.tid, req.user.sub, 'booking.reschedule', 'job_order', joId, {
        number: jo.number, from: jo.booking_date, to: newDate,
      })
      return reply.send({ ok: true })
    })
  })

  // ── MARCAÇÕES: cancelar (com motivo obrigatório) ────────────
  app.post('/bookings/:joId/cancel', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    const reason = String((req.body as any).reason || '')
    const note = String((req.body as any).note || '')
    if (!reason) return reply.code(400).send({ error: 'Motivo obrigatório' })
    return withTenant(req.user.tid, async (tx) => {
      const [jo] = await tx`select number from job_orders where id = ${joId} and status = 'draft'`
      if (!jo) return reply.code(404).send({ error: 'Marcação não encontrada' })
      await tx`update job_orders set booking_status = 'cancelled', cancel_reason = ${reason},
        cancel_reason_note = ${note || null}, cancelled_by = ${req.user.sub}, cancelled_at = now(),
        updated_at = now() where id = ${joId}`
      await audit(tx, req.user.tid, req.user.sub, 'booking.cancel', 'job_order', joId, {
        number: jo.number, reason, note,
      })
      return reply.send({ ok: true })
    })
  })

  // ── ELIMINAÇÃO: pedir (qualquer recepção, com motivo) ───────
  app.post('/receptions/:joId/request-deletion', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    const reason = String((req.body as any).reason || '')
    if (!reason) return reply.code(400).send({ error: 'Motivo obrigatório' })
    return withTenant(req.user.tid, async (tx) => {
      const [jo] = await tx`select number, deletion_status from job_orders where id = ${joId}`
      if (!jo) return reply.code(404).send({ error: 'Entrada não encontrada' })
      if (jo.deletion_status === 'pending') return reply.code(409).send({ error: 'Já existe um pedido pendente' })
      await tx`update job_orders set deletion_status = 'pending', deletion_reason = ${reason},
        deletion_requested_by = ${req.user.sub}, deletion_requested_at = now(), updated_at = now()
        where id = ${joId}`
      await audit(tx, req.user.tid, req.user.sub, 'deletion.request', 'job_order', joId, { number: jo.number, reason })
      return reply.send({ ok: true })
    })
  })

  // ── ELIMINAÇÃO: lista de pedidos pendentes (só dono) ────────
  app.get('/deletion-requests', { preHandler: [guard('jobdelete:any')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`
        select jo.id, jo.number, jo.deletion_reason, jo.deletion_requested_at,
               u.full_name as requested_by_name,
               v.plate, c.full_name as customer_name
        from job_orders jo
        join vehicles v on v.id = jo.vehicle_id
        join customers c on c.id = jo.customer_id
        left join users u on u.id = jo.deletion_requested_by
        where jo.tenant_id = ${req.user.tid} and jo.deletion_status = 'pending'
        order by jo.deletion_requested_at asc`
      return { data: rows }
    })
  })

  // ── ELIMINAÇÃO: aprovar ou recusar (só dono) ────────────────
  app.post('/receptions/:joId/decide-deletion', { preHandler: [guard('jobdelete:any')] }, async (req: any, reply) => {
    const { joId } = req.params
    const approve = (req.body as any).approve === true
    const note = String((req.body as any).note || '')
    return withTenant(req.user.tid, async (tx) => {
      const [jo] = await tx`select number, deletion_status from job_orders where id = ${joId}`
      if (!jo) return reply.code(404).send({ error: 'Entrada não encontrada' })
      if (jo.deletion_status !== 'pending') return reply.code(409).send({ error: 'Sem pedido pendente' })
      if (approve) {
        await tx`update job_orders set status = 'cancelled', deletion_status = 'approved',
          deletion_decided_by = ${req.user.sub}, deletion_decided_at = now(),
          deletion_decision_note = ${note || null}, updated_at = now() where id = ${joId}`
        await audit(tx, req.user.tid, req.user.sub, 'deletion.approve', 'job_order', joId, { number: jo.number, note })
      } else {
        await tx`update job_orders set deletion_status = 'rejected',
          deletion_decided_by = ${req.user.sub}, deletion_decided_at = now(),
          deletion_decision_note = ${note || null}, updated_at = now() where id = ${joId}`
        await audit(tx, req.user.tid, req.user.sub, 'deletion.reject', 'job_order', joId, { number: jo.number, note })
      }
      return reply.send({ ok: true, approved: approve })
    })
  })

  app.get('/receptions/:joId', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const [jo] = await tx`
        select jo.*, v.plate, v.brand, v.model, v.year, v.color, v.vin,
               c.full_name as customer_name, c.phone as customer_phone,
               u.full_name as received_by_name,
               ub.full_name as draft_created_by_name,
               ur.full_name as deletion_requested_by_name,
               uc.full_name as entry_completed_by_name
        from job_orders jo
        join vehicles v on v.id = jo.vehicle_id
        join customers c on c.id = jo.customer_id
        left join users uc on uc.id = jo.entry_completed_by
        left join users u on u.id = jo.received_by
        left join users ub on ub.id = jo.draft_created_by
        left join users ur on ur.id = jo.deletion_requested_by
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

      // Outras visitas do mesmo carro. É a semente da ficha viva do veículo:
      // quem abre um carro passa a ver o que já lá foi feito, sem procurar.
      const historico = await tx`
        select h.id, h.number, h.status, h.received_at, h.km_entry, h.intentions,
               h.os_opened_at, h.signed_at
        from job_orders h
        where h.tenant_id = ${req.user.tid}
          and h.vehicle_id = ${jo.vehicle_id}
          and h.id <> ${joId}
          and h.status <> 'cancelled'
        order by coalesce(h.received_at, h.created_at) desc
        limit 20`

      // Documento de identificação: está guardado desde sempre e nunca foi
      // mostrado em lado nenhum. Faz parte do que se registou à entrada.
      let idDocUrl = null
      if (jo.id_document_path) {
        const { data } = await supabase.storage.from(BUCKET).createSignedUrl(jo.id_document_path, 3600)
        idDocUrl = data?.signedUrl || null
      }
      return { ...jo, photos: withUrls, signatureViewUrl: signatureUrl, idDocViewUrl: idDocUrl, historico }
    })
  })

  // ── COMPLETAR ENTRADA (KM + painel que ficaram pendentes) ──
  // A entrada fechou e assinou sem o KM porque o carro não ligava.
  // Aqui completa-se o que faltava. As fotos do painel sobem pelo
  // caminho normal das fotos; isto sela o número e marca como completa.
  app.post('/receptions/:joId/complete-entry', { preHandler: [guard('reception:create')] }, async (req: any, reply) => {
    const { joId } = req.params
    const body = z.object({ kmEntry: z.number().int().min(0) }).safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'Quilometragem inválida' })

    return withTenant(req.user.tid, async (tx) => {
      const [jo] = await tx`
        select id, entry_pending_reason, entry_completed_at from job_orders
        where id = ${joId} and tenant_id = ${req.user.tid}`
      if (!jo) return reply.code(404).send({ error: 'Entrada não encontrada' })
      if (!jo.entry_pending_reason) return reply.code(409).send({ error: 'Esta entrada não tem nada pendente.' })
      if (jo.entry_completed_at) return reply.code(409).send({ error: 'Entrada já foi completada.' })

      // As três fotos do painel têm de estar lá — são o que exigia a ignição.
      const [{ count }] = await tx`
        select count(*) from reception_photos
        where job_order_id = ${joId} and zone in ('dash_ign','dash_run','km')`
      if (Number(count) < 3)
        return reply.code(400).send({
          error: `Faltam fotos do painel (${count} de 3). Tira as três antes de completar.`,
        })

      await tx`
        update job_orders set km_entry = ${body.data.kmEntry},
          entry_completed_at = now(), entry_completed_by = ${req.user.sub}
        where id = ${joId}`
      await audit(tx, req.user.tid, req.user.sub, 'reception.complete_entry', 'job_order', joId, {
        km: body.data.kmEntry, motivo_original: jo.entry_pending_reason,
      })
      return reply.send({ ok: true })
    })
  })

  // ── TERMOS ACTIVOS (para o tablet mostrar) ─────────────────
  app.get('/terms/active', { preHandler: [guard('reception:read')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const [t] = await tx`
        select version, content, parking_fee, parking_grace_days,
               quote_approval_days, pickup_days, advance_threshold, advance_percent
        from terms_versions
        where active and kind = 'geral'
        order by created_at desc limit 1`
      return t || null
    })
  })

  // ── TERMOS POR TIPO (non_runner, dyno, marcacao...) ────────
  // Os textos vivem como dados: mudá-los é editar a linha, não fazer deploy.
  app.get('/terms/:kind', { preHandler: [guard('reception:read')] }, async (req: any) => {
    const kind = String(req.params.kind || '').trim()
    return withTenant(req.user.tid, async (tx) => {
      const [t] = await tx`
        select version, content from terms_versions
        where active and kind = ${kind}
        order by created_at desc limit 1`
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

  // ── CONFIG da recepção (flags do tenant) ────────────────────
  app.get('/reception-config', { preHandler: [guard('reception:read')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const [t] = await tx`select diagnosis_notice_on from tenants where id = ${req.user.tid}`
      const criteria = await tx`select id, label from priority_criteria where active order by sort_order`
      return { diagnosisNoticeOn: t?.diagnosis_notice_on ?? true, priorityCriteria: criteria }
    })
  })

  // ── PRIORIDADE: definir nível + razão ───────────────────────
  app.post('/receptions/:joId/priority', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    const b = req.body as any
    const level = String(b.level || '')
    if (!['urgent', 'high', 'normal', 'low'].includes(level))
      return reply.code(400).send({ error: 'Nível inválido' })
    if (!b.reason) return reply.code(400).send({ error: 'Razão obrigatória' })
    return withTenant(req.user.tid, async (tx) => {
      const [jo] = await tx`select number, priority_set_by from job_orders where id = ${joId}`
      if (!jo) return reply.code(404).send({ error: 'Entrada não encontrada' })
      // é uma correcção do dono? (alguém já tinha definido, e quem altera é diferente)
      const isOwner = can(req.user.perms, 'jobdelete:any')
      const isCorrection = isOwner && jo.priority_set_by && jo.priority_set_by !== req.user.sub
      await tx`update job_orders set
        priority_level = ${level}, priority_reason = ${b.reason},
        priority_reason_note = ${b.note || null}, priority_rank = ${b.rank ?? 0},
        priority_set_by = ${req.user.sub}, priority_set_at = now(),
        updated_at = now() where id = ${joId}`
      if (isCorrection) {
        await tx`update job_orders set priority_corrected_by = ${req.user.sub}, priority_corrected_at = now() where id = ${joId}`
      }
      await audit(tx, req.user.tid, req.user.sub, isCorrection ? 'priority.correct' : 'priority.set', 'job_order', joId, {
        number: jo.number, level, reason: b.reason, corrected: isCorrection,
      })
      return reply.send({ ok: true, corrected: isCorrection })
    })
  })

  // ── SERVIÇOS de uma unidade (catálogo por sector) ──────────
  app.get('/services', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const unitId = String((req.query as any).unitId || '')
    if (!unitId) return reply.code(400).send({ error: 'unitId em falta' })
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`
        select id, name, category, est_hours
        from service_catalog
        where business_unit_id = ${unitId} and active
        order by sort, name`
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
