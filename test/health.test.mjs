import test from "node:test";
import assert from "node:assert/strict";
import { buildHealthReport } from "../src/health.mjs";

test("health report exposes healthy checks using the Reku contract", async () => {
  const report = await buildHealthReport({
    postgres: async () => {},
    static_bundle: async () => {},
    storage: async () => {},
  });

  assert.equal(report.status, "ok");
  assert.equal(report.app, "Reku Admin");
  assert.deepEqual(Object.keys(report.checks), [
    "postgres",
    "static_bundle",
    "storage",
  ]);

  for (const check of Object.values(report.checks)) {
    assert.equal(check.status, "ok");
    assert.equal(typeof check.latency_ms, "number");
    assert.ok(check.latency_ms >= 0);
  }
});

test("health report fails closed without exposing dependency errors", async () => {
  const report = await buildHealthReport({
    postgres: async () => {
      throw new Error("sensitive database detail");
    },
    static_bundle: async () => {},
    storage: async () => {},
  });

  assert.equal(report.status, "error");
  assert.equal(report.checks.postgres.status, "error");
  assert.equal("error" in report.checks.postgres, false);
  assert.equal(report.checks.static_bundle.status, "ok");
  assert.equal(report.checks.storage.status, "ok");
});

test("health report times out a stalled dependency without exposing details", async () => {
  const report = await buildHealthReport(
    {
      postgres: async () => new Promise(() => {}),
      static_bundle: async () => {},
      storage: async () => {},
    },
    { checkTimeoutMs: 20 },
  );

  assert.equal(report.status, "error");
  assert.equal(report.checks.postgres.status, "error");
  assert.equal("error" in report.checks.postgres, false);
  assert.equal(report.checks.static_bundle.status, "ok");
  assert.equal(report.checks.storage.status, "ok");
});
