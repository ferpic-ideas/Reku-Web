import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { config, root } from "./config.mjs";

export const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
};

const sameOriginFrameHeaders = {
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy": securityHeaders["Content-Security-Policy"].replace(
    "frame-ancestors 'none'",
    "frame-ancestors 'self'",
  ),
};

export const withSecurityHeaders = (headers = {}, { privateRoute = false } = {}) => ({
  ...securityHeaders,
  ...(privateRoute ? { "X-Robots-Tag": "noindex, nofollow" } : {}),
  ...headers,
});

export const sendJson = (response, statusCode, payload, extraHeaders = {}) => {
  response.writeHead(
    statusCode,
    withSecurityHeaders(
      {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...extraHeaders,
      },
      { privateRoute: true },
    ),
  );
  response.end(JSON.stringify(payload));
};

export const sendText = (response, statusCode, text, headers = {}) => {
  response.writeHead(
    statusCode,
    withSecurityHeaders({
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    }),
  );
  response.end(text);
};

export const sendRedirect = (response, location, statusCode = 303) => {
  response.writeHead(statusCode, withSecurityHeaders({ Location: location }));
  response.end();
};

export const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const readBody = async (request, maxBytes = config.maxBodyBytes) => {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error("PAYLOAD_TOO_LARGE");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
};

export const parseRequestBody = async (request) => {
  const body = await readBody(request);
  const contentType = request.headers["content-type"] || "";

  if (contentType.includes("application/json")) {
    return new URLSearchParams(JSON.parse(body || "{}"));
  }

  return new URLSearchParams(body);
};

export const getTrimmed = (params, key) => String(params.get(key) || "").trim();

export const parseCookies = (request) => {
  const header = request.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const separator = item.indexOf("=");
        return [
          decodeURIComponent(item.slice(0, separator)),
          decodeURIComponent(item.slice(separator + 1)),
        ];
      }),
  );
};

export const getClientIp = (request) =>
  String(request.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim() ||
  request.socket.remoteAddress ||
  "unknown";

export const resolveStaticPath = async (pathname) => {
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

export const serveStatic = async (request, response, pathname) => {
  const filePath = await resolveStaticPath(pathname);

  if (!filePath) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    const isPrivateRoute =
      pathname.startsWith("/admin") || pathname.startsWith("/uploads");
    const allowsSameOriginFrame = pathname.startsWith("/agenda");
    const headers = withSecurityHeaders(
      {
        "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
        "Cache-Control": pathname.startsWith("/admin")
          ? "no-store"
          : "public, max-age=60",
        ...(allowsSameOriginFrame ? sameOriginFrameHeaders : {}),
      },
      { privateRoute: isPrivateRoute },
    );
    response.writeHead(200, headers);
    response.end(request.method === "HEAD" ? undefined : file);
  } catch {
    const notFoundPath = join(root, "404.html");
    const notFound = await readFile(notFoundPath).catch(() => null);
    response.writeHead(
      404,
      withSecurityHeaders({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      }),
    );
    response.end(notFound || "Not found");
  }
};
