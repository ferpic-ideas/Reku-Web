import { createServer } from "node:http";
import { createHash, createHmac } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname);
const port = Number(process.env.PORT || 3000);
const maxBodyBytes = 25_000;

const contactToEmail = process.env.CONTACT_TO_EMAIL || "hola@reku.io";
const patientIntakeToEmail =
  process.env.PATIENT_INTAKE_TO_EMAIL || "altas-pacientes@reku.io";
const sesFromEmail = process.env.SES_FROM_EMAIL || "Reku <hola@reku.io>";
const awsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "";
const emailDryRun = process.env.EMAIL_DRY_RUN === "true";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

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

const sendJson = (response, statusCode, payload) => {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
};

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const readBody = async (request) => {
  let body = "";

  for await (const chunk of request) {
    body += chunk;
    if (body.length > maxBodyBytes) {
      throw new Error("PAYLOAD_TOO_LARGE");
    }
  }

  return body;
};

const parseFormBody = async (request) => {
  const body = await readBody(request);
  const contentType = request.headers["content-type"] || "";

  if (contentType.includes("application/json")) {
    return new URLSearchParams(JSON.parse(body || "{}"));
  }

  return new URLSearchParams(body);
};

const getTrimmed = (params, key) => String(params.get(key) || "").trim();

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
      to: contactToEmail,
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
      to: patientIntakeToEmail,
      subject: getTrimmed(params, "subject") || "Alta de paciente desde QR - Reku",
      replyTo: getTrimmed(params, "email").toLowerCase(),
      values: {
        nombre: getTrimmed(params, "nombre"),
        apellido: getTrimmed(params, "apellido"),
        telefono: getTrimmed(params, "telefono"),
        email: getTrimmed(params, "email").toLowerCase(),
      },
      labels: {
        nombre: "Nombre",
        apellido: "Apellido",
        telefono: "Teléfono",
        email: "Mail",
      },
    };
  }

  return null;
};

const validateSubmission = (submission) => {
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

const buildEmail = (submission) => {
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
    text,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5;">
        <h1 style="font-size: 20px;">${escapeHtml(submission.subject)}</h1>
        ${htmlRows}
      </div>
    `,
  };
};

const parseJson = (value) => {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
};

const getAwsTimestamp = () =>
  new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");

const hashSha256 = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const hmacSha256 = (key, value, encoding) =>
  createHmac("sha256", key).update(value, "utf8").digest(encoding);

const getAwsSigningKey = (secretAccessKey, dateStamp, region, service) => {
  const dateKey = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmacSha256(dateKey, region);
  const serviceKey = hmacSha256(regionKey, service);
  return hmacSha256(serviceKey, "aws4_request");
};

const signAwsRequest = ({ body, host, method, path, region, service }) => {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;

  if (!accessKeyId || !secretAccessKey || !region) {
    throw new Error("SES_CONFIGURATION_MISSING");
  }

  const amzDate = getAwsTimestamp();
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = hashSha256(body);
  const headers = {
    "content-type": "application/json",
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  if (sessionToken) {
    headers["x-amz-security-token"] = sessionToken;
  }

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name]}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    method,
    path,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hashSha256(canonicalRequest),
  ].join("\n");
  const signingKey = getAwsSigningKey(
    secretAccessKey,
    dateStamp,
    region,
    service,
  );
  const signature = hmacSha256(signingKey, stringToSign, "hex");

  return {
    ...headers,
    authorization: [
      "AWS4-HMAC-SHA256",
      `Credential=${accessKeyId}/${credentialScope},`,
      `SignedHeaders=${signedHeaders},`,
      `Signature=${signature}`,
    ].join(" "),
  };
};

const sendEmail = async (submission) => {
  if (emailDryRun) {
    console.log("EMAIL_DRY_RUN", {
      formName: submission.formName,
      to: submission.to,
      subject: submission.subject,
    });
    return { id: "dry-run" };
  }

  const email = buildEmail(submission);
  const host = `email.${awsRegion}.amazonaws.com`;
  const path = "/v2/email/outbound-emails";
  const body = JSON.stringify({
    FromEmailAddress: sesFromEmail,
    Destination: {
      ToAddresses: [submission.to],
    },
    ReplyToAddresses: [submission.replyTo],
    Content: {
      Simple: {
        Subject: {
          Data: submission.subject,
          Charset: "UTF-8",
        },
        Body: {
          Text: {
            Data: email.text,
            Charset: "UTF-8",
          },
          Html: {
            Data: email.html,
            Charset: "UTF-8",
          },
        },
      },
    },
  });
  const response = await fetch(`https://${host}${path}`, {
    method: "POST",
    headers: signAwsRequest({
      body,
      host,
      method: "POST",
      path,
      region: awsRegion,
      service: "ses",
    }),
    body,
  });

  const responseBody = await response.text();
  const payload = parseJson(responseBody);

  if (!response.ok) {
    console.error("SES error", {
      status: response.status,
      error:
        payload?.message ||
        payload?.Message ||
        payload?.__type ||
        responseBody.slice(0, 300) ||
        "unknown",
    });
    throw new Error("SES_SEND_FAILED");
  }

  return { id: payload.MessageId };
};

const handleFormSubmission = async (request, response) => {
  let params;
  try {
    params = await parseFormBody(request);
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

  const errors = validateSubmission(submission);
  if (Object.keys(errors).length > 0) {
    sendJson(response, 422, {
      error: "Revisá los campos marcados para poder enviar el formulario.",
      errors,
    });
    return;
  }

  try {
    const result = await sendEmail(submission);
    sendJson(response, 200, { ok: true, id: result?.id });
  } catch (error) {
    const statusCode = error.message === "SES_CONFIGURATION_MISSING" ? 503 : 502;
    sendJson(response, statusCode, {
      error: "No se pudo enviar el formulario. Probá de nuevo.",
    });
  }
};

const resolveStaticPath = async (pathname) => {
  const decodedPath = decodeURIComponent(pathname);
  const safePath = normalize(decodedPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = resolve(join(root, safePath));

  if (!filePath.startsWith(root)) {
    return null;
  }

  const fileStat = await stat(filePath).catch(() => null);
  if (fileStat?.isDirectory()) {
    filePath = join(filePath, "index.html");
  }

  return filePath;
};

const serveStatic = async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = await resolveStaticPath(pathname);

  if (!filePath) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    const headers = {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "public, max-age=60",
    };
    response.writeHead(200, headers);
    if (request.method !== "HEAD") {
      response.end(file);
    } else {
      response.end();
    }
  } catch {
    const notFoundPath = join(root, "404.html");
    const notFound = await readFile(notFoundPath).catch(() => null);
    response.writeHead(404, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    });
    response.end(notFound || "Not found");
  }
};

const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST") {
      await handleFormSubmission(request, response);
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      await serveStatic(request, response);
      return;
    }

    response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Method not allowed");
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "Error inesperado." });
  }
});

server.listen(port, () => {
  console.log(`Reku Web listening on http://localhost:${port}`);
});
