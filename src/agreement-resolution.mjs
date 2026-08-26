import { config } from "./config.mjs";
import {
  getAgreementBySlug,
  getAgreementBySubdomainPrefix,
} from "./db.mjs";
import { agreementSubdomainPrefixFromHostname } from "./agreement-domains.mjs";

export const agreementPrefixForRequest = (request) => {
  const host = String(request?.headers?.host || "").trim();
  if (!host) return "";
  try {
    return agreementSubdomainPrefixFromHostname(
      new URL(`http://${host}`).hostname,
      config.appPublicUrl,
    );
  } catch {
    return "";
  }
};

export const resolveAgreementForRequest = async (request, url) => {
  const slug = String(url.searchParams.get("form") || "").trim();
  const prefix = agreementPrefixForRequest(request);
  const [slugAgreement, prefixAgreement] = await Promise.all([
    slug ? getAgreementBySlug(slug) : null,
    prefix ? getAgreementBySubdomainPrefix(prefix) : null,
  ]);

  if (
    slugAgreement &&
    prefixAgreement &&
    Number(slugAgreement.id) !== Number(prefixAgreement.id)
  ) {
    return null;
  }
  return prefixAgreement || slugAgreement || null;
};

export const requestIdentifiesAgreement = (request, url) =>
  Boolean(
    String(url.searchParams.get("form") || "").trim() ||
      agreementPrefixForRequest(request),
  );
