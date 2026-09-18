ALTER TABLE agreements
  ADD COLUMN IF NOT EXISTS direct_treatment BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS treatment_service_id BIGINT REFERENCES services(id),
  ADD COLUMN IF NOT EXISTS medical_order_required BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE agreements ADD CONSTRAINT agreements_direct_treatment_service_check
  CHECK (NOT direct_treatment OR treatment_service_id IS NOT NULL);

CREATE TABLE patient_intake_medical_orders (
  patient_intake_id BIGINT PRIMARY KEY REFERENCES patient_intakes(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS medical_order_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE appointment_documents
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'study'
    CHECK (purpose IN ('study', 'medical_order'));
