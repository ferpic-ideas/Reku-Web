CREATE TABLE IF NOT EXISTS professional_agreements (
  professional_id BIGINT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  agreement_id BIGINT NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  PRIMARY KEY (professional_id, agreement_id)
);

CREATE INDEX IF NOT EXISTS professional_agreements_agreement_idx
  ON professional_agreements (agreement_id, professional_id);

INSERT INTO professional_agreements (professional_id, agreement_id)
SELECT professional.id, agreement.id
FROM professionals professional
CROSS JOIN agreements agreement
WHERE professional.deleted_at IS NULL
  AND agreement.deleted_at IS NULL
ON CONFLICT DO NOTHING;
