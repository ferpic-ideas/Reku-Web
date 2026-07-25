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

const adminBundleFiles = [
  join(root, "admin", "index.html"),
  join(root, "admin", "app.js"),
  join(root, "admin", "styles.css"),
];

const defaultChecks = {
  postgres: async () => {
    await query("SELECT 1");
  },
  static_bundle: async () => {
    const fileStats = await Promise.all(adminBundleFiles.map((file) => stat(file)));
    if (fileStats.some((fileStat) => !fileStat.isFile())) {
      throw new Error("ADMIN_BUNDLE_UNAVAILABLE");
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

const runCheck = async (check) => {
  const startedAt = performance.now();
  try {
    await check();
    return {
      status: "ok",
      latency_ms: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  } catch {
    return {
      status: "error",
      latency_ms: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  }
};

export const buildHealthReport = async (checks = defaultChecks) => {
  const results = await Promise.all(
    Object.entries(checks).map(async ([name, check]) => [
      name,
      await runCheck(check),
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
