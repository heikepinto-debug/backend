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
function clean(t: string): string {
  return (t || '')
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
    y += 8

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
    doc.fillColor(muted).fontSize(8).font('Helvetica').text('Assinatura do cliente', M, y + 66)
    doc.fillColor(ink).fontSize(10).font('Helvetica-Bold').text(clean(data.customer_name), M, y + 78)
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
