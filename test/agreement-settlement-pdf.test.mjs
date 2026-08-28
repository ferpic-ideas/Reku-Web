import assert from "node:assert/strict";
import test from "node:test";
import { renderAgreementSettlementPdf } from "../src/agreement-settlements.mjs";

const snapshot = {
  agreement: { id: 7, name: "Acuerdo Ejemplo", slug: "ejemplo" },
  month: "2026-08",
  currency: "ARS",
  totals: { appointments: 2, cancelled: 1, amount: 45000 },
  appointments: [
    {
      appointment_id: "apt_11111111111111111111111111111111",
      external_id: "ORD-1001",
      payment_reference: "PAY-1001",
      patient_name: "Ana Pérez",
      patient_email: "ana@example.com",
      patient_phone: "+5491160000000",
      professional_name: "Lic. María González",
      service_name: "Evaluación Kinésica",
      date: "2026-08-04",
      start_time: "10:00",
      end_time: "10:30",
      status: "confirmed",
      cancellation_reason: "",
      amount: 20000,
      billable: true,
    },
    {
      appointment_id: "apt_22222222222222222222222222222222",
      external_id: "ORD-1002",
      payment_reference: "PAY-1002",
      patient_name: "Juan Fernández",
      patient_email: "juan@example.com",
      patient_phone: "+5491160000001",
      professional_name: "Lic. Pedro Núñez",
      service_name: "Tratamiento Kinésico",
      date: "2026-08-11",
      start_time: "14:30",
      end_time: "15:00",
      status: "confirmed",
      cancellation_reason: "",
      amount: 25000,
      billable: true,
    },
    {
      appointment_id: "apt_33333333333333333333333333333333",
      external_id: "ORD-1003",
      payment_reference: "PAY-1003",
      patient_name: "Carla López",
      patient_email: "carla@example.com",
      patient_phone: "+5491160000002",
      professional_name: "Lic. María González",
      service_name: "Evaluación Kinésica",
      date: "2026-08-18",
      start_time: "09:00",
      end_time: "09:30",
      status: "cancelled",
      cancellation_reason: "Cancelado por el acuerdo",
      amount: 20000,
      billable: false,
    },
  ],
};

test("monthly agreement settlement renders a valid detailed PDF", async () => {
  const pdf = await renderAgreementSettlementPdf(snapshot);
  assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(pdf.length > 1500);
});
