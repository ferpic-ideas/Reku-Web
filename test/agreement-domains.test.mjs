import assert from "node:assert/strict";
import test from "node:test";
import {
  agreementBookingUrl,
  agreementSubdomainPrefixFromHostname,
  isValidAgreementSubdomainPrefix,
  validateAgreementSubdomainPrefix,
} from "../src/agreement-domains.mjs";

test("agreement subdomain prefixes use a single safe DNS label", () => {
  assert.equal(validateAgreementSubdomainPrefix(" YPF "), "ypf");
  assert.equal(isValidAgreementSubdomainPrefix("artro-2"), true);

  for (const prefix of [
    "",
    "ypf salud",
    "ypf_salud",
    "-ypf",
    "ypf-",
    "área",
    "a".repeat(64),
    "www",
  ]) {
    assert.equal(isValidAgreementSubdomainPrefix(prefix), false, prefix);
  }
});

test("only direct Reku agreement subdomains are recognized", () => {
  const appUrl = "https://www.reku.io";
  assert.equal(
    agreementSubdomainPrefixFromHostname("ypf.reku.io", appUrl),
    "ypf",
  );
  assert.equal(
    agreementSubdomainPrefixFromHostname("www.reku.io", appUrl),
    "",
  );
  assert.equal(
    agreementSubdomainPrefixFromHostname("nested.ypf.reku.io", appUrl),
    "",
  );
  assert.equal(
    agreementSubdomainPrefixFromHostname("ypf.reku.io.example", appUrl),
    "",
  );
});

test("agreement URLs prefer the dedicated subdomain and keep legacy fallback", () => {
  assert.equal(
    agreementBookingUrl(
      { slug: "ypf", subdomain_prefix: "ypf" },
      "https://www.reku.io",
    ),
    "https://ypf.reku.io/turnos/",
  );
  assert.equal(
    agreementBookingUrl({ slug: "legacy" }, "https://www.reku.io"),
    "https://www.reku.io/turnos/?form=legacy",
  );
});
