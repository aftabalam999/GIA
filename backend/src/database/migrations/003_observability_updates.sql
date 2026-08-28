ALTER TABLE model_runs ALTER COLUMN agent_run_id DROP NOT NULL;
ALTER TABLE model_runs ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_model_runs_conversation_id ON model_runs(conversation_id);
