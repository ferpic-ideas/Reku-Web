import { randomBytes, randomInt } from "node:crypto";
import { config } from "./config.mjs";
import { one, query, recordAudit, tx } from "./db.mjs";
import { sendEmail } from "./email.mjs";
import { consumeRateLimit } from "./rate-limit.mjs";
import {
  hashPassword,
  hashToken,
  verifyPassword,
} from "./security.mjs";

const audiences = new Set(["admin", "professional"]);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const tokenPattern = /^[A-Za-z0-9_-]{40,128}$/;

const waitUntil = async (notBefore) => {
  const remaining = notBefore - Date.now();
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
};

export const passwordResetGenericMessage =
  "Si existe una cuenta habilitada con ese email, te enviamos un enlace para recuperar la contraseña.";

const passwordResetError = (message, statusCode = 422, publicMessage = "") => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = publicMessage;
  return error;
};

const normalizeAudience = (value) => {
  const audience = String(value || "").trim().toLowerCase();
  if (!audiences.has(audience)) {
    throw passwordResetError("PASSWORD_RESET_AUDIENCE_INVALID", 400);
  }
  return audience;
};

const escapeHtml = (value) =>
  String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const passwordResetMinimumLength = (audience) =>
  normalizeAudience(audience) === "admin" ? 10 : 8;

export const validatePasswordResetPassword = (audience, value) => {
  const password = String(value || "");
  const minimum = passwordResetMinimumLength(audience);
  if (password.length < minimum || password.length > 128) {
    throw passwordResetError(
      "PASSWORD_RESET_PASSWORD_INVALID",
      422,
      `La nueva contraseña debe tener entre ${minimum} y 128 caracteres.`,
    );
  }
  return password;
};

export const buildPasswordResetUrl = ({ audience, token }) => {
  const target = normalizeAudience(audience) === "admin" ? "/admin/" : "/profesional/";
  return `${config.appPublicUrl}${target}#reset-password=${encodeURIComponent(token)}`;
};

export const buildPasswordResetEmail = ({ audience, name, url }) => {
  const portal = normalizeAudience(audience) === "admin" ? "Admin" : "Portal Profesional";
  const safeName = escapeHtml(name || "");
  const safeUrl = escapeHtml(url);
  const expiry = config.passwordResetTtlMinutes;
  return {
    subject: `Recuperá tu contraseña de Reku ${portal}`,
    text: [
      `Hola${name ? ` ${name}` : ""},`,
      "",
      "Recibimos una solicitud para cambiar tu contraseña de Reku.",
      `Creá una nueva contraseña desde este enlace: ${url}`,
      "",
      `El enlace vence en ${expiry} minutos y sólo puede usarse una vez.`,
      "Si no solicitaste este cambio, ignorá este email. Tu contraseña actual seguirá funcionando.",
    ].join("\n"),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#17213f;line-height:1.55">
        <h1 style="font-size:24px">Recuperá tu contraseña</h1>
        <p>Hola${safeName ? ` ${safeName}` : ""},</p>
        <p>Recibimos una solicitud para cambiar tu contraseña de Reku.</p>
        <p style="margin:28px 0">
          <a href="${safeUrl}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#17213f;color:#fff;text-decoration:none;font-weight:700">Crear nueva contraseña</a>
        </p>
        <p style="color:#667085;font-size:13px">El enlace vence en ${expiry} minutos y sólo puede usarse una vez.</p>
        <p style="color:#667085;font-size:13px">Si no solicitaste este cambio, ignorá este email. Tu contraseña actual seguirá funcionando.</p>
      </div>
    `,
  };
};

const buildPasswordChangedEmail = ({ audience, name }) => {
  const portal = normalizeAudience(audience) === "admin" ? "Admin" : "Portal Profesional";
  const safeName = escapeHtml(name || "");
  return {
    subject: `Tu contraseña de Reku ${portal} fue actualizada`,
    text: [
      `Hola${name ? ` ${name}` : ""},`,
      "",
      "La contraseña de tu cuenta Reku fue actualizada correctamente.",
      "Por seguridad, cerramos las sesiones que estaban abiertas.",
      "Si no realizaste este cambio, contactanos de inmediato respondiendo este email.",
    ].join("\n"),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#17213f;line-height:1.55">
        <h1 style="font-size:24px">Contraseña actualizada</h1>
        <p>Hola${safeName ? ` ${safeName}` : ""},</p>
        <p>La contraseña de tu cuenta Reku fue actualizada correctamente.</p>
        <p>Por seguridad, cerramos las sesiones que estaban abiertas.</p>
        <p><strong>Si no realizaste este cambio, contactanos de inmediato respondiendo este email.</strong></p>
      </div>
    `,
  };
};

const eligibleUser = (row, audience) => {
  if (!row?.is_active) return false;
  if (audience === "admin") return row.role !== "professional";
  return (
    row.role === "professional" &&
    Boolean(row.professional_id) &&
    Boolean(row.professional_active) &&
    !row.professional_deleted_at
  );
};

const enforceRequestRateLimit = async ({ audience, clientIp, email }) => {
  await Promise.all([
    consumeRateLimit({
      scope: `password-reset.${audience}.ip.15m`,
      key: clientIp || "unknown",
      limit: 5,
      windowSeconds: 900,
    }),
    consumeRateLimit({
      scope: `password-reset.${audience}.identity.30m`,
      key: email || "invalid",
      limit: 3,
      windowSeconds: 1800,
    }),
    consumeRateLimit({
      scope: `password-reset.${audience}.global.day`,
      key: "global",
      limit: 500,
      windowSeconds: 86_400,
    }),
  ]);
};

const enforceCompletionRateLimit = async ({ audience, clientIp, token }) => {
  await Promise.all([
    consumeRateLimit({
      scope: `password-reset-complete.${audience}.ip.15m`,
      key: clientIp || "unknown",
      limit: 10,
      windowSeconds: 900,
    }),
    consumeRateLimit({
      scope: `password-reset-complete.${audience}.token.15m`,
      key: hashToken(token || "invalid"),
      limit: 5,
      windowSeconds: 900,
    }),
  ]);
};

const updateDelivery = async (tokenId, values) => {
  await query(
    `
      UPDATE password_reset_tokens
      SET sent_at = $1,
          email_message_id = $2,
          email_error = $3,
          updated_at = NOW()
      WHERE id = $4
    `,
    [values.sentAt || null, values.messageId || null, values.error || null, tokenId],
  );
};

const deliverResetEmail = async ({ tokenId, user, audience, url }) => {
  const content = buildPasswordResetEmail({
    audience,
    name: user.name,
    url,
  });
  try {
    const result = await sendEmail({
      formName: `recuperacion-clave-${audience}`,
      to: user.email,
      replyTo: config.resendReplyToEmail,
      ...content,
    });
    await updateDelivery(tokenId, {
      sentAt: new Date(),
      messageId: result?.id || null,
    });
    await recordAudit("auth.password_reset_email_sent", {
      actorUserId: user.id,
      detail: { audience, password_reset_token_id: tokenId },
    });
  } catch (error) {
    const message = String(error.message || "EMAIL_SEND_FAILED").slice(0, 500);
    await updateDelivery(tokenId, { error: message }).catch(() => {});
    await recordAudit("auth.password_reset_email_failed", {
      actorUserId: user.id,
      detail: {
        audience,
        password_reset_token_id: tokenId,
        error: message.slice(0, 120),
      },
    }).catch(() => {});
  }
};

const deliverPasswordChangedEmail = async ({ user, audience }) => {
  try {
    await sendEmail({
      formName: `clave-actualizada-${audience}`,
      to: user.email,
      replyTo: config.resendReplyToEmail,
      ...buildPasswordChangedEmail({ audience, name: user.name }),
    });
  } catch (error) {
    await recordAudit("auth.password_reset_confirmation_failed", {
      actorUserId: user.id,
      detail: {
        audience,
        error: String(error.message || "EMAIL_SEND_FAILED").slice(0, 120),
      },
    }).catch(() => {});
  }
};

export const requestPasswordReset = async ({ audience: value, email: valueEmail, clientIp }) => {
  const audience = normalizeAudience(value);
  const email = String(valueEmail || "").trim().toLowerCase().slice(0, 320);
  await enforceRequestRateLimit({ audience, clientIp, email });
  const respondNotBefore = Date.now() + 300 + randomInt(0, 201);

  const user = emailPattern.test(email)
    ? await one(
        `
          SELECT
            account.id,
            account.email,
            account.name,
            account.role,
            account.is_active,
            account.professional_id,
            professional.active AS professional_active,
            professional.deleted_at AS professional_deleted_at
          FROM users account
          LEFT JOIN professionals professional ON professional.id = account.professional_id
          WHERE lower(account.email) = lower($1)
        `,
        [email],
      )
    : null;

  const matched = eligibleUser(user, audience);
  await recordAudit("auth.password_reset_requested", {
    actorUserId: matched ? user.id : null,
    detail: {
      audience,
      account_matched: matched,
      email_hash: hashToken(email || "invalid"),
      client_ip_hash: hashToken(clientIp || "unknown"),
    },
  });

  if (!matched) {
    await waitUntil(respondNotBefore);
    return { accepted: true };
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    Date.now() + config.passwordResetTtlMinutes * 60 * 1000,
  );
  const created = await tx(async (client) => {
    await client.query(
      `
        UPDATE password_reset_tokens
        SET revoked_at = NOW(), updated_at = NOW()
        WHERE user_id = $1
          AND audience = $2
          AND used_at IS NULL
          AND revoked_at IS NULL
      `,
      [user.id, audience],
    );
    const result = await client.query(
      `
        INSERT INTO password_reset_tokens
          (user_id, audience, token_hash, requested_ip_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `,
      [
        user.id,
        audience,
        hashToken(token),
        hashToken(clientIp || "unknown"),
        expiresAt,
      ],
    );
    return { id: Number(result.rows[0].id) };
  });

  const url = buildPasswordResetUrl({ audience, token });
  void deliverResetEmail({ tokenId: created.id, user, audience, url }).catch(() => {});
  await waitUntil(respondNotBefore);
  return { accepted: true };
};

export const resetPassword = async ({ audience: value, token: valueToken, password, clientIp }) => {
  const audience = normalizeAudience(value);
  const newPassword = validatePasswordResetPassword(audience, password);
  const token = String(valueToken || "").trim();
  await enforceCompletionRateLimit({ audience, clientIp, token });
  const passwordHash = await hashPassword(newPassword);

  if (!tokenPattern.test(token)) {
    throw passwordResetError(
      "PASSWORD_RESET_INVALID",
      400,
      "El enlace venció, ya fue usado o no es válido. Solicitá uno nuevo.",
    );
  }

  const completed = await tx(async (client) => {
    const result = await client.query(
      `
        SELECT
          reset.id AS reset_id,
          reset.user_id,
          account.email,
          account.name,
          account.role,
          account.password_hash,
          account.is_active,
          account.professional_id,
          professional.active AS professional_active,
          professional.deleted_at AS professional_deleted_at
        FROM password_reset_tokens reset
        INNER JOIN users account ON account.id = reset.user_id
        LEFT JOIN professionals professional ON professional.id = account.professional_id
        WHERE reset.token_hash = $1
          AND reset.audience = $2
          AND reset.used_at IS NULL
          AND reset.revoked_at IS NULL
          AND reset.expires_at > NOW()
        FOR UPDATE OF reset, account
      `,
      [hashToken(token), audience],
    );
    const row = result.rows[0];
    if (!eligibleUser(row, audience)) {
      throw passwordResetError(
        "PASSWORD_RESET_INVALID",
        400,
        "El enlace venció, ya fue usado o no es válido. Solicitá uno nuevo.",
      );
    }
    if (await verifyPassword(newPassword, row.password_hash)) {
      throw passwordResetError(
        "PASSWORD_RESET_PASSWORD_REUSED",
        422,
        "Elegí una contraseña diferente a la actual.",
      );
    }

    await client.query(
      `
        UPDATE password_reset_tokens
        SET used_at = NOW(), updated_at = NOW()
        WHERE id = $1
      `,
      [row.reset_id],
    );
    await client.query(
      `
        UPDATE users
        SET password_hash = $1,
            session_version = session_version + 1,
            updated_at = NOW()
        WHERE id = $2
      `,
      [passwordHash, row.user_id],
    );
    await client.query(
      `
        UPDATE password_reset_tokens
        SET revoked_at = NOW(), updated_at = NOW()
        WHERE user_id = $1
          AND id <> $2
          AND used_at IS NULL
          AND revoked_at IS NULL
      `,
      [row.user_id, row.reset_id],
    );
    return {
      user: {
        id: Number(row.user_id),
        email: row.email,
        name: row.name || "",
      },
    };
  });

  await recordAudit("auth.password_reset_completed", {
    actorUserId: completed.user.id,
    detail: {
      audience,
      client_ip_hash: hashToken(clientIp || "unknown"),
    },
  }).catch((error) => {
    console.error("Password reset audit failed", {
      audience,
      error: String(error.message || "AUDIT_FAILED").slice(0, 120),
    });
  });
  void deliverPasswordChangedEmail({ user: completed.user, audience }).catch(() => {});
  return { ok: true };
};
