// ============================================================
// Gestão do modelo de PPI (secções → pontos → campos)
//
// É isto que tira a oficina da dependência do programador: a dona
// edita os pontos, as dicas, os níveis e os obrigatórios sozinha.
// E é o que torna o PPI vendável — cada oficina monta o seu.
//
// Só para quem gere a configuração (config:manage → dono).
//
// NUNCA se apaga: desativa-se (active = false). As inspeções já
// feitas apontam para estes registos e não podem ficar órfãs.
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

const NIVEIS = ['basic', 'standard', 'premium'] as const
const TIPOS = ['state', 'number', 'text', 'photo', 'file'] as const

export async function ppiModelRoutes(app: FastifyInstance) {

  // ── Árvore completa, incluindo desativados ────────────────
  app.get('/ppi/model', { preHandler: [guard('config:manage')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const secs = await tx`select id, name, min_level, sort_order, active from ppi_sections
                            where tenant_id = ${req.user.tid} order by sort_order, name`
      const pts = await tx`select id, section_id, name, min_level, sort_order, active, hint,
                                  applies_fuel, applies_drivetrain from ppi_points
                           where tenant_id = ${req.user.tid} order by sort_order, name`
      const fls = await tx`select id, point_id, label, field_type, unit, required, sort_order, active, hint
                           from ppi_fields where tenant_id = ${req.user.tid} order by sort_order, label`
      return {
        sections: secs.map((s: any) => ({
          ...s,
          points: pts.filter((p: any) => p.section_id === s.id).map((p: any) => ({
            ...p, fields: fls.filter((f: any) => f.point_id === p.id),
          })),
        })),
      }
    })
  })

  // ── Secções ───────────────────────────────────────────────
  app.post('/ppi/model/section', { preHandler: [guard('config:manage')] }, async (req: any, reply) => {
    const b = z.object({ name: z.string().min(1).max(120), minLevel: z.enum(NIVEIS).default('basic'),
                         sortOrder: z.number().int().default(0) }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    return withTenant(req.user.tid, async (tx) => {
      const [row] = await tx`insert into ppi_sections (tenant_id, name, min_level, sort_order)
        values (${req.user.tid}, ${b.data.name.trim()}, ${b.data.minLevel}, ${b.data.sortOrder})
        returning id, name, min_level, sort_order, active`
      await audit(tx, req.user.tid, req.user.sub, 'ppi_model.section.create', 'ppi_section', row.id, { nome: row.name })
      return reply.send(row)
    })
  })

  app.patch('/ppi/model/section/:id', { preHandler: [guard('config:manage')] }, async (req: any, reply) => {
    const b = z.object({ name: z.string().min(1).max(120).optional(), minLevel: z.enum(NIVEIS).optional(),
                         sortOrder: z.number().int().optional(), active: z.boolean().optional() }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d = b.data
    return withTenant(req.user.tid, async (tx) => {
      await tx`update ppi_sections set
        name = coalesce(${d.name?.trim() ?? null}, name),
        min_level = coalesce(${d.minLevel ?? null}, min_level),
        sort_order = coalesce(${d.sortOrder ?? null}, sort_order),
        active = coalesce(${d.active ?? null}, active)
        where id = ${req.params.id} and tenant_id = ${req.user.tid}`
      await audit(tx, req.user.tid, req.user.sub, 'ppi_model.section.edit', 'ppi_section', req.params.id, d)
      return reply.send({ ok: true })
    })
  })

  // ── Pontos ────────────────────────────────────────────────
  app.post('/ppi/model/point', { preHandler: [guard('config:manage')] }, async (req: any, reply) => {
    const b = z.object({ sectionId: z.string().uuid(), name: z.string().min(1).max(160),
                         minLevel: z.enum(NIVEIS).default('basic'), sortOrder: z.number().int().default(0),
                         hint: z.string().max(2000).nullable().optional() }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d = b.data
    return withTenant(req.user.tid, async (tx) => {
      const [row] = await tx`insert into ppi_points (tenant_id, section_id, name, min_level, sort_order, hint)
        values (${req.user.tid}, ${d.sectionId}, ${d.name.trim()}, ${d.minLevel}, ${d.sortOrder}, ${d.hint ?? null})
        returning id, section_id, name, min_level, sort_order, active, hint, applies_fuel, applies_drivetrain`
      await audit(tx, req.user.tid, req.user.sub, 'ppi_model.point.create', 'ppi_point', row.id, { nome: row.name })
      return reply.send({ ...row, fields: [] })
    })
  })

  app.patch('/ppi/model/point/:id', { preHandler: [guard('config:manage')] }, async (req: any, reply) => {
    const b = z.object({
      name: z.string().min(1).max(160).optional(), minLevel: z.enum(NIVEIS).optional(),
      sortOrder: z.number().int().optional(), active: z.boolean().optional(),
      hint: z.string().max(2000).nullable().optional(),
      appliesFuel: z.array(z.string()).nullable().optional(),
      appliesDrivetrain: z.array(z.string()).nullable().optional(),
    }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d = b.data
    return withTenant(req.user.tid, async (tx) => {
      // Listas vazias guardam-se como null (= aplica-se a tudo).
      const fuel = d.appliesFuel === undefined ? undefined : (d.appliesFuel && d.appliesFuel.length ? d.appliesFuel : null)
      const drive = d.appliesDrivetrain === undefined ? undefined : (d.appliesDrivetrain && d.appliesDrivetrain.length ? d.appliesDrivetrain : null)
      await tx`update ppi_points set
        name = coalesce(${d.name?.trim() ?? null}, name),
        min_level = coalesce(${d.minLevel ?? null}, min_level),
        sort_order = coalesce(${d.sortOrder ?? null}, sort_order),
        active = coalesce(${d.active ?? null}, active)
        where id = ${req.params.id} and tenant_id = ${req.user.tid}`
      // hint tratado à parte: com coalesce nunca se conseguiria limpar.
      if (d.hint !== undefined) {
        await tx`update ppi_points set hint = ${d.hint} where id = ${req.params.id} and tenant_id = ${req.user.tid}`
      }
      if (fuel !== undefined) {
        await tx`update ppi_points set applies_fuel = ${fuel} where id = ${req.params.id} and tenant_id = ${req.user.tid}`
      }
      if (drive !== undefined) {
        await tx`update ppi_points set applies_drivetrain = ${drive} where id = ${req.params.id} and tenant_id = ${req.user.tid}`
      }
      await audit(tx, req.user.tid, req.user.sub, 'ppi_model.point.edit', 'ppi_point', req.params.id, d)
      return reply.send({ ok: true })
    })
  })

  // ── Campos ────────────────────────────────────────────────
  app.post('/ppi/model/field', { preHandler: [guard('config:manage')] }, async (req: any, reply) => {
    const b = z.object({ pointId: z.string().uuid(), label: z.string().min(1).max(160),
                         fieldType: z.enum(TIPOS).default('state'), unit: z.string().max(20).nullable().optional(),
                         required: z.boolean().default(false), sortOrder: z.number().int().default(0),
                         hint: z.string().max(1000).nullable().optional() }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d = b.data
    return withTenant(req.user.tid, async (tx) => {
      const [row] = await tx`insert into ppi_fields (tenant_id, point_id, label, field_type, unit, required, sort_order, hint)
        values (${req.user.tid}, ${d.pointId}, ${d.label.trim()}, ${d.fieldType}, ${d.unit ?? null},
                ${d.required}, ${d.sortOrder}, ${d.hint ?? null})
        returning id, point_id, label, field_type, unit, required, sort_order, active, hint`
      await audit(tx, req.user.tid, req.user.sub, 'ppi_model.field.create', 'ppi_field', row.id, { label: row.label })
      return reply.send(row)
    })
  })

  app.patch('/ppi/model/field/:id', { preHandler: [guard('config:manage')] }, async (req: any, reply) => {
    const b = z.object({
      label: z.string().min(1).max(160).optional(), fieldType: z.enum(TIPOS).optional(),
      unit: z.string().max(20).nullable().optional(), required: z.boolean().optional(),
      sortOrder: z.number().int().optional(), active: z.boolean().optional(),
      hint: z.string().max(1000).nullable().optional(),
    }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d = b.data
    return withTenant(req.user.tid, async (tx) => {
      await tx`update ppi_fields set
        label = coalesce(${d.label?.trim() ?? null}, label),
        field_type = coalesce(${d.fieldType ?? null}, field_type),
        required = coalesce(${d.required ?? null}, required),
        sort_order = coalesce(${d.sortOrder ?? null}, sort_order),
        active = coalesce(${d.active ?? null}, active)
        where id = ${req.params.id} and tenant_id = ${req.user.tid}`
      if (d.unit !== undefined) {
        await tx`update ppi_fields set unit = ${d.unit} where id = ${req.params.id} and tenant_id = ${req.user.tid}`
      }
      if (d.hint !== undefined) {
        await tx`update ppi_fields set hint = ${d.hint} where id = ${req.params.id} and tenant_id = ${req.user.tid}`
      }
      await audit(tx, req.user.tid, req.user.sub, 'ppi_model.field.edit', 'ppi_field', req.params.id, d)
      return reply.send({ ok: true })
    })
  })
}
