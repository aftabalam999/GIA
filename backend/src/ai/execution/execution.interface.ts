import { z } from 'zod';

export type PlanExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type StepExecutionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface PlanExecutionRequest {
  planId: string;
  planVersion: number;
  userId: string;
  ticketToken: string;
}

export interface StepExecutionRecord {
  id?: string;
  executionId?: string;
  stepId: number;
  action: string;
  toolName?: string;
  toolArgs: Record<string, any>;
  status: StepExecutionStatus;
  result?: any;
  verification?: {
    verified: boolean;
    message: string;
    details?: Record<string, any>;
  };
  error?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface PlanExecutionResult {
  executionId: string;
  planId: string;
  planVersion: number;
  userId: string;
  status: PlanExecutionStatus;
  totalSteps: number;
  completedSteps: number;
  failedStepId?: number;
  errorMessage?: string;
  stepRecords: StepExecutionRecord[];
  startedAt: string;
  completedAt?: string;
}

