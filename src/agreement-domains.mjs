const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const reservedPrefixes = new Set([
  "admin",
  "api",
  "app",
  "assets",
  "cdn",
  "dev",
  "ftp",
  "imap",
  "localhost",
  "mail",
  "patient",
  "patients",
  "physios",
  "pop",
  "reku-web",
  "smtp",
  "staging",
  "static",
  "status",
  "support",
  "test",
  "users",
  "www",
]);

export const normalizeAgreementSubdomainPrefix = (value) =>
  String(value || "").trim().toLowerCase();

export const isValidAgreementSubdomainPrefix = (value) => {
  const prefix = normalizeAgreementSubdomainPrefix(value);
  return dnsLabelPattern.test(prefix) && !reservedPrefixes.has(prefix);
};

export const validateAgreementSubdomainPrefix = (value) => {
  const prefix = normalizeAgreementSubdomainPrefix(value);
  if (!prefix) {
    const error = new Error("AGREEMENT_SUBDOMAIN_REQUIRED");
    error.statusCode = 422;
    throw error;
  }
  if (!dnsLabelPattern.test(prefix)) {
    const error = new Error("AGREEMENT_SUBDOMAIN_INVALID");
    error.statusCode = 422;
    throw error;
  }
  if (reservedPrefixes.has(prefix)) {
    const error = new Error("AGREEMENT_SUBDOMAIN_RESERVED");
    error.statusCode = 422;
    throw error;
  }
  return prefix;
};

export const agreementRootDomain = (appPublicUrl) => {
  const hostname = new URL(appPublicUrl).hostname.toLowerCase().replace(/\.$/, "");
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
};

export const agreementSubdomainPrefixFromHostname = (
  hostname,
  appPublicUrl,
) => {
  const normalizedHostname = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  const rootDomain = agreementRootDomain(appPublicUrl);
  const suffix = `.${rootDomain}`;
  if (!normalizedHostname.endsWith(suffix)) return "";
  const prefix = normalizedHostname.slice(0, -suffix.length);
  if (prefix.includes(".") || !isValidAgreementSubdomainPrefix(prefix)) return "";
  return prefix;
};

export const agreementBookingUrl = (agreement, appPublicUrl) => {
  const prefix = normalizeAgreementSubdomainPrefix(
    agreement?.subdomain_prefix,
  );
  if (isValidAgreementSubdomainPrefix(prefix)) {
    const baseUrl = new URL(appPublicUrl);
    baseUrl.hostname = `${prefix}.${agreementRootDomain(appPublicUrl)}`;
    baseUrl.pathname = "/turnos/";
    baseUrl.search = "";
    baseUrl.hash = "";
    return baseUrl.toString();
  }
  const baseUrl = new URL("/turnos/", appPublicUrl);
  if (agreement?.slug) baseUrl.searchParams.set("form", agreement.slug);
  return baseUrl.toString();
};
