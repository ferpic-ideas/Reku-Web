import { randomBytes } from "node:crypto";
import { config } from "./config.mjs";
import { query, recordAudit, tx } from "./db.mjs";
import { sendEmail } from "./email.mjs";
import { hashPassword, hashToken } from "./security.mjs";
import { validateProfessionalPassword } from "./professional-users.mjs";

const invitationError = (message, statusCode = 422) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const escapeHtml = (value) =>
  String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const createProfessionalInvitation = async (
  client,
  { professionalId, userId, email, createdByUserId = null },
) => {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(
    Date.now() + config.professionalInvitationTtlHours * 60 * 60 * 1000,
  );

  await client.query(
    `
      UPDATE professional_invitations
      SET revoked_at = NOW(), updated_at = NOW()
      WHERE professional_id = $1
        AND accepted_at IS NULL
        AND revoked_at IS NULL
    `,
    [professionalId],
  );
  const result = await client.query(
    `
      INSERT INTO professional_invitations
        (token_hash, professional_id, user_id, email, expires_at, created_by_user_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `,
    [tokenHash, professionalId, userId, email, expiresAt, createdByUserId],
  );
  return {
    id: Number(result.rows[0].id),
    url: `${config.appPublicUrl}/profesional/#invite=${encodeURIComponent(token)}`,
    expiresAt: expiresAt.toISOString(),
  };
};

export const sendProfessionalInvitation = async ({
  invitationId,
  professionalId,
  name,
  email,
  url,
}) => {
  const safeName = escapeHtml(name || "Profesional");
  const safeUrl = escapeHtml(url);
  try {
    const result = await sendEmail({
      formName: "invitacion-profesional",
      to: email,
      replyTo: config.resendReplyToEmail,
      subject: "Activá tu cuenta profesional en Reku",
      text: [
        `Hola ${name || ""},`,
        "",
        "Te invitaron a usar el portal profesional de Reku.",
        `Activá tu cuenta y configurá tu perfil desde este enlace: ${url}`,
        "",
        `El enlace vence en ${config.professionalInvitationTtlHours} horas y sólo puede usarse una vez.`,
      ].join("\n"),
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#17213f;line-height:1.55">
          <h1 style="font-size:24px">Hola ${safeName}</h1>
          <p>Te invitaron a usar el portal profesional de Reku.</p>
          <p>Desde allí vas a poder completar tu perfil, elegir tus prácticas, cargar tus horarios y conectar Google Calendar.</p>
          <p style="margin:28px 0">
            <a href="${safeUrl}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#6c4bf4;color:#fff;text-decoration:none;font-weight:700">Activar mi cuenta</a>
          </p>
          <p style="color:#667085;font-size:13px">El enlace vence en ${config.professionalInvitationTtlHours} horas y sólo puede usarse una vez.</p>
        </div>
      `,
    });
    await query(
      `
        UPDATE professional_invitations
        SET sent_at = NOW(), email_message_id = $1, email_error = NULL, updated_at = NOW()
        WHERE id = $2
      `,
      [result?.id || null, invitationId],
    );
    await recordAudit("professional.invitation.sent", {
      detail: { professional_id: professionalId, invitation_id: invitationId, email },
    });
    return { sent: true };
  } catch (error) {
    await query(
      `
        UPDATE professional_invitations
        SET email_error = $1, updated_at = NOW()
        WHERE id = $2
      `,
      [String(error.message || "EMAIL_SEND_FAILED").slice(0, 500), invitationId],
    );
    await recordAudit("professional.invitation.email_failed", {
      detail: {
        professional_id: professionalId,
        invitation_id: invitationId,
        email,
        error: String(error.message || "EMAIL_SEND_FAILED").slice(0, 120),
      },
    });
    return { sent: false };
  }
};

export const acceptProfessionalInvitation = async ({ token, password }) => {
  const normalizedToken = String(token || "").trim();
  if (!normalizedToken) throw invitationError("PROFESSIONAL_INVITATION_INVALID", 401);
  const validPassword = validateProfessionalPassword(password, { required: true });
  const passwordHash = await hashPassword(validPassword);

  return tx(async (client) => {
    const result = await client.query(
      `
        SELECT
          invitation.id AS invitation_id,
          invitation.professional_id,
          invitation.user_id,
          invitation.email,
          professional.name AS professional_name,
          professional.email AS professional_email,
          professional.active AS professional_active,
          professional.deleted_at,
          account.role,
          account.is_active
        FROM professional_invitations invitation
        INNER JOIN professionals professional ON professional.id = invitation.professional_id
        INNER JOIN users account ON account.id = invitation.user_id
        WHERE invitation.token_hash = $1
          AND invitation.accepted_at IS NULL
          AND invitation.revoked_at IS NULL
          AND invitation.expires_at > NOW()
        FOR UPDATE OF invitation, professional, account
      `,
      [hashToken(normalizedToken)],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.deleted_at ||
      !row.professional_active ||
      row.role !== "professional" ||
      row.is_active
    ) {
      throw invitationError("PROFESSIONAL_INVITATION_INVALID", 401);
    }

    const userResult = await client.query(
      `
        UPDATE users
        SET password_hash = $1,
            is_active = TRUE,
            session_version = session_version + 1,
            updated_at = NOW()
        WHERE id = $2
          AND professional_id = $3
        RETURNING id, email, name, role, professional_id, session_version
      `,
      [passwordHash, row.user_id, row.professional_id],
    );
    const user = userResult.rows[0];
    if (!user) throw invitationError("PROFESSIONAL_INVITATION_INVALID", 401);

    await client.query(
      `
        UPDATE professional_invitations
        SET accepted_at = NOW(), updated_at = NOW()
        WHERE id = $1
      `,
      [row.invitation_id],
    );
    await client.query(
      `
        UPDATE professional_invitations
        SET revoked_at = NOW(), updated_at = NOW()
        WHERE professional_id = $1
          AND id <> $2
          AND accepted_at IS NULL
          AND revoked_at IS NULL
      `,
      [row.professional_id, row.invitation_id],
    );
    return {
      user,
      professional: {
        id: Number(row.professional_id),
        name: row.professional_name || "",
        email: row.professional_email || row.email || "",
      },
      invitationId: Number(row.invitation_id),
    };
  });
};
