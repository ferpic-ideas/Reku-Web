import pg from "pg";
import { config } from "./config.mjs";
import { hashPassword } from "./security.mjs";
import { defaultPatientBody, defaultPatientSubject } from "./templates.mjs";

const { Pool } = pg;

export const pool = config.databaseUrl
  ? new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
  : null;

export const ensureDb = () => {
  if (!pool) {
    const error = new Error("DB_UNAVAILABLE");
    error.statusCode = 503;
    throw error;
  }
  return pool;
};

export const query = async (text, params = []) => ensureDb().query(text, params);

export const one = async (text, params = []) => {
  const result = await query(text, params);
  return result.rows[0] || null;
};

export const tx = async (callback) => {
  const client = await ensureDb().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const initDb = async () => {
  if (!pool) {
    console.warn("DATABASE_URL not configured; DB-backed features are disabled.");
    return;
  }

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      session_version INTEGER NOT NULL DEFAULT 1,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key
      ON users (lower(email));

    CREATE TABLE IF NOT EXISTS agreements (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      logo_path TEXT,
      pdf_path TEXT,
      cobranded BOOLEAN NOT NULL DEFAULT FALSE,
      type TEXT NOT NULL CHECK (type IN ('Pago', 'Nomina')),
      payment_evaluation_url TEXT,
      payment_treatment_url TEXT,
      email_subject_template TEXT NOT NULL DEFAULT '${defaultPatientSubject.replaceAll("'", "''")}',
      email_body_template TEXT NOT NULL DEFAULT '${defaultPatientBody.replaceAll("'", "''")}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    );

    CREATE UNIQUE INDEX IF NOT EXISTS agreements_slug_active_key
      ON agreements (lower(slug))
      WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS nomina_entries (
      id BIGSERIAL PRIMARY KEY,
      agreement_id BIGINT NOT NULL REFERENCES agreements(id),
      nombre TEXT,
      apellido TEXT,
      identificador TEXT NOT NULL,
      identificador_normalized TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE nomina_entries
      ADD COLUMN IF NOT EXISTS identificador_normalized TEXT;

    UPDATE nomina_entries
      SET identificador_normalized = lower(identificador)
      WHERE identificador_normalized IS NULL
         OR identificador_normalized = '';

    ALTER TABLE nomina_entries
      ALTER COLUMN identificador_normalized SET NOT NULL;

    DROP INDEX IF EXISTS nomina_entries_agreement_identifier_key;

    CREATE UNIQUE INDEX nomina_entries_agreement_identifier_key
      ON nomina_entries (agreement_id, identificador_normalized);

    CREATE TABLE IF NOT EXISTS patient_intakes (
      id BIGSERIAL PRIMARY KEY,
      agreement_id BIGINT REFERENCES agreements(id),
      agreement_slug_snapshot TEXT,
      agreement_name_snapshot TEXT,
      nombre TEXT NOT NULL,
      apellido TEXT NOT NULL,
      telefono TEXT NOT NULL,
      email TEXT NOT NULL,
      identificador TEXT,
      source_path TEXT,
      email_message_id TEXT,
      email_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS patient_intakes_created_at_idx
      ON patient_intakes (created_at DESC);
    CREATE INDEX IF NOT EXISTS patient_intakes_agreement_id_idx
      ON patient_intakes (agreement_id);
    CREATE INDEX IF NOT EXISTS patient_intakes_agreement_identifier_idx
      ON patient_intakes (agreement_id, lower(identificador))
      WHERE identificador IS NOT NULL;

    CREATE TABLE IF NOT EXISTS contacts (
      id BIGSERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      apellido TEXT NOT NULL,
      email TEXT NOT NULL,
      telefono TEXT NOT NULL,
      organizacion TEXT NOT NULL,
      rol TEXT NOT NULL,
      pacientes TEXT NOT NULL,
      source_path TEXT,
      email_message_id TEXT,
      email_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS contacts_created_at_idx
      ON contacts (created_at DESC);

    CREATE TABLE IF NOT EXISTS services (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0 AND duration_minutes <= 480),
      cost_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      payment_url TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS services_active_idx
      ON services (active)
      WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS professionals (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      photo_path TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS professionals_active_idx
      ON professionals (active)
      WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS professional_services (
      professional_id BIGINT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      service_id BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      PRIMARY KEY (professional_id, service_id)
    );

    CREATE TABLE IF NOT EXISTS professional_availability (
      id BIGSERIAL PRIMARY KEY,
      professional_id BIGINT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      CHECK (start_time < end_time)
    );

    CREATE INDEX IF NOT EXISTS professional_availability_lookup_idx
      ON professional_availability (professional_id, day_of_week);

    CREATE TABLE IF NOT EXISTS schedule_blocks (
      id BIGSERIAL PRIMARY KEY,
      professional_id BIGINT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      block_date DATE NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (start_time < end_time)
    );

    CREATE INDEX IF NOT EXISTS schedule_blocks_lookup_idx
      ON schedule_blocks (professional_id, block_date);

    CREATE TABLE IF NOT EXISTS booking_access_links (
      id BIGSERIAL PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      patient_intake_id BIGINT REFERENCES patient_intakes(id) ON DELETE SET NULL,
      label TEXT NOT NULL DEFAULT '',
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS booking_access_links_expires_idx
      ON booking_access_links (expires_at);

    CREATE TABLE IF NOT EXISTS professional_access_links (
      id BIGSERIAL PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      professional_id BIGINT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_accessed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS professional_access_links_lookup_idx
      ON professional_access_links (professional_id, expires_at);

    CREATE TABLE IF NOT EXISTS appointments (
      id BIGSERIAL PRIMARY KEY,
      booking_access_link_id BIGINT REFERENCES booking_access_links(id) ON DELETE SET NULL,
      patient_intake_id BIGINT REFERENCES patient_intakes(id) ON DELETE SET NULL,
      service_id BIGINT NOT NULL REFERENCES services(id),
      professional_id BIGINT NOT NULL REFERENCES professionals(id),
      appointment_date DATE NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      patient_name TEXT NOT NULL DEFAULT '',
      patient_email TEXT NOT NULL DEFAULT '',
      patient_phone TEXT NOT NULL DEFAULT '',
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'pending',
      payment_reference TEXT,
      payment_provider TEXT,
      payment_preference_id TEXT,
      payment_init_point TEXT,
      payment_id TEXT,
      payment_external_reference TEXT,
      payment_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      professional_notified_at TIMESTAMPTZ,
      professional_notification_message_id TEXT,
      professional_notification_error TEXT,
      status TEXT NOT NULL DEFAULT 'confirmed',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (start_time < end_time)
    );

    ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS payment_provider TEXT,
      ADD COLUMN IF NOT EXISTS payment_preference_id TEXT,
      ADD COLUMN IF NOT EXISTS payment_init_point TEXT,
      ADD COLUMN IF NOT EXISTS payment_id TEXT,
      ADD COLUMN IF NOT EXISTS payment_external_reference TEXT,
      ADD COLUMN IF NOT EXISTS payment_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS professional_notified_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS professional_notification_message_id TEXT,
      ADD COLUMN IF NOT EXISTS professional_notification_error TEXT;

    CREATE INDEX IF NOT EXISTS appointments_lookup_idx
      ON appointments (professional_id, appointment_date, status);
    CREATE INDEX IF NOT EXISTS appointments_created_at_idx
      ON appointments (created_at DESC);
    CREATE INDEX IF NOT EXISTS appointments_payment_id_idx
      ON appointments (payment_id)
      WHERE payment_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS appointments_payment_reference_idx
      ON appointments (payment_external_reference)
      WHERE payment_external_reference IS NOT NULL;

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id BIGSERIAL PRIMARY KEY,
      actor_user_id BIGINT REFERENCES users(id),
      event_type TEXT NOT NULL,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS audit_events_created_at_idx
      ON audit_events (created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_events_actor_user_id_idx
      ON audit_events (actor_user_id);
  `);

  await bootstrapAdmin();
};

export const bootstrapAdmin = async () => {
  if (!config.bootstrapAdminEmail || !config.bootstrapAdminPassword) return;

  const existing = await one("SELECT id FROM users WHERE lower(email) = lower($1)", [
    config.bootstrapAdminEmail,
  ]);
  if (existing) return;

  const passwordHash = await hashPassword(config.bootstrapAdminPassword);
  await query(
    `
      INSERT INTO users (email, name, password_hash, role)
      VALUES ($1, $2, $3, 'admin')
    `,
    [config.bootstrapAdminEmail, "Fernando Piccolo", passwordHash],
  );
};

export const recordAudit = async (eventType, { actorUserId = null, detail = {} } = {}) => {
  if (!pool) return;
  await query(
    "INSERT INTO audit_events (actor_user_id, event_type, detail) VALUES ($1, $2, $3::jsonb)",
    [actorUserId, eventType, JSON.stringify(detail)],
  );
};

export const normalizeAgreement = (row) =>
  row
    ? {
        ...row,
        id: Number(row.id),
        cobranded: Boolean(row.cobranded),
        logo_url: row.logo_path ? `/uploads/${row.logo_path}` : "",
        pdf_url: row.pdf_path ? `/uploads/${row.pdf_path}` : "",
      }
    : null;

export const getAgreementBySlug = async (slug) =>
  normalizeAgreement(
    await one(
      `
        SELECT *
        FROM agreements
        WHERE lower(slug) = lower($1)
          AND deleted_at IS NULL
      `,
      [slug],
    ),
  );

export const getAgreementById = async (id) =>
  normalizeAgreement(
    await one(
      `
        SELECT *
        FROM agreements
        WHERE id = $1
          AND deleted_at IS NULL
      `,
      [id],
    ),
  );

export const findNominaEntry = async (agreementId, identificador) =>
  one(
    `
      SELECT *
      FROM nomina_entries
      WHERE agreement_id = $1
        AND identificador_normalized = lower($2)
    `,
    [agreementId, identificador],
  );
