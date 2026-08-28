import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  config,
  isProduction,
  publicUploadRoot,
  root,
} from "./config.mjs";

export const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
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
  ...(isProduction
    ? { "Strict-Transport-Security": "max-age=31536000" }
    : {}),
};

const sameOriginFrameHeaders = {
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy": securityHeaders["Content-Security-Policy"].replace(
    "frame-ancestors 'none'",
    "frame-ancestors 'self'",
  ),
};

const adminAgreementPreviewHeaders = {
  "Content-Security-Policy": `${securityHeaders["Content-Security-Policy"]}; frame-src 'self' https://*.reku.io`,
};

const agreementPreviewHeaders = {
  "Content-Security-Policy": securityHeaders["Content-Security-Policy"].replace(
    "frame-ancestors 'none'",
    "frame-ancestors https://www.reku.io",
  ),
};

export const withSecurityHeaders = (
  headers = {},
  { privateRoute = false, omitFrameOptions = false } = {},
) => {
  const result = {
    ...securityHeaders,
    ...(privateRoute ? { "X-Robots-Tag": "noindex, nofollow" } : {}),
    ...headers,
  };
  if (omitFrameOptions) delete result["X-Frame-Options"];
  return result;
};

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
      .flatMap((item) => {
        const separator = item.indexOf("=");
        if (separator <= 0) return [];
        try {
          return [[
            decodeURIComponent(item.slice(0, separator)),
            decodeURIComponent(item.slice(separator + 1)),
          ]];
        } catch {
          return [];
        }
      }),
  );
};

export const getClientIp = (request) =>
  String(request.headers["x-forwarded-for"] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1) ||
  request.socket.remoteAddress ||
  "unknown";

const publicFiles = new Map(
  [
    "index.html",
    "producto.html",
    "evidencia.html",
    "404.html",
    "favicon.ico",
    "favicon-16x16.png",
    "favicon-32x32.png",
    "apple-touch-icon.png",
    "robots.txt",
    "sitemap.xml",
    "google85f04377b6d8f892.html",
  ].map((name) => [`/${name}`, join(root, name)]),
);

const publicMounts = [
  {
    prefix: "/images/",
    directory: join(root, "images"),
    extensions: new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]),
  },
  {
    prefix: "/admin/",
    directory: join(root, "admin"),
    extensions: new Set([".html", ".css", ".js"]),
  },
  {
    prefix: "/turnos/",
    directory: join(root, "agenda"),
    extensions: new Set([".html", ".css", ".js"]),
  },
  {
    prefix: "/profesional-turnos/",
    directory: join(root, "profesional-turnos"),
    extensions: new Set([".html", ".css", ".js"]),
  },
  {
    prefix: "/profesional/",
    directory: join(root, "profesional"),
    extensions: new Set([".html", ".css", ".js", ".webmanifest", ".png"]),
  },
  {
    prefix: "/alta-pacientes/",
    directory: join(root, "alta-pacientes"),
    extensions: new Set([".html", ".css", ".js"]),
  },
  {
    prefix: "/congreso-cokiba/",
    directory: join(root, "congreso-cokiba"),
    extensions: new Set([".html", ".css", ".js"]),
  },
  {
    prefix: "/privacidad/",
    directory: join(root, "privacidad"),
    extensions: new Set([".html"]),
  },
  {
    prefix: "/terminos/",
    directory: join(root, "terminos"),
    extensions: new Set([".html"]),
  },
  {
    prefix: "/legal/",
    directory: join(root, "legal"),
    extensions: new Set([".css"]),
  },
];

const publicUploadFolders = new Map([
  ["agreements", new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp"])],
  ["professionals", new Set([".jpg", ".jpeg", ".png", ".webp"])],
  ["services", new Set([".jpg", ".jpeg", ".png", ".webp"])],
]);

export const resolveStaticRequestPath = (pathname) => {
  if (pathname === "/") return "/index.html";

  if (pathname === "/privacidad" || pathname === "/privacidad/") {
    return "/privacidad/index.html";
  }

  if (pathname === "/terminos" || pathname === "/terminos/") {
    return "/terminos/index.html";
  }

  if (pathname === "/congreso-cokiba" || pathname === "/congreso-cokiba/") {
    return "/congreso-cokiba/index.html";
  }

  const isBookingPage =
    pathname === "/turnos" ||
    (pathname.startsWith("/turnos/") &&
      !pathname.slice("/turnos/".length).includes("."));
  if (isBookingPage) return "/turnos/index.html";

  const isAdminPage =
    pathname === "/admin/" ||
    (pathname.startsWith("/admin/") &&
      !pathname.slice("/admin/".length).includes("."));
  if (isAdminPage) return "/admin/index.html";

  const isProfessionalPage =
    pathname === "/profesional" ||
    pathname === "/profesional/" ||
    (pathname.startsWith("/profesional/") &&
      !pathname.slice("/profesional/".length).includes("."));
  if (isProfessionalPage) return "/profesional/index.html";

  if (
    pathname === "/profesional-turnos" ||
    pathname === "/profesional-turnos/"
  ) {
    return "/profesional-turnos/index.html";
  }

  return pathname;
};

const resolveInside = (directory, path) => {
  const filePath = resolve(directory, path);
  const relativePath = relative(directory, filePath);
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return filePath;
};

const decodedPathname = (pathname) => {
  try {
    const decoded = decodeURIComponent(pathname);
    return decoded.includes("\0") ? null : decoded;
  } catch {
    return null;
  }
};

export const resolveStaticPath = async (pathname) => {
  const decodedPath = decodedPathname(pathname);
  if (!decodedPath) return null;
  let filePath = publicFiles.get(decodedPath) || null;

  if (!filePath) {
    for (const mount of publicMounts) {
      if (!decodedPath.startsWith(mount.prefix)) continue;
      const suffix = decodedPath.slice(mount.prefix.length);
      if (!mount.extensions.has(extname(suffix).toLowerCase())) return null;
      filePath = resolveInside(mount.directory, suffix);
      break;
    }
  }

  if (!filePath) return null;

  const fileStat = await stat(filePath).catch(() => null);
  if (fileStat?.isDirectory()) {
    return null;
  }

  return filePath;
};

export const resolvePublicUploadPath = async (pathname) => {
  const decodedPath = decodedPathname(pathname);
  if (!decodedPath?.startsWith("/uploads/")) return null;
  const suffix = decodedPath.slice("/uploads/".length);
  const [folder, ...parts] = suffix.split("/");
  const extensions = publicUploadFolders.get(folder);
  if (!extensions || parts.length !== 1 || !parts[0]) return null;
  if (!extensions.has(extname(parts[0]).toLowerCase())) return null;
  const filePath = resolveInside(publicUploadRoot, `${folder}/${parts[0]}`);
  if (!filePath) return null;
  const fileStat = await stat(filePath).catch(() => null);
  return fileStat?.isFile() ? filePath : null;
};

const serveFile = async (
  request,
  response,
  filePath,
  {
    cacheControl,
    privateRoute = false,
    extraHeaders = {},
    omitFrameOptions = false,
  } = {},
) => {
  const file = await readFile(filePath);
  const headers = withSecurityHeaders(
    {
      "Content-Type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": cacheControl || "public, max-age=60",
      ...extraHeaders,
    },
    { privateRoute, omitFrameOptions },
  );
  response.writeHead(200, headers);
  response.end(request.method === "HEAD" ? undefined : file);
};

export const servePublicUpload = async (request, response, pathname) => {
  const filePath = await resolvePublicUploadPath(pathname);
  if (!filePath) {
    sendText(response, 404, "Not found");
    return;
  }

  const isPdf = extname(filePath).toLowerCase() === ".pdf";
  await serveFile(request, response, filePath, {
    cacheControl: isPdf
      ? "private, no-store"
      : "public, max-age=31536000, immutable",
    extraHeaders: { "X-Robots-Tag": "noindex, nofollow" },
  });
};

export const serveStatic = async (
  request,
  response,
  pathname,
  { agreementSubdomain = false } = {},
) => {
  const filePath = await resolveStaticPath(pathname);

  if (!filePath) {
    sendText(response, 404, "Not found");
    return;
  }

  try {
    const isPrivateRoute =
      pathname.startsWith("/admin") ||
      pathname.startsWith("/profesional") ||
      pathname.startsWith("/profesional-turnos");
    const isHtml = extname(filePath).toLowerCase() === ".html";
    const isAgreementPreview =
      agreementSubdomain && pathname.startsWith("/turnos") && isHtml;
    const allowsSameOriginFrame =
      !isAgreementPreview && pathname.startsWith("/turnos");
    const allowsAgreementPreview = pathname.startsWith("/admin") && isHtml;
    const extraHeaders = isAgreementPreview
      ? agreementPreviewHeaders
      : allowsSameOriginFrame
        ? sameOriginFrameHeaders
        : allowsAgreementPreview
          ? adminAgreementPreviewHeaders
          : {};
    await serveFile(request, response, filePath, {
      cacheControl: isPrivateRoute ? "no-store" : "public, max-age=60",
      privateRoute: isPrivateRoute,
      extraHeaders,
      omitFrameOptions: isAgreementPreview,
    });
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
