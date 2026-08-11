(() => {
  const form = document.getElementById("congreso-form");
  const submitButton = document.getElementById("submit-button");
  const formStatus = document.getElementById("form-status");
  const successState = document.getElementById("success-state");
  const newResponseButton = document.getElementById("new-response-button");

  if (!form || !submitButton || !formStatus || !successState || !newResponseButton) {
    return;
  }

  const fields = {
    nombre: form.elements.nombre,
    apellido: form.elements.apellido,
    profesion: form.elements.profesion,
    telefono: form.elements.telefono,
    email: form.elements.email,
  };
  const touched = new Set();
  const namePattern = /^[\p{L}]+(?:[ '-][\p{L}]+)*$/u;
  const phonePattern = /^[+()\d\s.-]+$/;
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  const setStatus = (message = "", type = "") => {
    formStatus.textContent = message;
    formStatus.className = "form-status";
    if (type) formStatus.classList.add(`is-${type}`);
  };

  const setFieldError = (field, message = "") => {
    const wrapper = field.closest(".field");
    const error = document.getElementById(`${field.name}-error`);
    field.setAttribute("aria-invalid", message ? "true" : "false");
    wrapper?.classList.toggle("is-invalid", Boolean(message));
    if (error) error.textContent = message;
  };

  const validateName = (field, label) => {
    const value = field.value.trim();
    if (!value) return `Ingresá tu ${label}.`;
    if (value.length < 2) return `El ${label} debe tener al menos 2 letras.`;
    if (!namePattern.test(value)) {
      return "Usá solo letras, espacios, apóstrofes o guiones.";
    }
    return "";
  };

  const validators = {
    nombre: (field) => validateName(field, "nombre"),
    apellido: (field) => validateName(field, "apellido"),
    profesion: (field) => {
      const value = field.value.trim();
      if (!value) return "Ingresá tu profesión.";
      if (value.length < 2 || value.length > 100) {
        return "Ingresá una profesión válida.";
      }
      return "";
    },
    telefono: (field) => {
      const value = field.value.trim();
      const digits = value.replace(/\D/g, "");
      if (!value) return "Ingresá tu celular.";
      if (!phonePattern.test(value) || digits.length < 8 || digits.length > 15) {
        return "Ingresá un celular válido, con código de área.";
      }
      return "";
    },
    email: (field) => {
      const value = field.value.trim().toLowerCase();
      if (!value) return "Ingresá tu mail.";
      if (!emailPattern.test(value)) {
        return "Ingresá un mail válido, por ejemplo nombre@email.com.";
      }
      return "";
    },
  };

  const validateField = (field) => {
    const message = validators[field.name]?.(field) || "";
    setFieldError(field, message);
    return !message;
  };

  const validateForm = () => {
    let firstInvalid = null;
    Object.values(fields).forEach((field) => {
      if (!validateField(field) && !firstInvalid) firstInvalid = field;
    });
    firstInvalid?.focus();
    return !firstInvalid;
  };

  Object.values(fields).forEach((field) => {
    field.addEventListener("blur", () => {
      touched.add(field.name);
      validateField(field);
    });
    field.addEventListener("input", () => {
      if (touched.has(field.name) || field.getAttribute("aria-invalid") === "true") {
        validateField(field);
      }
    });
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus();
    Object.keys(fields).forEach((name) => touched.add(name));
    if (!validateForm()) return;

    Object.values(fields).forEach((field) => {
      field.value = field.value.trim();
    });
    fields.email.value = fields.email.value.toLowerCase();

    submitButton.disabled = true;
    submitButton.textContent = "Enviando...";

    try {
      const response = await fetch("/congreso-cokiba/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(new FormData(form)).toString(),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        if (payload.errors) {
          Object.entries(payload.errors).forEach(([name, message]) => {
            if (fields[name]) setFieldError(fields[name], message);
          });
        }
        throw new Error(payload.error || "No se pudo enviar el formulario.");
      }

      form.reset();
      Object.values(fields).forEach((field) => setFieldError(field));
      touched.clear();
      form.hidden = true;
      successState.hidden = false;
      successState.focus();
    } catch (error) {
      setStatus(error.message || "No se pudo enviar el formulario. Probá de nuevo.", "error");
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Enviar";
    }
  });

  newResponseButton.addEventListener("click", () => {
    successState.hidden = true;
    form.hidden = false;
    setStatus();
    fields.nombre.focus();
  });
})();
