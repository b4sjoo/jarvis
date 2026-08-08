CREATE UNIQUE INDEX IF NOT EXISTS idx_preparation_materials_workspace_active_checksum
ON preparation_materials(workspace_id, checksum_sha256)
WHERE status <> 'deleted' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_preparation_materials_workspace_scope
ON preparation_materials(workspace_id, scope_kind, scope_id, updated_at DESC);
