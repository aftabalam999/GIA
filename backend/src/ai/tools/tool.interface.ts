import { z } from 'zod';

export type RiskLevel = 'low' | 'medium' | 'high';
export type OperationType = 'read' | 'mutate' | 'execute';

export interface ToolDefinition<I extends z.ZodTypeAny = z.ZodTypeAny, O = any> {
  name: string;
  description: string;
  inputSchema: I;
  permissions: string[]; // Permissions needed to run this tool
  riskLevel: RiskLevel;
  operationType: OperationType; // Distinguishes between READ, MUTATE, and EXECUTE operations
  timeoutMs: number;
  execute(args: z.infer<I>, context: { userId: string }): Promise<O>;
}
