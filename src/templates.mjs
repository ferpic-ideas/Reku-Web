import { config } from "./config.mjs";
import { escapeHtml } from "./http.mjs";

export const defaultPatientSubject =
  "Alta de paciente - {{agreement.name}}";

export const defaultPatientBody = [
  "Recibimos una nueva solicitud de alta.",
  "",
  "Paciente: {{patient.nombre}} {{patient.apellido}}",
  "Teléfono: {{patient.telefono}}",
  "Mail: {{patient.email}}",
  "Identificador: {{patient.identificador}}",
  "Acuerdo: {{agreement.name}}",
  "Tipo de acuerdo: {{agreement.type}}",
].join("\n");

export const allowedTemplateVariables = new Set([
  "patient.nombre",
  "patient.apellido",
  "patient.telefono",
  "patient.email",
  "patient.identificador",
  "agreement.name",
  "agreement.type",
]);

export const getTemplateErrors = (subject, body) => {
  const errors = [];
  const values = [
    ["subject", subject],
    ["body", body],
  ];

  for (const [label, value] of values) {
    if (!String(value || "").trim()) {
      errors.push(`${label === "subject" ? "El asunto" : "El cuerpo"} es obligatorio.`);
    }

    const stripped = String(value || "").replace(/\{\{\s*[\w.]+\s*\}\}/g, "");
    if (stripped.includes("{{") || stripped.includes("}}")) {
      errors.push(
        `${label === "subject" ? "El asunto" : "El cuerpo"} tiene llaves de template sin cerrar.`,
      );
    }

    for (const match of String(value || "").matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
      if (!allowedTemplateVariables.has(match[1])) {
        errors.push(`Variable no permitida: {{${match[1]}}}.`);
      }
    }
  }

  if (errors.length === 0) {
    const preview = renderTemplate(body, sampleTemplateContext());
    if (/\{\{.*\}\}/.test(preview)) {
      errors.push("El template deja variables sin resolver.");
    }
  }

  return [...new Set(errors)];
};

export const sampleTemplateContext = () => ({
  patient: {
    nombre: "María",
    apellido: "Gómez",
    telefono: "+54 11 4444 5555",
    email: "maria@email.com",
    identificador: "ABC123",
  },
  agreement: {
    name: "Acuerdo Demo",
    type: "Pago",
  },
});

export const renderTemplate = (template, context) =>
  String(template || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [group, field] = key.split(".");
    return context[group]?.[field] ?? "";
  });

export const agreementFileUrl = (path) =>
  path ? `${config.appPublicUrl}/uploads/${path}` : "";

export const buildAgreementLinks = (agreement) => {
  const links = [];
  const pdfUrl = agreementFileUrl(agreement?.pdf_path);

  if (pdfUrl) {
    links.push({ label: "Cómo funciona", url: pdfUrl });
  }

  if (agreement && agreement.type !== "Nomina" && agreement.payment_evaluation_url) {
    links.push({
      label: "Link de pago de consulta/evaluación",
      url: agreement.payment_evaluation_url,
    });
  }

  if (agreement && agreement.type !== "Nomina" && agreement.payment_treatment_url) {
    links.push({
      label: "Link de pago de tratamiento",
      url: agreement.payment_treatment_url,
    });
  }

  return links;
};

export const buildPatientEmail = ({ submission, agreement }) => {
  if (!agreement) {
    const subject = "Alta de paciente desde QR - Reku";
    const rows = [
      ["Nombre", submission.values.nombre],
      ["Apellido", submission.values.apellido],
      ["Teléfono", submission.values.telefono],
      ["Mail", submission.values.email],
    ];
    const bookingLine = submission.booking_url
      ? `\nReservar turno: ${submission.booking_url}`
      : "";
    const bookingHtml = submission.booking_url
      ? `<p><strong>Reservar turno:</strong> <a href="${escapeHtml(
          submission.booking_url,
        )}">${escapeHtml(submission.booking_url)}</a></p>`
      : "";
    return {
      subject,
      text: `${rows.map(([label, value]) => `${label}: ${value || ""}`).join("\n")}${bookingLine}`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.5;">
          <h1 style="font-size: 20px;">${escapeHtml(subject)}</h1>
          ${rows
            .map(
              ([label, value]) =>
                `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`,
            )
            .join("")}
          ${bookingHtml}
        </div>
      `,
    };
  }

  const context = {
    patient: {
      nombre: submission.values.nombre,
      apellido: submission.values.apellido,
      telefono: submission.values.telefono,
      email: submission.values.email,
      identificador: submission.values.identificador || "",
    },
    agreement: {
      name: agreement.name,
      type: agreement.type,
    },
  };
  const subject = renderTemplate(
    agreement.email_subject_template || defaultPatientSubject,
    context,
  );
  const body = renderTemplate(
    agreement.email_body_template || defaultPatientBody,
    context,
  );
  const links = buildAgreementLinks(agreement);
  if (submission.booking_url) {
    links.push({ label: "Reservar turno", url: submission.booking_url });
  }
  const linksText = links.length
    ? `\n\nRecursos:\n${links.map((link) => `${link.label}: ${link.url}`).join("\n")}`
    : "";
  const htmlBody = escapeHtml(body).replaceAll("\n", "<br />");
  const linksHtml = links.length
    ? `<h2 style="font-size: 16px;">Recursos</h2>${links
        .map(
          (link) =>
            `<p><strong>${escapeHtml(link.label)}:</strong> <a href="${escapeHtml(
              link.url,
            )}">${escapeHtml(link.url)}</a></p>`,
        )
        .join("")}`
    : "";

  return {
    subject,
    text: `${body}${linksText}`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5;">
        <h1 style="font-size: 20px;">${escapeHtml(subject)}</h1>
        <p>${htmlBody}</p>
        ${linksHtml}
      </div>
    `,
  };
};

export const buildContactEmail = (submission) => {
  const rows = Object.entries(submission.labels).map(([key, label]) => ({
    label,
    value: submission.values[key] || "",
  }));

  const text = rows.map(({ label, value }) => `${label}: ${value}`).join("\n");
  const htmlRows = rows
    .map(
      ({ label, value }) =>
        `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`,
    )
    .join("");

  return {
    subject: submission.subject,
    text,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5;">
        <h1 style="font-size: 20px;">${escapeHtml(submission.subject)}</h1>
        ${htmlRows}
      </div>
    `,
  };
};
