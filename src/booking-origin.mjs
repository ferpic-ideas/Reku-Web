import { config } from './config.mjs';
import { agreementSubdomainPrefixFromHostname } from './agreement-domains.mjs';

// Multipart intake can originate on the main site or an agreement subdomain.
// Require the actual receiving host, not a sibling site or forwarded headers.
// createIntakeAccess separately verifies that the agreement exists and matches.
export const enforceBookingIntakeOrigin = (request, appPublicUrl = config.appPublicUrl) => {
  let valid = false;
  try {
    const rawOrigin = String(request.headers.origin || '').trim();
    const origin = new URL(rawOrigin);
    const app = new URL(appPublicUrl);
    const host = String(request.headers.host || '').trim().toLowerCase();
    valid = rawOrigin === origin.origin &&
      ['http:', 'https:'].includes(origin.protocol) &&
      origin.protocol === app.protocol && origin.port === app.port &&
      origin.host === host &&
      (origin.origin === app.origin || Boolean(
        agreementSubdomainPrefixFromHostname(origin.hostname, appPublicUrl),
      ));
  } catch {
    valid = false;
  }
  if (!valid) {
    const error = new Error('PATIENT_APPOINTMENT_ORIGIN_INVALID');
    error.statusCode = 403;
    throw error;
  }
};
