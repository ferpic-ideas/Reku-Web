const calendarDate = (value) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("APPOINTMENT_CALENDAR_DATE_INVALID");
  }
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
};

const escapeCalendarText = (value) =>
  String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");

const appointmentSummary = (appointment) => {
  const serviceName = String(
    appointment.service_name || appointment.service?.name || "Turno",
  ).trim();
  const professionalName = String(
    appointment.professional_name || appointment.professional?.name || "",
  ).trim();
  return professionalName
    ? `${serviceName} con ${professionalName} · Reku`
    : `${serviceName} · Reku`;
};

const appointmentDescription = (manageUrl) =>
  [
    "Accedé a la videollamada y gestioná tu turno desde Reku:",
    manageUrl,
    "",
    "El acceso a la videollamada se habilita únicamente dentro del horario permitido.",
  ].join("\n");

const googleCalendarDate = (date, time) => {
  const dateValue = String(date || "");
  const timeValue = String(time || "").slice(0, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue) || !/^\d{2}:\d{2}$/.test(timeValue)) {
    throw new Error("APPOINTMENT_CALENDAR_DATE_INVALID");
  }
  return `${dateValue.replace(/-/g, "")}T${timeValue.replace(":", "")}00`;
};

const foldCalendarLine = (line) => {
  const chunks = [];
  let current = "";
  for (const character of String(line)) {
    const limit = chunks.length ? 74 : 75;
    if (Buffer.byteLength(current + character, "utf8") > limit) {
      chunks.push(current);
      current = ` ${character}`;
    } else {
      current += character;
    }
  }
  chunks.push(current);
  return chunks.join("\r\n");
};

export const patientCalendarActionUrl = (manageUrl) => {
  const value = String(manageUrl || "").trim();
  if (!value) return "";
  const separator = value.includes("#") ? "&" : "#";
  return `${value}${separator}calendar=1`;
};

export const isGoogleCalendarEmail = (email) =>
  /@(gmail|googlemail)\.com$/i.test(String(email || "").trim());

export const googleCalendarTemplateUrl = ({
  appointment,
  manageUrl,
  timeZone = "America/Argentina/Buenos_Aires",
}) => {
  const date = appointment.appointment_date || appointment.date;
  const startTime = appointment.start_time;
  const endTime = appointment.end_time;
  const url = new URL("https://calendar.google.com/calendar/render");
  url.searchParams.set("action", "TEMPLATE");
  url.searchParams.set("text", appointmentSummary(appointment));
  url.searchParams.set(
    "dates",
    `${googleCalendarDate(date, startTime)}/${googleCalendarDate(date, endTime)}`,
  );
  url.searchParams.set("details", appointmentDescription(manageUrl));
  url.searchParams.set("location", "Videollamada online");
  url.searchParams.set("ctz", timeZone);
  return url.toString();
};

export const appointmentCalendarFilename = (appointment) =>
  `turno-reku-${String(appointment.appointment_date || appointment.date || "")
    .replace(/[^0-9-]/g, "") || "cita"}.ics`;

export const appointmentCalendarContent = ({
  appointment,
  manageUrl,
  generatedAt = new Date(),
}) => {
  const summary = appointmentSummary(appointment);
  const description = appointmentDescription(manageUrl);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Reku//Turnos//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:appointment-${Number(appointment.id)}@reku.io`,
    `DTSTAMP:${calendarDate(generatedAt)}`,
    `DTSTART:${calendarDate(appointment.starts_at)}`,
    `DTEND:${calendarDate(appointment.ends_at)}`,
    `SEQUENCE:${Math.max(0, Number(appointment.reschedule_count || 0))}`,
    "STATUS:CONFIRMED",
    `SUMMARY:${escapeCalendarText(summary)}`,
    `DESCRIPTION:${escapeCalendarText(description)}`,
    `URL:${escapeCalendarText(manageUrl)}`,
    "LOCATION:Videollamada online",
    "BEGIN:VALARM",
    "TRIGGER:-PT24H",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeCalendarText(`Recordatorio: ${summary}`)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldCalendarLine).join("\r\n")}\r\n`;
};
