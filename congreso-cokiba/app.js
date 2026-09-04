(() => {
  const isProfessionalSignup = ["/sumate", "/sumate/"].includes(window.location.pathname);
  const form = document.getElementById("congreso-form");
  const submitButton = document.getElementById("submit-button");
  const formStatus = document.getElementById("form-status");
  const successState = document.getElementById("success-state");
  const newResponseButton = document.getElementById("new-response-button");

  if (!form || !submitButton || !formStatus || !successState || !newResponseButton) {
    return;
  }

  if (isProfessionalSignup) {
    document.title = "Sumate a Reku | Profesionales";
    document.querySelector('meta[name="description"]')?.setAttribute(
      "content",
      "Formulario para profesionales que quieren sumarse a Reku.",
    );
    document.querySelector(".eyebrow").textContent = "Profesionales Reku";
    document.getElementById("page-title").textContent = "Sumate a Reku";
    document.querySelector(".intro-copy").textContent =
      "Completá tus datos, contanos cómo trabajás y conocé cómo formar parte de la red profesional de Reku.";
    form.action = "/sumate";
    form.querySelector('[name="reku-form"]').value = "sumate-profesional";
    submitButton.textContent = "Quiero sumarme";
    document.querySelector(".form-note").textContent =
      "Usaremos estos datos únicamente para evaluar tu perfil y contactarte sobre Reku.";
    successState.querySelector("h2").textContent = "¡Gracias por tu interés!";
    successState.querySelector("p").textContent =
      "Recibimos tus datos y nos pondremos en contacto a la brevedad.";
  }

  const requiredFields = ["nombre_apellido", "email", "telefono", "profesion"];
  const allFieldNames = [
    ...requiredFields,
    "ambito",
    "interes_telerehabilitacion",
    "interes_tecnologia",
    "comentario",
  ];
  const touched = new Set();
  const namePattern = /^[\p{L}]+(?:[ '-][\p{L}]+)*$/u;
  const phonePattern = /^[+()\d\s.-]+$/;
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  const controlsFor = (name) => [...form.querySelectorAll(`[name="${name}"]`)];

  const valueFor = (name) => {
    const controls = controlsFor(name);
    if (controls[0]?.type === "radio") {
      return controls.find((control) => control.checked)?.value || "";
    }
    return controls[0]?.value?.trim() || "";
  };

  const setStatus = (message = "", type = "") => {
    formStatus.textContent = message;
    formStatus.className = "form-status";
    if (type) formStatus.classList.add(`is-${type}`);
  };

  const setFieldError = (name, message = "") => {
    const controls = controlsFor(name);
    const wrapper =
      form.querySelector(`[data-field-name="${name}"]`) ||
      controls[0]?.closest(".field");
    const error = document.getElementById(`${name}-error`);
    controls.forEach((control) =>
      control.setAttribute("aria-invalid", message ? "true" : "false"),
    );
    wrapper?.classList.toggle("is-invalid", Boolean(message));
    if (error) error.textContent = message;
  };

  const validators = {
    nombre_apellido: () => {
      const value = valueFor("nombre_apellido");
      if (!value) return "Ingresá tu nombre y apellido.";
      if (value.length < 2) return "El nombre debe tener al menos 2 letras.";
      if (value.split(/\s+/).length < 2) return "Ingresá tu nombre y apellido.";
      if (!namePattern.test(value)) {
        return "Usá solo letras, espacios, apóstrofes o guiones.";
      }
      return "";
    },
    email: () => {
      const value = valueFor("email").toLowerCase();
      if (!value) return "Ingresá tu correo electrónico.";
      if (!emailPattern.test(value)) {
        return "Ingresá un correo válido, por ejemplo nombre@email.com.";
      }
      return "";
    },
    telefono: () => {
      const value = valueFor("telefono");
      const digits = value.replace(/\D/g, "");
      if (!value) return "Ingresá tu teléfono o WhatsApp.";
      if (!phonePattern.test(value) || digits.length < 8 || digits.length > 15) {
        return "Ingresá un número válido, con código de área.";
      }
      return "";
    },
    profesion: () =>
      valueFor("profesion") ? "" : "Seleccioná tu profesión o especialidad.",
  };

  const validateField = (name) => {
    const message = validators[name]?.() || "";
    setFieldError(name, message);
    return !message;
  };

  const validateForm = () => {
    let firstInvalid = "";
    requiredFields.forEach((name) => {
      if (!validateField(name) && !firstInvalid) firstInvalid = name;
    });
    controlsFor(firstInvalid)[0]?.focus();
    return !firstInvalid;
  };

  requiredFields.forEach((name) => {
    controlsFor(name).forEach((control) => {
      const eventName = control.type === "radio" ? "change" : "input";
      control.addEventListener("blur", () => {
        touched.add(name);
        validateField(name);
      });
      control.addEventListener(eventName, () => {
        if (touched.has(name) || control.getAttribute("aria-invalid") === "true") {
          validateField(name);
        }
      });
    });
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus();
    requiredFields.forEach((name) => touched.add(name));
    if (!validateForm()) return;

    form.querySelectorAll("input[type='text'], input[type='email'], input[type='tel'], textarea")
      .forEach((control) => {
        control.value = control.value.trim();
      });
    form.elements.email.value = form.elements.email.value.toLowerCase();

    submitButton.disabled = true;
    submitButton.textContent = "Enviando...";

    try {
      const response = await fetch(isProfessionalSignup ? "/sumate" : "/congreso-cokiba/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(new FormData(form)).toString(),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        if (payload.errors) {
          Object.entries(payload.errors).forEach(([name, message]) => {
            if (allFieldNames.includes(name)) setFieldError(name, message);
          });
        }
        throw new Error(payload.error || "No se pudo enviar el formulario.");
      }

      form.reset();
      allFieldNames.forEach((name) => setFieldError(name));
      touched.clear();
      form.hidden = true;
      successState.hidden = false;
      successState.focus();
    } catch (error) {
      setStatus(
        error.message || "No se pudo enviar el formulario. Probá de nuevo.",
        "error",
      );
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = isProfessionalSignup ? "Quiero sumarme" : "Registrarme";
    }
  });

  newResponseButton.addEventListener("click", () => {
    successState.hidden = true;
    form.hidden = false;
    setStatus();
    controlsFor("nombre_apellido")[0]?.focus();
  });
})();
