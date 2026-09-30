import test from 'node:test';
import assert from 'node:assert/strict';
import { agreementEmailHtml, usesYpfBrand } from '../src/agreement-brand.mjs';
import { patientConfirmationHtml, patientConfirmationSubject } from '../src/appointment-notifications.mjs';
import { buildPatientVerificationEmail } from '../src/templates.mjs';
import { renderConsultationReport } from '../src/consultation-bot-report.mjs';
const brand = { name: 'YPF Obra Social', cobranded: true, brand_theme: 'ypf-os' };

test('branding requires both an explicit supported theme and cobranding', () => {
  for (const other of [undefined, {}, { name:'YPF', slug:'ypf', cobranded:true }, {...brand,cobranded:false}, {...brand,brand_theme:'unknown'}]) {
    assert.equal(usesYpfBrand(other), false);
    assert.equal(agreementEmailHtml(other, '<p>Sin cambios</p>'), '<p>Sin cambios</p>');
  }
  assert.equal(usesYpfBrand(brand), true);
});
test('email branding recolors styles without rewriting patient text or private links', () => {
  const body='<p style="color:#18213f">Texto #18213f</p><a href="https://example.test/#6c4bf4" style="background:#6c4bf4">Abrir</a>';
  const html=agreementEmailHtml(brand,body);
  assert.match(html,/color:#001464/); assert.match(html,/background:#0451E4/);
  assert.ok(html.includes('Texto #18213f')); assert.ok(html.includes('href="https://example.test/#6c4bf4"'));
  assert.match(html,/alt="YPF Obra Social"/); assert.match(html,/Servicio brindado por/);
});
test('confirmation and verification use the configured brand without exposing markup', () => {
  const appointment={agreement_brand:brand,appointment_date:'2026-10-01',start_time:'10:00',end_time:'10:30',service_name:'<Prueba>',professional_name:'Profesional'};
  assert.match(patientConfirmationSubject(appointment), /YPF Obra Social · Reku/);
  const html=patientConfirmationHtml({appointment,manageUrl:'https://example.test/private#token'});
  assert.ok(html.includes('&lt;Prueba&gt;')); assert.ok(html.includes('https://example.test/private#token'));
  const verification=buildPatientVerificationEmail({agreement:brand,submission:{values:{nombre:'Prueba',apellido:'Local'}},verificationUrl:'https://example.test/verify'});
  assert.match(verification.html,/YPF Obra Social/); assert.match(verification.html,/Confirmar mail y reservar/);
});
test('YPF consultation PDF embeds the official DIN fonts', async () => {
  const pdf=await renderConsultationReport({brand:{...brand,slug:'ypf',logo_url:''},updatedAt:'2026-09-30T12:00:00Z',data:{complaints:[]}}, {narrative:'Relato sintético para verificar la tipografía.'});
  assert.equal(pdf.subarray(0,4).toString(),'%PDF');
  assert.match(pdf.toString('latin1'),/DIN/);
  assert.match(pdf.toString('latin1'),/FontFile2/);
});
