import { config } from "./config.mjs";
import {
  findNominaEntry,
  getAgreementBySlug,
  pool,
  query,
  recordAudit,
  tx,
} from "./db.mjs";
import { sendEmail } from "./email.mjs";
import {
  buildPatientBookingEmail,
  buildPatientEmail,
} from "./templates.mjs";
import { createBookingAccessLink } from "./booking-links.mjs";

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

const validateEmail = (value) => {
  const normalized = value.toLowerCase();

  if (!value) return "Ingresá tu mail.";
  if (!emailPattern.test(normalized)) {
    return "Ingresá un mail válido, por ejemplo nombre@email.com.";
  }

  return "";
};

export const normalizePatientIntakeValues = (values = {}) => ({
  nombre: String(values.nombre || "").trim(),
  apellido: String(values.apellido || "").trim(),
  telefono: String(values.telefono || "").trim(),
  email: String(values.email || "").trim().toLowerCase(),
  identificador: String(values.identificador || "").trim(),
});

export const buildPatientIntakeSubmission = ({ agreementSlug = "", values = {} } = {}) => {
  const normalizedValues = normalizePatientIntakeValues(values);
  return {
    formName: "alta-pacientes",
    to: config.patientIntakeToEmail,
    replyTo: normalizedValues.email,
    agreementSlug: String(agreementSlug || "").trim(),
    values: normalizedValues,
  };
};

export const loadPatientIntakeAgreement = async (submission) => {
  if (!submission.agreementSlug) return null;

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

export const validatePatientIntakeSubmission = async (submission, agreement) => {
  const errors = {
    nombre: validateName(submission.values.nombre, "nombre"),
    apellido: validateName(submission.values.apellido, "apellido"),
    telefono: validatePhone(submission.values.telefono),
    email: validateEmail(submission.values.email),
  };

  if (agreement?.type === "Nomina") {
    if (!submission.values.identificador) {
      errors.identificador = "Ingresá tu identificador para validar la nómina.";
    } else {
      const nominaEntry = await findNominaEntry(
        agreement.id,
        submission.values.identificador,
      );
      if (!nominaEntry) {
        errors.identificador = "No encontramos ese identificador en la nómina del acuerdo.";
      }
    }
  }

  return Object.fromEntries(Object.entries(errors).filter(([, value]) => value));
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

export const upsertPatientIntake = async (submission, agreement, sourcePath) => {
  if (!pool) return { id: null, created: false };

  if (!agreement?.id) {
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
        null,
        submission.agreementSlug || "",
        "",
        "",
        submission.values.nombre,
        submission.values.apellido,
        submission.values.telefono,
        submission.values.email,
        submission.values.identificador || null,
        sourcePath,
      ],
    );
    return { id: Number(result.rows[0].id), created: true };
  }

  return tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `patient_intake:${submission.values.email}`,
    ]);
    const existing = await client.query(
      `
        SELECT id
        FROM patient_intakes
        WHERE lower(email) = lower($1)
        ORDER BY updated_at DESC NULLS LAST, created_at DESC, id DESC
        LIMIT 1
        FOR UPDATE
      `,
      [submission.values.email],
    );

    if (existing.rows[0]) {
      const id = Number(existing.rows[0].id);
      await client.query(
        `
          UPDATE patient_intakes
          SET agreement_id = $1,
              agreement_slug_snapshot = $2,
              agreement_name_snapshot = $3,
              agreement_type_snapshot = $4,
              nombre = $5,
              apellido = $6,
              telefono = $7,
              email = $8,
              identificador = $9,
              source_path = $10,
              email_message_id = NULL,
              email_error = NULL,
              booking_email_message_id = NULL,
              booking_email_error = NULL,
              updated_at = NOW()
          WHERE id = $11
        `,
        [
          agreement.id,
          agreement.slug || submission.agreementSlug || "",
          agreement.name || "",
          agreement.type || "",
          submission.values.nombre,
          submission.values.apellido,
          submission.values.telefono,
          submission.values.email,
          submission.values.identificador || null,
          sourcePath,
          id,
        ],
      );
      return { id, created: false };
    }

    const result = await client.query(
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
        agreement.id,
        agreement.slug || submission.agreementSlug || "",
        agreement.name || "",
        agreement.type || "",
        submission.values.nombre,
        submission.values.apellido,
        submission.values.telefono,
        submission.values.email,
        submission.values.identificador || null,
        sourcePath,
      ],
    );
    return { id: Number(result.rows[0].id), created: true };
  });
};

export const createPatientBookingLink = async ({ recordId, submission, agreement }) => {
  if (!pool || !recordId) return null;
  return createBookingAccessLink({
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
  });
};

export const sendPatientIntakeNotifications = async ({
  submission,
  agreement,
  recordId,
  bookingLink,
}) => {
  submission.booking_url = bookingLink?.url || "";
  const results = {
    intake: { ok: false, id: "" },
    booking: { ok: false, id: "" },
  };
  const intakeEmail = buildPatientEmail({ submission, agreement });

  try {
    const result = await sendEmail({
      formName: submission.formName,
      to: submission.to,
      replyTo: submission.replyTo,
      ...intakeEmail,
    });
    results.intake = { ok: true, id: result?.id || "" };
    await updateEmailResult("patient_intakes", recordId, { messageId: result?.id });
  } catch (error) {
    results.intake = { ok: false, error: error.message };
    await updateEmailResult("patient_intakes", recordId, { error: error.message });
    await recordAudit("patient_intake.email_failed", {
      detail: { patient_intake_id: recordId, email: submission.values.email, error: error.message },
    });
  }

  if (bookingLink?.url) {
    const bookingEmail = buildPatientBookingEmail({ submission, agreement });
    try {
      const result = await sendEmail({
        formName: "alta-pacientes-agenda",
        to: submission.values.email,
        replyTo: config.patientIntakeToEmail,
        ...bookingEmail,
      });
      results.booking = { ok: true, id: result?.id || "" };
      await updatePatientBookingEmailResult(recordId, { messageId: result?.id });
      await recordAudit("patient_intake.booking_email_sent", {
        detail: { patient_intake_id: recordId, email: submission.values.email },
      });
    } catch (error) {
      results.booking = { ok: false, error: error.message };
      await updatePatientBookingEmailResult(recordId, { error: error.message });
      await recordAudit("patient_intake.booking_email_failed", {
        detail: {
          patient_intake_id: recordId,
          email: submission.values.email,
          error: error.message,
        },
      });
    }
  }

  return results;
};

export const savePatientIntakeAndNotify = async ({ submission, agreement, sourcePath }) => {
  const saved = await upsertPatientIntake(submission, agreement, sourcePath);
  const bookingLink = await createPatientBookingLink({
    recordId: saved.id,
    submission,
    agreement,
  });
  const notifications = await sendPatientIntakeNotifications({
    submission,
    agreement,
    recordId: saved.id,
    bookingLink,
  });

  return {
    recordId: saved.id,
    created: saved.created,
    bookingLink,
    notifications,
  };
};
