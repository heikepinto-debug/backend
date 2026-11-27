// ============================================================
// Diagnóstico electrónico (scan) — novo workflow, passo 1 (v108)
//
// Todos os carros levam scan: é a prova do estado em que o carro
// entrou (como as fotos) e o ponto de partida do diagnóstico.
// Anexa-se PDF ou várias fotos. Sem scan, ou sem uma excepção
// justificada pela gestão, o diagnóstico não é submetido
// (a verificação está em os.ts, submit-diagnosis).
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
const TIPOS: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
const MAX_BYTES = 10 * 1024 * 1024
export const SCAN_EXEMPT_REASONS = ['O carro não liga', 'Sem bateria', 'A máquina não comunica com este carro', 'Outro']

export async function scanRoutes(app: FastifyInstance) {

  app.get('/os/:joId/scan', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId } = req.params
    const r = await withTenant(req.user.tid, async (tx) => {
      const [jo] = await tx`
        select jo.scan_status, jo.scan_exempt_reason, jo.scan_note, jo.scan_at, u.full_name as scan_by_name
        from job_orders jo left join users u on u.id = jo.scan_by
        where jo.id = ${joId} and jo.tenant_id = ${req.user.tid}`
      if (!jo) return null
      const [t] = await tx`select scan_required from tenants where id = ${req.user.tid}`
      const files = await tx`
        select f.id, f.path, f.file_name, f.content_type, f.size_bytes, f.created_at, f.uploaded_by, u.full_name as uploaded_by_name
        from jo_scan_files f left join users u on u.id = f.uploaded_by
        where f.job_order_id = ${joId} and f.tenant_id = ${req.user.tid} order by f.created_at`
      return { jo, files, required: t?.scan_required ?? true }
    })
    if (!r) return reply.code(404).send({ error: 'Carro não encontrado' })
    const files = await Promise.all(r.files.map(async (f: any) => {
      let url: string | null = null
      try { const { data } = await supabase.storage.from(BUCKET).createSignedUrl(f.path, 3600); url = data?.signedUrl || null } catch {}
      return { id: f.id, name: f.file_name, type: f.content_type, size: f.size_bytes, at: f.created_at, by: f.uploaded_by_name, mine: f.uploaded_by === req.user.sub, url }
    }))
    return { status: r.jo.scan_status, exemptReason: r.jo.scan_exempt_reason, note: r.jo.scan_note, at: r.jo.scan_at, by: r.jo.scan_by_name,
      required: r.required, files, exemptReasons: SCAN_EXEMPT_REASONS }
  })

  // Juntar um ficheiro (PDF ou foto). Um pedido por ficheiro, até 10 MB.
  app.post('/os/:joId/scan/files', { bodyLimit: 16 * 1024 * 1024, preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const p = z.object({ fileBase64: z.string().min(50), fileName: z.string().trim().max(160).optional(), contentType: z.string() }).safeParse(req.body)
    if (!p.success) return reply.code(400).send({ error: 'Ficheiro em falta.' })
    const ext = TIPOS[p.data.contentType]
    if (!ext) return reply.code(400).send({ error: 'Só PDF ou fotografias (JPG, PNG).' })
    const buf = Buffer.from(p.data.fileBase64, 'base64')
    if (buf.length < 20) return reply.code(400).send({ error: 'Ficheiro vazio.' })
    if (buf.length > MAX_BYTES) return reply.code(413).send({ error: 'Ficheiro demasiado grande (máximo 10 MB).' })
    const { joId } = req.params
    const jo = await withTenant(req.user.tid, async (tx) => {
      const [j] = await tx`select id, status from job_orders where id = ${joId} and tenant_id = ${req.user.tid}`
      return j
    })
    if (!jo) return reply.code(404).send({ error: 'Carro não encontrado' })
    if (['delivered', 'cancelled'].includes(jo.status)) return reply.code(409).send({ error: 'Este carro já está fechado.' })
    const path = `${req.user.tid}/scan/${joId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const { error } = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: p.data.contentType })
    if (error) return reply.code(500).send({ error: 'Não foi possível guardar o ficheiro. Tenta de novo.' })
    return withTenant(req.user.tid, async (tx) => {
      const [f] = await tx`
        insert into jo_scan_files (tenant_id, job_order_id, path, file_name, content_type, size_bytes, uploaded_by)
        values (${req.user.tid}, ${joId}, ${path}, ${p.data.fileName || null}, ${p.data.contentType}, ${buf.length}, ${req.user.sub}) returning id`
      return reply.code(201).send({ ok: true, id: f.id })
    })
  })

  // Tirar um ficheiro: quem o juntou, ou a gestão. Só enquanto o scan está em aberto.
  app.delete('/os/:joId/scan/files/:fid', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const { joId, fid } = req.params
    const r = await withTenant(req.user.tid, async (tx) => {
      const [f] = await tx`
        select f.id, f.path, f.uploaded_by, jo.scan_status from jo_scan_files f join job_orders jo on jo.id = f.job_order_id
        where f.id = ${fid} and f.job_order_id = ${joId} and f.tenant_id = ${req.user.tid}`
      if (!f) return { code: 404, error: 'Ficheiro não encontrado' }
      if (f.uploaded_by !== req.user.sub && !can(req.user.perms, 'os:manage')) return { code: 403, error: 'Só quem juntou o ficheiro ou a gestão o pode tirar.' }
      if (f.scan_status === 'done' && !can(req.user.perms, 'os:manage')) return { code: 409, error: 'O scan já foi concluído.' }
      await tx`delete from jo_scan_files where id = ${fid} and tenant_id = ${req.user.tid}`
      return { path: f.path }
    })
    if ((r as any).code) return reply.code((r as any).code).send({ error: (r as any).error })
    try { await supabase.storage.from(BUCKET).remove([(r as any).path]) } catch {}
    return reply.send({ ok: true })
  })

  // Concluir o scan — precisa de pelo menos um ficheiro.
  app.post('/os/:joId/scan/done', { preHandler: [guard('reception:read')] }, async (req: any, reply) => {
    const note = String((req.body as any)?.note || '').trim().slice(0, 600) || null
    const { joId } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const [jo] = await tx`select id, number from job_orders where id = ${joId} and tenant_id = ${req.user.tid}`
      if (!jo) return reply.code(404).send({ error: 'Carro não encontrado' })
      const [{ n }] = await tx`select count(*)::int as n from jo_scan_files where job_order_id = ${joId} and tenant_id = ${req.user.tid}`
      if (n === 0) return reply.code(400).send({ error: 'Junta primeiro o relatório do scan (PDF ou fotos).' })
      await tx`update job_orders set scan_status = 'done', scan_exempt_reason = null, scan_note = ${note}, scan_by = ${req.user.sub}, scan_at = now(), updated_at = now()
               where id = ${joId} and tenant_id = ${req.user.tid}`
      await audit(tx, req.user.tid, req.user.sub, 'scan.done', 'job_order', joId, { number: jo.number, ficheiros: n })
      return reply.send({ ok: true })
    })
  })

  // Excepção justificada — só a gestão (senão seria a saída fácil).
  app.post('/os/:joId/scan/exempt', { preHandler: [guard('os:manage')] }, async (req: any, reply) => {
    const p = z.object({ reason: z.string().trim().min(2).max(80), note: z.string().trim().max(300).nullable().optional() }).safeParse(req.body)
    if (!p.success) return reply.code(400).send({ error: 'Escolhe o motivo.' })
    if (p.data.reason === 'Outro' && (p.data.note || '').length < 3) return reply.code(400).send({ error: 'Explica o motivo em poucas palavras.' })
    const { joId } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const r = await tx`update job_orders set scan_status = 'exempt', scan_exempt_reason = ${p.data.reason}, scan_note = ${p.data.note || null},
                         scan_by = ${req.user.sub}, scan_at = now(), updated_at = now()
                         where id = ${joId} and tenant_id = ${req.user.tid} returning number`
      if (!r.length) return reply.code(404).send({ error: 'Carro não encontrado' })
      await audit(tx, req.user.tid, req.user.sub, 'scan.exempt', 'job_order', joId, { number: r[0].number, motivo: p.data.reason, nota: p.data.note || null })
      return reply.send({ ok: true })
    })
  })

  // Reabrir (a gestão): volta a "por fazer".
  app.post('/os/:joId/scan/reopen', { preHandler: [guard('os:manage')] }, async (req: any, reply) => {
    const { joId } = req.params
    return withTenant(req.user.tid, async (tx) => {
      const r = await tx`update job_orders set scan_status = 'pending', scan_exempt_reason = null, scan_by = null, scan_at = null, updated_at = now()
                         where id = ${joId} and tenant_id = ${req.user.tid} returning number`
      if (!r.length) return reply.code(404).send({ error: 'Carro não encontrado' })
      await audit(tx, req.user.tid, req.user.sub, 'scan.reopen', 'job_order', joId, { number: r[0].number })
      return reply.send({ ok: true })
    })
  })
}
