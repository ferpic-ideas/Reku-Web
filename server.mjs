import { createServer } from "node:http";
import {
  handleAdminApi,
  handlePublicAgreementApi,
  validatePublicAgreementRoute,
} from "./src/admin-api.mjs";
import { handleBookingApi } from "./src/booking-api.mjs";
import { handleProfessionalApi } from "./src/professional-api.mjs";
import {
  assertSafeStartup,
  config,
  ensureRuntimeDirectories,
  isProduction,
} from "./src/config.mjs";
import { initDb } from "./src/db.mjs";
import { handleFormSubmission } from "./src/forms.mjs";
import { handleHealth } from "./src/health.mjs";
import { cleanupExpiredGoogleCalendarHolds } from "./src/google-calendar.mjs";
import {
  retryPendingPaymentNotifications,
  retryPendingGoogleAppointmentNotifications,
  sendUpcomingAppointmentFollowups,
} from "./src/appointment-notifications.mjs";
import {
  sendJson,
  sendRedirect,
  servePublicUpload,
  serveStatic,
  sendText,
  resolveStaticRequestPath,
} from "./src/http.mjs";
import { agreementPrefixForRequest } from "./src/agreement-resolution.mjs";

assertSafeStartup();
await ensureRuntimeDirectories();
await initDb();

const runCalendarMaintenance = () =>
  Promise.all([
    cleanupExpiredGoogleCalendarHolds(),
    retryPendingPaymentNotifications(),
    retryPendingGoogleAppointmentNotifications(),
    sendUpcomingAppointmentFollowups(),
  ]).catch((error) => {
    console.error("Google Calendar maintenance failed", { message: error.message });
  });
runCalendarMaintenance();
const calendarCleanupTimer = setInterval(runCalendarMaintenance, 5 * 60 * 1000);
calendarCleanupTimer.unref();

const isAgreementHostPath = (pathname) =>
  pathname === "/" ||
  pathname === "/agenda" ||
  pathname.startsWith("/agenda/") ||
  pathname.startsWith("/api/booking/") ||
  pathname.startsWith("/uploads/") ||
  pathname === "/images/logo-reku.svg" ||
  pathname === "/favicon-32x32.png";

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const { pathname } = requestUrl;
  const agreementPrefix = agreementPrefixForRequest(request);

  try {
    if (
      pathname === "/healthz" &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (
      pathname === "/health" &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      await handleHealth(response);
      return;
    }

    if (isProduction) {
      const canonicalUrl = new URL(config.appPublicUrl);
      const isCanonicalHost =
        requestUrl.host.toLowerCase() === canonicalUrl.host.toLowerCase();
      if (!isCanonicalHost && !agreementPrefix) {
        sendRedirect(
          response,
          `${config.appPublicUrl}${pathname}${requestUrl.search}`,
          308,
        );
        return;
      }
      if (agreementPrefix && !isAgreementHostPath(pathname)) {
        sendRedirect(
          response,
          `${config.appPublicUrl}${pathname}${requestUrl.search}`,
          308,
        );
        return;
      }
    }

    if (
      agreementPrefix &&
      pathname === "/" &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      sendRedirect(response, `/agenda/${requestUrl.search}`, 308);
      return;
    }

    if (
      (request.method === "GET" || request.method === "HEAD") &&
      ["/congreso-coquiba", "/congreso-coquiba/"].includes(pathname)
    ) {
      sendRedirect(response, `/congreso-cokiba${requestUrl.search}`, 308);
      return;
    }

    if (pathname === "/admin" && (request.method === "GET" || request.method === "HEAD")) {
      sendRedirect(response, "/admin/", 308);
      return;
    }

    if (
      pathname.startsWith("/api/public/agreements/") &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      await handlePublicAgreementApi(request, response, requestUrl);
      return;
    }

    if (pathname.startsWith("/api/admin/")) {
      const handled = await handleAdminApi(request, response, requestUrl);
      if (!handled) {
        sendJson(response, 404, { error: "Endpoint no encontrado." });
      }
      return;
    }

    if (pathname.startsWith("/api/booking/")) {
      const handled = await handleBookingApi(request, response, requestUrl);
      if (!handled) {
        sendJson(response, 404, { error: "Endpoint no encontrado." });
      }
      return;
    }

    if (pathname.startsWith("/api/professional/")) {
      const handled = await handleProfessionalApi(request, response, requestUrl);
      if (!handled) {
        sendJson(response, 404, { error: "Endpoint no encontrado." });
      }
      return;
    }

    if (pathname.startsWith("/uploads/")) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendText(response, 405, "Method not allowed");
        return;
      }
      await servePublicUpload(request, response, pathname);
      return;
    }

    if (
      request.method === "POST" &&
      ["/", "/congreso-cokiba", "/congreso-cokiba/"].includes(pathname)
    ) {
      await handleFormSubmission(request, response);
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      if (pathname === "/alta-pacientes" || pathname.startsWith("/alta-pacientes/")) {
        const slug = String(requestUrl.searchParams.get("form") || "").trim();
        sendRedirect(
          response,
          slug ? `/agenda/?form=${encodeURIComponent(slug)}` : "/agenda/",
          308,
        );
        return;
      }

      if (
        (pathname === "/agenda" || pathname === "/agenda/") &&
        !(await validatePublicAgreementRoute(request, requestUrl, response))
      ) {
        return;
      }

      if (pathname.startsWith("/api/")) {
        sendJson(response, 404, { error: "Endpoint no encontrado." });
        return;
      }

      const staticPath = resolveStaticRequestPath(pathname);
      await serveStatic(request, response, staticPath);
      return;
    }

    sendText(response, 405, "Method not allowed");
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode || 500, { error: "Error inesperado." });
  }
});

server.listen(config.port, () => {
  console.log(`Reku Web listening on http://localhost:${config.port}`);
});
