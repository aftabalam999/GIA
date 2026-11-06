-- ==============================================================================
-- Migration 008: Plan Execution Engine & Step Audit Logs Table
-- Complete Audit Trail and Execution State Tracking for Approved Plans
-- ==============================================================================

CREATE TABLE IF NOT EXISTS plan_executions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    plan_id UUID NOT NULL REFERENCES task_plans(id) ON DELETE CASCADE,
    plan_version INT NOT NULL,
    approval_id UUID REFERENCES plan_approvals(id) ON DELETE SET NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(50) NOT NULL DEFAULT 'running', -- 'running', 'completed', 'failed', 'cancelled'
    started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    total_steps INT NOT NULL DEFAULT 0,
    completed_steps INT NOT NULL DEFAULT 0,
    failed_step_id INT,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plan_executions_plan_id ON plan_executions(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_executions_user_id ON plan_executions(user_id);
CREATE INDEX IF NOT EXISTS idx_plan_executions_status ON plan_executions(status);

CREATE TABLE IF NOT EXISTS plan_step_executions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    execution_id UUID NOT NULL REFERENCES plan_executions(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES task_plans(id) ON DELETE CASCADE,
    step_id INT NOT NULL,
    action VARCHAR(100) NOT NULL,
    tool_name VARCHAR(100),
    tool_args JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- 'pending', 'running', 'completed', 'failed', 'skipped', 'cancelled'
    result JSONB,
    verification JSONB,
    error TEXT,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    duration_ms INT
);

CREATE INDEX IF NOT EXISTS idx_plan_step_executions_execution_id ON plan_step_executions(execution_id);
CREATE INDEX IF NOT EXISTS idx_plan_step_executions_plan_id ON plan_step_executions(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_step_executions_status ON plan_step_executions(status);

