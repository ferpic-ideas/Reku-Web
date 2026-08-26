import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const flushAsyncWork = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

test("intake continues directly to services when email verification is disabled", async () => {
  const source = await readFile(
    new URL("../agenda/app.js", import.meta.url),
    "utf8",
  );
  let html = "";
  let submitHandler = null;
  const app = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = value;
    },
    querySelector(selector) {
      if (
        selector === "#booking-intake-form" &&
        html.includes('id="booking-intake-form"')
      ) {
        return {
          addEventListener(event, handler) {
            if (event === "submit") submitHandler = handler;
          },
        };
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const window = {
    location: {
      search: "?form=demo",
      hash: "",
      href: "https://www.reku.io/turnos/?form=demo",
    },
    history: {
      replaceState() {},
    },
  };
  window.self = window;
  window.top = window;
  const jsonResponse = (payload, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  });
  const fetch = async (path) => {
    if (String(path).startsWith("/api/booking/agreement")) {
      return jsonResponse({
        agreement: {
          id: 1,
          name: "Demo",
          slug: "demo",
          type: "Pago",
          logo_url: "",
          pdf_url: "",
        },
      });
    }
    if (path === "/api/booking/intake") {
      return jsonResponse(
        {
          ok: true,
          verification_required: false,
          patient: {
            name: "Test Reku",
            email: "test@example.com",
            phone: "1111111111",
          },
          agreement: {
            id: 1,
            name: "Demo",
            slug: "demo",
            type: "Pago",
          },
        },
        201,
      );
    }
    if (path === "/api/booking/services") {
      return jsonResponse({
        patient: {
          name: "Test Reku",
          email: "test@example.com",
          phone: "1111111111",
        },
        agreement: {
          id: 1,
          name: "Demo",
          slug: "demo",
          type: "Pago",
        },
        payment_required: true,
        services: [],
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  vm.runInNewContext(source, {
    console,
    Date,
    FormData: class {
      entries() {
        return Object.entries({
          nombre: "Test",
          apellido: "Reku",
          telefono: "1111111111",
          email: "test@example.com",
          identificador: "",
        });
      }
    },
    Intl,
    Number,
    Object,
    String,
    URL,
    URLSearchParams,
    document: {
      getElementById() {
        return app;
      },
    },
    fetch,
    window,
  });

  await flushAsyncWork();
  assert.equal(typeof submitHandler, "function");
  assert.doesNotMatch(html, /class="stepper"/);

  await submitHandler({
    preventDefault() {},
    currentTarget: {},
  });
  await flushAsyncWork();

  const stepper = html.match(
    /<div class="stepper">([\s\S]*?)<\/div>\s*<\/header>/,
  )?.[1];
  assert.ok(stepper);
  assert.equal((stepper.match(/<span>✓<\/span>/g) || []).length, 1);
  for (const pendingStep of [2, 3, 4, 5]) {
    assert.match(stepper, new RegExp(`<span>${pendingStep}</span>`));
  }
  assert.match(html, /Elegí tu servicio/);
  assert.doesNotMatch(html, /Revisá tu mail/);
});
