// ============================================================
// Geração do PDF do documento de entrada (recepção)
// Profissional, com branding do tenant. Arquiva no Storage.
// ============================================================
import PDFDocument from 'pdfkit'
import { withTenant, supabase, BUCKET } from './core.js'

const MZ = (n: number) => new Intl.NumberFormat('pt-PT').format(n)
const FUEL_LABEL = (lvl: number) => `${Math.round((lvl / 8) * 100)}%`

// Gera o PDF em memória e devolve um Buffer
function buildPdf(data: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const brand = data.brand_primary || '#5B6470'
    const ink = '#18181B'
    const muted = '#6B7280'
    const line = '#E5E7EB'
    let y = 50

    // Cabeçalho
    doc.fillColor(brand).fontSize(22).font('Helvetica-Bold')
      .text(data.tenant_name || 'Oficina', 50, y)
    y = doc.y + 2
    doc.fillColor(muted).fontSize(9).font('Helvetica')
      .text('DOCUMENTO DE ENTRADA DE VIATURA', 50, y)
    doc.fillColor(ink).fontSize(15).font('Helvetica-Bold')
      .text(data.number, 400, 52, { align: 'right' })
    doc.fillColor(muted).fontSize(9).font('Helvetica')
      .text(new Date(data.received_at).toLocaleString('pt-PT'), 400, 72, { align: 'right' })

    y = 100
    doc.moveTo(50, y).lineTo(545, y).strokeColor(line).lineWidth(1).stroke()
    y += 18

    const section = (title: string) => {
      doc.fillColor(brand).fontSize(11).font('Helvetica-Bold').text(title, 50, y)
      y = doc.y + 6
    }
    const row = (label: string, value: string) => {
      doc.fillColor(muted).fontSize(9).font('Helvetica').text(label, 50, y, { width: 150 })
      doc.fillColor(ink).fontSize(10).font('Helvetica').text(value || '—', 200, y, { width: 345 })
      y = doc.y + 6
    }

    section('CLIENTE')
    row('Nome', data.customer_name)
    row('Contacto', data.customer_phone)
    if (data.customer_email) row('Email', data.customer_email)
    y += 6

    section('VIATURA')
    row('Marca / Modelo', `${data.brand || ''} ${data.model || ''}`.trim())
    row('Matrícula', data.plate)
    if (data.year) row('Ano', String(data.year))
    row('Quilometragem', `${MZ(data.km_entry)} km`)
    row('Combustível', FUEL_LABEL(data.fuel_level))
    y += 6

    section('INTENÇÃO DO CLIENTE')
    const intentions: string[] = data.intentions || []
    if (intentions.length)
      intentions.forEach(it => {
        doc.fillColor(ink).fontSize(10).font('Helvetica').text(`• ${it}`, 50, y, { width: 495 })
        y = doc.y + 3
      })
    else { doc.fillColor(muted).fontSize(10).text('—', 50, y); y = doc.y }
    if (data.service_description) {
      y += 4
      doc.fillColor(muted).fontSize(9).font('Helvetica').text('Notas: ' + data.service_description, 50, y, { width: 495 })
      y = doc.y
    }
    y += 10

    section('ESTADO E ITENS DECLARADOS')
    const checklist = data.checklist || {}
    const items = Object.keys(checklist).filter(k => checklist[k])
    row('Itens presentes', items.length ? items.join(', ') : 'Nenhum assinalado')
    row('Objectos declarados', data.declared_valuables)
    y += 6

    const damages = data.damage_zones || []
    if (damages.length) {
      section('DANOS REGISTADOS À ENTRADA')
      damages.forEach((d: any, i: number) => {
        doc.fillColor(ink).fontSize(10).font('Helvetica-Bold').text(`${i + 1}. ${d.area}`, 50, y, { width: 495, continued: true })
          .font('Helvetica').fillColor(muted).text(d.note ? ` — ${d.note}` : '')
        y = doc.y + 4
      })
      y += 6
    }

    // Nova página se estiver perto do fim
    if (y > 640) { doc.addPage(); y = 50 }

    section('TERMOS E CONDIÇÕES ACEITES')
    doc.fillColor(muted).fontSize(8).font('Helvetica')
      .text(data.terms_content || '', 50, y, { width: 495, align: 'justify' })
    y = doc.y + 14

    if (y > 660) { doc.addPage(); y = 50 }

    // Assinatura + confirmação
    doc.moveTo(50, y).lineTo(545, y).strokeColor(line).lineWidth(1).stroke()
    y += 16
    doc.fillColor(ink).fontSize(9).font('Helvetica')
      .text(`Versão dos termos: ${data.terms_version}  ·  Aceites em ${new Date(data.terms_accepted_at || data.received_at).toLocaleString('pt-PT')}`, 50, y)
    y += 30

    if (data.signature_buf) {
      try { doc.image(data.signature_buf, 50, y, { width: 160, height: 60, fit: [160, 60] }) } catch {}
    }
    doc.fillColor(muted).fontSize(8).text('Assinatura do cliente', 50, y + 64)
    doc.fillColor(ink).fontSize(10).font('Helvetica-Bold').text(data.customer_name, 50, y + 76)

    doc.fillColor(muted).fontSize(8).font('Helvetica')
      .text('Recepção efectuada por', 350, y + 64)
    doc.fillColor(ink).fontSize(10).font('Helvetica-Bold').text(data.received_by_name || '—', 350, y + 76)

    // Rodapé
    doc.fillColor(muted).fontSize(7).font('Helvetica')
      .text('Documento gerado por OficinaHub · prova do estado da viatura à entrada, com registo fotográfico datado e geolocalizado.',
        50, 800, { width: 495, align: 'center' })

    doc.end()
  })
}

// Recolhe os dados da JO, gera o PDF e arquiva-o no Storage
export async function generateEntryPdf(tenantId: string, joId: string): Promise<string> {
  const { path, buf } = await withTenant(tenantId, async (tx) => {
    const [jo] = await tx`
      select j.*, c.full_name as customer_name, c.phone as customer_phone, c.email as customer_email,
        v.plate, v.brand, v.model, v.year,
        t.name as tenant_name, t.pdf_archive_folder,
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

    // assinatura (se existir)
    if (jo.signature_url) {
      const { data } = await supabase.storage.from(BUCKET).download(jo.signature_url)
      if (data) jo.signature_buf = Buffer.from(await data.arrayBuffer())
    }

    const folder = jo.pdf_archive_folder || 'recepcoes'
    const pdfPath = `${tenantId}/${folder}/${jo.number}.pdf`
    const buf = await buildPdf(jo)
    return { path: pdfPath, buf, jo }
  })

  // Upload para o Storage
  const { error } = await supabase.storage.from(BUCKET)
    .upload(path, buf, { contentType: 'application/pdf', upsert: true })
  if (error) throw error

  // Guarda o caminho na JO
  await withTenant(tenantId, async (tx) => {
    await tx`update job_orders set entry_pdf_path = ${path} where id = ${joId}`
  })
  return path
}
