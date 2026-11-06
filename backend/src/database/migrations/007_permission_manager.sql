-- ==============================================================================
-- Migration 007: Permission Manager & Approval Tickets Table
-- Centralized User Approval and Permission Gate
-- ==============================================================================

CREATE TABLE IF NOT EXISTS plan_approvals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    plan_id UUID NOT NULL REFERENCES task_plans(id) ON DELETE CASCADE,
    plan_version INT NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel VARCHAR(50) NOT NULL DEFAULT 'web_ui', -- 'web_ui', 'voice_command', 'api'
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'rejected', 'expired', 'cancelled'
    sensitive_confirmations JSONB NOT NULL DEFAULT '{}'::jsonb,
    ticket_token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plan_approvals_plan_id ON plan_approvals(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_approvals_user_id ON plan_approvals(user_id);
CREATE INDEX IF NOT EXISTS idx_plan_approvals_ticket_token ON plan_approvals(ticket_token);
CREATE INDEX IF NOT EXISTS idx_plan_approvals_status ON plan_approvals(status);

