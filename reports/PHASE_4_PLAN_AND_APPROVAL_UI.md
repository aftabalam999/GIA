# GIA AI Assistant — Phase 4: Plan and Approval User Interface Report

**Date:** 2026-11-06  
**Status:** Completed & Fully Verified  
**Branch:** `v1/desktop/voice-agents`  
**Test Suite:** 265 passing tests across 29 test files (11 dedicated Phase 4 UI & Approval Gate tests; 0 TypeScript build errors; Tauri crate check passed)

---

## 1. Executive Summary

Phase 4 establishes the **Plan and Approval User Interface** in GIA's desktop application (React 19 + TypeScript + Tauri + Vite), seamlessly connecting the visual workspace to the **Phase 1 Task Planning Engine**, **Phase 2 Permission Manager Gate**, and **Phase 3 Approved Plan Execution Engine**.

### Absolute Principle: Zero-Bypass Unified Control
> **CORE ARCHITECTURAL RULE:**  
> GIA must NEVER execute actionable instructions immediately, regardless of input modality.
> 
> Whether an instruction originates from:
> 1. **Desktop UI Controls** (Button clicks, inline forms)
> 2. **Text Composer Input** (Keyboard chat)
> 3. **Continuous Voice Mode** (Faster-Whisper STT speech stream)
>
> All three input channels are funneled through the identical backend verification gate. No frontend-only bypass exists. Every actionable task must produce a structured plan, present it clearly, wait for explicit user approval, and execute with live telemetry.

---

## 2. Plan Lifecycle & UI Architecture

```
                       USER REQUEST (Voice / Text)
                                  │
                                  ▼
               ┌──────────────────────────────────────┐
               │    Intent & Actionability Check      │
               │   (TaskPlanningEngine.classifyIntent) │
               └──────────────────┬───────────────────┘
                                  │
                                  ▼
               ┌──────────────────────────────────────┐
               │     1. TASK PLANNING ENGINE          │
               │     - Formulates structured plan     │
               │     - Computes risk levels & tools   │
               │     - Status: 'awaiting_approval'    │
               └──────────────────┬───────────────────┘
                                  │
                                  ▼
               ┌──────────────────────────────────────┐
               │         2. DESKTOP PLAN CARD         │
               │   - Displays Plan ID, Objective      │
               │   - Visualizes atomic steps & risks  │
               │   - Action buttons: Approve / Reject │
               └─────────┬──────────────────┬─────────┘
                         │                  │
               [Approve] │                  │ [Reject / Modify]
                         ▼                  ▼
    ┌───────────────────────────┐   ┌───────────────────────────┐
    │  Backend Permission Gate  │   │  Permission Manager Gate  │
    │  - Issues ExecutionTicket │   │  - Status: 'rejected' /   │
    │  - Status: 'approved'     │   │    'modified' (fresh v+1) │
    └────────────┬──────────────┘   └───────────────────────────┘
                 │
                 ▼
    ┌───────────────────────────┐
    │  3. PLAN EXECUTION ENGINE │
    │  - Verified step sequence │
    │  - Real-time progress bar │
    │  - Step duration & result │
    │  - Status: 'completed'    │
    └───────────────────────────┘
```

---

## 3. UI Component Implementation

### `PlanCard.tsx` (`frontend/src/components/PlanCard.tsx`)
The `PlanCard` component renders glassmorphic task plans inline within the conversation flow, providing clear visual hierarchy and responsive controls:

1. **Header & Meta Section:**
   - **Plan Objective:** Prominent title with dynamic task icon.
   - **Plan ID & Version:** Monospace chip display with version counter (`v1`, `v2`).
   - **Atomic Steps Counter:** Chip indicating total step count.
   - **Status Badges:** Real-time color-coded badges for all 9 approval states:
     - ⏳ `awaiting_approval` / `pending` (Gold pulse glow)
     - ✅ `approved` (Green badge)
     - ⚡ `executing` (Indigo animated pulse)
     - 🎉 `completed` (Emerald badge)
     - ❌ `failed` (Crimson badge)
     - 🚫 `cancelled` (Slate badge)
     - ⛔ `rejected` (Red badge)
     - ⏰ `expired` (Gray badge)
     - 🔄 `modified` (Amber badge)

2. **Ordered Step Sequence:**
   - Sequential step bubbles (numbered `1`, `2`, `3...`, transforming to animated spinners while running, green checkmarks upon completion, and red crosshairs on failure).
   - **Action Name & Description:** Plain-language explanation of what each atomic operation does.
   - **Target Resource:** Explicit identification of affected applications, URLs, or local filesystem paths.
   - **Allowlisted Tool Badge:** Indicates the internal backend tool (`launch_application`, `navigate_browser`, `read_file`, etc.).
   - **Risk Classification Badges:**
     - 🟢 `low`: Standard non-destructive tasks.
     - 🟡 `medium`: Directory indexing or network operations.
     - 🟠 `high`: System settings or software execution.
     - 🔴 `critical`: Terminal commands, deletions, overwrites.
   - **Step Dependencies:** Lists prerequisite steps that must succeed first.
   - **Expected Outcome:** Clear statement of post-condition state.

3. **Live Execution Progress Track:**
   - Progress bar with percentage completion.
   - Elapsed execution time per step in milliseconds.
   - Post-execution verification pills (`✓ Verified` / `Verification Details`).
   - Honest error callout on failed steps with cancellation status.

4. **Interactive Action Controls:**
   - **Approve Button:** Primary emerald action button emitting explicit approval request.
   - **Reject Button:** Destructive red action button aborting the proposed plan.
   - **Modify Button:** Toggles an inline feedback form to adjust steps (e.g., *"Also open YouTube"*, *"Remove step 2"*).
   - **Abort / Cancel Button:** Immediately cancels active execution via backend engine.

---

## 4. Multi-Modal Approval & Integration

### 1. Desktop UI Button Flow
- Clicking **"Approve Plan"** dispatches `api.approvePlan(token, convoId, planId, { channel: 'web_ui', explicitConfirmation: true })`.
- Upon receiving the cryptographic `ExecutionTicket`, the UI immediately triggers `api.executePlan(token, convoId, planId, ticketToken)`.
- Step execution records and telemetry update reactively via real-time polling.

### 2. Text Chat Composer Gate
- If a plan is awaiting approval, the user can type plain-language commands into the composer:
  - **Approval:** `"yes"`, `"proceed"`, `"approve"`, `"execute"`, `"go ahead"`, `"looks good"`.
  - **Rejection:** `"no"`, `"cancel"`, `"reject"`, `"abort"`, `"discard plan"`.
  - **Explanation:** `"explain step 2"`, `"what does step 1 do"`.
  - **Modification:** `"also open GitHub"`, `"don't open YouTube"`, `"remove step 2"`.
- If no plan is active and an actionable instruction is typed (e.g. *"Open Chrome and search YouTube"*), GIA intercepts the instruction, generates an execution plan first, and presents it with `<PlanCard>` without executing anything.

### 3. Continuous Voice Mode Gate
- The `VoiceStateMachine` feeds transcribed utterances through the exact same backend authorization channel:
  - Transcripts matching `"GIA, approve this plan"`, `"GIA, execute the plan"`, or `"GIA, yes, proceed"` invoke `POST /plans/voice-command`.
  - Transcripts matching `"GIA, reject this plan"` or `"GIA, cancel"` cancel the plan.
  - Assistant's own TTS output is strictly flagged with `isAssistantVoice: true` and rejected with HTTP 400 to prevent echo self-approval attacks.

---

## 5. Verification & Test Suite

### 1. Dedicated Phase 4 Test Suite (`backend/tests/plan-and-approval-ui.test.ts`)
All 11 integration tests pass with 100% success:
- ✅ `should generate a structured plan with all PlanCard required metadata`
- ✅ `should fetch active plan for conversation to populate PlanCard on load`
- ✅ `Desktop UI: should approve plan via Desktop UI controls and issue execution ticket`
- ✅ `Voice Input: should approve plan via explicit voice command ("GIA, approve this plan")`
- ✅ `Voice Input: should reject plan via explicit voice command ("GIA, reject this plan")`
- ✅ `Security Barrier: should strictly block assistant TTS voice self-approval`
- ✅ `Modify Plan: should update plan steps, increment version, and invalidate previous approvals`
- ✅ `should execute approved plan and provide step-by-step progress and verification telemetry`
- ✅ `should support execution cancellation`
- ✅ `should reject execution request without valid approval ticket with 400 Validation Error`
- ✅ `should reject execution request with forged / non-existent ticket token with 403 error`

### 2. Full System Regression Verification
- **Total Backend Tests:** 265 passed across 29 test files (0 failures).
- **Frontend TypeScript Build:** `npm --prefix frontend run build` completed in 445ms with 0 type errors.
- **Tauri Native Check:** `cargo check --manifest-path frontend/src-tauri/Cargo.toml` completed in 0.18s with 0 errors.

---

## 6. Summary of Created & Modified Artifacts

| Component | File Path | Description |
|---|---|---|
| **Plan Card Component** | [`frontend/src/components/PlanCard.tsx`](file:///Users/aftab/Desktop/GIA-AI/frontend/src/components/PlanCard.tsx) | Complete React component displaying objective, atomic steps, badges, progress, and controls |
| **Workspace Integration** | [`frontend/src/App.tsx`](file:///Users/aftab/Desktop/GIA-AI/frontend/src/App.tsx) | Integrated PlanCard, state hooks, polling, text/voice routing, and action handlers |
| **API Client Service** | [`frontend/src/services/api.ts`](file:///Users/aftab/Desktop/GIA-AI/frontend/src/services/api.ts) | Added TypeScript interfaces and endpoints for plans, approvals, executions, tickets, and voice commands |
| **Design Language Styles** | [`frontend/src/App.css`](file:///Users/aftab/Desktop/GIA-AI/frontend/src/App.css) | Glassmorphic theme, status badge colors, step numbers, progress animations, and control buttons |
| **Integration Test Suite** | [`backend/tests/plan-and-approval-ui.test.ts`](file:///Users/aftab/Desktop/GIA-AI/backend/tests/plan-and-approval-ui.test.ts) | 11 comprehensive tests validating UI data integrity, multi-modal approval, and security gates |

