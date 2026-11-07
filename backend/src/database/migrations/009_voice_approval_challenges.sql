-- ==============================================================================
-- Migration 009: Voice Approval Challenges Table
-- Persistent single-use approval challenge nonces with atomic multi-instance consumption
-- ==============================================================================

CREATE TABLE IF NOT EXISTS voice_approval_challenges (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    challenge_token VARCHAR(255) UNIQUE NOT NULL,
    plan_id UUID NOT NULL REFERENCES task_plans(id) ON DELETE CASCADE,
    plan_version INT NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    consumed BOOLEAN NOT NULL DEFAULT FALSE,
    consumed_at TIMESTAMP WITH TIME ZONE,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    revoked_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_voice_approval_challenges_token ON voice_approval_challenges(challenge_token);
CREATE INDEX IF NOT EXISTS idx_voice_approval_challenges_plan_id ON voice_approval_challenges(plan_id);
CREATE INDEX IF NOT EXISTS idx_voice_approval_challenges_user_id ON voice_approval_challenges(user_id);
CREATE INDEX IF NOT EXISTS idx_voice_approval_challenges_expires_at ON voice_approval_challenges(expires_at);

