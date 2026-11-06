import { z } from 'zod';

export const PlanRiskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
export type PlanRiskLevel = z.infer<typeof PlanRiskLevelSchema>;

export const PlanStatusSchema = z.enum([
  'pending',
  'awaiting_approval',
  'approved',
  'rejected',
  'modified',
  'modifying',
  'expired',
  'executing',
  'completed',
  'failed',
  'cancelled',
  'draft',
]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const PlanStepSchema = z.object({
  step_id: z.number().int().positive(),
  action: z.string().min(1, 'Action name must not be empty'),
  target: z.string().optional().default(''),
  description: z.string().min(1, 'Step description must not be empty'),
  tool_name: z.string().optional(),
  tool_args: z.record(z.any()).optional().default({}),
  risk_level: PlanRiskLevelSchema.default('low'),
  requires_approval: z.boolean().default(true),
  depends_on: z.array(z.number().int()).default([]),
  expected_outcome: z.string().optional().default(''),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanApprovalSchema = z.object({
  required: z.boolean().default(true),
  approved: z.boolean().default(false),
  approved_at: z.string().nullable().optional().default(null),
  feedback: z.string().nullable().optional().default(null),
});
export type PlanApproval = z.infer<typeof PlanApprovalSchema>;

export const ExecutionPlanSchema = z.object({
  id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  user_id: z.string().uuid(),
  objective: z.string().min(1, 'Objective must not be empty'),
  status: PlanStatusSchema.default('awaiting_approval'),
  is_ambiguous: z.boolean().default(false),
  clarification_question: z.string().nullable().optional().default(null),
  steps: z.array(PlanStepSchema).min(1, 'A plan must contain at least one step'),
  approval: PlanApprovalSchema.default({ required: true, approved: false }),
  metadata: z.record(z.any()).default({}),
  version: z.number().int().default(1),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

export type PlanIntent =
  | 'create_plan'
  | 'modify_plan'
  | 'explain_plan'
  | 'approve_plan'
  | 'reject_plan'
  | 'conversational';

export interface PlanIntentResult {
  intent: PlanIntent;
  reason: string;
  stepIdToExplain?: number;
}

