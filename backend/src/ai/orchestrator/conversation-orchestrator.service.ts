import { ConversationRepository } from '../../database/repositories/conversation.repository.js';
import { MessageRepository, Message } from '../../database/repositories/message.repository.js';
import { PlanRepository } from '../planner/plan.repository.js';
import { TaskPlanningEngine } from '../planner/planner.service.js';
import { PermissionManager } from '../permissions/permission.manager.js';
import { PlanExecutionEngine } from '../execution/plan-execution.engine.js';
import { AgentOrchestrator } from './orchestrator.js';
import { ExecutionPlan } from '../planner/planner.interface.js';
import { PlanExecutionResult } from '../execution/execution.interface.js';
import { aiServiceClient } from '../ml-client/ai-service.client.js';
import { AuthorizationError, NotFoundError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';

export interface ProcessUserMessageParams {
  conversationId: string;
  userId: string;
  content: string;
  inputType: 'text' | 'voice';
  options?: {
    requestId?: string;
    correlationId?: string;
    synthesize?: boolean;
    requireWakeWord?: boolean;
  };
}

export interface ProcessUserMessageResult {
  success: boolean;
  userMessage: Message;
  assistantMessage: Message;
  speechText: string;
  plan?: ExecutionPlan | null;
  presentation?: string;
  execution?: PlanExecutionResult | null;
  ticket?: any;
  runId?: string;
  audioBase64?: string;
}

export class ConversationOrchestrator {
  /**
   * Unified conversation orchestration engine.
   * Both text chat and voice mode route through this single application-level entry point.
   * Enforces identical intent classification, database-backed pending plan continuity,
   * permission validation, PlanExecutionEngine execution, and verified-result response grounding.
   */
  public static async processUserMessage(
    params: ProcessUserMessageParams
  ): Promise<ProcessUserMessageResult> {
    const { conversationId, userId, content, inputType, options } = params;
    const trimmed = content.trim();

    // 1. Authoritative access check
    const convo = await ConversationRepository.findById(conversationId);
    if (!convo) {
      throw new NotFoundError('Conversation not found');
    }
    if (convo.user_id !== userId) {
      throw new AuthorizationError('Access denied to this conversation');
    }

    logger.info({
      msg: '[UNIFIED_ORCHESTRATOR] Processing user message',
      conversationId,
      userId,
      inputType,
      contentLength: trimmed.length,
      sample: trimmed.slice(0, 60),
    });

    // 2. Database-backed pending plan retrieval (Phase 3: Multi-turn continuity across both text and voice)
    const activePlan = await PlanRepository.findActiveByConversationId(conversationId);

    // 3. Authoritative task planning intent classification
    const intentResult = TaskPlanningEngine.classifyIntent(
      trimmed,
      Boolean(activePlan),
      activePlan || undefined
    );

    logger.info({
      msg: '[UNIFIED_ORCHESTRATOR] Intent classified',
      intent: intentResult.intent,
      hasActivePlan: Boolean(activePlan),
      activePlanId: activePlan?.id,
      activePlanStatus: activePlan?.status,
      isAmbiguous: activePlan?.is_ambiguous,
    });

    // =========================================================================
    // STAGE A: ACTIVE PLAN APPROVAL ("yes", "approve", "proceed", "go ahead")
    // =========================================================================
    if (activePlan && intentResult.intent === 'approve_plan') {
      const userMessage = await MessageRepository.create(
        conversationId,
        'user',
        trimmed,
        { inputType }
      );

      // Phase 4: Request verified execution ticket from PermissionManager
      const approvalResult = await PermissionManager.requestApproval({
        planId: activePlan.id,
        planVersion: activePlan.version,
        userId,
        conversationId,
        channel: inputType === 'voice' ? 'voice_command' : 'web_ui',
        explicitConfirmation: true,
        voiceTranscript: inputType === 'voice' ? trimmed : undefined,
        transcriptTimestamp: inputType === 'voice' ? Date.now() : undefined,
      });

      if (!approvalResult.success || !approvalResult.ticket) {
        const errorMsg = `⚠️ Plan approval failed: ${approvalResult.message}`;
        const speechMsg = `Plan approval failed: ${approvalResult.message}`;
        const assistantMessage = await MessageRepository.create(
          conversationId,
          'assistant',
          errorMsg,
          { inputType, planId: activePlan.id, error: true }
        );

        return {
          success: false,
          userMessage,
          assistantMessage,
          speechText: speechMsg,
          plan: await PlanRepository.findById(activePlan.id),
        };
      }

      const ticketToken = (approvalResult.ticket.ticketToken || approvalResult.ticket.ticketId)!;

      // Phase 4 & 5: Execute via PlanExecutionEngine (Single execution engine)
      const executionResult = await PlanExecutionEngine.executeApprovedPlan({
        planId: activePlan.id,
        planVersion: activePlan.version,
        userId,
        ticketToken,
      });

      let textContent = '';
      let speechContent = '';

      if (executionResult.status === 'completed') {
        const verifiedSteps = executionResult.stepRecords
          .filter((s) => s.verification?.verified)
          .map((s) => `• ${s.verification?.message || s.action}`)
          .join('\n');

        textContent = `✅ Plan "${activePlan.objective}" executed successfully.\n\n${verifiedSteps}`;

        // Phase 5: Voice response generated strictly from verified tool execution records
        const folderStep = executionResult.stepRecords.find(
          (s) => s.action === 'create_directory' || s.action === 'create_folder'
        );
        if (folderStep && folderStep.verification?.verified) {
          const folderName =
            (folderStep.toolArgs as any)?.folderName ||
            activePlan.metadata?.folder_name ||
            'requested folder';
          const targetLoc = activePlan.metadata?.target_location || 'desktop';
          speechContent = `Done! I have created and verified the folder ${folderName} on your ${targetLoc}.`;
        } else {
          speechContent = `Done! I have executed and verified all steps for ${activePlan.objective}.`;
        }
      } else {
        textContent = `❌ Plan "${activePlan.objective}" failed during execution.\n\nError: ${executionResult.errorMessage || 'Execution step failed.'}`;
        speechContent = `I could not complete the plan: ${executionResult.errorMessage || 'an execution step failed.'}`;
      }

      const assistantMessage = await MessageRepository.create(
        conversationId,
        'assistant',
        textContent,
        {
          inputType,
          planId: activePlan.id,
          executionId: executionResult.executionId,
          executionStatus: executionResult.status,
          speechText: speechContent,
        }
      );

      const audioBase64 = await this.maybeSynthesize(speechContent, options);

      return {
        success: executionResult.status === 'completed',
        userMessage,
        assistantMessage,
        speechText: speechContent,
        plan: await PlanRepository.findById(activePlan.id),
        execution: executionResult,
        ticket: approvalResult.ticket,
        audioBase64,
      };
    }

    // =========================================================================
    // STAGE B: ACTIVE PLAN REJECTION / CANCELLATION ("no", "cancel", "stop")
    // =========================================================================
    if (activePlan && intentResult.intent === 'reject_plan') {
      const userMessage = await MessageRepository.create(
        conversationId,
        'user',
        trimmed,
        { inputType }
      );

      await PermissionManager.cancelPlan(activePlan.id, trimmed);
      const updatedPlan = await PlanRepository.findById(activePlan.id);

      const textContent = `🛑 Plan "${activePlan.objective}" has been cancelled. No actions were performed.`;
      const speechContent = 'Plan cancelled. No actions were performed.';

      const assistantMessage = await MessageRepository.create(
        conversationId,
        'assistant',
        textContent,
        { inputType, planId: activePlan.id, cancelled: true, speechText: speechContent }
      );

      const audioBase64 = await this.maybeSynthesize(speechContent, options);

      return {
        success: true,
        userMessage,
        assistantMessage,
        speechText: speechContent,
        plan: updatedPlan,
        audioBase64,
      };
    }

    // =========================================================================
    // STAGE C: ACTIVE PLAN MODIFICATION / MISSING PARAMETER RESOLUTION
    // (Turn 2: user providing "Jasin-Gia-test" to resolve ambiguous folder name)
    // =========================================================================
    if (activePlan && intentResult.intent === 'modify_plan') {
      const userMessage = await MessageRepository.create(
        conversationId,
        'user',
        trimmed,
        { inputType }
      );

      await PermissionManager.invalidateApproval(activePlan.id, 'User modified or clarified plan');

      // Resolve missing parameters and formulate concrete atomic steps
      const modifiedPlan = await TaskPlanningEngine.modifyPlan(activePlan, trimmed);
      const presentation = TaskPlanningEngine.presentPlan(modifiedPlan);

      // Speech-ready response for voice mode
      let speechContent = '';
      if (!modifiedPlan.is_ambiguous) {
        const folderName = modifiedPlan.metadata?.folder_name || 'specified';
        const targetLoc = modifiedPlan.metadata?.target_location || 'Desktop';
        speechContent = `I formulated a plan to create the folder "${folderName}" on your ${targetLoc}. Should I proceed? Please say Approve or Reject.`;
      } else {
        speechContent =
          modifiedPlan.clarification_question ||
          'Could you please specify more details so I can formulate the execution plan?';
      }

      const assistantMessage = await MessageRepository.create(
        conversationId,
        'assistant',
        presentation,
        {
          inputType,
          planId: modifiedPlan.id,
          version: modifiedPlan.version,
          speechText: speechContent,
        }
      );

      const audioBase64 = await this.maybeSynthesize(speechContent, options);

      return {
        success: true,
        userMessage,
        assistantMessage,
        speechText: speechContent,
        plan: modifiedPlan,
        presentation,
        audioBase64,
      };
    }

    // =========================================================================
    // STAGE D: ACTIVE PLAN EXPLANATION ("explain step 1", "what does this plan do")
    // =========================================================================
    if (activePlan && intentResult.intent === 'explain_plan') {
      const userMessage = await MessageRepository.create(
        conversationId,
        'user',
        trimmed,
        { inputType }
      );

      const explanation = TaskPlanningEngine.explainPlan(activePlan, intentResult.stepIdToExplain);
      const speechContent = explanation.replace(/[#*`_]/g, '').slice(0, 200);

      const assistantMessage = await MessageRepository.create(
        conversationId,
        'assistant',
        explanation,
        { inputType, planId: activePlan.id, speechText: speechContent }
      );

      const audioBase64 = await this.maybeSynthesize(speechContent, options);

      return {
        success: true,
        userMessage,
        assistantMessage,
        speechText: speechContent,
        plan: activePlan,
        audioBase64,
      };
    }

    // =========================================================================
    // STAGE E: ACTIONABLE INSTRUCTION INTERCEPTION -> FORMULATE PLAN FIRST
    // (Turn 1: "Make a folder on desktop.")
    // =========================================================================
    if (TaskPlanningEngine.isActionableInstruction(trimmed) || intentResult.intent === 'create_plan') {
      const userMessage = await MessageRepository.create(
        conversationId,
        'user',
        trimmed,
        { inputType }
      );

      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, trimmed);
      const presentation = TaskPlanningEngine.presentPlan(plan);

      // Determine speech response based on ambiguity
      let speechContent = '';
      if (plan.is_ambiguous) {
        // Speak the clarification question directly!
        speechContent =
          plan.clarification_question || 'What would you like to name this folder?';
      } else {
        speechContent = `I have formulated an execution plan to ${plan.objective}. May I execute this plan? Please say Approve or Reject.`;
      }

      const assistantMessage = await MessageRepository.create(
        conversationId,
        'assistant',
        presentation,
        {
          inputType,
          planId: plan.id,
          version: plan.version,
          isAmbiguous: plan.is_ambiguous,
          speechText: speechContent,
        }
      );

      const audioBase64 = await this.maybeSynthesize(speechContent, options);

      return {
        success: true,
        userMessage,
        assistantMessage,
        speechText: speechContent,
        plan,
        presentation,
        audioBase64,
      };
    }

    // =========================================================================
    // STAGE F: CONVERSATIONAL / Q&A QUERY (Direct LLM / RAG / Memory Orchestrator)
    // =========================================================================
    const result = await AgentOrchestrator.run(userId, conversationId, trimmed, {
      requestId: options?.requestId,
    });

    const speechContent = result.assistantMessage.content;
    const audioBase64 = await this.maybeSynthesize(speechContent, options);

    return {
      success: true,
      userMessage: result.userMessage,
      assistantMessage: result.assistantMessage,
      speechText: speechContent,
      runId: result.runId,
      audioBase64,
    };
  }

  /**
   * Helper to synthesize speech audio when requested (e.g. for voice endpoints).
   */
  private static async maybeSynthesize(
    text: string,
    options?: { requestId?: string; correlationId?: string; synthesize?: boolean }
  ): Promise<string | undefined> {
    if (!options?.synthesize || !text) return undefined;
    try {
      const audioBuffer = await aiServiceClient.synthesize(text, undefined, undefined, {
        requestId: options.requestId,
        correlationId: options.correlationId,
      });
      return audioBuffer.toString('base64');
    } catch (err: any) {
      logger.warn({
        msg: '[UNIFIED_ORCHESTRATOR] Optional speech synthesis failed',
        err: err.message,
      });
      return undefined;
    }
  }
}
