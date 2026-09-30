import { config } from './config.mjs';
import { escapeHtml } from './http.mjs';

export const ypfBrand = Object.freeze({
  name: 'YPF Obra Social',
  blue: '#0451E4', navy: '#001464', mint: '#4AE5C2',
  logo: '/turnos/brands/ypf-os/logo.png',
  fontRegular: 'assets/ypf-guide/din-regular.ttf',
  fontMedium: 'assets/ypf-guide/din-medium.ttf',
});

export const usesYpfBrand = (agreement) =>
  Boolean(agreement?.cobranded && agreement.brand_theme === 'ypf-os');

// Current agreement settings apply to old appointment links and future messages.
export const appointmentBrandSql = (alias) => {
  if (!/^[a-z_]+$/.test(alias)) throw new Error('INVALID_SQL_ALIAS');
  return `(SELECT json_build_object('name', brand.name, 'cobranded', brand.cobranded, 'brand_theme', brand.brand_theme)
    FROM agreements brand WHERE brand.id = ${alias}.agreement_id AND brand.deleted_at IS NULL) AS agreement_brand`;
};

export const agreementEmailHtml = (agreement, content) => {
  if (!usesYpfBrand(agreement)) return content;
  const absolute = (path) => escapeHtml(new URL(path, config.appPublicUrl).href);
  // Only rewrite CSS declarations, never user text, URLs or tokens.
  const body = content.replace(/style="([^"]*)"/g, (_, styles) => `style="${styles
    .replace(/#(?:6c4bf4|625df5|318b99)/gi, ypfBrand.blue)
    .replace(/#18213f/gi, ypfBrand.navy)
    .replace(/#(?:f4f1ff|ecebff)/gi, '#eef4ff')
    .replace(/font-family:[^;]+/gi, "font-family:'DIN',Arial,sans-serif")}"`);
  return `<div style="background:#f4f7fc;padding:24px 12px;font-family:'DIN',Arial,sans-serif;color:${ypfBrand.navy};line-height:1.5">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:640px;margin:auto;background:#ffffff;border-collapse:collapse">
      <tr><td style="height:8px;background:${ypfBrand.blue};background:linear-gradient(110deg,${ypfBrand.blue},${ypfBrand.navy})"></td></tr>
      <tr><td style="padding:32px 28px;border-bottom:4px solid ${ypfBrand.mint}"><img src="${absolute(ypfBrand.logo)}" width="240" alt="YPF Obra Social" style="display:block;max-width:100%;height:auto" /></td></tr>
      <tr><td style="padding:28px">${body}</td></tr>
      <tr><td style="padding:20px 28px;border-top:1px solid #dbe3ee;color:#53617b;font-size:13px">Servicio brindado por <strong>Reku</strong></td></tr>
    </table>
  </div>`;
};
