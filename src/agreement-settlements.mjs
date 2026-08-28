import { randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import { one, query, recordAudit } from "./db.mjs";
import { withSecurityHeaders } from "./http.mjs";

const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

const settlementError = (code, message, statusCode = 422) => {
  const error = new Error(code);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
};

const validateMonth = (value) => {
  const month = String(value || "").trim();
  if (!monthPattern.test(month)) {
    throw settlementError("SETTLEMENT_MONTH_INVALID", "Seleccioná un mes válido.");
  }
  return month;
};

const monthEndExclusive = (month) => {
  const [year, monthNumber] = month.split("-").map(Number);
  return monthNumber === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(monthNumber + 1).padStart(2, "0")}-01`;
};

const mapSettlementAppointment = (row) => ({
  appointment_id: row.agreement_api_public_id,
  external_id: row.agreement_api_external_id,
  payment_reference: row.payment_reference || "",
  patient_name: row.patient_name || "",
  patient_email: row.patient_email || "",
  patient_phone: row.patient_phone || "",
  professional_name: row.professional_name || "",
  service_name: row.service_name || "",
  date: row.appointment_date,
  start_time: String(row.start_time || "").slice(0, 5),
  end_time: String(row.end_time || "").slice(0, 5),
  status: row.status,
  cancellation_reason: row.cancellation_reason || "",
  amount: Number(row.amount || 0),
  billable: row.status === "confirmed",
});

export const getAgreementSettlementPreview = async ({ agreementId, month }) => {
  const parsedAgreementId = Number(agreementId);
  if (!Number.isInteger(parsedAgreementId) || parsedAgreementId < 1) {
    throw settlementError("SETTLEMENT_AGREEMENT_INVALID", "Seleccioná un acuerdo.");
  }
  const periodMonth = validateMonth(month);
  const agreement = await one(
    `
      SELECT id, name, slug, type
      FROM agreements
      WHERE id = $1 AND deleted_at IS NULL
    `,
    [parsedAgreementId],
  );
  if (!agreement) {
    throw settlementError("SETTLEMENT_AGREEMENT_NOT_FOUND", "Acuerdo no encontrado.", 404);
  }
  if (agreement.type !== "Pago") {
    throw settlementError(
      "SETTLEMENT_AGREEMENT_NOT_AVAILABLE",
      "Las liquidaciones por API sólo están disponibles para acuerdos que no son de nómina.",
    );
  }
  const start = `${periodMonth}-01`;
  const end = monthEndExclusive(periodMonth);
  const result = await query(
    `
      SELECT
        appointment.agreement_api_public_id,
        appointment.agreement_api_external_id,
        appointment.payment_reference,
        appointment.patient_name,
        appointment.patient_email,
        appointment.patient_phone,
        professional.name AS professional_name,
        service.name AS service_name,
        to_char(appointment.appointment_date, 'YYYY-MM-DD') AS appointment_date,
        to_char(appointment.start_time, 'HH24:MI') AS start_time,
        to_char(appointment.end_time, 'HH24:MI') AS end_time,
        appointment.status,
        appointment.cancellation_reason,
        appointment.amount
      FROM appointments appointment
      INNER JOIN professionals professional ON professional.id = appointment.professional_id
      INNER JOIN services service ON service.id = appointment.service_id
      WHERE appointment.agreement_id = $1
        AND appointment.booking_channel = 'agreement_api'
        AND appointment.appointment_date >= $2::date
        AND appointment.appointment_date < $3::date
      ORDER BY appointment.appointment_date, appointment.start_time, appointment.id
    `,
    [parsedAgreementId, start, end],
  );
  const appointments = result.rows.map(mapSettlementAppointment);
  const billable = appointments.filter((appointment) => appointment.billable);
  const existing = await one(
    `
      SELECT id, public_id, status, total_appointments, total_cancelled,
             total_amount, generated_at, finalized_at
      FROM agreement_settlements
      WHERE agreement_id = $1 AND period_month = $2::date
    `,
    [parsedAgreementId, start],
  );
  return {
    agreement: {
      id: Number(agreement.id),
      name: agreement.name,
      slug: agreement.slug,
    },
    month: periodMonth,
    currency: "ARS",
    totals: {
      appointments: billable.length,
      cancelled: appointments.length - billable.length,
      amount: Number(
        billable.reduce((total, appointment) => total + appointment.amount, 0).toFixed(2),
      ),
    },
    appointments,
    generated_settlement: existing
      ? {
          id: Number(existing.id),
          public_id: existing.public_id,
          status: existing.status,
          total_appointments: Number(existing.total_appointments || 0),
          total_cancelled: Number(existing.total_cancelled || 0),
          total_amount: Number(existing.total_amount || 0),
          generated_at: existing.generated_at,
          finalized_at: existing.finalized_at,
        }
      : null,
  };
};

export const generateAgreementSettlement = async ({ agreementId, month, userId }) => {
  const snapshot = await getAgreementSettlementPreview({ agreementId, month });
  const periodMonth = `${snapshot.month}-01`;
  const publicId = `liq_${randomUUID().replaceAll("-", "")}`;
  const result = await query(
    `
      INSERT INTO agreement_settlements (
        public_id, agreement_id, period_month, status,
        total_appointments, total_cancelled, total_amount,
        snapshot, generated_by_user_id, generated_at
      )
      VALUES ($1, $2, $3::date, 'generated', $4, $5, $6, $7::jsonb, $8, NOW())
      ON CONFLICT (agreement_id, period_month) DO UPDATE SET
        status = 'generated',
        total_appointments = EXCLUDED.total_appointments,
        total_cancelled = EXCLUDED.total_cancelled,
        total_amount = EXCLUDED.total_amount,
        snapshot = EXCLUDED.snapshot,
        generated_by_user_id = EXCLUDED.generated_by_user_id,
        generated_at = NOW(),
        finalized_at = NULL
      RETURNING id, public_id, status, total_appointments, total_cancelled,
                total_amount, generated_at, finalized_at
    `,
    [
      publicId,
      snapshot.agreement.id,
      periodMonth,
      snapshot.totals.appointments,
      snapshot.totals.cancelled,
      snapshot.totals.amount,
      JSON.stringify({ ...snapshot, generated_settlement: undefined }),
      userId,
    ],
  );
  const settlement = {
    id: Number(result.rows[0].id),
    public_id: result.rows[0].public_id,
    status: result.rows[0].status,
    total_appointments: Number(result.rows[0].total_appointments || 0),
    total_cancelled: Number(result.rows[0].total_cancelled || 0),
    total_amount: Number(result.rows[0].total_amount || 0),
    generated_at: result.rows[0].generated_at,
    finalized_at: result.rows[0].finalized_at,
  };
  await recordAudit("agreement_settlement.generated", {
    actorUserId: userId,
    detail: {
      settlement_id: settlement.id,
      agreement_id: snapshot.agreement.id,
      month: snapshot.month,
      total_appointments: settlement.total_appointments,
      total_cancelled: settlement.total_cancelled,
      total_amount: settlement.total_amount,
    },
  });
  return { settlement, snapshot };
};

const money = (value) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 2,
  }).format(Number(value || 0));

const displayDate = (value) => {
  const [year, month, day] = String(value || "").split("-");
  return year && month && day ? `${day}/${month}/${year}` : String(value || "");
};

const statusLabel = (appointment) =>
  appointment.status === "cancelled" ? "Cancelado" : "Confirmado";

const settlementFilename = (snapshot) =>
  `liquidacion-${String(snapshot.agreement.slug || snapshot.agreement.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "acuerdo"}-${snapshot.month}.pdf`;

export const renderAgreementSettlementPdf = (snapshot) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - 80;
    const columns = [
      { key: "date", label: "Fecha", width: 58 },
      { key: "time", label: "Horario", width: 55 },
      { key: "patient", label: "Paciente", width: 105 },
      { key: "professional", label: "Profesional", width: 85 },
      { key: "service", label: "Práctica", width: 97 },
      { key: "status", label: "Estado", width: 62 },
      { key: "amount", label: "Monto", width: 53, align: "right" },
    ];

    const drawBrand = () => {
      doc.fillColor("#55c7d8").font("Helvetica-Bold").fontSize(28).text("Reku", 40, 34);
      doc
        .fillColor("#172241")
        .font("Helvetica-Bold")
        .fontSize(18)
        .text("Liquidación mensual", 40, 72);
      doc
        .fillColor("#65728a")
        .font("Helvetica")
        .fontSize(9)
        .text("Turnos confirmados mediante la API de acuerdos", 40, 96);
      doc
        .strokeColor("#dce4ef")
        .moveTo(40, 116)
        .lineTo(pageWidth - 40, 116)
        .stroke();
    };

    const drawTableHeader = (y) => {
      doc.rect(40, y, contentWidth, 22).fill("#172241");
      let x = 40;
      for (const column of columns) {
        doc
          .fillColor("#ffffff")
          .font("Helvetica-Bold")
          .fontSize(7)
          .text(column.label, x + 4, y + 7, {
            width: column.width - 8,
            align: column.align || "left",
            lineBreak: false,
          });
        x += column.width;
      }
      return y + 22;
    };

    drawBrand();
    doc
      .fillColor("#172241")
      .font("Helvetica-Bold")
      .fontSize(11)
      .text(`Acuerdo: ${snapshot.agreement.name}`, 40, 135);
    doc
      .font("Helvetica")
      .fontSize(10)
      .text(`Período: ${snapshot.month}`, 40, 153)
      .text(`Generado: ${new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" }).format(new Date())}`, 40, 169);
    doc
      .roundedRect(pageWidth - 225, 134, 185, 54, 6)
      .fill("#eef9f4");
    doc
      .fillColor("#176b48")
      .font("Helvetica-Bold")
      .fontSize(10)
      .text(`${snapshot.totals.appointments} turnos facturables`, pageWidth - 213, 145)
      .fontSize(15)
      .text(money(snapshot.totals.amount), pageWidth - 213, 164);

    let y = drawTableHeader(210);
    snapshot.appointments.forEach((appointment, index) => {
      const values = {
        date: displayDate(appointment.date),
        time: `${appointment.start_time}\n${appointment.end_time}`,
        patient: `${appointment.patient_name}\n${appointment.patient_email}`,
        professional: appointment.professional_name,
        service: appointment.service_name,
        status: statusLabel(appointment),
        amount: appointment.billable ? money(appointment.amount) : "—",
      };
      const rowHeight = Math.max(
        30,
        ...columns.map((column) =>
          doc.heightOfString(values[column.key], {
            width: column.width - 8,
            font: "Helvetica",
            fontSize: 7,
          }),
        ),
      ) + 10;
      if (y + rowHeight > doc.page.height - 58) {
        doc.addPage();
        drawBrand();
        y = drawTableHeader(135);
      }
      doc.rect(40, y, contentWidth, rowHeight).fill(index % 2 ? "#f7f9fc" : "#ffffff");
      let x = 40;
      for (const column of columns) {
        doc
          .fillColor(appointment.billable ? "#172241" : "#8a5160")
          .font(column.key === "amount" ? "Helvetica-Bold" : "Helvetica")
          .fontSize(7)
          .text(values[column.key], x + 4, y + 6, {
            width: column.width - 8,
            align: column.align || "left",
          });
        x += column.width;
      }
      doc.strokeColor("#e4eaf2").moveTo(40, y + rowHeight).lineTo(pageWidth - 40, y + rowHeight).stroke();
      y += rowHeight;
    });

    if (!snapshot.appointments.length) {
      doc
        .fillColor("#65728a")
        .font("Helvetica")
        .fontSize(10)
        .text("No hubo turnos reservados por API durante este período.", 48, y + 18);
      y += 54;
    }

    if (y + 82 > doc.page.height - 50) {
      doc.addPage();
      drawBrand();
      y = 135;
    }
    const summaryY = y + 18;
    doc
      .roundedRect(pageWidth - 260, summaryY, 220, 65, 6)
      .fill("#f3f1ff");
    doc
      .fillColor("#172241")
      .font("Helvetica")
      .fontSize(9)
      .text(`Confirmados: ${snapshot.totals.appointments}`, pageWidth - 248, summaryY + 11)
      .text(`Cancelados: ${snapshot.totals.cancelled}`, pageWidth - 248, summaryY + 26)
      .font("Helvetica-Bold")
      .fontSize(11)
      .text(`Total: ${money(snapshot.totals.amount)}`, pageWidth - 248, summaryY + 43);

    const range = doc.bufferedPageRange();
    for (let pageIndex = 0; pageIndex < range.count; pageIndex += 1) {
      doc.switchToPage(pageIndex);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc
        .fillColor("#8b96aa")
        .font("Helvetica")
        .fontSize(7)
        .text(
          `Reku · Liquidación ${snapshot.agreement.name} · ${snapshot.month} · Página ${pageIndex + 1} de ${range.count}`,
          40,
          doc.page.height - 30,
          { width: contentWidth, align: "center", lineBreak: false },
        );
      doc.page.margins.bottom = bottomMargin;
    }
    doc.end();
  });

export const streamAgreementSettlementPdf = async (response, settlementId) => {
  const settlement = await one(
    `SELECT id, snapshot FROM agreement_settlements WHERE id = $1`,
    [settlementId],
  );
  if (!settlement) {
    throw settlementError("SETTLEMENT_NOT_FOUND", "Liquidación no encontrada.", 404);
  }
  const snapshot = settlement.snapshot;
  const pdf = await renderAgreementSettlementPdf(snapshot);
  response.writeHead(
    200,
    withSecurityHeaders(
      {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${settlementFilename(snapshot)}"`,
        "Content-Length": String(pdf.length),
        "Cache-Control": "private, no-store",
      },
      { privateRoute: true },
    ),
  );
  response.end(pdf);
};
