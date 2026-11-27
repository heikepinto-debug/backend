// ============================================================
// Equipa e definições da oficina (v107)
//
// EQUIPA — só o dono (team:manage, coberto pelo '*'): criar acessos,
// escolher o papel, desactivar, definir senha nova.
// DEFINIÇÕES — config:manage: dados e cor da oficina, regras.
// CATEGORIAS — pricing:manage: o plano de lançamentos e o que a
// equipa pode usar.
//
// Os papéis são os de sistema (iguais para todas as oficinas) mais
// os que a oficina tiver próprios. Editar permissões de um papel
// fica para depois — aqui só se atribui.
// ============================================================
import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant, audit, can, sql, bcrypt, forgetSession } from '../lib/core.js'

function guard(perm: string) {
  return async (req: any, reply: any) => {
    try { await req.jwtVerify() } catch { return reply.code(401).send({ error: 'Não autenticado' }) }
    if (!can(req.user.perms, perm)) return reply.code(403).send({ error: 'Sem permissão', needed: perm })
  }
}
const senha = z.string().min(8, 'A senha tem de ter pelo menos 8 caracteres.').max(100)

export async function settingsRoutes(app: FastifyInstance) {

  // ── EQUIPA ──────────────────────────────────────────────────
  app.get('/team', { preHandler: [guard('team:manage')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const users = await tx`
        select u.id, u.full_name, u.email, u.phone, u.active, u.last_login_at, u.must_change_password,
               (select r.id from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = u.id
                order by r.hierarchy_level limit 1) as role_id
        from users u where u.tenant_id = ${req.user.tid}
        order by u.active desc, u.full_name`
      const roles = await tx`
        select id, code, name, hierarchy_level, ('*' = any(permissions)) as is_owner
        from roles where tenant_id is null or tenant_id = ${req.user.tid}
        order by hierarchy_level, name`
      return { users, roles, me: req.user.sub }
    })
  })

  app.post('/team', { preHandler: [guard('team:manage')] }, async (req: any, reply) => {
    const p = z.object({
      fullName: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email().max(160),
      phone: z.string().trim().max(40).nullable().optional(), roleId: z.string().uuid(), password: senha,
    }).safeParse(req.body)
    if (!p.success) return reply.code(400).send({ error: p.error.issues[0]?.message?.includes('senha') ? p.error.issues[0].message : 'Preenche o nome, um email válido, o papel e uma senha com 8 ou mais caracteres.' })
    const d = p.data
    // O login é só pelo email → tem de ser único em TODA a plataforma.
    const [taken] = await sql`select 1 from users where lower(email) = ${d.email} limit 1`
    if (taken) return reply.code(409).send({ error: 'Já existe um acesso com esse email.' })
    const hash = await bcrypt.hash(d.password, 12)
    return withTenant(req.user.tid, async (tx) => {
      const [role] = await tx`select id, name from roles where id = ${d.roleId} and (tenant_id is null or tenant_id = ${req.user.tid})`
      if (!role) return reply.code(400).send({ error: 'Papel inválido.' })
      const [u] = await tx`
        insert into users (tenant_id, email, full_name, phone, password_hash, must_change_password)
        values (${req.user.tid}, ${d.email}, ${d.fullName}, ${d.phone || null}, ${hash}, true) returning id`
      await tx`insert into user_roles (user_id, role_id) values (${u.id}, ${role.id})`
      await audit(tx, req.user.tid, req.user.sub, 'team.create', 'user', u.id, { nome: d.fullName, papel: role.name })
      return reply.code(201).send({ ok: true, id: u.id })
    })
  })

  app.patch('/team/:id', { preHandler: [guard('team:manage')] }, async (req: any, reply) => {
    const p = z.object({
      fullName: z.string().trim().min(2).max(120).optional(), phone: z.string().trim().max(40).nullable().optional(),
      roleId: z.string().uuid().optional(), active: z.boolean().optional(),
    }).safeParse(req.body)
    if (!p.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d = p.data, id = req.params.id, souEu = id === req.user.sub
    const r = await withTenant(req.user.tid, async (tx) => {
      const [u] = await tx`select id, full_name, active from users where id = ${id} and tenant_id = ${req.user.tid}`
      if (!u) return { code: 404, error: 'Pessoa não encontrada' }
      if (souEu && (d.active === false || d.roleId)) return { code: 409, error: 'Não podes mudar o teu próprio papel nem desactivar-te.' }
      let papel: string | undefined
      if (d.roleId) {
        const [role] = await tx`select id, name from roles where id = ${d.roleId} and (tenant_id is null or tenant_id = ${req.user.tid})`
        if (!role) return { code: 400, error: 'Papel inválido.' }
        papel = role.name
      }
      // Nunca deixar a oficina sem um dono activo.
      if (d.active === false || d.roleId) {
        const donos = await tx`
          select distinct u2.id from users u2 join user_roles ur on ur.user_id = u2.id join roles r on r.id = ur.role_id
          where u2.tenant_id = ${req.user.tid} and u2.active = true and '*' = any(r.permissions)`
        const eDono = donos.some((x: any) => x.id === id)
        let continuaDono = eDono && d.active !== false
        if (continuaDono && d.roleId) {
          const [nr] = await tx`select ('*' = any(permissions)) as dono from roles where id = ${d.roleId}`
          continuaDono = !!nr?.dono
        }
        if (eDono && !continuaDono && donos.length <= 1) return { code: 409, error: 'A oficina tem de ficar com pelo menos um dono activo.' }
      }
      if (d.fullName !== undefined) await tx`update users set full_name = ${d.fullName} where id = ${id} and tenant_id = ${req.user.tid}`
      if (d.phone !== undefined) await tx`update users set phone = ${d.phone || null} where id = ${id} and tenant_id = ${req.user.tid}`
      if (d.roleId) {
        await tx`delete from user_roles where user_id = ${id}`
        await tx`insert into user_roles (user_id, role_id) values (${id}, ${d.roleId})`
        await tx`update users set session_epoch = session_epoch + 1 where id = ${id} and tenant_id = ${req.user.tid}`
      }
      if (d.active !== undefined && d.active !== u.active) {
        await tx`update users set active = ${d.active}, session_epoch = session_epoch + 1,
                 sessions_valid_from = case when ${d.active} then sessions_valid_from else date_trunc('second', now()) end
                 where id = ${id} and tenant_id = ${req.user.tid}`
      }
      await audit(tx, req.user.tid, req.user.sub, 'team.update', 'user', id, { ...(papel ? { papel } : {}), ...(d.active !== undefined ? { activo: d.active } : {}) })
      return { ok: true }
    })
    forgetSession(id)
    if ((r as any).code) return reply.code((r as any).code).send({ error: (r as any).error })
    return reply.send(r)
  })

  // Senha nova definida pelo dono (quem se esqueceu). A pessoa é obrigada
  // a escolher a sua ao entrar, e as sessões antigas deixam de valer.
  app.post('/team/:id/password', { preHandler: [guard('team:manage')] }, async (req: any, reply) => {
    const p = z.object({ password: senha }).safeParse(req.body)
    if (!p.success) return reply.code(400).send({ error: 'A senha tem de ter pelo menos 8 caracteres.' })
    const id = req.params.id
    if (id === req.user.sub) return reply.code(409).send({ error: 'Para a tua própria senha usa "A minha senha".' })
    const hash = await bcrypt.hash(p.data.password, 12)
    const ok = await withTenant(req.user.tid, async (tx) => {
      const r = await tx`update users set password_hash = ${hash}, must_change_password = true,
                         session_epoch = session_epoch + 1, sessions_valid_from = date_trunc('second', now())
                         where id = ${id} and tenant_id = ${req.user.tid} returning id`
      if (r.length) await audit(tx, req.user.tid, req.user.sub, 'team.password_reset', 'user', id, {})
      return r.length > 0
    })
    forgetSession(id)
    if (!ok) return reply.code(404).send({ error: 'Pessoa não encontrada' })
    return reply.send({ ok: true })
  })

  // ── DEFINIÇÕES DA OFICINA ───────────────────────────────────
  app.get('/settings/workshop', { preHandler: [guard('config:manage')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const [t] = await tx`select name, nuit, phone, email, address, brand_primary_color, diag_authorization_on, allow_third_party_signer, stale_days, scan_required
                           from tenants where id = ${req.user.tid}`
      return { workshop: t }
    })
  })

  app.put('/settings/workshop', { preHandler: [guard('config:manage')] }, async (req: any, reply) => {
    const p = z.object({
      name: z.string().trim().min(2).max(120),
      nuit: z.string().trim().max(40).nullable().optional(), phone: z.string().trim().max(40).nullable().optional(),
      email: z.string().trim().max(160).nullable().optional(), address: z.string().trim().max(300).nullable().optional(),
      brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Cor inválida'),
      diagAuthorizationOn: z.boolean(), allowThirdPartySigner: z.boolean(), staleDays: z.number().int().min(1).max(60).optional(), scanRequired: z.boolean().optional(),
    }).safeParse(req.body)
    if (!p.success) return reply.code(400).send({ error: 'Confirma o nome da oficina e a cor.' })
    const d = p.data
    return withTenant(req.user.tid, async (tx) => {
      await tx`update tenants set name = ${d.name}, nuit = ${d.nuit || null}, phone = ${d.phone || null}, email = ${d.email || null},
               address = ${d.address || null}, brand_primary_color = ${d.brandColor},
               diag_authorization_on = ${d.diagAuthorizationOn}, allow_third_party_signer = ${d.allowThirdPartySigner},
               stale_days = coalesce(${d.staleDays ?? null}, stale_days),
               scan_required = coalesce(${d.scanRequired ?? null}, scan_required)
               where id = ${req.user.tid}`
      await audit(tx, req.user.tid, req.user.sub, 'settings.workshop', 'tenant', req.user.tid, { nome: d.name, cor: d.brandColor })
      return reply.send({ ok: true })
    })
  })

  // ── CATEGORIAS DE LANÇAMENTO ────────────────────────────────
  app.get('/settings/categories', { preHandler: [guard('pricing:manage')] }, async (req: any) => {
    return withTenant(req.user.tid, async (tx) => {
      const rows = await tx`
        select c.id, c.flow, c.group_name, c.name, c.nature, c.active, c.team_visible,
               (select count(*)::int from ledger_entries le where le.category_id = c.id) as uses
        from ledger_categories c where c.tenant_id = ${req.user.tid} order by c.flow, c.sort_order, c.name`
      return { categories: rows }
    })
  })

  app.post('/settings/categories', { preHandler: [guard('pricing:manage')] }, async (req: any, reply) => {
    const p = z.object({ flow: z.enum(['cost', 'revenue']), groupName: z.string().trim().min(2).max(60), name: z.string().trim().min(2).max(80),
      nature: z.enum(['fixed', 'variable']).nullable().optional(), teamVisible: z.boolean().optional() }).safeParse(req.body)
    if (!p.success) return reply.code(400).send({ error: 'Escreve o nome e o grupo da categoria.' })
    const d = p.data
    return withTenant(req.user.tid, async (tx) => {
      const [dup] = await tx`select 1 from ledger_categories where tenant_id = ${req.user.tid} and flow = ${d.flow} and lower(name) = ${d.name.toLowerCase()}`
      if (dup) return reply.code(409).send({ error: 'Já existe uma categoria com esse nome.' })
      const [{ n }] = await tx`select coalesce(max(sort_order), 0) + 1 as n from ledger_categories where tenant_id = ${req.user.tid} and flow = ${d.flow} and group_name = ${d.groupName}`
      const [c] = await tx`insert into ledger_categories (tenant_id, flow, group_name, name, nature, sort_order, team_visible)
        values (${req.user.tid}, ${d.flow}, ${d.groupName}, ${d.name}, ${d.flow === 'cost' ? (d.nature ?? 'variable') : null}, ${n}, ${!!d.teamVisible}) returning id`
      return reply.code(201).send({ ok: true, id: c.id })
    })
  })

  app.patch('/settings/categories/:id', { preHandler: [guard('pricing:manage')] }, async (req: any, reply) => {
    const p = z.object({ name: z.string().trim().min(2).max(80).optional(), teamVisible: z.boolean().optional(), active: z.boolean().optional() }).safeParse(req.body)
    if (!p.success) return reply.code(400).send({ error: 'Dados inválidos' })
    const d = p.data
    return withTenant(req.user.tid, async (tx) => {
      const [c] = await tx`select id, flow, name, team_visible, active from ledger_categories where id = ${req.params.id} and tenant_id = ${req.user.tid}`
      if (!c) return reply.code(404).send({ error: 'Categoria não encontrada' })
      if (d.name && d.name.toLowerCase() !== c.name.toLowerCase()) {
        const [dup] = await tx`select 1 from ledger_categories where tenant_id = ${req.user.tid} and flow = ${c.flow} and lower(name) = ${d.name.toLowerCase()}`
        if (dup) return reply.code(409).send({ error: 'Já existe uma categoria com esse nome.' })
      }
      await tx`update ledger_categories set name = ${d.name ?? c.name}, team_visible = ${d.teamVisible ?? c.team_visible}, active = ${d.active ?? c.active}
               where id = ${c.id} and tenant_id = ${req.user.tid}`
      return reply.send({ ok: true })
    })
  })
}
