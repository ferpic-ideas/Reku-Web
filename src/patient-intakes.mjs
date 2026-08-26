import { randomBytes } from "node:crypto";
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
  buildPatientEmail,
  buildPatientVerificationEmail,
} from "./templates.mjs";
import { createBookingAccessLink } from "./booking-links.mjs";
import { hashToken } from "./security.mjs";

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

export const insertPatientIntake = async (submission, agreement, sourcePath) => {
  if (!pool) return { id: null, created: false };

  return tx(async (client) => {
    const patient = await client.query(
      `
        INSERT INTO patients
          (first_name, last_name, full_name, email, email_normalized, phone)
        VALUES ($1, $2, $3, $4, lower(trim($4)), $5)
        ON CONFLICT (email_normalized)
        DO UPDATE SET
          first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name,
          full_name = EXCLUDED.full_name,
          email = EXCLUDED.email,
          phone = EXCLUDED.phone,
          active = TRUE,
          updated_at = NOW()
        RETURNING id
      `,
      [
        submission.values.nombre,
        submission.values.apellido,
        patientFullName(submission),
        submission.values.email,
        submission.values.telefono,
      ],
    );
    const result = await client.query(
      `
        INSERT INTO patient_intakes
          (
            patient_id,
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id
      `,
      [
        patient.rows[0].id,
        agreement?.id || null,
        agreement?.slug || submission.agreementSlug || "",
        agreement?.name || "",
        agreement?.type || "",
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

const createPatientIntakeVerification = async ({ recordId }) => {
  const token = randomBytes(32).toString("base64url");
  await query(
    `
      INSERT INTO patient_intake_verifications
        (token_hash, patient_intake_id, expires_at)
      VALUES ($1, $2, NOW() + INTERVAL '24 hours')
    `,
    [hashToken(token), recordId],
  );
  return {
    token,
    url: `${config.appPublicUrl}/turnos/#verify=${encodeURIComponent(token)}`,
  };
};

export const createPatientBookingLink = async ({
  recordId,
  submission,
  agreement,
  client = null,
}) => {
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
    agreementSubdomainPrefix: agreement?.subdomain_prefix || "",
    agreementType: agreement?.type || "",
    ttlHours: 48,
    client,
  });
};

export const sendPatientIntakeNotifications = async ({
  submission,
  agreement,
  recordId,
  verification,
}) => {
  const results = {
    intake: { ok: false, id: "" },
    verification: { ok: false, id: "" },
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

  if (verification?.url) {
    const verificationEmail = buildPatientVerificationEmail({
      submission,
      agreement,
      verificationUrl: verification.url,
    });
    try {
      const result = await sendEmail({
        formName: "alta-pacientes-verificacion",
        to: submission.values.email,
        replyTo: config.patientIntakeToEmail,
        ...verificationEmail,
      });
      results.verification = { ok: true, id: result?.id || "" };
      await updatePatientBookingEmailResult(recordId, { messageId: result?.id });
      await recordAudit("patient_intake.verification_email_sent", {
        detail: { patient_intake_id: recordId, email: submission.values.email },
      });
    } catch (error) {
      results.verification = { ok: false, error: error.message };
      await updatePatientBookingEmailResult(recordId, { error: error.message });
      await recordAudit("patient_intake.verification_email_failed", {
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

export const savePatientIntakeAndNotify = async ({
  submission,
  agreement,
  sourcePath,
  requireEmailVerification = true,
}) => {
  const saved = await insertPatientIntake(submission, agreement, sourcePath);
  const verification = requireEmailVerification
    ? await createPatientIntakeVerification({ recordId: saved.id })
    : null;
  const notifications = await sendPatientIntakeNotifications({
    submission,
    agreement,
    recordId: saved.id,
    verification,
  });

  return {
    recordId: saved.id,
    created: saved.created,
    verification,
    notifications,
  };
};

export const redeemPatientIntakeVerification = async (token) => {
  const tokenHash = hashToken(token);
  return tx(async (client) => {
    const result = await client.query(
      `
        SELECT
          v.id AS verification_id,
          p.*,
          a.name AS current_agreement_name,
          a.slug AS current_agreement_slug,
          a.type AS current_agreement_type,
          a.cobranded,
          a.logo_path,
          a.pdf_path
        FROM patient_intake_verifications v
        INNER JOIN patient_intakes p ON p.id = v.patient_intake_id
        LEFT JOIN agreements a
          ON a.id = p.agreement_id
         AND a.deleted_at IS NULL
        WHERE v.token_hash = $1
          AND v.used_at IS NULL
          AND v.expires_at > NOW()
        FOR UPDATE OF v
      `,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) {
      const error = new Error("INTAKE_VERIFICATION_INVALID");
      error.statusCode = 401;
      throw error;
    }

    const submission = buildPatientIntakeSubmission({
      agreementSlug: row.current_agreement_slug || row.agreement_slug_snapshot || "",
      values: {
        nombre: row.nombre,
        apellido: row.apellido,
        telefono: row.telefono,
        email: row.email,
        identificador: row.identificador || "",
      },
    });
    const agreement = {
      id: row.agreement_id ? Number(row.agreement_id) : null,
      name: row.current_agreement_name || row.agreement_name_snapshot || "",
      slug: row.current_agreement_slug || row.agreement_slug_snapshot || "",
      type: row.current_agreement_type || row.agreement_type_snapshot || "",
      cobranded: Boolean(row.cobranded),
      logo_path: row.logo_path || "",
      pdf_path: row.pdf_path || "",
      logo_url: row.logo_path ? `/uploads/${row.logo_path}` : "",
      pdf_url: row.pdf_path ? `/uploads/${row.pdf_path}` : "",
    };
    const bookingLink = await createPatientBookingLink({
      recordId: Number(row.id),
      submission,
      agreement,
      client,
    });
    await client.query(
      "UPDATE patient_intake_verifications SET used_at = NOW() WHERE id = $1",
      [row.verification_id],
    );
    return {
      patientIntakeId: Number(row.id),
      bookingLink,
      patient: {
        name: patientFullName(submission),
        email: submission.values.email,
        phone: submission.values.telefono,
      },
      agreement,
    };
  });
};
