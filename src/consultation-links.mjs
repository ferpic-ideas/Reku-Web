import { agreementRootDomain, validateAgreementSubdomainPrefix } from './agreement-domains.mjs';

export const appointmentBotUrl = (prefix, token, appPublicUrl) => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) throw new Error('BOT_LINK_TOKEN_INVALID');
  const url = new URL('/bot', appPublicUrl);
  if (prefix) url.hostname = `${validateAgreementSubdomainPrefix(prefix)}.${agreementRootDomain(appPublicUrl)}`;
  url.search = '';
  url.hash = `appointment=${token}`;
  return url.toString();
};

export const professionalReportUrl = appointmentId => {
  if (!Number.isSafeInteger(Number(appointmentId)) || Number(appointmentId) < 1) return '';
  return `/api/professional/appointments/${Number(appointmentId)}/consultation-report`;
};

export const adminReportUrl = appointmentId => {
  if (!Number.isSafeInteger(Number(appointmentId)) || Number(appointmentId) < 1) return '';
  return `/api/admin/appointments/${Number(appointmentId)}/consultation-report`;
};

export const adminReHubTriageUrl = value => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password ||
        !(url.hostname === 'rehub.cloud' || url.hostname.endsWith('.rehub.cloud'))) return '';
    return url.toString();
  } catch { return ''; }
};
