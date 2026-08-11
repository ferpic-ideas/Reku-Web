import { config } from "./config.mjs";
import { pool, query, recordAudit } from "./db.mjs";
import { sendEmail } from "./email.mjs";
import {
  getClientIp,
  getTrimmed,
  parseRequestBody,
  sendJson,
} from "./http.mjs";
import { buildContactEmail } from "./templates.mjs";
import {
  buildPatientIntakeSubmission,
  loadPatientIntakeAgreement,
  savePatientIntakeAndNotify,
  validatePatientIntakeSubmission,
} from "./patient-intakes.mjs";
import {
  enforceContactRateLimits,
  enforceIntakeRateLimits,
} from "./rate-limit.mjs";

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

export const normalizeSubmission = (params) => {
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

  if (formName === "congreso-cokiba") {
    return {
      formName,
      to: config.contactToEmail,
      subject: "Contacto Reku",
      replyTo: getTrimmed(params, "email").toLowerCase(),
      values: {
        nombre: getTrimmed(params, "nombre"),
        apellido: getTrimmed(params, "apellido"),
        profesion: getTrimmed(params, "profesion"),
        telefono: getTrimmed(params, "telefono"),
        email: getTrimmed(params, "email").toLowerCase(),
      },
      labels: {
        nombre: "Nombre",
        apellido: "Apellido",
        profesion: "Profesión",
        telefono: "Celular",
        email: "Mail",
      },
    };
  }

  if (formName === "alta-pacientes") {
    return buildPatientIntakeSubmission({
      agreementSlug: getTrimmed(params, "agreement_slug"),
      values: {
        nombre: getTrimmed(params, "nombre"),
        apellido: getTrimmed(params, "apellido"),
        telefono: getTrimmed(params, "telefono"),
        email: getTrimmed(params, "email").toLowerCase(),
        identificador: getTrimmed(params, "identificador"),
      },
    });
  }

  return null;
};

export const validateBaseSubmission = (submission) => {
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

  if (formName === "congreso-cokiba") {
    if (!values.profesion) {
      errors.profesion = "Ingresá tu profesión.";
    } else if (values.profesion.length < 2 || values.profesion.length > 100) {
      errors.profesion = "Ingresá una profesión válida.";
    }
  }

  return Object.fromEntries(Object.entries(errors).filter(([, value]) => value));
};

const loadSubmissionAgreement = async (submission) => {
  if (submission.formName !== "alta-pacientes") return null;
  return loadPatientIntakeAgreement(submission);
};

const validateAgreementSubmission = async (submission, agreement, errors) => {
  if (submission.formName !== "alta-pacientes") return errors;
  return {
    ...errors,
    ...(await validatePatientIntakeSubmission(submission, agreement)),
  };
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

const insertCongressRegistration = async (submission, requestUrl) => {
  if (!pool) return null;
  const result = await query(
    `
      INSERT INTO congreso_cokiba_registrations
        (nombre, apellido, profesion, telefono, email, source_path)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `,
    [
      submission.values.nombre,
      submission.values.apellido,
      submission.values.profesion,
      submission.values.telefono,
      submission.values.email,
      requestUrl,
    ],
  );
  return Number(result.rows[0].id);
};

const updateEmailResult = async (table, id, { messageId = null, error = null }) => {
  if (!pool || !id) return;
  await query(
    `UPDATE ${table} SET email_message_id = $1, email_error = $2 WHERE id = $3`,
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

const handleCongressRegistration = async (submission, request, response) => {
  const recordId = await insertCongressRegistration(submission, request.url);
  const email = buildContactEmail(submission);

  try {
    const result = await sendEmail({
      formName: submission.formName,
      to: submission.to,
      replyTo: submission.replyTo,
      ...email,
    });
    await updateEmailResult("congreso_cokiba_registrations", recordId, {
      messageId: result?.id,
    });
    sendJson(response, 200, { ok: true, id: result?.id });
  } catch (error) {
    await updateEmailResult("congreso_cokiba_registrations", recordId, {
      error: error.message,
    });
    throw error;
  }
};

const handlePatientIntake = async (submission, agreement, request, response) => {
  await savePatientIntakeAndNotify({
    submission,
    agreement,
    sourcePath: request.url,
  });
  sendJson(response, 202, {
    ok: true,
    message: "Revisá tu mail para confirmar la dirección y continuar.",
  });
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

    if (["contact", "congreso-cokiba"].includes(submission.formName)) {
      await enforceContactRateLimits({
        clientIp: getClientIp(request),
        email: submission.values.email,
      });
    } else {
      await enforceIntakeRateLimits({
        clientIp: getClientIp(request),
        email: submission.values.email,
        agreementSlug: submission.agreementSlug,
      });
    }

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

    if (submission.formName === "congreso-cokiba") {
      await handleCongressRegistration(submission, request, response);
      await recordAudit("congreso_cokiba.registration_created", {
        detail: { email: submission.values.email },
      });
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
    if (error.message === "RATE_LIMITED") {
      sendJson(
        response,
        429,
        { error: "Demasiadas solicitudes. Probá nuevamente más tarde." },
        { "Retry-After": String(error.retryAfter || 60) },
      );
      return;
    }
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
