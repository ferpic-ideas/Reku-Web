import { createHmac } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mercadoPagoRefundIdempotencyKey,
  verifyMercadoPagoWebhookSignature,
} from "../src/mercado-pago.mjs";

const signedHeaders = ({ secret, dataId, timestamp, requestId = "request-1" }) => {
  const manifest = `id:${dataId};request-id:${requestId};ts:${timestamp};`;
  const signature = createHmac("sha256", secret).update(manifest).digest("hex");
  return {
    "x-request-id": requestId,
    "x-signature": `ts=${timestamp},v1=${signature}`,
  };
};

test("webhook verification fails closed without a configured secret", () => {
  assert.deepEqual(
    verifyMercadoPagoWebhookSignature({
      headers: {},
      dataId: "123",
      secret: "",
    }),
    { configured: false, valid: false, fresh: false },
  );
});

test("webhook verification accepts a fresh valid signature", () => {
  const secret = "webhook-secret";
  const dataId = "123";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const result = verifyMercadoPagoWebhookSignature({
    headers: signedHeaders({ secret, dataId, timestamp }),
    dataId,
    secret,
  });
  assert.equal(result.configured, true);
  assert.equal(result.fresh, true);
  assert.equal(result.valid, true);
});

test("webhook verification rejects stale and malformed signatures", () => {
  const secret = "webhook-secret";
  const dataId = "123";
  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 3600);
  assert.equal(
    verifyMercadoPagoWebhookSignature({
      headers: signedHeaders({
        secret,
        dataId,
        timestamp: staleTimestamp,
      }),
      dataId,
      secret,
    }).valid,
    false,
  );
  assert.equal(
    verifyMercadoPagoWebhookSignature({
      headers: {
        "x-request-id": "request-1",
        "x-signature": `ts=${Math.floor(Date.now() / 1000)},v1=not-hex`,
      },
      dataId,
      secret,
    }).valid,
    false,
  );
});

test("refunds use a stable appointment-scoped idempotency key", () => {
  assert.equal(
    mercadoPagoRefundIdempotencyKey(42),
    mercadoPagoRefundIdempotencyKey(42),
  );
  assert.notEqual(
    mercadoPagoRefundIdempotencyKey(42),
    mercadoPagoRefundIdempotencyKey(43),
  );
});
