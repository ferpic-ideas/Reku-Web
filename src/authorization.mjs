const rolePermissions = Object.freeze({
  admin: ["*"],
  user: [
    "account.self",
    "dashboard.read",
    "agreements.read",
    "services.read",
    "professionals.read",
    "schedule_blocks.read",
    "appointments.read",
  ],
  professional: [
    "professional.account.self",
    "professional.profile.read_self",
    "professional.profile.write_self",
    "professional.availability.read_self",
    "professional.availability.write_self",
    "professional.blocks.read_self",
    "professional.blocks.write_self",
    "professional.patients.read_self",
    "professional.appointments.read_self",
    "professional.appointments.cancel_self",
    "professional.appointments.triage_remind_self",
    "professional.notifications.manage_self",
    "professional.integrations.google.manage_self",
  ],
});

const routeRules = [
  ["GET", /^\/api\/admin\/auth\/me$/, "account.self"],
  ["POST", /^\/api\/admin\/auth\/logout$/, "account.self"],
  ["POST", /^\/api\/admin\/auth\/change-password$/, "account.self"],
  ["GET", /^\/api\/admin\/users$/, "users.read"],
  ["POST", /^\/api\/admin\/users$/, "users.write"],
  ["DELETE", /^\/api\/admin\/users\/\d+$/, "users.write"],
  ["GET", /^\/api\/admin\/dashboard$/, "dashboard.read"],
  ["GET", /^\/api\/admin\/agreements$/, "agreements.read"],
  ["POST", /^\/api\/admin\/agreements$/, "agreements.write"],
  ["GET", /^\/api\/admin\/agreements\/\d+\/qr$/, "agreements.read"],
  [
    "GET",
    /^\/api\/admin\/agreements\/\d+\/api-credentials$/,
    "agreements.write",
  ],
  [
    "POST",
    /^\/api\/admin\/agreements\/\d+\/api-credentials$/,
    "agreements.write",
  ],
  [
    "POST",
    /^\/api\/admin\/agreements\/\d+\/api-credentials\/\d+\/revoke$/,
    "agreements.write",
  ],
  ["PUT", /^\/api\/admin\/agreements\/\d+$/, "agreements.write"],
  ["DELETE", /^\/api\/admin\/agreements\/\d+$/, "agreements.delete"],
  ["GET", /^\/api\/admin\/services$/, "services.read"],
  ["POST", /^\/api\/admin\/services$/, "services.write"],
  ["PUT", /^\/api\/admin\/services\/\d+$/, "services.write"],
  ["DELETE", /^\/api\/admin\/services\/\d+$/, "services.delete"],
  ["GET", /^\/api\/admin\/professionals$/, "professionals.read"],
  ["POST", /^\/api\/admin\/professionals$/, "professionals.write"],
  ["POST", /^\/api\/admin\/professionals\/invite$/, "professionals.write"],
  ["PUT", /^\/api\/admin\/professionals\/\d+$/, "professionals.write"],
  ["DELETE", /^\/api\/admin\/professionals\/\d+$/, "professionals.delete"],
  [
    "POST",
    /^\/api\/admin\/professionals\/\d+\/notifications$/,
    "professionals.write",
  ],
  [
    "POST",
    /^\/api\/admin\/professionals\/\d+\/invite$/,
    "professionals.write",
  ],
  [
    "POST",
    /^\/api\/admin\/professionals\/\d+\/revoke-access$/,
    "professionals.revoke_access",
  ],
  ["GET", /^\/api\/admin\/schedule-blocks$/, "schedule_blocks.read"],
  ["POST", /^\/api\/admin\/schedule-blocks$/, "schedule_blocks.write"],
  ["DELETE", /^\/api\/admin\/schedule-blocks\/\d+$/, "schedule_blocks.delete"],
  ["GET", /^\/api\/admin\/appointments$/, "appointments.read"],
  ["GET", /^\/api\/admin\/appointment-documents\/\d+$/, "appointments.read"],
  ["HEAD", /^\/api\/admin\/appointment-documents\/\d+$/, "appointments.read"],
  ["GET", /^\/api\/admin\/appointments\/\d+\/slots$/, "appointments.write"],
  ["PUT", /^\/api\/admin\/appointments\/\d+$/, "appointments.write"],
  ["POST", /^\/api\/admin\/appointments\/\d+\/cancel$/, "appointments.write"],
  ["GET", /^\/api\/admin\/settlements\/preview$/, "settlements.read"],
  ["POST", /^\/api\/admin\/settlements$/, "settlements.write"],
  ["GET", /^\/api\/admin\/settlements\/\d+\/pdf$/, "settlements.read"],
  ["POST", /^\/api\/admin\/booking-links\/test$/, "booking_links.create"],
  ["GET", /^\/api\/admin\/settings\/mercado-pago$/, "settings.read"],
  ["PUT", /^\/api\/admin\/settings\/mercado-pago$/, "settings.write"],
  ["GET", /^\/api\/admin\/audit$/, "audit.read"],
  ["GET", /^\/api\/admin\/patient-intakes$/, "patient_intakes.read"],
  ["DELETE", /^\/api\/admin\/patient-intakes\/\d+$/, "records.delete"],
  ["GET", /^\/api\/admin\/patients$/, "patient_intakes.read"],
  ["DELETE", /^\/api\/admin\/patients\/\d+$/, "records.delete"],
  ["GET", /^\/api\/admin\/contacts$/, "contacts.read"],
  ["DELETE", /^\/api\/admin\/contacts\/\d+$/, "records.delete"],
  ["GET", /^\/api\/admin\/congress-registrations$/, "contacts.read"],
  ["GET", /^\/api\/admin\/congress-registrations\.csv$/, "contacts.read"],
  [
    "DELETE",
    /^\/api\/admin\/congress-registrations\/\d+$/,
    "records.delete",
  ],
  ["GET", /^\/api\/admin\/nomina$/, "nomina.read"],
  ["POST", /^\/api\/admin\/nomina$/, "nomina.write"],
  ["POST", /^\/api\/admin\/nomina\/import$/, "nomina.write"],
  ["DELETE", /^\/api\/admin\/nomina\/\d+$/, "nomina.delete"],
];

const professionalRouteRules = [
  ["GET", /^\/api\/professional\/auth\/me$/, "professional.account.self"],
  ["POST", /^\/api\/professional\/auth\/logout$/, "professional.account.self"],
  [
    "POST",
    /^\/api\/professional\/auth\/change-password$/,
    "professional.account.self",
  ],
  ["GET", /^\/api\/professional\/profile$/, "professional.profile.read_self"],
  ["PUT", /^\/api\/professional\/profile$/, "professional.profile.write_self"],
  [
    "GET",
    /^\/api\/professional\/notifications\/push$/,
    "professional.notifications.manage_self",
  ],
  [
    "POST",
    /^\/api\/professional\/notifications\/push\/(subscriptions|subscriptions\/check|test|activation-email)$/,
    "professional.notifications.manage_self",
  ],
  [
    "DELETE",
    /^\/api\/professional\/notifications\/push\/subscriptions(?:\/\d+)?$/,
    "professional.notifications.manage_self",
  ],
  [
    "GET",
    /^\/api\/professional\/integrations\/google$/,
    "professional.integrations.google.manage_self",
  ],
  [
    "POST",
    /^\/api\/professional\/integrations\/google\/(connect|disconnect)$/,
    "professional.integrations.google.manage_self",
  ],
  [
    "GET",
    /^\/api\/professional\/availability$/,
    "professional.availability.read_self",
  ],
  [
    "PUT",
    /^\/api\/professional\/availability$/,
    "professional.availability.write_self",
  ],
  ["GET", /^\/api\/professional\/blocks$/, "professional.blocks.read_self"],
  ["POST", /^\/api\/professional\/blocks$/, "professional.blocks.write_self"],
  [
    "DELETE",
    /^\/api\/professional\/blocks\/\d+$/,
    "professional.blocks.write_self",
  ],
  [
    "GET",
    /^\/api\/professional\/patients$/,
    "professional.patients.read_self",
  ],
  [
    "GET",
    /^\/api\/professional\/appointments$/,
    "professional.appointments.read_self",
  ],
  [
    "GET|HEAD",
    /^\/api\/professional\/appointment-documents\/\d+$/,
    "professional.appointments.read_self",
  ],
  [
    "POST",
    /^\/api\/professional\/appointments\/\d+\/cancel$/,
    "professional.appointments.cancel_self",
  ],
  [
    "POST",
    /^\/api\/professional\/appointments\/\d+\/triage-reminder$/,
    "professional.appointments.triage_remind_self",
  ],
];

export const permissionsForRole = (role) => [
  ...(rolePermissions[String(role || "").toLowerCase()] || []),
];

export const permissionsForUser = (user) => {
  const roleBased = permissionsForRole(user?.role);
  if (roleBased.includes("*")) return ["*"];
  const explicit = Array.isArray(user?.permissions)
    ? user.permissions.filter((permission) => permission && permission !== "*")
    : [];
  return [...new Set([...roleBased, ...explicit].filter(Boolean))];
};

export const hasPermission = (user, permission) => {
  const permissions = permissionsForUser(user);
  return permissions.includes("*") || permissions.includes(permission);
};

export const requiredPermissionForRequest = (method, pathname) => {
  const normalizedMethod = String(method || "").toUpperCase();
  const rule = routeRules.find(
    ([allowedMethod, pattern]) =>
      allowedMethod === normalizedMethod && pattern.test(pathname),
  );
  return rule?.[2] || null;
};

export const requiredProfessionalPermissionForRequest = (method, pathname) => {
  const normalizedMethod = String(method || "").toUpperCase();
  const rule = professionalRouteRules.find(
    ([allowedMethods, pattern]) =>
      allowedMethods.split("|").includes(normalizedMethod) && pattern.test(pathname),
  );
  return rule?.[2] || null;
};

export const requireAdminApiPermission = (user, method, pathname) => {
  const permission = requiredPermissionForRequest(method, pathname);
  if (!permission || !hasPermission(user, permission)) {
    const error = new Error("PERMISSION_DENIED");
    error.statusCode = 403;
    throw error;
  }
  return permission;
};

export const requireProfessionalApiPermission = (user, method, pathname) => {
  const permission = requiredProfessionalPermissionForRequest(method, pathname);
  if (!permission || !hasPermission(user, permission)) {
    const error = new Error("PERMISSION_DENIED");
    error.statusCode = 403;
    throw error;
  }
  return permission;
};
