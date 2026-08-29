import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const flushAsyncWork = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

test("admin loads only the active module data and reuses fresh references", async () => {
  const source = await readFile(
    new URL("../admin/app.js", import.meta.url),
    "utf8",
  );
  const requests = [];
  const currentMonth = new Date().toISOString().slice(0, 7);
  const moduleHandlers = new Map();
  let html = "";

  class Element {}
  class HTMLAnchorElement extends Element {
    constructor(module) {
      super();
      this.dataset = { module };
      this.search = "";
    }

    addEventListener(event, handler) {
      if (event === "click") moduleHandlers.set(this.dataset.module, handler);
    }
  }

  const moduleLinks = [
    "dashboard",
    "agreements",
    "nomina",
    "services",
    "professionals",
    "blocks",
    "booking-test",
    "appointments",
    "settlements",
    "patient-intakes",
    "contacts",
    "users",
    "config",
    "audit",
  ].map((module) => new HTMLAnchorElement(module));
  const app = {
    className: "",
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = value;
    },
  };
  const document = {
    getElementById(id) {
      return id === "app" ? app : null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      return selector === "[data-module]" ? moduleLinks : [];
    },
    addEventListener() {},
  };
  const location = {
    origin: "https://www.reku.io",
    pathname: "/admin/",
    search: "",
  };
  const window = {
    location,
    history: {
      pushState(_state, _title, nextLocation) {
        const url = new URL(nextLocation, location.origin);
        location.pathname = url.pathname;
        location.search = url.search;
      },
      replaceState(_state, _title, nextLocation) {
        const url = new URL(nextLocation, location.origin);
        location.pathname = url.pathname;
        location.search = url.search;
      },
    },
    addEventListener() {},
  };
  const jsonResponse = (payload) => ({
    ok: true,
    status: 200,
    async json() {
      return payload;
    },
  });
  const fetch = async (path) => {
    requests.push(path);
    if (path === "/api/admin/auth/me") {
      return jsonResponse({
        user: {
          id: 1,
          name: "Admin",
          email: "admin@example.com",
          permissions: ["*"],
          can_manage_system: true,
        },
        csrf_token: "csrf",
      });
    }
    if (path === "/api/admin/dashboard") {
      return jsonResponse({ dashboard: {} });
    }
    if (path.startsWith("/api/admin/appointments")) {
      return jsonResponse({ appointments: [], pagination: { has_more: false } });
    }
    if (path === "/api/admin/professionals") {
      return jsonResponse({ professionals: [] });
    }
    if (path === "/api/admin/agreements") {
      return jsonResponse({
        agreements: [{ id: 1, name: "Convenio", type: "Pago", slug: "convenio" }],
      });
    }
    if (path === "/api/admin/services") {
      return jsonResponse({ services: [] });
    }
    if (path.startsWith("/api/admin/patients")) {
      return jsonResponse({ patients: [], pagination: { has_more: false } });
    }
    if (path.startsWith("/api/admin/nomina")) {
      return jsonResponse({ nomina_entries: [], pagination: { has_more: false } });
    }
    if (path.startsWith("/api/admin/schedule-blocks")) {
      return jsonResponse({ schedule_blocks: [], pagination: { has_more: false } });
    }
    if (path.startsWith("/api/admin/contacts")) {
      return jsonResponse({ contacts: [], pagination: { has_more: false } });
    }
    if (path.startsWith("/api/admin/congress-registrations")) {
      return jsonResponse({
        congress_registrations: [],
        pagination: { has_more: false },
      });
    }
    if (path.startsWith("/api/admin/settlements/preview")) {
      return jsonResponse({
        settlement: {
          totals: { appointments: 0, cancelled: 0, amount: 0 },
          appointments: [],
          generated_settlement: null,
        },
      });
    }
    if (path === "/api/admin/users") {
      return jsonResponse({ users: [] });
    }
    if (path === "/api/admin/settings/mercado-pago") {
      return jsonResponse({ settings: {} });
    }
    if (path.startsWith("/api/admin/audit")) {
      return jsonResponse({ audit_events: [], pagination: { has_more: false } });
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  vm.runInNewContext(source, {
    console,
    Date,
    document,
    Element,
    fetch,
    FormData,
    HTMLAnchorElement,
    Intl,
    navigator: { clipboard: { writeText: async () => {} } },
    URL,
    URLSearchParams,
    window,
  });
  await flushAsyncWork();

  assert.deepEqual(new Set(requests), new Set([
    "/api/admin/auth/me",
    "/api/admin/dashboard",
    "/api/admin/appointments?page=1&page_size=8",
    "/api/admin/professionals",
  ]));

  const clickModule = async (module) => {
    const before = requests.length;
    moduleHandlers.get(module)({
      preventDefault() {},
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    });
    await flushAsyncWork();
    return requests.slice(before);
  };

  assert.deepEqual(await clickModule("services"), ["/api/admin/services"]);
  assert.deepEqual(new Set(await clickModule("contacts")), new Set([
    "/api/admin/contacts?page=1&page_size=500",
    "/api/admin/congress-registrations?page=1&page_size=500",
  ]));
  assert.deepEqual(await clickModule("appointments"), [
    "/api/admin/appointments?page=1&page_size=500",
  ]);
  assert.deepEqual(await clickModule("agreements"), ["/api/admin/agreements"]);
  assert.deepEqual(await clickModule("nomina"), [
    "/api/admin/nomina?page=1&page_size=500",
  ]);
  assert.deepEqual(await clickModule("patient-intakes"), [
    "/api/admin/patients?page=1&page_size=500",
  ]);
  assert.deepEqual(await clickModule("professionals"), [
    "/api/admin/professionals",
  ]);
  assert.deepEqual(await clickModule("blocks"), [
    "/api/admin/schedule-blocks?page=1&page_size=500",
  ]);
  assert.deepEqual(await clickModule("booking-test"), []);
  assert.deepEqual(await clickModule("settlements"), [
    `/api/admin/settlements/preview?agreement_id=1&month=${currentMonth}`,
  ]);
  assert.deepEqual(await clickModule("users"), ["/api/admin/users"]);
  assert.deepEqual(await clickModule("config"), [
    "/api/admin/settings/mercado-pago",
  ]);
  assert.deepEqual(await clickModule("audit"), [
    "/api/admin/audit?page=1&page_size=500",
  ]);
});
