import { z } from 'zod';

export type RiskLevel = 'low' | 'medium' | 'high';
export type OperationType = 'read' | 'mutate' | 'execute';
export type ErrorBehavior = 'fail_fast' | 'graceful_fallback' | 'retry';

export interface ToolResult<T = any> {
  success: boolean;
  result?: T;
  error?: string;
  metadata?: Record<string, any>;
}

export interface ToolDefinition<I extends z.ZodTypeAny = z.ZodTypeAny, O = any> {
  name: string;
  description: string;
  inputSchema: I;
  permissions: string[]; // Permissions needed to run this tool
  riskLevel: RiskLevel;
  operationType: OperationType; // Distinguishes between READ, MUTATE, and EXECUTE operations
  timeoutMs: number;
  errorBehavior?: ErrorBehavior;
  execute(args: z.infer<I>, context: { userId: string }): Promise<O>;
}

export type Tool = ToolDefinition;
