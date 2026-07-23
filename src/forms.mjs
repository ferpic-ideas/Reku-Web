import { config } from "./config.mjs";
import {
  findNominaEntry,
  getAgreementBySlug,
  pool,
  query,
  recordAudit,
} from "./db.mjs";
import { sendEmail } from "./email.mjs";
import { getTrimmed, parseRequestBody, sendJson } from "./http.mjs";
import {
  buildContactEmail,
  buildPatientBookingEmail,
  buildPatientEmail,
} from "./templates.mjs";
import { createBookingAccessLink } from "./booking-links.mjs";

const genericDomains = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "gmx.com",
  "mail.com",
  "proton.me",
  "protonmail.com",
  "yandex.com",
]);

const namePattern = /^[\p{L}]+(?:[ '-][\p{L}]+)*$/u;
const phonePattern = /^[+()\d\s.-]+$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const validateName = (value, fieldName) => {
  if (!value) return `Ingresá tu ${fieldName}.`;
  if (value.length < 2) return `El ${fieldName} debe tener al menos 2 letras.`;
  if (!namePattern.test(value)) {
    return "Usá solo letras, espacios, apóstrofes o guiones.";
  }
  return "";
};

const validatePhone = (value) => {
  const digits = value.replace(/\D/g, "");
  if (!value) return "Ingresá tu teléfono.";
  if (!phonePattern.test(value) || digits.length < 8 || digits.length > 15) {
    return "Ingresá un teléfono válido, con código de área.";
  }
  return "";
};

const validateEmail = (value, { corporate = false } = {}) => {
  const normalized = value.toLowerCase();
  const emailDomain = normalized.split("@")[1] || "";

  if (!value) return corporate ? "Ingresá tu email corporativo." : "Ingresá tu mail.";
  if (!emailPattern.test(normalized)) {
    return corporate
      ? "Ingresá un email válido, por ejemplo nombre@empresa.com."
      : "Ingresá un mail válido, por ejemplo nombre@email.com.";
  }
  if (corporate && genericDomains.has(emailDomain)) {
    return "Usá un email corporativo, no uno personal.";
  }

  return "";
};

const normalizeSubmission = (params) => {
  const formName = getTrimmed(params, "reku-form");

  if (formName === "contact") {
    return {
      formName,
      to: config.contactToEmail,
      subject: "Nuevo contacto institucional - Reku",
      replyTo: getTrimmed(params, "email").toLowerCase(),
      values: {
        nombre: getTrimmed(params, "nombre"),
        apellido: getTrimmed(params, "apellido"),
        email: getTrimmed(params, "email").toLowerCase(),
        telefono: getTrimmed(params, "telefono"),
        organizacion: getTrimmed(params, "organizacion"),
        rol: getTrimmed(params, "rol"),
        pacientes: getTrimmed(params, "pacientes"),
      },
      labels: {
        nombre: "Nombre",
        apellido: "Apellido",
        email: "Email corporativo",
        telefono: "Teléfono",
        organizacion: "Organización",
        rol: "Rol",
        pacientes: "Pacientes al mes",
      },
    };
  }

  if (formName === "alta-pacientes") {
    return {
      formName,
      to: config.patientIntakeToEmail,
      replyTo: getTrimmed(params, "email").toLowerCase(),
      agreementSlug: getTrimmed(params, "agreement_slug"),
      values: {
        nombre: getTrimmed(params, "nombre"),
        apellido: getTrimmed(params, "apellido"),
        telefono: getTrimmed(params, "telefono"),
        email: getTrimmed(params, "email").toLowerCase(),
        identificador: getTrimmed(params, "identificador"),
      },
    };
  }

  return null;
};

const validateBaseSubmission = (submission) => {
  const errors = {};
  const { formName, values } = submission;

  errors.nombre = validateName(values.nombre, "nombre");
  errors.apellido = validateName(values.apellido, "apellido");
  errors.telefono = validatePhone(values.telefono);
  errors.email = validateEmail(values.email, { corporate: formName === "contact" });

  if (formName === "contact") {
    if (!values.organizacion) errors.organizacion = "Seleccioná el tipo de organización.";
    if (!values.rol) errors.rol = "Seleccioná tu rol en la organización.";
    if (!values.pacientes) {
      errors.pacientes = "Seleccioná cuántos pacientes atienden al mes.";
    }
  }

  return Object.fromEntries(Object.entries(errors).filter(([, value]) => value));
};

const loadSubmissionAgreement = async (submission) => {
  if (submission.formName !== "alta-pacientes" || !submission.agreementSlug) {
    return null;
  }

  if (!pool) {
    const error = new Error("DB_UNAVAILABLE");
    error.statusCode = 503;
    throw error;
  }

  const agreement = await getAgreementBySlug(submission.agreementSlug);
  if (!agreement) {
    const error = new Error("AGREEMENT_NOT_FOUND");
    error.statusCode = 404;
    throw error;
  }
  return agreement;
};

const validateAgreementSubmission = async (submission, agreement, errors) => {
  if (!agreement || agreement.type !== "Nomina") return errors;

  if (!submission.values.identificador) {
    return {
      ...errors,
      identificador: "Ingresá tu identificador para validar la nómina.",
    };
  }

  const nominaEntry = await findNominaEntry(
    agreement.id,
    submission.values.identificador,
  );
  if (!nominaEntry) {
    return {
      ...errors,
      identificador: "No encontramos ese identificador en la nómina del acuerdo.",
    };
  }

  return errors;
};

const insertContact = async (submission, requestUrl) => {
  if (!pool) return null;
  const result = await query(
    `
      INSERT INTO contacts
        (nombre, apellido, email, telefono, organizacion, rol, pacientes, source_path)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `,
    [
      submission.values.nombre,
      submission.values.apellido,
      submission.values.email,
      submission.values.telefono,
      submission.values.organizacion,
      submission.values.rol,
      submission.values.pacientes,
      requestUrl,
    ],
  );
  return Number(result.rows[0].id);
};

const insertPatientIntake = async (submission, agreement, requestUrl) => {
  if (!pool) return null;
  const result = await query(
    `
      INSERT INTO patient_intakes
        (
          agreement_id,
          agreement_slug_snapshot,
          agreement_name_snapshot,
          agreement_type_snapshot,
          nombre,
          apellido,
          telefono,
          email,
          identificador,
          source_path
        )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `,
    [
      agreement?.id || null,
      agreement?.slug || submission.agreementSlug || "",
      agreement?.name || "",
      agreement?.type || "",
      submission.values.nombre,
      submission.values.apellido,
      submission.values.telefono,
      submission.values.email,
      submission.values.identificador || null,
      requestUrl,
    ],
  );
  return Number(result.rows[0].id);
};

const patientFullName = (submission) =>
  [submission.values.nombre, submission.values.apellido].filter(Boolean).join(" ");

const updateEmailResult = async (table, id, { messageId = null, error = null }) => {
  if (!pool || !id) return;
  await query(
    `UPDATE ${table} SET email_message_id = $1, email_error = $2 WHERE id = $3`,
    [messageId, error, id],
  );
};

const updatePatientBookingEmailResult = async (id, { messageId = null, error = null }) => {
  if (!pool || !id) return;
  await query(
    `
      UPDATE patient_intakes
      SET booking_email_message_id = $1,
          booking_email_error = $2
      WHERE id = $3
    `,
    [messageId, error, id],
  );
};

const handleContact = async (submission, request, response) => {
  const recordId = await insertContact(submission, request.url);
  const email = buildContactEmail(submission);

  try {
    const result = await sendEmail({
      formName: submission.formName,
      to: submission.to,
      replyTo: submission.replyTo,
      ...email,
    });
    await updateEmailResult("contacts", recordId, { messageId: result?.id });
    sendJson(response, 200, { ok: true, id: result?.id });
  } catch (error) {
    await updateEmailResult("contacts", recordId, { error: error.message });
    throw error;
  }
};

const handlePatientIntake = async (submission, agreement, request, response) => {
  const recordId = await insertPatientIntake(submission, agreement, request.url);
  const bookingLink = pool
    ? await createBookingAccessLink({
        patientIntakeId: recordId,
        label: `Alta ${submission.values.email}`,
        patientName: patientFullName(submission),
        patientEmail: submission.values.email,
        patientPhone: submission.values.telefono,
        agreementId: agreement?.id || null,
        agreementName: agreement?.name || "",
        agreementSlug: agreement?.slug || submission.agreementSlug || "",
        agreementType: agreement?.type || "",
        ttlHours: 48,
      })
    : null;
  submission.booking_url = bookingLink?.url || "";
  const email = buildPatientEmail({ submission, agreement });

  try {
    const result = await sendEmail({
      formName: submission.formName,
      to: submission.to,
      replyTo: submission.replyTo,
      ...email,
    });
    await updateEmailResult("patient_intakes", recordId, { messageId: result?.id });
    if (bookingLink?.url) {
      const bookingEmail = buildPatientBookingEmail({ submission, agreement });
      try {
        const bookingResult = await sendEmail({
          formName: "alta-pacientes-agenda",
          to: submission.values.email,
          replyTo: config.patientIntakeToEmail,
          ...bookingEmail,
        });
        await updatePatientBookingEmailResult(recordId, {
          messageId: bookingResult?.id,
        });
        await recordAudit("patient_intake.booking_email_sent", {
          detail: { patient_intake_id: recordId, email: submission.values.email },
        });
      } catch (bookingError) {
        await updatePatientBookingEmailResult(recordId, {
          error: bookingError.message,
        });
        await recordAudit("patient_intake.booking_email_failed", {
          detail: {
            patient_intake_id: recordId,
            email: submission.values.email,
            error: bookingError.message,
          },
        });
      }
    }
    sendJson(response, 200, {
      ok: true,
      id: result?.id,
      booking_url: bookingLink?.url || "",
      booking_expires_at: bookingLink?.expires_at || "",
    });
  } catch (error) {
    await updateEmailResult("patient_intakes", recordId, { error: error.message });
    throw error;
  }
};

export const handleFormSubmission = async (request, response) => {
  let params;
  try {
    params = await parseRequestBody(request);
  } catch (error) {
    const statusCode = error.message === "PAYLOAD_TOO_LARGE" ? 413 : 400;
    sendJson(response, statusCode, { error: "No se pudo leer el formulario." });
    return;
  }

  if (getTrimmed(params, "website")) {
    sendJson(response, 200, { ok: true });
    return;
  }

  const submission = normalizeSubmission(params);
  if (!submission) {
    sendJson(response, 422, { error: "Formulario desconocido." });
    return;
  }

  try {
    const agreement = await loadSubmissionAgreement(submission);
    const baseErrors = validateBaseSubmission(submission);
    const errors = await validateAgreementSubmission(
      submission,
      agreement,
      baseErrors,
    );

    if (Object.keys(errors).length > 0) {
      sendJson(response, 422, {
        error: "Revisá los campos marcados para poder enviar el formulario.",
        errors,
      });
      return;
    }

    if (submission.formName === "contact") {
      await handleContact(submission, request, response);
      await recordAudit("contact.created", { detail: { email: submission.values.email } });
      return;
    }

    await handlePatientIntake(submission, agreement, request, response);
    await recordAudit("patient_intake.created", {
      detail: {
        email: submission.values.email,
        agreement_slug: agreement?.slug || "",
      },
    });
  } catch (error) {
    const statusCode =
      error.statusCode ||
      (error.message === "SES_CONFIGURATION_MISSING" ||
      error.message === "EMAIL_CONFIGURATION_MISSING"
        ? 503
        : 502);
    sendJson(response, statusCode, {
      error:
        error.message === "AGREEMENT_NOT_FOUND"
          ? "No encontramos el acuerdo indicado."
          : "No se pudo enviar el formulario. Probá de nuevo.",
    });
  }
};
