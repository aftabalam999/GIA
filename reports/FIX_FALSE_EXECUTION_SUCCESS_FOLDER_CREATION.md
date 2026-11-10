# GIA — Fix False Execution Success (Desktop Folder Creation)

## Executive Summary

When a user instructed GIA to:
1. *"Make a folder on desktop."*
2. GIA asked: *"What would you like to name this folder?"*
3. User replied: *"Jasin-Gia-test."*
4. GIA previously responded: *"Done! The folder has been successfully created on your desktop."*

**The folder was never created on the actual macOS Desktop.** GIA was falsely reporting success due to an ungrounded LLM hallucination bypassing the Plan-First architecture, coupled with the complete absence of a folder creation tool in the tool registry.

This issue has now been completely resolved. A dedicated `create_directory` tool has been implemented, integrated with the `PermissionManager` and `PlanExecutionEngine`, grounded with post-creation verification, and protected against ungrounded hallucinations across multi-turn conversations.

---

## 1. Root Cause Analysis

Tracing the execution flow revealed three critical flaws:

1. **Intent Classification Gap**:
   In `frontend/src/App.tsx` and `backend/src/ai/planner/planner.service.ts`, `isActionableInstruction` checked for `create file`, `make file`, and `read file`, but completely lacked patterns for `make folder`, `create folder`, `make a folder`, or `directory`.
   Consequently, the instruction *"Make a folder on desktop."* was treated as non-actionable chit-chat and routed directly to the raw Qwen LLM.

2. **Missing Tool in Tool Registry**:
   In `backend/src/ai/tools/registry.ts`, `create_file`, `update_file`, `delete_file`, and `open_folder` existed, but there was **no** `create_directory` or `create_folder` tool registered.

3. **Multi-Turn Ambiguity Resolution Dropped to Raw LLM**:
   In Turn 2, when the user answered *"Jasin-Gia-test."*, `classifyIntent` classified the response as `conversational` because it did not start with approval words (`yes`, `proceed`) or explicit modification verbs (`also`, `instead of`, `remove`). It was forwarded to raw Qwen LLM.
   Qwen received the conversational history:
   - User: *"Make a folder on desktop."*
   - Assistant: *"What would you like to name this folder?"*
   - User: *"Jasin-Gia-test."*
   Without tools or execution constraints, Qwen generated a fabricated completion response:
   *"Done! The folder has been successfully created on your desktop."*

---

## 2. Complete Architecture Fix

```
[User Input] "Make a folder on desktop."
      │
      ▼
[isActionableInstruction] ──► Matched (Folder creation intent)
      │
      ▼
[isAmbiguousInstruction] ──► Missing folder name!
      │
      ▼
[createPlan] ──► Formulates Ambiguous Plan:
                 • is_ambiguous: true
                 • clarification_question: "What would you like to name this folder?"
                 • metadata: { pending_action: 'create_directory', target_location: 'Desktop', missing_param: 'folder_name' }
      │
      ▼
[GIA UI / Voice] "What would you like to name this folder?"
      │
      ▼
[User Input] "Jasin-Gia-test."
      │
      ▼
[classifyIntent] ──► Active ambiguous plan detected ──► intent: 'modify_plan'
      │
      ▼
[modifyPlan] ──► Extracts and validates folderName: "Jasin-Gia-test"
                 • Target location: "Desktop"
                 • Transforms into concrete 2-step plan:
                   Step 1: create_directory (tool: 'create_directory', args: { directoryPath: 'Desktop', folderName: 'Jasin-Gia-test' })
                   Step 2: verify_directory (synthetic verification verifying filesystem stat)
                 • is_ambiguous: false
                 • status: 'awaiting_approval'
      │
      ▼
[GIA UI / Voice] Presents concrete plan with approval buttons / voice confirmation:
                 "Execution Plan Formulated: Create folder 'Jasin-Gia-test' on Desktop. May I execute this plan? Say Approve or Reject."
      │
      ▼
[User Input] "Approved" / "Proceed"
      │
      ▼
[PermissionManager] ──► Validates user authorization & issues single-use execution ticket
      │
      ▼
[PlanExecutionEngine] ──► Executes Step 1: ToolExecutor -> create_directory
                          • Resolves macOS Desktop directory via os.homedir() (or GIA_DESKTOP_DIR)
                          • Checks pre-existence
                          • Executes native fs.mkdirSync(path, { recursive: false, mode: 0o755 })
                          • Immediate post-creation verification (fs.statSync)
                      ──► Executes Step 2: verify_directory
                          • Confirms directory exists on disk and is a valid directory
      │
      ▼
[GIA UI / Voice] Grounded Truthful Response:
                 "✅ Plan 'Create folder \"Jasin-Gia-test\" on Desktop' executed successfully.
                  • Created directory \"Jasin-Gia-test\" successfully at \"/Users/<user>/Desktop/Jasin-Gia-test\".
                  • Verified directory \"Jasin-Gia-test\" exists on disk."
```

---

## 3. Implementation Details

### A. Dedicated Filesystem Tool: `create_directory` & `create_folder`
- **Location**: `backend/src/ai/tools/registry.ts`
- **Permissions**: `['write:files']`
- **Risk Level**: `medium`
- **Input Schema**:
  ```typescript
  {
    directoryPath: z.string().optional().default('Desktop'),
    folderName: z.string().optional(),
  }
  ```
- **Desktop Resolution**:
  Uses `process.env.GIA_DESKTOP_DIR || path.join(os.homedir(), 'Desktop')`.
  Safely expands `~`, `Desktop`, `Documents`, and `Downloads`.
- **Security & Validation**:
  - Validates folder names: rejects `..`, path traversal, slashes (`/`, `\`), null bytes (`\0`), and colons (`:`).
  - Enforces home directory and workspace boundary confinement.
  - Checks pre-existence: rejects duplicate creation with an explicit error: `Directory already exists: "<path>"`.
  - Checks parent directory existence: rejects if parent does not exist.
  - Creates folder via native `fs.mkdirSync(targetPath, { recursive: false, mode: 0o755 })`.
  - Performs immediate post-creation verification via `fs.statSync(targetPath).isDirectory()`.
- **Alias Registered**: `create_folder` is registered with the exact same implementation.

### B. Actionable Detection: `isActionableInstruction`
- **Locations**: `backend/src/ai/planner/planner.service.ts` and `frontend/src/App.tsx`
- Added comprehensive folder creation patterns:
  - `make folder`, `create folder`, `make a folder`, `create a folder`, `new folder`
  - `create directory`, `make directory`, `make a directory`, `create a directory`, `new directory`
  - Hinglish / Hindi: `folder banao`, `folder bana do`, `folder create karo`, `folder bana de`

### C. Multi-Turn Parameter Preservation & Ambiguity Resolution
- **Location**: `backend/src/ai/planner/planner.service.ts`
- In `isAmbiguousInstruction`: Detects folder commands missing the folder name (e.g. *"Make a folder on desktop."*) and flags them as ambiguous.
- In `createPlan`: Attaches `metadata: { pending_action: 'create_directory', target_location: 'Desktop', missing_param: 'folder_name' }`.
- In `classifyIntent`: When an active ambiguous plan exists, follow-up messages (e.g. *"Jasin-Gia-test."*) are classified as `modify_plan` rather than `conversational`.
- In `modifyPlan`: Resolves the missing folder name from user input, updates the plan to a concrete 2-step plan with target `Desktop` and `create_directory` tool call, sets `is_ambiguous: false`, and prompts the user for approval.

### D. Engine Step Normalization & Synthetic Verification
- **Location**: `backend/src/ai/execution/plan-execution.engine.ts`
- Added `create_directory` / `create_folder` parameter normalization in `normalizeStepToolArgs`.
- Added `verify_directory` in `executeSyntheticStep` to perform filesystem verification on disk.

### E. Prevention of Fabricated Success Responses
- **Location**: `backend/src/ai/orchestrator/contextBuilder.ts`
- Added explicit application rules in the system prompt:
  > *"CRITICAL: NEVER claim, report, or fabricate that an operating-system, filesystem, desktop, file, or application action has succeeded unless it was actually executed by an authorized tool and confirmed in EXECUTED TOOL RESULTS."*
  > *"CRITICAL: If asked to create, delete, or modify files, folders, or desktop resources without prior tool execution, formulate an execution plan or ask for required parameters. Never claim an action is 'Done' or 'Created' without verified tool execution."*
- **Location**: `backend/src/api/routes/agent.ts` & `backend/src/conversations/services/conversation.service.ts`
  - Grounded execution messages in actual tool verification records.
  - If execution fails, the assistant reports the actual failure without claiming success.

---

## 4. Automated Verification Results

A dedicated automated test suite was created in `backend/tests/folder_creation_execution.test.ts`. All automated tests use a temporary isolated directory via `process.env.GIA_DESKTOP_DIR` to protect the real macOS Desktop.

**Test Run Output**:
```
 ✓ tests/folder_creation_execution.test.ts (10)
   ✓ GIA — Desktop Folder Creation & Truthful Execution Pipeline Tests (10)
     ✓ TEST 1: should create a new folder inside the resolved Desktop directory
     ✓ TEST 2: should verify that created directory exists on disk and detect absent ones
     ✓ TEST 3: should reject creation and throw an explicit error if folder already exists
     ✓ TEST 4: should reject invalid folder names containing slashes, null bytes, traversal, or whitespace
     ✓ TEST 5: should reject target directories outside permitted user boundaries
     ✓ TEST 6: should reject creation if parent directory does not exist
     ✓ TEST 7: should preserve parameters across multi-turn conversation and execute upon approval
     ✓ TEST 8: should reject execution without a valid authorization ticket
     ✓ TEST 9: should enforce anti-fabrication rules and prevent LLM or agent from fabricating success
     ✓ TEST 10: should honestly report execution failure if folder creation encounters a conflict or error

 Test Files  1 passed (1)
      Tests  10 passed (10)
```

**Full Regression Test Run (91 tests)**:
```
 Test Files  5 passed (5)
      Tests  91 passed (91)
   Duration  5.25s
```
- `tests/folder_creation_execution.test.ts`: 10 passed
- `tests/execution-engine.test.ts`: 24 passed
- `tests/permission-manager.test.ts`: 24 passed
- `tests/planner.test.ts`: 16 passed
- `tests/tools.test.ts`: 17 passed

Both TypeScript backend (`backend/src`) and frontend (`frontend/src`) compile with **0 errors**.

---

## 5. Manual Real Desktop Acceptance Test Instructions

To verify that GIA creates real folders on the actual macOS Desktop:

1. **Start the backend and AI services**:
   ```bash
   cd backend && npm run dev
   ```
2. **Start the Tauri application (or browser UI)**:
   ```bash
   cd frontend && npm run tauri dev
   ```
3. **Execute Test Case A (Multi-turn parameter flow)**:
   - Type or speak: `Make a folder on desktop.`
   - GIA should respond: `What would you like to name this folder?`
   - Reply: `GIA-REAL-EXECUTION-TEST`
   - GIA should present an Execution Plan for creating folder `"GIA-REAL-EXECUTION-TEST"` on Desktop.
   - Click **Approve** (or type/say `Approved`).
   - GIA executes the approved plan and confirms execution.
   - Check your macOS Desktop in Finder or Terminal:
     ```bash
     ls -la ~/Desktop/GIA-REAL-EXECUTION-TEST
     ```
     Confirm the directory exists.

4. **Execute Test Case B (One-shot command)**:
   - Type or speak: `Make a folder on desktop named GIA-ONESHOT-TEST`
   - GIA should formulate the plan directly and request approval.
   - Say or click `Approve`.
   - Confirm folder creation on `~/Desktop/GIA-ONESHOT-TEST`.

5. **Execute Test Case C (Duplicate rejection & honest error reporting)**:
   - Request to make `GIA-ONESHOT-TEST` again on desktop.
   - Approve the plan.
   - GIA should report: `❌ Plan failed during execution. Error: Directory already exists: "/Users/.../Desktop/GIA-ONESHOT-TEST"`.
   - Verify GIA does NOT claim success.

