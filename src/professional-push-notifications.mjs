import { config } from "./config.mjs";
import { one, recordAudit } from "./db.mjs";
import { sendEmail } from "./email.mjs";
import { escapeHtml } from "./http.mjs";

export const sendProfessionalPushActivationEmail = async ({ account }) => {
  const recent = await one(
    `
      SELECT created_at
      FROM audit_events
      WHERE actor_user_id = $1
        AND event_type = 'professional.push.activation_email_sent'
        AND created_at > NOW() - INTERVAL '5 minutes'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [account.user.id],
  );
  if (recent) {
    const error = new Error("PUSH_ACTIVATION_EMAIL_RATE_LIMITED");
    error.statusCode = 429;
    throw error;
  }

  const link = `${config.appPublicUrl}/profesional/?activar-notificaciones=1`;
  const name = account.professional?.name || account.user.name || "Profesional";
  const text = [
    `Hola ${name},`,
    "",
    "Activá las notificaciones de Reku en tu teléfono para recibir un aviso inmediato cuando un paciente esté esperando para su videollamada.",
    "",
    `Abrir en mi teléfono: ${link}`,
    "",
    "En Android, abrí el enlace y tocá Activar notificaciones.",
    "En iPhone, abrí el enlace en Safari, elegí Compartir > Agregar a inicio, abrí Reku desde el nuevo ícono y tocá Activar notificaciones.",
  ].join("\n");
  const html = `
    <div style="font-family:Arial,sans-serif;color:#18213f;line-height:1.5">
      <h1 style="font-size:24px;margin:0 0 16px">Activá los avisos de pacientes en espera</h1>
      <p>Hola ${escapeHtml(name)},</p>
      <p>Activá las notificaciones de Reku en tu teléfono para recibir un aviso inmediato cuando un paciente esté esperando para su videollamada.</p>
      <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#6c4bf4;color:#fff;padding:12px 16px;border-radius:8px;text-decoration:none;font-weight:700">Activar en mi teléfono</a></p>
      <p><strong>Android:</strong> abrí el enlace y tocá “Activar notificaciones”.</p>
      <p><strong>iPhone:</strong> abrí el enlace en Safari, elegí Compartir → Agregar a inicio, abrí Reku desde el nuevo ícono y tocá “Activar notificaciones”.</p>
    </div>
  `;
  const result = await sendEmail({
    formName: "activar-notificaciones-profesional",
    to: account.professional?.email || account.user.email,
    subject: "Activá las notificaciones de Reku en tu celular",
    text,
    html,
  });
  await recordAudit("professional.push.activation_email_sent", {
    actorUserId: account.user.id,
    detail: {
      professional_id: Number(account.user.professional_id),
      message_id: result?.id || "",
    },
  });
  return { ok: true, message_id: result?.id || "" };
};
