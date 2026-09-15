ALTER TABLE preparation_materials ADD COLUMN purpose TEXT
  CHECK (purpose IS NULL OR purpose IN ('guidance', 'personal-context'));
