import { randomUUID } from 'crypto';
import { LLMGateway } from '../router/index.js';
import {
  ExecutionPlan,
  ExecutionPlanSchema,
  PlanStep,
  PlanStepSchema,
  PlanIntentResult,
} from './planner.interface.js';
import { PlanRepository } from './plan.repository.js';
import { logger } from '../../shared/logger.js';

export class TaskPlanningEngine {
  /**
   * Generates a new structured execution plan from a user instruction.
   * STRICT SAFETY RESTRICTION: The planner NEVER executes tools, shell commands, or accesses the filesystem.
   */
  static async createPlan(
    userId: string,
    conversationId: string,
    instruction: string,
    _contextHistory?: any[]
  ): Promise<ExecutionPlan> {
    const trimmed = instruction.trim();

    // 1. Check for ambiguous instructions
    if (this.isAmbiguousInstruction(trimmed)) {
      const planId = randomUUID();
      const ambiguousPlan: ExecutionPlan = {
        id: planId,
        conversation_id: conversationId,
        user_id: userId,
        objective: trimmed,
        status: 'awaiting_approval',
        is_ambiguous: true,
        clarification_question: this.generateClarificationQuestion(trimmed),
        steps: [
          {
            step_id: 1,
            action: 'await_clarification',
            target: '',
            description: 'Awaiting user clarification before proceeding with task planning',
            tool_name: undefined,
            tool_args: {},
            risk_level: 'low',
            requires_approval: true,
            depends_on: [],
            expected_outcome: 'Clarification received from user',
          },
        ],
        approval: {
          required: true,
          approved: false,
          approved_at: null,
          feedback: null,
        },
        metadata: { original_instruction: trimmed },
        version: 1,
      };

      const saved = await PlanRepository.create(ambiguousPlan);
      return saved;
    }

    // 2. Deterministic planner for common direct patterns (instant, zero-latency)
    const deterministicSteps = this.generateDeterministicSteps(trimmed);
    if (deterministicSteps) {
      const planId = randomUUID();
      const plan: ExecutionPlan = {
        id: planId,
        conversation_id: conversationId,
        user_id: userId,
        objective: deterministicSteps.objective,
        status: 'awaiting_approval',
        is_ambiguous: false,
        clarification_question: null,
        steps: deterministicSteps.steps,
        approval: {
          required: true,
          approved: false,
          approved_at: null,
          feedback: null,
        },
        metadata: { original_instruction: trimmed, planner_type: 'deterministic' },
        version: 1,
      };

      const validated = this.validatePlan(plan);
      return PlanRepository.create(validated);
    }

    // 3. LLM-based autonomous task decomposition using Qwen
    const prompt = `You are the GIA Autonomous Task Planning Engine.
Your ONLY role is to break down the user's natural language instruction into an atomic, dependency-ordered execution plan.
STRICT RESTRICTION: You NEVER execute actions, shell commands, or tools. You ONLY output a validated JSON plan.

Instruction: "${trimmed}"

Output a single JSON object matching this schema:
{
  "objective": "Concise summary of the user's actual goal",
  "is_ambiguous": boolean,
  "clarification_question": string or null,
  "steps": [
    {
      "step_id": number (starting at 1),
      "action": "short action verb phrase (e.g. launch_application, navigate_browser, verify_browser, read_file)",
      "target": "target app, url, or path",
      "description": "Clear explanation of what this atomic step does",
      "tool_name": "open_application" | "open_url" | "open_file_or_folder" | "list_directory" | "read_file_content" | "search_files" | "get_system_info" | null,
      "tool_args": object with tool arguments,
      "risk_level": "low" | "medium" | "high" | "critical",
      "requires_approval": true,
      "depends_on": array of previous step_id numbers that must finish first (e.g. []),
      "expected_outcome": "Expected state after successful step execution"
    }
  ]
}

Constraints:
- Break complex tasks into atomic sequential steps (e.g., launch app -> wait/verify -> navigate -> verify).
- All steps must set "requires_approval": true.
- Output ONLY valid JSON. No markdown fences. No other text.`;

    try {
      const response = await LLMGateway.generate(
        {
          systemPrompt: 'You are an autonomous AI task planner. You generate structured JSON execution plans.',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          responseFormat: 'json',
          maxTokens: 500,
          enableThinking: false,
        },
        { modelType: 'reasoning' }
      );

      const parsed = JSON.parse(response.content);
      const planId = randomUUID();

      const candidatePlan: ExecutionPlan = {
        id: planId,
        conversation_id: conversationId,
        user_id: userId,
        objective: parsed.objective || trimmed,
        status: 'awaiting_approval',
        is_ambiguous: Boolean(parsed.is_ambiguous),
        clarification_question: parsed.clarification_question || null,
        steps: (parsed.steps || []).map((s: any, idx: number) => ({
          step_id: s.step_id || idx + 1,
          action: s.action || 'execute_action',
          target: s.target || '',
          description: s.description || `Step ${idx + 1}`,
          tool_name: s.tool_name || undefined,
          tool_args: s.tool_args || {},
          risk_level: ['low', 'medium', 'high', 'critical'].includes(s.risk_level) ? s.risk_level : 'low',
          requires_approval: true,
          depends_on: Array.isArray(s.depends_on) ? s.depends_on : [],
          expected_outcome: s.expected_outcome || '',
        })),
        approval: {
          required: true,
          approved: false,
          approved_at: null,
          feedback: null,
        },
        metadata: { original_instruction: trimmed, planner_type: 'llm' },
        version: 1,
      };

      const validated = this.validatePlan(candidatePlan);
      return PlanRepository.create(validated);
    } catch (err: any) {
      logger.error({ msg: 'Planning engine LLM generation failed, falling back to safe fallback plan', err: err.message });
      // Safe fallback plan creation
      const planId = randomUUID();
      const fallbackPlan: ExecutionPlan = {
        id: planId,
        conversation_id: conversationId,
        user_id: userId,
        objective: trimmed,
        status: 'awaiting_approval',
        is_ambiguous: false,
        clarification_question: null,
        steps: [
          {
            step_id: 1,
            action: 'execute_instruction',
            target: trimmed,
            description: `Execute requested instruction: "${trimmed}"`,
            tool_name: undefined,
            tool_args: {},
            risk_level: 'medium',
            requires_approval: true,
            depends_on: [],
            expected_outcome: 'Instruction executed after approval',
          },
        ],
        approval: {
          required: true,
          approved: false,
          approved_at: null,
          feedback: null,
        },
        metadata: { original_instruction: trimmed, fallback: true },
        version: 1,
      };

      return PlanRepository.create(this.validatePlan(fallbackPlan));
    }
  }

  /**
   * Modifies an existing pending plan based on user feedback without executing anything.
   */
  static async modifyPlan(existingPlan: ExecutionPlan, userFeedback: string): Promise<ExecutionPlan> {
    const feedbackLower = userFeedback.toLowerCase().trim();

    // 1. Check for step removal: "remove step 2", "delete the second step", "drop step 1"
    const removeMatch = feedbackLower.match(/(?:remove|delete|drop|omit)\s+(?:the\s+)?(?:step\s+(\d+)|second\s+step|third\s+step|first\s+step|last\s+step)/i);
    if (removeMatch) {
      let stepIndexToRemove = -1;
      if (removeMatch[1]) {
        stepIndexToRemove = parseInt(removeMatch[1], 10) - 1;
      } else if (feedbackLower.includes('first')) {
        stepIndexToRemove = 0;
      } else if (feedbackLower.includes('second')) {
        stepIndexToRemove = 1;
      } else if (feedbackLower.includes('third')) {
        stepIndexToRemove = 2;
      } else if (feedbackLower.includes('last')) {
        stepIndexToRemove = existingPlan.steps.length - 1;
      }

      if (stepIndexToRemove >= 0 && stepIndexToRemove < existingPlan.steps.length && existingPlan.steps.length > 1) {
        const updatedSteps = existingPlan.steps
          .filter((_, idx) => idx !== stepIndexToRemove)
          .map((s, idx) => ({ ...s, step_id: idx + 1 }));

        const updated = await PlanRepository.update(existingPlan.id, {
          steps: updatedSteps,
          approval: { required: true, approved: false, approved_at: null, feedback: userFeedback },
          metadata: { ...existingPlan.metadata, last_modification: userFeedback },
        });
        return updated;
      }
    }

    // 2. Check for step replacement: "don't open X, open Y", "instead of X, open Y", "change target to Y"
    const replaceMatch = feedbackLower.match(/(?:don't|do not|instead of)\s+(?:open|navigate to|run)?\s*([a-zA-Z0-9._:/-]+)(?:,|\s+)?\s*(?:open|run|navigate to|use)?\s*([a-zA-Z0-9._:/-]+)/i);
    if (replaceMatch) {
      const oldTarget = replaceMatch[1].trim();
      const newTarget = replaceMatch[2].trim();

      const updatedSteps = existingPlan.steps.map((s) => {
        if (s.target.toLowerCase().includes(oldTarget) || s.description.toLowerCase().includes(oldTarget)) {
          return {
            ...s,
            target: newTarget,
            description: s.description.replace(new RegExp(oldTarget, 'gi'), newTarget),
            expected_outcome: s.expected_outcome.replace(new RegExp(oldTarget, 'gi'), newTarget),
          };
        }
        return s;
      });

      const updatedObjective = existingPlan.objective.replace(new RegExp(oldTarget, 'gi'), newTarget);
      return PlanRepository.update(existingPlan.id, {
        objective: updatedObjective,
        steps: updatedSteps,
        approval: { required: true, approved: false, approved_at: null, feedback: userFeedback },
        metadata: { ...existingPlan.metadata, last_modification: userFeedback },
      });
    }

    // 3. Check for step append: "also open Y", "add another step to open Y"
    const appendMatch = feedbackLower.match(/(?:also\s+(?:open|launch|navigate to|run)|add\s+(?:another\s+)?step\s+(?:to\s+)?(?:open|run|navigate to)?)\s*([a-zA-Z0-9._:/-]+)/i);
    if (appendMatch) {
      const targetToAdd = appendMatch[1].trim();
      const newStepId = existingPlan.steps.length + 1;
      const isUrl = targetToAdd.startsWith('http') || targetToAdd.includes('.com') || targetToAdd.includes('.org');

      const newStep: PlanStep = {
        step_id: newStepId,
        action: isUrl ? 'navigate_browser' : 'launch_application',
        target: targetToAdd,
        description: isUrl ? `Navigate browser to ${targetToAdd}` : `Launch ${targetToAdd}`,
        tool_name: isUrl ? 'open_url' : 'open_application',
        tool_args: isUrl ? { url: targetToAdd } : { appName: targetToAdd },
        risk_level: 'low',
        requires_approval: true,
        depends_on: [newStepId - 1],
        expected_outcome: `${targetToAdd} opened and accessible`,
      };

      const updatedSteps = [...existingPlan.steps, newStep];
      return PlanRepository.update(existingPlan.id, {
        steps: updatedSteps,
        approval: { required: true, approved: false, approved_at: null, feedback: userFeedback },
        metadata: { ...existingPlan.metadata, last_modification: userFeedback },
      });
    }

    // 4. Fallback LLM-powered modification for complex feedback
    const prompt = `You are modifying an existing GIA execution plan based on user feedback.
Current Plan:
${JSON.stringify({ objective: existingPlan.objective, steps: existingPlan.steps }, null, 2)}

User Modification Request: "${userFeedback}"

Output the updated plan in JSON:
{
  "objective": "Updated objective",
  "steps": [
    {
      "step_id": number (starting at 1),
      "action": "action name",
      "target": "target app/file/url",
      "description": "step description",
      "tool_name": "tool name or null",
      "tool_args": {},
      "risk_level": "low" | "medium" | "high" | "critical",
      "requires_approval": true,
      "depends_on": [],
      "expected_outcome": "expected result"
    }
  ]
}`;

    try {
      const response = await LLMGateway.generate(
        {
          systemPrompt: 'You update structured execution plans according to user instructions. Output only JSON.',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          responseFormat: 'json',
          maxTokens: 500,
          enableThinking: false,
        },
        { modelType: 'reasoning' }
      );

      const parsed = JSON.parse(response.content);
      const validatedSteps = (parsed.steps || []).map((s: any, idx: number) => PlanStepSchema.parse({
        step_id: idx + 1,
        action: s.action || 'step',
        target: s.target || '',
        description: s.description || `Step ${idx + 1}`,
        tool_name: s.tool_name || undefined,
        tool_args: s.tool_args || {},
        risk_level: s.risk_level || 'low',
        requires_approval: true,
        depends_on: s.depends_on || [],
        expected_outcome: s.expected_outcome || '',
      }));

      return PlanRepository.update(existingPlan.id, {
        objective: parsed.objective || existingPlan.objective,
        steps: validatedSteps,
        approval: { required: true, approved: false, approved_at: null, feedback: userFeedback },
        metadata: { ...existingPlan.metadata, last_modification: userFeedback },
      });
    } catch {
      return existingPlan;
    }
  }

  /**
   * Explains what the plan or a specific step does without modifying or executing anything.
   */
  static explainPlan(plan: ExecutionPlan, stepId?: number): string {
    if (stepId !== undefined) {
      const step = plan.steps.find((s) => s.step_id === stepId);
      if (!step) {
        return `Step ${stepId} does not exist in plan "${plan.objective}". This plan has ${plan.steps.length} step(s).`;
      }
      return `### Explanation for Step ${step.step_id}: **${step.action}**\n` +
        `• **Target:** \`${step.target || 'None'}\`\n` +
        `• **Description:** ${step.description}\n` +
        `• **Tool:** \`${step.tool_name || 'Standard Orchestrator'}\`\n` +
        `• **Risk Level:** **${step.risk_level.toUpperCase()}**\n` +
        `• **Dependencies:** ${step.depends_on.length > 0 ? step.depends_on.map((d) => `Step ${d}`).join(', ') : 'None (can run immediately)'}\n` +
        `• **Expected Outcome:** ${step.expected_outcome}\n` +
        `\n*This step will NOT execute until you explicitly approve the plan.*`;
    }

    const stepExplanations = plan.steps
      .map(
        (s) =>
          `**Step ${s.step_id}: ${s.description}**\n` +
          `  - Target: \`${s.target || '-'}\` | Tool: \`${s.tool_name || 'System'}\` | Risk: *${s.risk_level}*\n` +
          `  - Expected Result: ${s.expected_outcome}`
      )
      .join('\n\n');

    return `### 🔍 Detailed Plan Breakdown for: **${plan.objective}**\n\n` +
      `**Plan ID:** \`${plan.id}\` (Version ${plan.version})\n` +
      `**Status:** ⏳ *${plan.status}*\n\n` +
      `${stepExplanations}\n\n` +
      `🛡️ **Safety Guarantee:** GIA will wait for your explicit approval before performing any of these steps.`;
  }

  /**
   * Formats the plan into an elegant, human-readable markdown presentation for the chat interface.
   */
  static presentPlan(plan: ExecutionPlan): string {
    if (plan.is_ambiguous) {
      return `❓ **Clarification Needed for Your Request**\n\n` +
        `${plan.clarification_question || 'Your request is ambiguous. Could you please specify more details?'}\n\n` +
        `*Once you clarify, GIA will formulate a validated execution plan.*`;
    }

    const stepsList = plan.steps
      .map((s) => {
        const riskBadge = s.risk_level === 'critical'
          ? '🔴 [CRITICAL RISK]'
          : s.risk_level === 'high'
          ? '🟠 [HIGH RISK]'
          : s.risk_level === 'medium'
          ? '🟡 [MEDIUM RISK]'
          : '🟢 [LOW RISK]';

        const toolBadge = s.tool_name ? ` 🔧 \`${s.tool_name}\`` : '';
        const targetBadge = s.target ? ` • Target: \`${s.target}\`` : '';
        const deps = s.depends_on.length > 0 ? ` *(depends on Step ${s.depends_on.join(', ')})*` : '';

        return `**${s.step_id}. ${s.description}**${targetBadge}${toolBadge}\n` +
          `   ↳ ${riskBadge}${deps}\n` +
          `   ↳ *Expected Outcome:* ${s.expected_outcome || 'Success'}`;
      })
      .join('\n\n');

    return `📋 **Execution Plan Formulated: "${plan.objective}"**\n` +
      `*Plan ID: \`${plan.id}\` • Version: ${plan.version} • Status: ⏳ Awaiting Approval*\n\n` +
      `${stepsList}\n\n` +
      `---\n` +
      `⚠️ **Explicit Approval Required**\n` +
      `In accordance with GIA's Plan-First architecture, no action has been executed yet.\n\n` +
      `• Type **"Approved"** or **"Proceed"** to execute this plan.\n` +
      `• Or tell me how to adjust it (e.g., *"Also open YouTube"*, *"Remove step 2"*, *"Explain step 1"*).`;
  }

  /**
   * Classifies user input intent regarding task planning.
   */
  static classifyIntent(userInput: string, hasActivePlan: boolean): PlanIntentResult {
    const text = userInput.trim().toLowerCase();

    // 1. Approval triggers
    if (
      hasActivePlan &&
      /^(?:yes|y|proceed|approve|approved|go ahead|looks good|execute|run plan|confirm|do it)\b/i.test(text)
    ) {
      return { intent: 'approve_plan', reason: 'User explicitly approved pending plan execution.' };
    }

    // 2. Rejection triggers
    if (
      hasActivePlan &&
      /^(?:no|n|cancel|reject|rejected|abort|stop|discard plan|forget it)\b/i.test(text)
    ) {
      return { intent: 'reject_plan', reason: 'User explicitly cancelled or rejected pending plan.' };
    }

    // 3. Explanation triggers: "explain step 2", "explain what this action does", "why step 1"
    const explainMatch = text.match(/(?:explain|what does|why do we need)\s+(?:what\s+)?(?:step\s+(\d+)|action\s+(\d+)|this\s+action|this\s+plan|the\s+plan)/i);
    if (hasActivePlan && explainMatch) {
      const stepNum = explainMatch[1] || explainMatch[2];
      return {
        intent: 'explain_plan',
        reason: 'User requested explanation of plan or step.',
        stepIdToExplain: stepNum ? parseInt(stepNum, 10) : undefined,
      };
    }

    // 4. Modification triggers
    if (
      hasActivePlan &&
      (
        text.startsWith('also ') ||
        text.startsWith("don't ") ||
        text.startsWith('do not ') ||
        text.startsWith('instead ') ||
        text.startsWith('remove ') ||
        text.startsWith('delete ') ||
        text.startsWith('add ') ||
        text.startsWith('change ') ||
        text.includes('another step') ||
        text.includes('second step') ||
        text.includes('first step')
      )
    ) {
      return { intent: 'modify_plan', reason: 'User requested modifications to pending plan.' };
    }

    // 5. Actionable command triggers (Create new plan)
    const isActionable = this.isActionableInstruction(text);
    if (isActionable) {
      return { intent: 'create_plan', reason: 'User requested an actionable instruction requiring task planning.' };
    }

    return { intent: 'conversational', reason: 'General conversation or query.' };
  }

  /**
   * Validates a plan against the strict ExecutionPlanSchema.
   */
  static validatePlan(rawPlan: unknown): ExecutionPlan {
    const parsed = ExecutionPlanSchema.safeParse(rawPlan);
    if (!parsed.success) {
      throw new Error(`Plan validation failed: ${JSON.stringify(parsed.error.format())}`);
    }
    return parsed.data;
  }

  // --- PRIVATE HELPERS ---

  private static isAmbiguousInstruction(text: string): boolean {
    const lower = text.toLowerCase().trim();
    const ambiguousPhrases = [
      'open it',
      'launch it',
      'run it',
      'delete it',
      'open that',
      'do it',
      'open that app',
      'run the program',
      'open the thing',
      'check it',
    ];
    return ambiguousPhrases.includes(lower) || lower.length < 4;
  }

  private static generateClarificationQuestion(text: string): string {
    const lower = text.toLowerCase();
    if (lower.includes('open') || lower.includes('launch')) {
      return 'Which specific application, file, or website would you like me to open?';
    }
    if (lower.includes('delete') || lower.includes('remove')) {
      return 'Which specific file or item would you like me to remove?';
    }
    if (lower.includes('run')) {
      return 'Which project, script, or program would you like me to run?';
    }
    return 'Could you please provide more details on what you would like to accomplish?';
  }

  public static isActionableInstruction(text: string): boolean {
    let lower = text.toLowerCase().trim();

    // Strip common conversational / polite prefixes
    lower = lower
      .replace(/^(?:can\s+you\s+(?:please\s+)?|could\s+you\s+(?:please\s+)?|please\s+|kindly\s+|gia,?\s*(?:please\s+)?|hey\s+gia,?\s*)/i, '')
      .trim();

    // Pure questions or conversational chit-chat are NOT actionable instructions
    if (
      lower.startsWith('what is') ||
      lower.startsWith('what are') ||
      lower.startsWith('who is') ||
      lower.startsWith('who are') ||
      lower.startsWith('who am i') ||
      lower.startsWith('how do') ||
      lower.startsWith('how does') ||
      lower.startsWith('why is') ||
      lower.startsWith('why do') ||
      lower.startsWith('tell me about') ||
      lower.startsWith('explain') ||
      lower.includes('recursion') ||
      lower.includes('javascript')
    ) {
      return false;
    }

    // Action verbs and keywords
    return (
      lower.startsWith('open ') ||
      lower.startsWith('launch ') ||
      lower.startsWith('start ') ||
      lower.startsWith('run ') ||
      lower.startsWith('execute ') ||
      lower.startsWith('navigate ') ||
      lower.startsWith('visit ') ||
      lower.startsWith('browse ') ||
      lower.startsWith('search ') ||
      lower.startsWith('create file') ||
      lower.startsWith('make file') ||
      lower.startsWith('write file') ||
      lower.startsWith('read file') ||
      lower.startsWith('delete file') ||
      lower.startsWith('remove file') ||
      lower.startsWith('list files') ||
      lower.startsWith('list directory') ||
      lower.startsWith('search for file') ||
      lower.startsWith('find file') ||
      lower.startsWith('close ') ||
      lower.startsWith('quit ') ||
      lower.startsWith('kill ') ||
      lower.startsWith('check battery') ||
      lower.startsWith('system info') ||
      lower.startsWith('take a screenshot') ||
      lower.startsWith('screenshot') ||
      lower.includes('vs code') ||
      lower.includes('vscode') ||
      lower.includes('chrome') ||
      lower.includes('youtube') ||
      lower.includes('terminal') ||
      lower.includes('calculator')
    );
  }

  private static generateDeterministicSteps(text: string): { objective: string; steps: PlanStep[] } | null {
    const lower = text.toLowerCase().trim();

    // YouTube in Chrome / Web Browser pattern
    if (lower.includes('youtube')) {
      if (lower.includes('search')) {
        return {
          objective: 'Open Chrome and search YouTube',
          steps: [
            {
              step_id: 1,
              action: 'launch_application',
              target: 'Google Chrome',
              description: 'Launch Google Chrome',
              tool_name: 'launch_application',
              tool_args: { appName: 'Google Chrome' },
              risk_level: 'low',
              requires_approval: true,
              depends_on: [],
              expected_outcome: 'Google Chrome running',
            },
            {
              step_id: 2,
              action: 'verify_application',
              target: 'Google Chrome',
              description: 'Verify Chrome is running',
              tool_name: undefined,
              tool_args: {},
              risk_level: 'low',
              requires_approval: true,
              depends_on: [1],
              expected_outcome: 'Chrome process verified',
            },
            {
              step_id: 3,
              action: 'focus_address_bar',
              target: 'Google Chrome',
              description: 'Focus browser window and address bar',
              tool_name: 'interact_with_application',
              tool_args: { appName: 'Google Chrome', action: 'activate' },
              risk_level: 'low',
              requires_approval: true,
              depends_on: [2],
              expected_outcome: 'Browser focused and active',
            },
            {
              step_id: 4,
              action: 'navigate_browser',
              target: 'https://www.youtube.com',
              description: 'Enter YouTube URL and navigate',
              tool_name: 'navigate_browser',
              tool_args: { url: 'https://www.youtube.com' },
              risk_level: 'low',
              requires_approval: true,
              depends_on: [3],
              expected_outcome: 'Navigated to YouTube',
            },
            {
              step_id: 5,
              action: 'search_browser',
              target: 'YouTube',
              description: 'Execute search query on YouTube',
              tool_name: 'search_browser',
              tool_args: { query: 'YouTube', engine: 'youtube' },
              risk_level: 'low',
              requires_approval: true,
              depends_on: [4],
              expected_outcome: 'Search results displayed',
            },
            {
              step_id: 6,
              action: 'verify_page_loaded',
              target: 'https://www.youtube.com',
              description: 'Verify the page loaded successfully',
              tool_name: undefined,
              tool_args: {},
              risk_level: 'low',
              requires_approval: true,
              depends_on: [5],
              expected_outcome: 'Page load verified',
            },
          ],
        };
      }

      return {
        objective: 'Open YouTube in Google Chrome',
        steps: [
          {
            step_id: 1,
            action: 'launch_application',
            target: 'Google Chrome',
            description: 'Launch Google Chrome',
            tool_name: 'launch_application',
            tool_args: { appName: 'Google Chrome' },
            risk_level: 'low',
            requires_approval: true,
            depends_on: [],
            expected_outcome: 'Google Chrome process running and active',
          },
          {
            step_id: 2,
            action: 'wait_for_application',
            target: 'Google Chrome',
            description: 'Wait until Google Chrome is ready to accept navigation',
            tool_name: undefined,
            tool_args: {},
            risk_level: 'low',
            requires_approval: true,
            depends_on: [1],
            expected_outcome: 'Google Chrome window initialized',
          },
          {
            step_id: 3,
            action: 'navigate_browser',
            target: 'https://www.youtube.com',
            description: 'Navigate Chrome to YouTube',
            tool_name: 'navigate_browser',
            tool_args: { url: 'https://www.youtube.com' },
            risk_level: 'low',
            requires_approval: true,
            depends_on: [2],
            expected_outcome: 'YouTube homepage loaded in browser tab',
          },
          {
            step_id: 4,
            action: 'verify_browser',
            target: 'https://www.youtube.com',
            description: 'Verify YouTube loaded successfully',
            tool_name: undefined,
            tool_args: {},
            risk_level: 'low',
            requires_approval: true,
            depends_on: [3],
            expected_outcome: 'Browser verification complete',
          },
        ],
      };
    }

    // Single Application Launch (e.g. "Open Chrome", "Launch Terminal", "Open Spotify", "Open Calculator")
    const appMatch = lower.match(/^(?:(?:can\s+you\s+|please\s+)?(?:open|launch|start)\s+(?:the\s+)?(?:app(?:lication)?\s+)?([a-zA-Z0-9\s._-]+?)(?:\s+app)?)$/i);
    if (appMatch) {
      const app = appMatch[1].trim();
      if (!app.includes('vs code') && !app.includes('vscode') && !app.includes('youtube') && !app.includes('file') && !app.includes('folder')) {
        return {
          objective: `Launch ${app}`,
          steps: [
            {
              step_id: 1,
              action: 'launch_application',
              target: app,
              description: `Launch ${app} on desktop`,
              tool_name: 'launch_application',
              tool_args: { appName: app },
              risk_level: 'low',
              requires_approval: true,
              depends_on: [],
              expected_outcome: `${app} process launched and window presented`,
            },
            {
              step_id: 2,
              action: 'verify_application',
              target: app,
              description: `Verify ${app} is running on system`,
              tool_name: undefined,
              tool_args: {},
              risk_level: 'low',
              requires_approval: true,
              depends_on: [1],
              expected_outcome: `${app} running successfully`,
            },
          ],
        };
      }
    }

    // VS Code Launch
    if (lower.includes('vs code') || lower.includes('vscode')) {
      const isProjectExplicit = lower.includes('folder') || lower.includes('project') || lower.includes('workspace');
      if (isProjectExplicit) {
        return {
          objective: 'Open project in Visual Studio Code',
          steps: [
            {
              step_id: 1,
              action: 'launch_application',
              target: 'Visual Studio Code',
              description: 'Open GIA-AI workspace in Visual Studio Code',
              tool_name: 'open_folder_in_vscode',
              tool_args: { folderName: 'GIA-AI' },
              risk_level: 'medium',
              requires_approval: true,
              depends_on: [],
              expected_outcome: 'Visual Studio Code workspace opened with GIA-AI',
            },
            {
              step_id: 2,
              action: 'verify_workspace',
              target: 'Visual Studio Code',
              description: 'Verify workspace opened in editor window',
              tool_name: undefined,
              tool_args: {},
              risk_level: 'low',
              requires_approval: true,
              depends_on: [1],
              expected_outcome: 'VS Code editor ready',
            },
          ],
        };
      }

      return {
        objective: 'Launch Visual Studio Code',
        steps: [
          {
            step_id: 1,
            action: 'launch_application',
            target: 'Visual Studio Code',
            description: 'Launch Visual Studio Code on desktop',
            tool_name: 'launch_application',
            tool_args: { appName: 'Visual Studio Code' },
            risk_level: 'low',
            requires_approval: true,
            depends_on: [],
            expected_outcome: 'Visual Studio Code running and window visible',
          },
          {
            step_id: 2,
            action: 'verify_application',
            target: 'Visual Studio Code',
            description: 'Verify Visual Studio Code is running on system',
            tool_name: undefined,
            tool_args: {},
            risk_level: 'low',
            requires_approval: true,
            depends_on: [1],
            expected_outcome: 'Visual Studio Code process verified',
          },
        ],
      };
    }

    // Screenshot Capture
    if (lower.includes('screenshot') || lower.includes('capture screen')) {
      return {
        objective: 'Capture Desktop Screenshot',
        steps: [
          {
            step_id: 1,
            action: 'capture_screen',
            target: 'Desktop Display',
            description: 'Capture screenshot of active desktop window',
            tool_name: 'capture_screen',
            tool_args: {},
            risk_level: 'low',
            requires_approval: true,
            depends_on: [],
            expected_outcome: 'Screenshot captured and stored safely',
          },
        ],
      };
    }

    // System Diagnostics
    if (lower === 'system info' || lower.includes('battery status') || lower.includes('laptop specs')) {
      return {
        objective: 'Retrieve Laptop System & Battery Diagnostics',
        steps: [
          {
            step_id: 1,
            action: 'read_system_metrics',
            target: 'System Hardware & Battery',
            description: 'Collect CPU, memory, uptime, and battery telemetry from macOS',
            tool_name: 'get_system_info',
            tool_args: {},
            risk_level: 'low',
            requires_approval: true,
            depends_on: [],
            expected_outcome: 'System telemetry captured and formatted',
          },
        ],
      };
    }

    return null;
  }
}
