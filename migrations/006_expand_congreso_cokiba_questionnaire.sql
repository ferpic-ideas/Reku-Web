ALTER TABLE congreso_cokiba_registrations
  ADD COLUMN IF NOT EXISTS ambitos TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS interes_telerehabilitacion TEXT,
  ADD COLUMN IF NOT EXISTS interes_tecnologia TEXT,
  ADD COLUMN IF NOT EXISTS comentario TEXT;
