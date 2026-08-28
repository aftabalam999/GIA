import { z } from 'zod';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface ToolDefinition<I extends z.ZodTypeAny = z.ZodTypeAny, O = any> {
  name: string;
  description: string;
  inputSchema: I;
  permissions: string[]; // Permissions needed to run this tool
  riskLevel: RiskLevel;
  timeoutMs: number;
  execute(args: z.infer<I>, context: { userId: string }): Promise<O>;
}
