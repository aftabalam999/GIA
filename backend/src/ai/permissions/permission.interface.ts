import { z } from 'zod';

export type ApprovalState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'modified'
  | 'expired'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const SensitiveOperationTypeSchema = z.enum([
  'PERMANENT_DELETION',
  'OVERWRITE_FILE',
  'PRIVILEGED_COMMAND',
  'INSTALL_SOFTWARE',
  'SYSTEM_CONFIGURATION',
  'EXTERNAL_COMMUNICATION',
  'FINANCIAL_TRANSACTION',
  'SHARING_PRIVATE_INFO',
]);
export type SensitiveOperationType = z.infer<typeof SensitiveOperationTypeSchema>;

export type ApprovalChannel = 'web_ui' | 'voice_command' | 'api';

export interface SensitiveOperationAssessment {
  isSensitive: boolean;
  operationTypes: SensitiveOperationType[];
  reasons: string[];
  requiredConfirmations: string[];
}

export interface ApprovalRequest {
  planId: string;
  planVersion: number;
  userId: string;
  conversationId?: string;
  channel: ApprovalChannel;
  explicitConfirmation?: boolean;
  voiceTranscript?: string;
  sensitiveConfirmations?: Record<string, boolean>; // Key format: "step_<id>_<OPERATION_TYPE>"
  isAssistantVoice?: boolean; // Client flag (untrusted for authorization decisions)
  voiceSessionId?: string;
  transcriptTimestamp?: number;
  approvalNonce?: string;
  challengeToken?: string;
}

export interface VoiceApprovalChallenge {
  challengeId: string;
  challengeToken: string;
  planId: string;
  planVersion: number;
  userId: string;
  conversationId: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
  revoked?: boolean;
}

export interface ExecutionTicket {
  ticketId: string;
  ticketToken?: string;
  planId: string;
  planVersion: number;
  userId: string;
  issuedAt: number;
  expiresAt: number;
  approvedSteps: number[];
  confirmedSensitiveOperations: Record<string, boolean>;
  usedSteps: number[];
}

export interface ApprovalResult {
  success: boolean;
  state: ApprovalState;
  message: string;
  ticket?: ExecutionTicket;
  missingSensitiveConfirmations?: string[];
}

export interface VoiceApprovalParseResult {
  isApproval: boolean;
  isRejection: boolean;
  isValid: boolean;
  reason?: string;
  commandType?: 'approve' | 'reject' | 'ambiguous' | 'unrecognized';
}

export interface ToolVerificationResult {
  allowed: boolean;
  reason?: string;
  ticket?: ExecutionTicket;
}
