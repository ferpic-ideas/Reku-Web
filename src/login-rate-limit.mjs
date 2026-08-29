import { consumeRateLimit } from "./rate-limit.mjs";

export const enforceLoginRateLimit = async (clientIp, identity) => {
  const normalizedIdentity = String(identity || "missing").trim().toLowerCase();
  await Promise.all([
    consumeRateLimit({
      scope: "login.ip.5m",
      key: clientIp || "unknown",
      limit: 10,
      windowSeconds: 300,
    }),
    consumeRateLimit({
      scope: "login.identity.5m",
      key: normalizedIdentity,
      limit: 10,
      windowSeconds: 300,
    }),
  ]);
};
