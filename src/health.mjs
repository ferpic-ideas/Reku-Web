import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  privateUploadRoot,
  publicUploadRoot,
  root,
} from "./config.mjs";
import { query } from "./db.mjs";
import { sendJson } from "./http.mjs";

const essentialBundleFiles = [
  join(root, "index.html"),
  join(root, "admin", "index.html"),
  join(root, "admin", "app.js"),
  join(root, "admin", "styles.css"),
  join(root, "agenda", "index.html"),
  join(root, "agenda", "app.js"),
  join(root, "agenda", "styles.css"),
  join(root, "profesional-turnos", "index.html"),
  join(root, "profesional-turnos", "app.js"),
  join(root, "profesional-turnos", "styles.css"),
  join(root, "profesional", "index.html"),
  join(root, "profesional", "app.js"),
  join(root, "profesional", "styles.css"),
];

const defaultCheckTimeoutMs = 3_000;

const defaultChecks = {
  postgres: async () => {
    await query("SELECT 1");
  },
  static_bundle: async () => {
    const fileStats = await Promise.all(
      essentialBundleFiles.map((file) => stat(file)),
    );
    if (fileStats.some((fileStat) => !fileStat.isFile())) {
      throw new Error("ESSENTIAL_BUNDLE_UNAVAILABLE");
    }
  },
  storage: async () => {
    const mode = fsConstants.R_OK | fsConstants.W_OK;
    await Promise.all([
      access(publicUploadRoot, mode),
      access(privateUploadRoot, mode),
    ]);
  },
};

const runCheck = async (check, timeoutMs) => {
  const startedAt = performance.now();
  let timeoutId;
  try {
    await Promise.race([
      Promise.resolve().then(check),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("HEALTH_CHECK_TIMEOUT")),
          timeoutMs,
        );
      }),
    ]);
    return {
      status: "ok",
      latency_ms: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  } catch {
    return {
      status: "error",
      latency_ms: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  } finally {
    clearTimeout(timeoutId);
  }
};

export const buildHealthReport = async (
  checks = defaultChecks,
  { checkTimeoutMs = defaultCheckTimeoutMs } = {},
) => {
  const results = await Promise.all(
    Object.entries(checks).map(async ([name, check]) => [
      name,
      await runCheck(check, checkTimeoutMs),
    ]),
  );
  const reportChecks = Object.fromEntries(results);
  const healthy = Object.values(reportChecks).every(
    (check) => check.status === "ok",
  );

  return {
    status: healthy ? "ok" : "error",
    app: "Reku Admin",
    checks: reportChecks,
  };
};

export const handleHealth = async (response) => {
  const report = await buildHealthReport();
  sendJson(response, report.status === "ok" ? 200 : 503, report);
};
