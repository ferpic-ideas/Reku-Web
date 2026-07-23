import {
  getAgreementById,
  getAgreementBySlug,
  one,
  query,
  recordAudit,
  tx,
} from "./db.mjs";
import QRCode from "qrcode";
import { getClientIp, readBody, sendJson, withSecurityHeaders } from "./http.mjs";
import { parseNominaCsv } from "./csv.mjs";
import { sendEmail } from "./email.mjs";
import {
  clearSessionCookie,
  createSessionToken,
  enforceCsrf,
  enforceLoginRateLimit,
  hashPassword,
  readSessionFromRequest,
  sessionCookie,
  verifyPassword,
} from "./security.mjs";
import { config } from "./config.mjs";
import {
  defaultPatientBody,
  defaultPatientSubject,
  buildPatientEmail,
  getTemplateErrors,
  renderTemplate,
  sampleTemplateContext,
} from "./templates.mjs";
import {
  parseMultipartForm,
  readCsvUpload,
  saveAgreementLogo,
  saveAgreementPdf,
} from "./uploads.mjs";

const canDeleteRecords = (user) => user?.email?.toLowerCase() === "ferpic@gmail.com";
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const parseJsonBody = async (request) => {
  const body = await readBody(request);
  return body ? JSON.parse(body) : {};
};

const slugify = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

const downloadSlug = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "formulario";

const optionalUrl = (value) => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("bad");
    return url.toString();
  } catch {
    const error = new Error("URL_INVALID");
    error.statusCode = 422;
    throw error;
  }
};

const requireCurrentUser = async (request) => {
  const session = readSessionFromRequest(request);
  if (!session) {
    const error = new Error("NOT_AUTHENTICATED");
    error.statusCode = 401;
    throw error;
  }

  const user = await one(
    `
      SELECT id, email, name, role, is_active, session_version
      FROM users
      WHERE id = $1
    `,
    [session.sub],
  );

  if (
    !user ||
    !user.is_active ||
    Number(user.session_version) !== Number(session.sv)
  ) {
    const error = new Error("SESSION_EXPIRED");
    error.statusCode = 401;
    throw error;
  }

  return {
    user: {
      ...user,
      id: Number(user.id),
      can_delete_records: canDeleteRecords(user),
    },
    session,
  };
};

const requireCsrfForMutation = (request, session) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    enforceCsrf(request, session);
  }
};

const publicUser = (user) => ({
  id: Number(user.id),
  email: user.email,
  name: user.name,
  role: user.role,
  can_delete_records: Boolean(user.can_delete_records),
});

const handleLogin = async (request, response) => {
  const payload = await parseJsonBody(request);
  const email = String(payload.email || "").trim().toLowerCase();
  const password = String(payload.password || "");

  enforceLoginRateLimit(getClientIp(request), email);

  const user = await one(
    `
      SELECT id, email, name, role, is_active, password_hash, session_version
      FROM users
      WHERE lower(email) = lower($1)
    `,
    [email],
  );

  if (!user || !user.is_active || !(await verifyPassword(password, user.password_hash))) {
    await recordAudit("auth.login_failed", {
      detail: { email, client_ip: getClientIp(request) },
    });
    sendJson(response, 401, { error: "Credenciales inválidas." });
    return;
  }

  await query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [user.id]);
  await recordAudit("auth.login_succeeded", {
    actorUserId: user.id,
    detail: { email, client_ip: getClientIp(request) },
  });

  const { token, csrf } = createSessionToken(user);
  sendJson(
    response,
    200,
    {
      user: publicUser({ ...user, can_delete_records: canDeleteRecords(user) }),
      csrf_token: csrf,
    },
    { "Set-Cookie": sessionCookie(token) },
  );
};

const handleMe = async (request, response) => {
  const { user, session } = await requireCurrentUser(request);
  sendJson(response, 200, { user: publicUser(user), csrf_token: session.csrf });
};

const handleLogout = async (request, response) => {
  const { user, session } = await requireCurrentUser(request);
  enforceCsrf(request, session);
  await recordAudit("auth.logout", { actorUserId: user.id, detail: { email: user.email } });
  sendJson(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
};

const handleChangePassword = async (request, response) => {
  const { user, session } = await requireCurrentUser(request);
  enforceCsrf(request, session);
  const payload = await parseJsonBody(request);
  const currentPassword = String(payload.current_password || "");
  const newPassword = String(payload.new_password || "");

  if (newPassword.length < 10) {
    sendJson(response, 422, { error: "La nueva clave debe tener al menos 10 caracteres." });
    return;
  }

  const dbUser = await one("SELECT password_hash FROM users WHERE id = $1", [user.id]);
  if (!dbUser || !(await verifyPassword(currentPassword, dbUser.password_hash))) {
    await recordAudit("auth.password_change_failed", {
      actorUserId: user.id,
      detail: { email: user.email },
    });
    sendJson(response, 400, { error: "La clave actual no es correcta." });
    return;
  }

  await query(
    `
      UPDATE users
      SET password_hash = $1,
          session_version = session_version + 1,
          updated_at = NOW()
      WHERE id = $2
    `,
    [await hashPassword(newPassword), user.id],
  );
  await recordAudit("auth.password_changed", { actorUserId: user.id });
  sendJson(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
};

const listAgreements = async (response) => {
  const result = await query(`
    SELECT
      a.*,
      COUNT(DISTINCT n.id)::int AS nomina_count,
      COUNT(DISTINCT p.id)::int AS intake_count
    FROM agreements a
    LEFT JOIN nomina_entries n ON n.agreement_id = a.id
    LEFT JOIN patient_intakes p ON p.agreement_id = a.id
    WHERE a.deleted_at IS NULL
    GROUP BY a.id
    ORDER BY a.created_at DESC
  `);
  sendJson(response, 200, { agreements: result.rows.map(mapAgreement) });
};

const mapAgreement = (row) => ({
  id: Number(row.id),
  name: row.name,
  slug: row.slug,
  cobranded: Boolean(row.cobranded),
  type: row.type,
  logo_path: row.logo_path || "",
  logo_url: row.logo_path ? `/uploads/${row.logo_path}` : "",
  pdf_path: row.pdf_path || "",
  pdf_url: row.pdf_path ? `/uploads/${row.pdf_path}` : "",
  payment_evaluation_url: row.payment_evaluation_url || "",
  payment_treatment_url: row.payment_treatment_url || "",
  email_subject_template: row.email_subject_template || defaultPatientSubject,
  email_body_template: row.email_body_template || defaultPatientBody,
  nomina_count: Number(row.nomina_count || 0),
  intake_count: Number(row.intake_count || 0),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const agreementPayloadFromMultipart = async (request) => {
  const { fields, files } = await parseMultipartForm(request);
  const name = String(fields.name || "").trim();
  const slug = slugify(fields.slug || name);
  const type = fields.type === "Nomina" ? "Nomina" : "Pago";
  const subject = String(fields.email_subject_template || defaultPatientSubject).trim();
  const body = String(fields.email_body_template || defaultPatientBody).trim();

  if (!name) {
    const error = new Error("NAME_REQUIRED");
    error.statusCode = 422;
    throw error;
  }

  if (!slug) {
    const error = new Error("SLUG_REQUIRED");
    error.statusCode = 422;
    throw error;
  }

  const templateErrors = getTemplateErrors(subject, body);
  if (templateErrors.length) {
    const error = new Error("TEMPLATE_INVALID");
    error.statusCode = 422;
    error.details = templateErrors;
    throw error;
  }

  return {
    fields: {
      name,
      slug,
      cobranded: fields.cobranded === "true" || fields.cobranded === "on",
      type,
      payment_evaluation_url:
        type === "Nomina" ? "" : optionalUrl(fields.payment_evaluation_url),
      payment_treatment_url:
        type === "Nomina" ? "" : optionalUrl(fields.payment_treatment_url),
      email_subject_template: subject,
      email_body_template: body,
      remove_logo: fields.remove_logo === "true",
      remove_pdf: fields.remove_pdf === "true",
    },
    files,
  };
};

const createAgreement = async (request, response, user) => {
  const payload = await agreementPayloadFromMultipart(request);
  const logoPath = await saveAgreementLogo(payload.files.logo);
  const pdfPath = await saveAgreementPdf(payload.files.pdf);

  const result = await query(
    `
      INSERT INTO agreements
        (
          name,
          slug,
          logo_path,
          pdf_path,
          cobranded,
          type,
          payment_evaluation_url,
          payment_treatment_url,
          email_subject_template,
          email_body_template
        )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `,
    [
      payload.fields.name,
      payload.fields.slug,
      logoPath || null,
      pdfPath || null,
      payload.fields.cobranded,
      payload.fields.type,
      payload.fields.payment_evaluation_url || null,
      payload.fields.payment_treatment_url || null,
      payload.fields.email_subject_template,
      payload.fields.email_body_template,
    ],
  );
  await recordAudit("agreement.created", {
    actorUserId: user.id,
    detail: { agreement_id: result.rows[0].id, slug: result.rows[0].slug },
  });
  sendJson(response, 201, { agreement: mapAgreement(result.rows[0]) });
};

const updateAgreement = async (request, response, user, id) => {
  const current = await getAgreementById(id);
  if (!current) {
    sendJson(response, 404, { error: "Acuerdo no encontrado." });
    return;
  }

  const payload = await agreementPayloadFromMultipart(request);
  const logoPath = await saveAgreementLogo(payload.files.logo);
  const pdfPath = await saveAgreementPdf(payload.files.pdf);

  const result = await query(
    `
      UPDATE agreements
      SET name = $1,
          slug = $2,
          logo_path = $3,
          pdf_path = $4,
          cobranded = $5,
          type = $6,
          payment_evaluation_url = $7,
          payment_treatment_url = $8,
          email_subject_template = $9,
          email_body_template = $10,
          updated_at = NOW()
      WHERE id = $11
        AND deleted_at IS NULL
      RETURNING *
    `,
    [
      payload.fields.name,
      payload.fields.slug,
      payload.fields.remove_logo ? null : logoPath || current.logo_path || null,
      payload.fields.remove_pdf ? null : pdfPath || current.pdf_path || null,
      payload.fields.cobranded,
      payload.fields.type,
      payload.fields.payment_evaluation_url || null,
      payload.fields.payment_treatment_url || null,
      payload.fields.email_subject_template,
      payload.fields.email_body_template,
      id,
    ],
  );
  await recordAudit("agreement.updated", {
    actorUserId: user.id,
    detail: { agreement_id: id },
  });
  sendJson(response, 200, { agreement: mapAgreement(result.rows[0]) });
};

const deleteAgreement = async (response, user, id) => {
  await query("UPDATE agreements SET deleted_at = NOW() WHERE id = $1", [id]);
  await recordAudit("agreement.deleted", {
    actorUserId: user.id,
    detail: { agreement_id: id },
  });
  sendJson(response, 200, { ok: true });
};

const downloadAgreementQr = async (response, id) => {
  const agreement = await getAgreementById(id);
  if (!agreement) {
    sendJson(response, 404, { error: "Acuerdo no encontrado." });
    return;
  }

  const formUrl = `${config.appPublicUrl}/alta-pacientes/?form=${encodeURIComponent(
    agreement.slug,
  )}`;
  const filename = `reku-alta-pacientes-${downloadSlug(agreement.slug)}-qr.png`;
  const png = await QRCode.toBuffer(formUrl, {
    type: "png",
    width: 500,
    margin: 1,
    errorCorrectionLevel: "M",
    color: {
      dark: "#18213f",
      light: "#ffffff",
    },
  });

  response.writeHead(
    200,
    withSecurityHeaders(
      {
        "Content-Type": "image/png",
        "Content-Length": String(png.length),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
      { privateRoute: true },
    ),
  );
  response.end(png);
};

const listPatientIntakes = async (url, response) => {
  const agreementId = url.searchParams.get("agreement_id") || null;
  const result = await query(
    `
      SELECT
        p.*,
        COALESCE(a.name, p.agreement_name_snapshot, '') AS agreement_name,
        COALESCE(a.slug, p.agreement_slug_snapshot, '') AS agreement_slug
      FROM patient_intakes p
      LEFT JOIN agreements a ON a.id = p.agreement_id
      WHERE ($1::bigint IS NULL OR p.agreement_id = $1::bigint)
      ORDER BY p.created_at DESC
      LIMIT 300
    `,
    [agreementId || null],
  );
  sendJson(response, 200, { patient_intakes: result.rows.map(mapPatientIntake) });
};

const mapPatientIntake = (row) => ({
  id: Number(row.id),
  agreement_id: row.agreement_id ? Number(row.agreement_id) : null,
  agreement_name: row.agreement_name || "",
  agreement_slug: row.agreement_slug || "",
  nombre: row.nombre,
  apellido: row.apellido,
  telefono: row.telefono,
  email: row.email,
  identificador: row.identificador || "",
  email_message_id: row.email_message_id || "",
  email_error: row.email_error || "",
  created_at: row.created_at,
});

const listContacts = async (response) => {
  const result = await query(`
    SELECT *
    FROM contacts
    ORDER BY created_at DESC
    LIMIT 300
  `);
  sendJson(response, 200, { contacts: result.rows.map(mapContact) });
};

const mapContact = (row) => ({
  id: Number(row.id),
  nombre: row.nombre,
  apellido: row.apellido,
  telefono: row.telefono,
  email: row.email,
  organizacion: row.organizacion,
  rol: row.rol,
  pacientes: row.pacientes,
  email_message_id: row.email_message_id || "",
  email_error: row.email_error || "",
  created_at: row.created_at,
});

const deleteRecord = async (response, user, table, id) => {
  if (!canDeleteRecords(user)) {
    sendJson(response, 403, { error: "No tenés permisos para eliminar registros." });
    return;
  }
  await query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  await recordAudit(`${table}.deleted`, {
    actorUserId: user.id,
    detail: { id },
  });
  sendJson(response, 200, { ok: true });
};

const listNomina = async (url, response) => {
  const agreementId = url.searchParams.get("agreement_id") || null;
  const result = await query(
    `
      SELECT
        n.*,
        a.name AS agreement_name,
        EXISTS (
          SELECT 1
          FROM patient_intakes p
          WHERE p.agreement_id = n.agreement_id
            AND lower(p.identificador) = n.identificador_normalized
        ) AS form_submitted
      FROM nomina_entries n
      INNER JOIN agreements a ON a.id = n.agreement_id
      WHERE ($1::bigint IS NULL OR n.agreement_id = $1::bigint)
        AND a.deleted_at IS NULL
      ORDER BY n.created_at DESC
      LIMIT 500
    `,
    [agreementId || null],
  );
  sendJson(response, 200, { nomina_entries: result.rows.map(mapNominaEntry) });
};

const mapNominaEntry = (row) => ({
  id: Number(row.id),
  agreement_id: Number(row.agreement_id),
  agreement_name: row.agreement_name || "",
  nombre: row.nombre || "",
  apellido: row.apellido || "",
  identificador: row.identificador,
  form_submitted: Boolean(row.form_submitted),
  created_at: row.created_at,
});

const assertNominaAgreement = async (agreementId) => {
  const agreement = await getAgreementById(agreementId);
  if (!agreement || agreement.type !== "Nomina") {
    const error = new Error("NOMINA_AGREEMENT_REQUIRED");
    error.statusCode = 422;
    throw error;
  }
  return agreement;
};

const createNominaEntry = async (request, response, user) => {
  const payload = await parseJsonBody(request);
  const agreementId = Number(payload.agreement_id);
  const identificador = String(payload.identificador || "").trim();

  await assertNominaAgreement(agreementId);
  if (!identificador) {
    sendJson(response, 422, { error: "El identificador es obligatorio." });
    return;
  }

  const existing = await one(
    `
      SELECT id
      FROM nomina_entries
      WHERE agreement_id = $1
        AND identificador_normalized = lower($2)
    `,
    [agreementId, identificador],
  );
  if (existing) {
    sendJson(response, 409, {
      error: "Ese identificador ya existe para este acuerdo.",
    });
    return;
  }

  const result = await query(
    `
      INSERT INTO nomina_entries
        (agreement_id, nombre, apellido, identificador, identificador_normalized)
      VALUES ($1, $2, $3, $4, lower($4))
      RETURNING *
    `,
    [
      agreementId,
      String(payload.nombre || "").trim() || null,
      String(payload.apellido || "").trim() || null,
      identificador,
    ],
  );
  await recordAudit("nomina_entry.created", {
    actorUserId: user.id,
    detail: { agreement_id: agreementId, identificador },
  });
  sendJson(response, 200, { nomina_entry: mapNominaEntry(result.rows[0]) });
};

const importNominaCsv = async (request, response, user) => {
  const { fields, files } = await parseMultipartForm(request, {
    maxBytes: config.csvUploadMaxBytes,
  });
  const agreementId = Number(fields.agreement_id);
  await assertNominaAgreement(agreementId);
  const rows = parseNominaCsv(readCsvUpload(files.csv));

  const result = await tx(async (client) => {
    let upserted = 0;
    for (const row of rows) {
      await client.query(
        `
          INSERT INTO nomina_entries
            (agreement_id, nombre, apellido, identificador, identificador_normalized)
          VALUES ($1, $2, $3, $4, lower($4))
          ON CONFLICT (agreement_id, identificador_normalized)
          DO UPDATE SET
            nombre = EXCLUDED.nombre,
            apellido = EXCLUDED.apellido,
            identificador = EXCLUDED.identificador,
            updated_at = NOW()
        `,
        [
          agreementId,
          row.nombre || null,
          row.apellido || null,
          row.identificador,
        ],
      );
      upserted += 1;
    }
    return { upserted };
  });

  await recordAudit("nomina_entries.imported", {
    actorUserId: user.id,
    detail: { agreement_id: agreementId, count: result.upserted },
  });
  sendJson(response, 200, { ok: true, ...result });
};

const deleteNominaEntry = async (response, user, id) => {
  await query("DELETE FROM nomina_entries WHERE id = $1", [id]);
  await recordAudit("nomina_entry.deleted", {
    actorUserId: user.id,
    detail: { id },
  });
  sendJson(response, 200, { ok: true });
};

const validateTemplatePreview = async (request, response) => {
  const payload = await parseJsonBody(request);
  const subject = String(payload.subject || "");
  const body = String(payload.body || "");
  const errors = getTemplateErrors(subject, body);
  sendJson(response, errors.length ? 422 : 200, {
    ok: errors.length === 0,
    errors,
    preview: {
      subject: renderTemplate(subject, sampleTemplateContext()),
      body: renderTemplate(body, sampleTemplateContext()),
    },
  });
};

const sendTemplateTest = async (request, response, user) => {
  const payload = await parseJsonBody(request);
  const to = String(payload.to || "").trim().toLowerCase();
  const subject = String(payload.subject || "");
  const body = String(payload.body || "");
  const type = payload.type === "Nomina" ? "Nomina" : "Pago";

  if (!emailPattern.test(to)) {
    const error = new Error("TEMPLATE_TEST_EMAIL_INVALID");
    error.statusCode = 422;
    throw error;
  }

  const templateErrors = getTemplateErrors(subject, body);
  if (templateErrors.length) {
    const error = new Error("TEMPLATE_INVALID");
    error.statusCode = 422;
    error.details = templateErrors;
    throw error;
  }

  const agreementId = Number(payload.agreement_id || 0);
  const existingAgreement = agreementId ? await getAgreementById(agreementId) : null;
  const sample = sampleTemplateContext();
  const agreement = {
    ...(existingAgreement || {}),
    name:
      String(payload.agreement_name || existingAgreement?.name || sample.agreement.name)
        .trim() || sample.agreement.name,
    type,
    pdf_path: existingAgreement?.pdf_path || "",
    payment_evaluation_url:
      type === "Nomina" ? "" : optionalUrl(payload.payment_evaluation_url),
    payment_treatment_url:
      type === "Nomina" ? "" : optionalUrl(payload.payment_treatment_url),
    email_subject_template: subject,
    email_body_template: body,
  };
  const email = buildPatientEmail({
    submission: { values: sample.patient },
    agreement,
  });
  const result = await sendEmail({
    formName: "template-test",
    to,
    replyTo: user.email,
    ...email,
  });

  await recordAudit("template.test_sent", {
    actorUserId: user.id,
    detail: { to, agreement_id: agreementId || null },
  });
  sendJson(response, 200, { ok: true, id: result?.id || "" });
};

export const handlePublicAgreementApi = async (request, response, url) => {
  const slug = decodeURIComponent(url.pathname.replace("/api/public/agreements/", ""));
  const agreement = await getAgreementBySlug(slug);
  if (!agreement) {
    sendJson(response, 404, { error: "Acuerdo no encontrado." });
    return true;
  }
  sendJson(response, 200, {
    agreement: {
      id: agreement.id,
      name: agreement.name,
      slug: agreement.slug,
      cobranded: agreement.cobranded,
      type: agreement.type,
      logo_url: agreement.cobranded ? agreement.logo_url : "",
      pdf_url: agreement.pdf_url,
    },
  });
  return true;
};

export const validatePublicAgreementRoute = async (url, response) => {
  const slug = String(url.searchParams.get("form") || "").trim();
  if (!slug) return true;
  const agreement = await getAgreementBySlug(slug);
  if (agreement) return true;
  sendJson(response, 404, { error: "Acuerdo no encontrado." });
  return false;
};

export const handleAdminApi = async (request, response, url) => {
  const pathname = url.pathname;

  try {
    if (pathname === "/api/admin/auth/login" && request.method === "POST") {
      await handleLogin(request, response);
      return true;
    }

    const { user, session } = await requireCurrentUser(request);
    requireCsrfForMutation(request, session);

    if (pathname === "/api/admin/auth/me" && request.method === "GET") {
      await handleMe(request, response);
      return true;
    }
    if (pathname === "/api/admin/auth/logout" && request.method === "POST") {
      await handleLogout(request, response);
      return true;
    }
    if (
      pathname === "/api/admin/auth/change-password" &&
      request.method === "POST"
    ) {
      await handleChangePassword(request, response);
      return true;
    }

    if (pathname === "/api/admin/agreements" && request.method === "GET") {
      await listAgreements(response);
      return true;
    }
    if (pathname === "/api/admin/agreements" && request.method === "POST") {
      await createAgreement(request, response, user);
      return true;
    }

    const agreementQrMatch = pathname.match(/^\/api\/admin\/agreements\/(\d+)\/qr$/);
    if (agreementQrMatch && request.method === "GET") {
      await downloadAgreementQr(response, Number(agreementQrMatch[1]));
      return true;
    }

    const agreementMatch = pathname.match(/^\/api\/admin\/agreements\/(\d+)$/);
    if (agreementMatch && request.method === "PUT") {
      await updateAgreement(request, response, user, Number(agreementMatch[1]));
      return true;
    }
    if (agreementMatch && request.method === "DELETE") {
      await deleteAgreement(response, user, Number(agreementMatch[1]));
      return true;
    }

    if (pathname === "/api/admin/patient-intakes" && request.method === "GET") {
      await listPatientIntakes(url, response);
      return true;
    }
    const patientMatch = pathname.match(/^\/api\/admin\/patient-intakes\/(\d+)$/);
    if (patientMatch && request.method === "DELETE") {
      await deleteRecord(response, user, "patient_intakes", Number(patientMatch[1]));
      return true;
    }

    if (pathname === "/api/admin/contacts" && request.method === "GET") {
      await listContacts(response);
      return true;
    }
    const contactMatch = pathname.match(/^\/api\/admin\/contacts\/(\d+)$/);
    if (contactMatch && request.method === "DELETE") {
      await deleteRecord(response, user, "contacts", Number(contactMatch[1]));
      return true;
    }

    if (pathname === "/api/admin/nomina" && request.method === "GET") {
      await listNomina(url, response);
      return true;
    }
    if (pathname === "/api/admin/nomina" && request.method === "POST") {
      await createNominaEntry(request, response, user);
      return true;
    }
    if (pathname === "/api/admin/nomina/import" && request.method === "POST") {
      await importNominaCsv(request, response, user);
      return true;
    }
    const nominaMatch = pathname.match(/^\/api\/admin\/nomina\/(\d+)$/);
    if (nominaMatch && request.method === "DELETE") {
      await deleteNominaEntry(response, user, Number(nominaMatch[1]));
      return true;
    }

    if (pathname === "/api/admin/templates/validate" && request.method === "POST") {
      await validateTemplatePreview(request, response);
      return true;
    }
    if (pathname === "/api/admin/templates/test" && request.method === "POST") {
      await sendTemplateTest(request, response, user);
      return true;
    }

    return false;
  } catch (error) {
    if (error.code === "23505") {
      sendJson(response, 409, { error: "Ya existe un registro con esos datos." });
      return true;
    }
    if (error.message === "URL_INVALID") {
      sendJson(response, 422, { error: "Revisá los links: deben empezar con http o https." });
      return true;
    }
    if (error.message === "SLUG_REQUIRED") {
      sendJson(response, 422, { error: "El slug no puede quedar vacío." });
      return true;
    }
    if (error.message === "TEMPLATE_INVALID") {
      sendJson(response, 422, {
        error: "El template tiene errores.",
        errors: error.details || [],
      });
      return true;
    }
    if (error.message === "TEMPLATE_TEST_EMAIL_INVALID") {
      sendJson(response, 422, { error: "Ingresá un mail válido para enviar el test." });
      return true;
    }
    if (error.message === "NOMINA_AGREEMENT_REQUIRED") {
      sendJson(response, 422, { error: "Seleccioná un acuerdo de tipo Nómina." });
      return true;
    }
    if (error.message === "PAYLOAD_TOO_LARGE") {
      sendJson(response, 413, { error: "El archivo supera el tamaño permitido." });
      return true;
    }
    if (error.message === "INVALID_IMAGE") {
      sendJson(response, 415, { error: "El logo debe ser una imagen válida." });
      return true;
    }
    if (error.message === "INVALID_PDF") {
      sendJson(response, 415, { error: "El archivo Cómo funciona debe ser PDF." });
      return true;
    }
    if (error.message === "INVALID_CSV" || error.message === "CSV_REQUIRED") {
      sendJson(response, 415, { error: "Subí un archivo CSV válido." });
      return true;
    }
    if (
      error.message === "SES_SEND_FAILED" ||
      error.message === "SES_CONFIGURATION_MISSING"
    ) {
      sendJson(response, 502, { error: "No se pudo enviar el mail de test." });
      return true;
    }
    sendJson(response, error.statusCode || 500, {
      error: error.statusCode === 401 ? "No autenticado." : "Error inesperado.",
    });
    return true;
  }
};
