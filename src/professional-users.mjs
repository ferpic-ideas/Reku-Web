export const PROFESSIONAL_PASSWORD_MIN_LENGTH = 8;

const professionalAccountError = (message, statusCode = 422) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

export const validateProfessionalPassword = (value, { required = false } = {}) => {
  const password = String(value || "");
  if (!password) {
    if (required) throw professionalAccountError("PROFESSIONAL_PASSWORD_REQUIRED");
    return "";
  }
  if (password.length < PROFESSIONAL_PASSWORD_MIN_LENGTH) {
    throw professionalAccountError("PROFESSIONAL_PASSWORD_INVALID");
  }
  return password;
};

const accountMatchesProfessional = (account, professionalId) =>
  Number(account?.professional_id) === Number(professionalId);

export const syncProfessionalUser = async (
  client,
  { professionalId, name, email, passwordHash = null },
) => {
  const normalizedEmail = String(email || "").toLowerCase();
  const accounts = await client.query(
    `
      SELECT id, email, role, professional_id, is_active
      FROM users
      WHERE professional_id = $1
         OR lower(email) = lower($2)
      ORDER BY id
      FOR UPDATE
    `,
    [professionalId, normalizedEmail],
  );
  const linkedAccount = accounts.rows.find((account) =>
    accountMatchesProfessional(account, professionalId),
  );
  const emailOwner = accounts.rows.find(
    (account) => String(account.email || "").toLowerCase() === normalizedEmail,
  );

  if (linkedAccount) {
    if (emailOwner && Number(emailOwner.id) !== Number(linkedAccount.id)) {
      throw professionalAccountError("PROFESSIONAL_EMAIL_IN_USE", 409);
    }
    if (!linkedAccount.is_active && !passwordHash) {
      throw professionalAccountError("PROFESSIONAL_PASSWORD_REQUIRED");
    }

    const result = await client.query(
      `
        UPDATE users
        SET email = $1,
            name = $2,
            password_hash = COALESCE($3, password_hash),
            role = 'professional',
            professional_id = $4,
            is_active = TRUE,
            session_version = session_version + CASE WHEN $3::text IS NULL THEN 0 ELSE 1 END,
            updated_at = NOW()
        WHERE id = $5
        RETURNING id, email, name, role, professional_id, is_active
      `,
      [normalizedEmail, name, passwordHash, professionalId, linkedAccount.id],
    );
    return {
      user: result.rows[0],
      action: linkedAccount.is_active ? "updated" : "reactivated",
    };
  }

  if (emailOwner?.is_active || emailOwner?.professional_id) {
    throw professionalAccountError("PROFESSIONAL_EMAIL_IN_USE", 409);
  }
  if (!passwordHash) {
    throw professionalAccountError("PROFESSIONAL_PASSWORD_REQUIRED");
  }

  if (emailOwner) {
    const result = await client.query(
      `
        UPDATE users
        SET email = $1,
            name = $2,
            password_hash = $3,
            role = 'professional',
            professional_id = $4,
            permissions = ARRAY[]::TEXT[],
            is_active = TRUE,
            session_version = session_version + 1,
            updated_at = NOW()
        WHERE id = $5
        RETURNING id, email, name, role, professional_id, is_active
      `,
      [normalizedEmail, name, passwordHash, professionalId, emailOwner.id],
    );
    return { user: result.rows[0], action: "reactivated" };
  }

  const result = await client.query(
    `
      INSERT INTO users (email, name, password_hash, role, professional_id)
      VALUES ($1, $2, $3, 'professional', $4)
      RETURNING id, email, name, role, professional_id, is_active
    `,
    [normalizedEmail, name, passwordHash, professionalId],
  );
  return { user: result.rows[0], action: "created" };
};
