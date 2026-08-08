ALTER TABLE preparation_material_chunks
  ADD COLUMN source_method TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE preparation_material_chunks
  ADD COLUMN confidence REAL;
