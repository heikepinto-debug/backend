// ============================================================
// Geração do PDF do documento de entrada (recepção)
// Template moderno: cabeçalho com logo + dados da empresa,
// barras de cor da marca a destacar secções. Arquiva no Storage.
// ============================================================
import PDFDocument from 'pdfkit'
import { withTenant, supabase, BUCKET } from './core.js'

const MZ = (n: number) => new Intl.NumberFormat('pt-PT').format(n)
const FUEL_LABEL = (lvl: number) => `${Math.round((lvl / 8) * 100)}%`

// Aceita jsonb como objecto/array já parseado OU como string JSON.
function asData<T>(value: any, fallback: T): T {
  if (value == null) return fallback
  if (typeof value === 'string') { try { return JSON.parse(value) as T } catch { return fallback } }
  return value as T
}

// Limpa texto para o PDF: normaliza quebras de linha (resolve os "Ð")
// e remove caracteres de controlo que a fonte não desenha.
function clean(t: any): string {
  return String(t ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
}

// hex → rgb para poder clarear cores (fundos suaves das secções)
function hexToRgb(hex: string): [number, number, number] {
  const h = (hex || '#5B6470').replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function tint(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex)
  const m = (c: number) => Math.round(c + (255 - c) * amount)
  return `rgb(${m(r)},${m(g)},${m(b)})`
}

function buildPdf(data: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const brand = data.brand_primary || '#6B8C2A'
    const dark = '#1F2937'
    const ink = '#111827'
    const muted = '#6B7280'
    const soft = tint(brand, 0.90)          // fundo suave da marca
    const line = '#E5E7EB'
    const M = 48                            // margem
    const W = 595                           // largura A4
    const CW = W - M * 2                     // largura de conteúdo

    // ── CABEÇALHO (branco, limpo, com fio fino da marca) ────
    let hx = M
    const headTop = 44
    // Logo (se existir)
    if (data.logo_buf) {
      try { doc.image(data.logo_buf, M, headTop - 4, { fit: [46, 46] }); hx = M + 58 } catch {}
    }
    doc.fillColor(ink).fontSize(17).font('Helvetica-Bold')
      .text(clean(data.tenant_name || 'Oficina'), hx, headTop, { width: 320 })
    doc.fillColor(muted).fontSize(8).font('Helvetica')
    const contactLine = [data.address, data.phone, data.email].filter(Boolean).map(clean).join('   ·   ')
    let ly = headTop + 23
    if (contactLine) { doc.text(contactLine, hx, ly, { width: 340 }); ly += 12 }
    if (data.nuit) doc.text('NUIT ' + clean(data.nuit), hx, ly)

    // Bloco do número da JO (direita) — etiqueta discreta + número na cor da marca
    doc.fillColor(muted).fontSize(7.5).font('Helvetica-Bold')
      .text('DOCUMENTO DE ENTRADA', W - M - 200, headTop, { width: 200, align: 'right', characterSpacing: 0.5 })
    doc.fillColor(brand).fontSize(18).font('Helvetica-Bold')
      .text(clean(data.number), W - M - 200, headTop + 13, { width: 200, align: 'right' })
    doc.fillColor(muted).fontSize(8).font('Helvetica')
      .text(new Date(data.received_at).toLocaleString('pt-PT'), W - M - 200, headTop + 36, { width: 200, align: 'right' })

    // fio fino da marca a fechar o cabeçalho
    const hrY = 118
    doc.rect(M, hrY, CW, 2).fill(brand)

    let y = 140

    // ── Helper: cabeçalho de secção com barra de cor ────────
    const sectionHeader = (title: string) => {
      if (y > 720) { doc.addPage(); y = 48 }
      doc.rect(M, y, 3.5, 13).fill(brand)
      doc.fillColor(dark).fontSize(11).font('Helvetica-Bold').text(title, M + 12, y + 1)
      y += 24
    }
    const field = (label: string, value: string) => {
      doc.fillColor(muted).fontSize(8.5).font('Helvetica').text(clean(label), M + 12, y, { width: 150 })
      doc.fillColor(ink).fontSize(10).font('Helvetica')
        .text(clean(value || '—'), M + 165, y - 1, { width: CW - 165 })
      y = Math.max(y + 15, doc.y + 6)
    }
    const bullet = (text: string) => {
      doc.fillColor(brand).fontSize(10).font('Helvetica-Bold').text('•', M + 12, y, { continued: true })
        .fillColor(ink).font('Helvetica').text('  ' + clean(text), { width: CW - 24 })
      y = doc.y + 4
    }

    // ── CLIENTE + VIATURA (duas colunas visuais) ────────────
    sectionHeader('CLIENTE')
    field('Nome', data.customer_name)
    field('Contacto', data.customer_phone)
    if (data.customer_email) field('Email', data.customer_email)
    y += 8

    sectionHeader('VIATURA')
    field('Marca / Modelo', `${data.brand || ''} ${data.model || ''}`.trim())
    field('Matrícula', data.plate)
    if (data.year) field('Ano', String(data.year))
    field('Quilometragem', `${MZ(data.km_entry)} km`)
    field('Combustível', FUEL_LABEL(data.fuel_level))
    y += 8

    // ── INTENÇÃO ────────────────────────────────────────────
    sectionHeader('INTENÇÃO DO CLIENTE')
    const intentions = asData<string[]>(data.intentions, [])
    if (intentions.length) intentions.forEach(bullet)
    else { doc.fillColor(muted).fontSize(10).text('—', M + 12, y); y = doc.y + 4 }
    if (data.service_description) {
      y += 2
      doc.fillColor(muted).fontSize(9).font('Helvetica-Oblique')
        .text('Notas: ' + clean(data.service_description), M + 12, y, { width: CW - 24 })
      y = doc.y
    }
    y += 10

    // ── ESTADO ──────────────────────────────────────────────
    sectionHeader('ESTADO E ITENS DECLARADOS')
    const checklist = asData<Record<string, boolean>>(data.checklist, {})
    const items = Object.keys(checklist).filter(k => checklist[k])
    field('Itens presentes', items.length ? items.join(', ') : 'Nenhum assinalado')
    field('Objectos declarados', data.declared_valuables)
    if (data.battery_reference) field('Referência da bateria', data.battery_reference)
    if (data.wants_old_parts != null) field('Peças antigas', data.wants_old_parts ? 'Cliente quer ficar com as peças substituídas' : 'Cliente dispensa as peças substituídas')
    y += 8

    // ── VERIFICAÇÃO DE SISTEMAS ─────────────────────────────
    const systems = asData<Record<string, string>>(data.systems_check, {})
    const sysKeys = Object.keys(systems)
    if (sysKeys.length) {
      sectionHeader('VERIFICAÇÃO DE SISTEMAS À ENTRADA')
      const label: Record<string, string> = { ok: 'Funciona', fail: 'Não funciona', untested: 'Não testado' }
      sysKeys.forEach(k => field(k, label[systems[k]] || systems[k]))
      y += 8
    }

    // ── DANOS ───────────────────────────────────────────────
    const damages = asData<any[]>(data.damage_zones, [])
    if (damages.length) {
      sectionHeader('DANOS REGISTADOS À ENTRADA')
      damages.forEach((d: any, i: number) => {
        doc.fillColor(ink).fontSize(10).font('Helvetica-Bold')
          .text(`${i + 1}. ${clean(d.area)}`, M + 12, y, { width: CW - 24, continued: !!d.note })
        if (d.note) doc.font('Helvetica').fillColor(muted).text('  —  ' + clean(d.note))
        y = doc.y + 5
      })
      y += 8
    }

    // ── TERMOS ──────────────────────────────────────────────
    if (y > 560) { doc.addPage(); y = 48 }
    sectionHeader('TERMOS E CONDIÇÕES ACEITES')
    doc.fillColor('#4B5563').fontSize(8).font('Helvetica')
      .text(clean(data.terms_content || ''), M + 12, y, { width: CW - 24, align: 'justify', lineGap: 1.5 })
    y = doc.y + 16

    // ── ASSINATURAS ─────────────────────────────────────────
    if (y > 640) { doc.addPage(); y = 48 }
    doc.moveTo(M, y).lineTo(W - M, y).strokeColor(line).lineWidth(1).stroke()
    y += 14
    doc.fillColor(muted).fontSize(8.5).font('Helvetica')
      .text(`Versão dos termos: ${clean(data.terms_version || '')}  ·  Aceites em ${new Date(data.terms_accepted_at || data.received_at).toLocaleString('pt-PT')}`, M, y)
    y += 34

    const colR = M + CW / 2 + 10
    if (data.signature_buf) {
      try { doc.image(data.signature_buf, M, y, { fit: [150, 55] }) } catch {}
    }
    doc.moveTo(M, y + 62).lineTo(M + 200, y + 62).strokeColor(line).stroke()
    doc.moveTo(colR, y + 62).lineTo(colR + 200, y + 62).strokeColor(line).stroke()
    doc.fillColor(muted).fontSize(8).font('Helvetica').text(data.signer_is_owner === false ? 'Assinatura de quem entregou o veículo' : 'Assinatura do cliente', M, y + 66)
    doc.fillColor(ink).fontSize(10).font('Helvetica-Bold').text(clean(data.signer_is_owner === false && data.signer_name ? data.signer_name : data.customer_name), M, y + 78)
    if (data.signer_is_owner === false) {
      doc.fillColor(muted).fontSize(7).font('Helvetica').text(`(em nome do proprietário ${clean(data.customer_name)})`, M, y + 91)
    }
    doc.fillColor(muted).fontSize(8).font('Helvetica').text('Técnico responsável pelo levantamento', colR, y + 66)
    doc.fillColor(ink).fontSize(10).font('Helvetica-Bold').text(clean(data.received_by_name || '—'), colR, y + 78)

    // ── RODAPÉ ──────────────────────────────────────────────
    doc.fillColor('#9CA3AF').fontSize(7).font('Helvetica')
      .text('Documento gerado por OficinaHub · prova do estado da viatura à entrada, com registo fotográfico datado e geolocalizado.',
        M, 812, { width: CW, align: 'center' })

    doc.end()
  })
}

// Recolhe os dados da JO, gera o PDF e arquiva-o no Storage
export async function generateEntryPdf(tenantId: string, joId: string): Promise<string> {
  const prepared = await withTenant(tenantId, async (tx) => {
    const [jo] = await tx`
      select j.*, c.full_name as customer_name, c.phone as customer_phone, c.email as customer_email,
        v.plate, v.brand, v.model, v.year,
        t.name as tenant_name, t.pdf_archive_folder, t.logo_url,
        t.nuit, t.phone, t.email, t.address,
        t.brand_primary_color as brand_primary,
        u.full_name as received_by_name
      from job_orders j
      join customers c on c.id = j.customer_id
      join vehicles v on v.id = j.vehicle_id
      join tenants t on t.id = j.tenant_id
      left join users u on u.id = j.received_by
      where j.id = ${joId}`
    if (!jo) throw new Error('JO não encontrada')

    const [terms] = await tx`
      select content, version from terms_versions
      where version = ${jo.terms_version} limit 1`
    jo.terms_content = terms?.content || ''

    // assinatura
    if (jo.signature_url) {
      const { data } = await supabase.storage.from(BUCKET).download(jo.signature_url)
      if (data) jo.signature_buf = Buffer.from(await data.arrayBuffer())
    }

    const folder = jo.pdf_archive_folder || 'recepcoes'
    jo.pdfPath = `${tenantId}/${folder}/${jo.number}.pdf`
    return jo
  })

  // Logo: descarrega do URL público (fora da transacção)
  if (prepared.logo_url) {
    try {
      const res = await fetch(prepared.logo_url)
      if (res.ok) prepared.logo_buf = Buffer.from(await res.arrayBuffer())
    } catch { /* sem logo, segue sem ele */ }
  }

  const buf = await buildPdf(prepared)

  const { error } = await supabase.storage.from(BUCKET)
    .upload(prepared.pdfPath, buf, { contentType: 'application/pdf', upsert: true })
  if (error) throw error

  await withTenant(tenantId, async (tx) => {
    await tx`update job_orders set entry_pdf_path = ${prepared.pdfPath} where id = ${joId}`
  })
  return prepared.pdfPath
}

// ============================================================
// RELATÓRIO PPI — documento de inspeção pré-compra para o cliente
// Reusa o estilo da lib (marca, cores). Recebe {inspection, sections}.
// ============================================================
function buildPpiPdf(data: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

   try {
    const brand = data.brand_primary || '#1B7A3D'
    const dark = '#1F2937', ink = '#111827', muted = '#6B7280'
    const soft = tint(brand, 0.90), line = '#E5E7EB'
    const M = 48, W = 595, CW = W - M * 2
    const insp = data.inspection
    const nivel = insp.level === 'basic' ? 'Básico' : insp.level === 'standard' ? 'Standard' : 'Premium'

    const stateLabel: Record<string, string> = { bom: 'Bom', aceitavel: 'Aceitável', mau: 'Mau', na: 'N.A.' }
    const stateColor: Record<string, string> = { bom: '#16A34A', aceitavel: '#D97706', mau: '#DC2626', na: '#9CA3AF' }

    let y = 44
    // Cabeçalho
    let hx = M
    if (data.logo_buf) { try { doc.image(data.logo_buf, M, y - 4, { fit: [46, 46] }); hx = M + 58 } catch {} }
    doc.fillColor(brand).fontSize(17).font('Helvetica-Bold').text(clean(data.tenant_name || 'Fuel Injection Technology'), hx, y)
    doc.fillColor(muted).fontSize(9).font('Helvetica').text('Relatório de Inspeção Pré-Compra (PPI)', hx, y + 22)
    y += 54
    doc.moveTo(M, y).lineTo(W - M, y).strokeColor(brand).lineWidth(2).stroke()
    y += 18

    // Bloco de identificação
    doc.fillColor(ink).fontSize(15).font('Helvetica-Bold').text(clean(`${insp.plate} · ${insp.brand} ${insp.model || ''}`), M, y)
    y = doc.y + 4
    const info = [
      `Cliente: ${clean(insp.customer_name || '—')}`,
      `Nível: PPI ${nivel}`,
      insp.year ? `Ano: ${insp.year}` : null,
      insp.km_entry != null ? `Km: ${insp.km_entry}` : null,
      `Data: ${insp.done_at ? new Date(insp.done_at).toLocaleDateString('pt-PT') : new Date(insp.started_at).toLocaleDateString('pt-PT')}`,
      `Ref: ${clean(insp.jo_number || '')}`,
    ].filter(Boolean)
    doc.fillColor(muted).fontSize(9).font('Helvetica').text(info.join('     '), M, y, { width: CW })
    y = doc.y + 14

    const ensureSpace = (need: number) => { if (y + need > 800) { doc.addPage(); y = 48 } }

    // Secções
    for (const sec of (data.sections || [])) {
      ensureSpace(60)
      // Cabeçalho da secção
      doc.rect(M, y, CW, 22).fill(soft)
      doc.fillColor(brand).fontSize(11).font('Helvetica-Bold').text(clean(sec.name), M + 10, y + 5)
      y += 30

      for (const pt of sec.points) {
        ensureSpace(40)
        doc.fillColor(ink).fontSize(10.5).font('Helvetica-Bold').text(clean(pt.name), M + 4, y)
        y = doc.y + 3
        for (const r of pt.respostas) {
          ensureSpace(20)
          let val = ''
          if (r.state) val = stateLabel[r.state] || r.state
          else if (r.number != null) val = `${r.number}${r.unit ? ' ' + r.unit : ''}`
          else if (r.text) val = clean(r.text)
          else if (r.url) val = r.type === 'file' ? '(ficheiro anexo)' : '(foto anexa)'
          // Rótulo do campo
          doc.fillColor(muted).fontSize(9).font('Helvetica').text(clean(r.label) + ':', M + 12, y, { width: 150, continued: false })
          // Valor, com cor se for estado
          const vx = M + 165
          if (r.state) doc.fillColor(stateColor[r.state] || ink).font('Helvetica-Bold')
          else doc.fillColor(ink).font('Helvetica')
          doc.fontSize(9).text(val || '—', vx, y, { width: CW - 165 })
          y = Math.max(y, doc.y) + 3
        }
        y += 4
      }
      y += 6
    }

    // Nota de rodapé / limitação
    ensureSpace(70)
    y += 8
    doc.moveTo(M, y).lineTo(W - M, y).strokeColor(line).lineWidth(1).stroke()
    y += 10
    doc.fillColor(muted).fontSize(7.5).font('Helvetica-Oblique').text(
      'Este relatório reflete a condição do veículo no momento exato da inspeção, com base nas condições observáveis e no equipamento disponível. Não garante a deteção de defeitos ocultos ou que exijam desmontagem extensa. Não constitui garantia de desempenho futuro nem recomendação de compra.',
      M, y, { width: CW, align: 'justify' })
    y = doc.y + 8
    doc.fillColor(muted).fontSize(8).font('Helvetica').text(
      clean(`${data.tenant_name || 'Fuel Injection Technology'} · ${insp.customer_phone ? '' : ''}Documento gerado em ${new Date().toLocaleDateString('pt-PT')}`),
      M, y, { width: CW, align: 'center' })

    doc.end()
   } catch (e) { reject(e) }
  })
}

export async function generatePpiReport(tenantId: string, inspectionId: string, reportData: any): Promise<string> {
  // reportData = { inspection, sections } vindo do endpoint
  const prepared: any = { ...reportData }
  // Branding do tenant
  await withTenant(tenantId, async (tx) => {
    const [t] = await tx`select name, logo_url, brand_primary_color as brand_primary from tenants where id = ${tenantId}`
    prepared.tenant_name = t?.name
    prepared.brand_primary = t?.brand_primary
    prepared.logo_url = t?.logo_url
  })
  if (prepared.logo_url) {
    try { const res = await fetch(prepared.logo_url); if (res.ok) prepared.logo_buf = Buffer.from(await res.arrayBuffer()) } catch {}
  }
  const buf = await buildPpiPdf(prepared)
  const path = `${tenantId}/ppi/${inspectionId}/relatorio-${Date.now()}.pdf`
  const { error } = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: 'application/pdf', upsert: true })
  if (error) throw error
  return path
}
