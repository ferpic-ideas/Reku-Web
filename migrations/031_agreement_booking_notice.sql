ALTER TABLE agreements
  ADD COLUMN minimum_booking_notice_hours INTEGER NOT NULL DEFAULT 4
  CHECK (minimum_booking_notice_hours BETWEEN 0 AND 8760);
