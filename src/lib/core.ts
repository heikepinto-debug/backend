// ============================================================
// OFICINAHUB — lib central: DB com contexto de tenant, auth, audit
// ============================================================
import postgres from 'postgres'
import bcrypt from 'bcryptjs'
import { createClient } from '@supabase/supabase-js'

export const sql = postgres(process.env.DATABASE_URL!, {
  max: 10,
  idle_timeout: 30,
  prepare: false,           // necessário p/ pooler transaction-mode do Supabase
})

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

export const BUCKET = process.env.STORAGE_BUCKET || 'reception-media'

// ── Executa uma função com o tenant definido (activa o RLS) ──
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenantId}, true)`
    return fn(tx)
  }) as Promise<T>
}

// ── Payload do JWT ───────────────────────────────────────────
export interface Jwt {
  sub: string           // user id
  tid: string           // tenant id
  perms: string[]       // permissões acumuladas de todos os roles
  name: string
}

// ── Verifica permissão (suporta wildcard: 'reception:*' ou '*')
export function can(perms: string[], needed: string): boolean {
  if (perms.includes('*')) return true
  if (perms.includes(needed)) return true
  const [domain] = needed.split(':')
  return perms.includes(`${domain}:*`)
}

// ── Login: valida credenciais e devolve payload + branding ──
export async function authenticate(email: string, password: string) {
  const [user] = await sql`
    select u.id, u.tenant_id, u.full_name, u.password_hash, u.active,
           t.name as tenant_name, t.slug, t.logo_url,
           t.brand_primary_color, t.brand_secondary_color, t.settings,
           t.active as tenant_active
    from users u join tenants t on t.id = u.tenant_id
    where lower(u.email) = ${email.toLowerCase()}
    limit 1`
  if (!user || !user.active || !user.tenant_active) return null
  const ok = await bcrypt.compare(password, user.password_hash)
  if (!ok) return null

  // Permissões acumuladas de todos os roles (roles cumulativos)
  const roles = await sql`
    select r.code, r.permissions from user_roles ur
    join roles r on r.id = ur.role_id
    where ur.user_id = ${user.id}`
  const perms = [...new Set(roles.flatMap((r: any) => r.permissions))]

  // Módulos activos do tenant
  const mods = await sql`
    select module_code from tenant_modules
    where tenant_id = ${user.tenant_id} and active`

  await sql`update users set last_login_at = now() where id = ${user.id}`

  return {
    user: { id: user.id, name: user.full_name, email },
    tenant: {
      id: user.tenant_id, slug: user.slug, name: user.tenant_name,
      logoUrl: user.logo_url,
      brandPrimary: user.brand_primary_color,
      brandSecondary: user.brand_secondary_color,
      settings: user.settings,
      modules: mods.map((m: any) => m.module_code),
    },
    perms,
    roles: roles.map((r: any) => r.code),
  }
}

// ── Audit log (imutável) ─────────────────────────────────────
export async function audit(
  tx: postgres.TransactionSql | typeof sql,
  tenantId: string, userId: string | null,
  action: string, entityType: string, entityId: string | null,
  metadata: Record<string, unknown> = {}
) {
  await tx`
    insert into audit_log (tenant_id, user_id, action, entity_type, entity_id, metadata)
    values (${tenantId}, ${userId}, ${action}, ${entityType}, ${entityId},
            ${JSON.stringify(metadata)})`
}

export { bcrypt }
