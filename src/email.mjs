import { createHash, createHmac } from "node:crypto";
import { config } from "./config.mjs";

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

const sendSesEmail = async ({ to, replyTo, subject, text, html }) => {
  const host = `email.${config.awsRegion}.amazonaws.com`;
  const path = "/v2/email/outbound-emails";
  const body = JSON.stringify({
    FromEmailAddress: config.emailFromEmail || config.sesFromEmail,
    Destination: {
      ToAddresses: [to],
    },
    ReplyToAddresses: replyTo ? [replyTo] : undefined,
    Content: {
      Simple: {
        Subject: {
          Data: subject,
          Charset: "UTF-8",
        },
        Body: {
          Text: {
            Data: text,
            Charset: "UTF-8",
          },
          Html: {
            Data: html,
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
      region: config.awsRegion,
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
    throw new Error("EMAIL_SEND_FAILED");
  }

  return { id: payload.MessageId };
};

const sendResendEmail = async ({ to, replyTo, subject, text, html }) => {
  if (!config.resendApiKey) {
    throw new Error("EMAIL_CONFIGURATION_MISSING");
  }

  const body = JSON.stringify({
    from: config.resendFromEmail,
    to: [to],
    reply_to: replyTo ? [replyTo] : undefined,
    subject,
    text,
    html,
  });
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.resendApiKey}`,
      "content-type": "application/json",
    },
    body,
  });

  const responseBody = await response.text();
  const payload = parseJson(responseBody);

  if (!response.ok) {
    console.error("Resend error", {
      status: response.status,
      error:
        payload?.message ||
        payload?.error ||
        payload?.name ||
        responseBody.slice(0, 300) ||
        "unknown",
    });
    throw new Error("EMAIL_SEND_FAILED");
  }

  return { id: payload.id };
};

export const sendEmail = async ({ formName, to, replyTo, subject, text, html }) => {
  if (config.emailDryRun) {
    console.log("EMAIL_DRY_RUN", { formName, to, subject });
    return { id: "dry-run" };
  }

  if (config.emailProvider === "resend") {
    return sendResendEmail({ to, replyTo, subject, text, html });
  }

  if (config.emailProvider === "ses") {
    try {
      return await sendSesEmail({ to, replyTo, subject, text, html });
    } catch (error) {
      if (error.message === "SES_CONFIGURATION_MISSING") {
        throw new Error("EMAIL_CONFIGURATION_MISSING");
      }
      throw error;
    }
  }

  throw new Error("EMAIL_CONFIGURATION_MISSING");
};
