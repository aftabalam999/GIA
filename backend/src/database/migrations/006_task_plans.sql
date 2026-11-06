-- ==============================================================================
-- Migration 006: Task Planning Engine Tables
-- Introduces mandatory Plan-First architecture for GIA Autonomous Execution
-- ==============================================================================

CREATE TABLE IF NOT EXISTS task_plans (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    objective TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'awaiting_approval',
    is_ambiguous BOOLEAN NOT NULL DEFAULT FALSE,
    clarification_question TEXT,
    steps JSONB NOT NULL DEFAULT '[]'::jsonb,
    approval JSONB NOT NULL DEFAULT '{"required": true, "approved": false}'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_plans_conversation_id ON task_plans(conversation_id);
CREATE INDEX IF NOT EXISTS idx_task_plans_user_id ON task_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_task_plans_status ON task_plans(status);

DROP TRIGGER IF EXISTS update_task_plans_updated_at ON task_plans;
CREATE TRIGGER update_task_plans_updated_at
    BEFORE UPDATE ON task_plans
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

