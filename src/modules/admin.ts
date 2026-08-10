// ============================================================
// Onboarding assistido — o super-admin (Heike) cria oficinas.
//
// Replica o que o seed 0004 fez para a FIT, mas por ecrã: cria a
// oficina (tenant), o dono, e semeia os defaults genéricos (tipos
// de serviço base, departamentos Oficina+Loja, checklist QC base).
//
// SEGURANÇA: só platform_admin. Um owner de oficina-cliente NÃO
// pode criar oficinas. É a operação mais sensível do sistema
// (mexe no isolamento entre clientes) — porta bem trancada.
// ============================================================
import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql, audit, bcrypt } from '../lib/core.js'

// Guarda de super-admin: verifica o token E a flag na base.
function superGuard() {
  return async (req: any, reply: any) => {
    try { await req.jwtVerify() } catch { return reply.code(401).send({ error: 'Não autenticado' }) }
    const [u] = await sql`select platform_admin from users where id = ${req.user.sub}`
    if (!u?.platform_admin) return reply.code(403).send({ error: 'Só o administrador da plataforma pode fazer isto.' })
  }
}

export async function adminRoutes(app: FastifyInstance) {

  // Listar oficinas (para o painel do super-admin).
  app.get('/admin/workshops', { preHandler: [superGuard()] }, async () => {
    const rows = await sql`
      select t.id, t.slug, t.name, t.country, t.currency, t.active, t.created_at,
             (select count(*) from users u where u.tenant_id = t.id) as users,
             (select full_name from users u where u.tenant_id = t.id order by created_at limit 1) as owner_name
      from tenants t order by t.created_at desc`
    return { data: rows }
  })

  // Criar uma oficina nova, completa e funcional.
  app.post('/admin/workshops', { preHandler: [superGuard()] }, async (req: any, reply) => {
    const b = z.object({
      // Oficina
      name: z.string().min(2).max(160),
      slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/, 'Só minúsculas, números e hífen'),
      country: z.string().default('MOZ'),
      currency: z.string().default('MZN'),
      vatRate: z.number().min(0).max(100).default(16),
      brandColor: z.string().default('#4F46E5'),
      nuit: z.string().max(40).nullable().optional(),
      phone: z.string().max(40).nullable().optional(),
      // Dono da oficina
      ownerName: z.string().min(2).max(160),
      ownerEmail: z.string().email(),
      ownerPassword: z.string().min(6).max(100),
    }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message || 'Dados inválidos' })
    const d = b.data

    // slug e email têm de ser únicos.
    const [slugTaken] = await sql`select 1 from tenants where slug = ${d.slug}`
    if (slugTaken) return reply.code(409).send({ error: 'Já existe uma oficina com esse endereço (slug).' })
    const [emailTaken] = await sql`select 1 from users where email = ${d.ownerEmail}`
    if (emailTaken) return reply.code(409).send({ error: 'Já existe um utilizador com esse email.' })

    // Tudo numa transação: ou cria a oficina inteira, ou nada.
    try {
      const result = await sql.begin(async (tx: any) => {
        // 1) Oficina
        const [tenant] = await tx`
          insert into tenants (slug, name, country, currency, vat_rate, nuit, phone, brand_primary_color)
          values (${d.slug}, ${d.name}, ${d.country}, ${d.currency}, ${d.vatRate},
                  ${d.nuit ?? null}, ${d.phone ?? null}, ${d.brandColor})
          returning id`
        const tid = tenant.id

        // 2) Dono da oficina (owner)
        const hash = await bcrypt.hash(d.ownerPassword, 10)
        const [owner] = await tx`
          insert into users (tenant_id, email, full_name, password_hash)
          values (${tid}, ${d.ownerEmail}, ${d.ownerName}, ${hash})
          returning id`
        // atribuir role owner (system role)
        const [ownerRole] = await tx`select id from roles where code = 'owner' and is_system = true limit 1`
        if (ownerRole) await tx`insert into user_roles (user_id, role_id) values (${owner.id}, ${ownerRole.id})`

        // 3) Tipos de serviço base (genéricos, do catálogo de defaults).
        await tx`
          insert into service_types (tenant_id, name, client_presence, sort_order)
          select ${tid}, name, client_presence, sort_order from service_type_defaults
          on conflict do nothing`

        // 4) Departamentos genéricos: Oficina e Loja (SEM Remaps).
        await tx`
          insert into departments (tenant_id, name, slug, sort_order) values
            (${tid}, 'Oficina', 'oficina', 1),
            (${tid}, 'Loja', 'loja', 2)
          on conflict (tenant_id, slug) do nothing`

        // 5) Checklist de QC base (os mesmos 20 itens de referência).
        await tx`
          insert into qc_items (tenant_id, section, label, required, sort_order)
          select ${tid}, section, label, required, sort_order
          from qc_items where tenant_id = (select id from tenants where slug = 'fuel-injection-technology')
          on conflict do nothing`

        await audit(tx, tid, req.user.sub, 'workshop.create', 'tenant', tid, { slug: d.slug, name: d.name })
        return { tenantId: tid, ownerId: owner.id }
      })
      return reply.send({ ok: true, ...result, slug: d.slug })
    } catch (e: any) {
      req.log.error(e)
      return reply.code(500).send({ error: 'Não foi possível criar a oficina. ' + (e?.message || '') })
    }
  })

  // Ativar/desativar uma oficina.
  app.post('/admin/workshops/:id/active', { preHandler: [superGuard()] }, async (req: any, reply) => {
    const b = z.object({ active: z.boolean() }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'Dados inválidos' })
    await sql`update tenants set active = ${b.data.active} where id = ${req.params.id}`
    return reply.send({ ok: true })
  })
}
