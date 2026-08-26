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

export const renderTemplate = (template, context) =>
  String(template || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [group, field] = key.split(".");
    return context[group]?.[field] ?? "";
  });

const renderTemplateHtml = (template, context) =>
  String(template || "")
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
      const [group, field] = key.split(".");
      const value = escapeHtml(context[group]?.[field] ?? "");
      return key === "agreement.type" ? `<strong>${value}</strong>` : value;
    })
    .replaceAll("\n", "<br />");

export const agreementFileUrl = (path) =>
  path ? `${config.appPublicUrl}/uploads/${path}` : "";

export const buildAgreementLinks = (agreement) => {
  const links = [];
  const pdfUrl = agreementFileUrl(agreement?.pdf_path);

  if (pdfUrl) {
    links.push({ label: "Cómo funciona", url: pdfUrl });
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
    return {
      subject,
      text: rows.map(([label, value]) => `${label}: ${value || ""}`).join("\n"),
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.5;">
          <h1 style="font-size: 20px;">${escapeHtml(subject)}</h1>
          ${rows
            .map(
              ([label, value]) =>
                `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`,
            )
            .join("")}
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
    defaultPatientSubject,
    context,
  );
  const body = renderTemplate(
    defaultPatientBody,
    context,
  );
  const links = buildAgreementLinks(agreement);
  const linksText = links.length
    ? `\n\nRecursos:\n${links.map((link) => `${link.label}: ${link.url}`).join("\n")}`
    : "";
  const htmlBody = renderTemplateHtml(
    defaultPatientBody,
    context,
  );
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

export const buildPatientVerificationEmail = ({
  submission,
  agreement,
  verificationUrl,
}) => {
  const patientName = [submission.values.nombre, submission.values.apellido]
    .filter(Boolean)
    .join(" ");
  const subject = "Confirmá tu mail para reservar tu turno - Reku";
  const intro = `Hola ${patientName || ""}, recibimos tu solicitud para ${
    agreement?.name || "Reku"
  }. Confirmá tu mail para continuar con la reserva.`;
  const pdfUrl = agreementFileUrl(agreement?.pdf_path);

  return {
    subject,
    text: [
      intro,
      "",
      `Confirmar mail: ${verificationUrl}`,
      "El enlace vence en 24 horas y puede usarse una sola vez.",
      pdfUrl ? `Cómo funciona: ${pdfUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5;">
        <h1 style="font-size: 20px;">${escapeHtml(subject)}</h1>
        <p>${escapeHtml(intro)}</p>
        <p><a href="${escapeHtml(verificationUrl)}" style="display:inline-block;padding:12px 18px;background:#18213f;color:#ffffff;text-decoration:none;border-radius:8px;">Confirmar mail y reservar</a></p>
        <p style="font-size: 13px; color: #667085;">El enlace vence en 24 horas y puede usarse una sola vez.</p>
        ${
          pdfUrl
            ? `<p><a href="${escapeHtml(pdfUrl)}" style="color:#18213f;">Cómo funciona</a></p>`
            : ""
        }
      </div>
    `,
  };
};

export const buildContactEmail = (submission) => {
  const rows = Object.entries(submission.labels).map(([key, label]) => ({
    label,
    value: Array.isArray(submission.values[key])
      ? submission.values[key].join(", ")
      : submission.values[key] || "",
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
