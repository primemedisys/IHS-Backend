-- ============================================================================
-- 047 — Clinic coordinates become optional
--
-- A doctor must be able to save a clinic by typing its address, with or
-- without a Google Maps pin. clinics.lat / clinics.lng were NOT NULL, which
-- forced a map pick. This only RELAXES the constraint: every existing row keeps
-- its coordinates, nothing is rewritten, and readers already treat a missing
-- pin as "no location" (doctor search filters `c.lat IS NOT NULL`, the public
-- serializer sends 0/0, which every client already reads as "not pinned").
-- Idempotent: each MODIFY runs only while the column is still NOT NULL.
-- ============================================================================

SET @lat_required := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinics' AND COLUMN_NAME = 'lat' AND IS_NULLABLE = 'NO');
SET @ddl := IF(@lat_required > 0,
  'ALTER TABLE clinics MODIFY COLUMN lat DECIMAL(10,7) NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @lng_required := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clinics' AND COLUMN_NAME = 'lng' AND IS_NULLABLE = 'NO');
SET @ddl := IF(@lng_required > 0,
  'ALTER TABLE clinics MODIFY COLUMN lng DECIMAL(10,7) NULL', 'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
