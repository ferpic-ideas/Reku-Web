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
} from "./src/config.mjs";
import { initDb } from "./src/db.mjs";
import { handleFormSubmission } from "./src/forms.mjs";
import { sendJson, sendRedirect, serveStatic, sendText } from "./src/http.mjs";

assertSafeStartup();
await ensureRuntimeDirectories();
await initDb();

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const { pathname } = requestUrl;

  try {
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

    if (request.method === "POST") {
      await handleFormSubmission(request, response);
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      if (
        ["/alta-pacientes", "/alta-pacientes/"].includes(pathname) &&
        !(await validatePublicAgreementRoute(requestUrl, response))
      ) {
        return;
      }

      if (pathname.startsWith("/api/")) {
        sendJson(response, 404, { error: "Endpoint no encontrado." });
        return;
      }

      const isAgendaPage =
        pathname === "/agenda" ||
        (pathname.startsWith("/agenda/") && !pathname.slice("/agenda/".length).includes("."));
      const isAdminPage =
        pathname === "/admin/" ||
        (pathname.startsWith("/admin/") && !pathname.slice("/admin/".length).includes("."));
      const staticPath =
        pathname === "/"
          ? "/index.html"
          : isAgendaPage
            ? "/agenda/index.html"
            : isAdminPage
              ? "/admin/index.html"
              : pathname;
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
