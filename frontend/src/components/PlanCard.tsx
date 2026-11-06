import React, { useState } from 'react';
import * as api from '../services/api.js';

interface PlanCardProps {
  plan: api.ExecutionPlan;
  execution?: api.PlanExecutionResult | null;
  isLoading?: boolean;
  onApprove: (planId: string, version: number) => Promise<void>;
  onReject: (planId: string) => Promise<void>;
  onModify: (planId: string, feedback: string) => Promise<void>;
  onCancel: (planId: string) => Promise<void>;
  onExecute: (planId: string, version: number) => Promise<void>;
}

export const PlanCard: React.FC<PlanCardProps> = ({
  plan,
  execution,
  isLoading = false,
  onApprove,
  onReject,
  onModify,
  onCancel,
  onExecute,
}) => {
  const [showModifyInput, setShowModifyInput] = useState(false);
  const [modifyFeedback, setModifyFeedback] = useState('');
  const [isModifying, setIsModifying] = useState(false);
  const [showProgress, setShowProgress] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);

  const status = plan.status;
  const isAwaitingApproval = status === 'awaiting_approval' || status === 'pending';
  const isApproved = status === 'approved';
  const isExecuting = status === 'executing';
  const isCompleted = status === 'completed';
  const isFailed = status === 'failed';
  const isCancelled = status === 'cancelled';
  const isRejected = status === 'rejected';
  const isExpired = status === 'expired';

  async function handleApproveClick() {
    setActionError(null);
    try {
      await onApprove(plan.id, plan.version);
    } catch (err: any) {
      setActionError(err.message || 'Failed to approve plan.');
    }
  }

  async function handleRejectClick() {
    setActionError(null);
    try {
      await onReject(plan.id);
    } catch (err: any) {
      setActionError(err.message || 'Failed to reject plan.');
    }
  }

  async function handleCancelClick() {
    setActionError(null);
    try {
      await onCancel(plan.id);
    } catch (err: any) {
      setActionError(err.message || 'Failed to cancel plan.');
    }
  }

  async function handleExecuteClick() {
    setActionError(null);
    try {
      await onExecute(plan.id, plan.version);
    } catch (err: any) {
      setActionError(err.message || 'Failed to execute plan.');
    }
  }

  async function handleModifySubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!modifyFeedback.trim()) return;
    setActionError(null);
    setIsModifying(true);
    try {
      await onModify(plan.id, modifyFeedback.trim());
      setModifyFeedback('');
      setShowModifyInput(false);
    } catch (err: any) {
      setActionError(err.message || 'Failed to modify plan.');
    } finally {
      setIsModifying(false);
    }
  }

  function getRiskBadge(risk: api.RiskLevel) {
    switch (risk) {
      case 'critical':
        return <span className="risk-badge risk-critical">🔴 Critical Risk</span>;
      case 'high':
        return <span className="risk-badge risk-high">🟠 High Risk</span>;
      case 'medium':
        return <span className="risk-badge risk-medium">🟡 Medium Risk</span>;
      case 'low':
      default:
        return <span className="risk-badge risk-low">🟢 Low Risk</span>;
    }
  }

  function getStatusBadge() {
    if (isAwaitingApproval) {
      return <span className="plan-status-badge status-pending">⏳ Awaiting Approval</span>;
    }
    if (isApproved) {
      return <span className="plan-status-badge status-approved">✅ Approved</span>;
    }
    if (isExecuting) {
      return <span className="plan-status-badge status-executing">⚡ Executing...</span>;
    }
    if (isCompleted) {
      return <span className="plan-status-badge status-completed">🎉 Completed</span>;
    }
    if (isFailed) {
      return <span className="plan-status-badge status-failed">❌ Failed</span>;
    }
    if (isCancelled) {
      return <span className="plan-status-badge status-cancelled">🚫 Cancelled</span>;
    }
    if (isRejected) {
      return <span className="plan-status-badge status-rejected">⛔ Rejected</span>;
    }
    if (isExpired) {
      return <span className="plan-status-badge status-expired">⏰ Expired</span>;
    }
    return <span className="plan-status-badge">{status}</span>;
  }

  return (
    <div className={`gia-plan-card backdrop-blur ${status}`}>
      {/* Header & Meta */}
      <div className="plan-card-header">
        <div className="plan-header-top">
          <div className="plan-meta-tags">
            <span className="plan-id-tag" title={plan.id}>
              Plan ID: {plan.id.slice(0, 8)}... (v{plan.version})
            </span>
            <span className="steps-count-tag">{plan.steps.length} atomic steps</span>
          </div>
          {getStatusBadge()}
        </div>

        <h3 className="plan-objective">
          <span className="plan-icon">📋</span> {plan.objective}
        </h3>
      </div>

      {actionError && (
        <div className="plan-alert plan-alert-error">
          ⚠️ {actionError}
        </div>
      )}

      {/* Ordered Step List */}
      <div className="plan-steps-container">
        <h4 className="steps-heading">Proposed Action Sequence:</h4>
        <div className="plan-steps-list">
          {plan.steps.map((step) => {
            // Match with live execution record if present
            const stepRecord = execution?.stepRecords.find((r) => r.stepId === step.step_id);
            const stepStatus = stepRecord?.status || (isCompleted ? 'completed' : 'pending');

            return (
              <div
                key={step.step_id}
                className={`plan-step-item status-${stepStatus} ${isExecuting && stepStatus === 'running' ? 'step-running' : ''}`}
              >
                <div className="step-num-col">
                  <div className="step-num-bubble">
                    {stepStatus === 'completed' && '✓'}
                    {stepStatus === 'running' && <span className="step-spinner" />}
                    {stepStatus === 'failed' && '✕'}
                    {stepStatus === 'pending' && step.step_id}
                    {stepStatus === 'cancelled' && '⊘'}
                  </div>
                </div>

                <div className="step-details-col">
                  <div className="step-title-row">
                    <span className="step-action-name">{step.description}</span>
                    <div className="step-tags">
                      {getRiskBadge(step.risk_level)}
                      {step.target && (
                        <span className="resource-tag" title="Affected Resource">
                          🎯 {step.target}
                        </span>
                      )}
                      {step.tool_name && (
                        <span className="tool-tag" title="Executing Tool">
                          🔧 {step.tool_name}
                        </span>
                      )}
                    </div>
                  </div>

                  {step.expected_outcome && (
                    <div className="step-outcome-row">
                      <span className="outcome-label">Expected:</span> {step.expected_outcome}
                    </div>
                  )}

                  {step.depends_on && step.depends_on.length > 0 && (
                    <div className="step-deps-row">
                      <span>🔗 Prerequisite: Step {step.depends_on.join(', ')}</span>
                    </div>
                  )}

                  {/* Verification Status */}
                  {stepRecord?.verification && (
                    <div className="step-verification-pill verified">
                      <span className="pill-dot" />
                      <span>{stepRecord.verification.message}</span>
                    </div>
                  )}

                  {/* Step Error Details */}
                  {stepRecord?.error && (
                    <div className="step-error-box">
                      ❌ <strong>Error:</strong> {stepRecord.error}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Live Execution Progress Overview */}
      {(isExecuting || isCompleted || isFailed || isCancelled) && execution && (
        <div className="execution-progress-bar-container">
          <div className="progress-header">
            <span>
              Execution Progress ({execution.completedSteps}/{execution.totalSteps} steps completed)
            </span>
            <button
              type="button"
              className="toggle-progress-btn"
              onClick={() => setShowProgress(!showProgress)}
            >
              {showProgress ? 'Hide Telemetry ▲' : 'Show Telemetry ▼'}
            </button>
          </div>

          <div className="progress-track">
            <div
              className={`progress-fill ${execution.status}`}
              style={{
                width: `${Math.round((execution.completedSteps / Math.max(execution.totalSteps, 1)) * 100)}%`,
              }}
            />
          </div>

          {execution.errorMessage && (
            <div className="execution-error-msg">
              <strong>Execution Aborted:</strong> {execution.errorMessage}
            </div>
          )}
        </div>
      )}

      {/* Inline Modification Input */}
      {showModifyInput && (
        <form onSubmit={handleModifySubmit} className="modify-plan-form">
          <input
            type="text"
            className="modify-input"
            placeholder='e.g., "Also open YouTube" or "Remove step 2"'
            value={modifyFeedback}
            onChange={(e) => setModifyFeedback(e.target.value)}
            disabled={isModifying}
            autoFocus
          />
          <div className="modify-btns-group">
            <button type="submit" className="modify-submit-btn" disabled={isModifying}>
              {isModifying ? 'Updating Plan...' : 'Apply Modification'}
            </button>
            <button
              type="button"
              className="modify-cancel-btn"
              onClick={() => setShowModifyInput(false)}
              disabled={isModifying}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Plan Controls Bar */}
      <div className="plan-card-controls">
        {isAwaitingApproval && (
          <>
            <button
              type="button"
              className="btn-approve-plan"
              onClick={handleApproveClick}
              disabled={isLoading}
              title="Explicitly approve this plan and issue execution ticket"
            >
              {isLoading ? 'Approving...' : '✓ Approve Plan'}
            </button>

            <button
              type="button"
              className="btn-modify-plan"
              onClick={() => setShowModifyInput(!showModifyInput)}
              disabled={isLoading}
              title="Instruct GIA to adjust or reorder steps"
            >
              ✏️ Modify Plan
            </button>

            <button
              type="button"
              className="btn-reject-plan"
              onClick={handleRejectClick}
              disabled={isLoading}
              title="Reject this plan and forbid execution"
            >
              ✕ Reject Plan
            </button>
          </>
        )}

        {isApproved && (
          <>
            <button
              type="button"
              className="btn-execute-approved"
              onClick={handleExecuteClick}
              disabled={isLoading}
              title="Execute approved plan sequence"
            >
              {isLoading ? 'Starting...' : '⚡ Run Approved Plan'}
            </button>

            <button
              type="button"
              className="btn-cancel-plan"
              onClick={handleCancelClick}
              disabled={isLoading}
              title="Revoke approval and cancel"
            >
              Cancel Plan
            </button>
          </>
        )}

        {isExecuting && (
          <button
            type="button"
            className="btn-cancel-plan active-exec"
            onClick={handleCancelClick}
            disabled={isLoading}
            title="Immediately halt in-flight step execution"
          >
            ⏹️ Abort Execution
          </button>
        )}

        {(isCompleted || isFailed || isCancelled || isRejected || isExpired) && (
          <div className="plan-finished-status-label">
            {isCompleted && '✨ Plan execution completed and verified.'}
            {isFailed && '⚠️ Plan execution failed. Re-planning required.'}
            {isCancelled && 'Plan was cancelled by user.'}
            {isRejected && 'Plan was rejected and cannot be executed.'}
            {isExpired && 'Plan approval expired. Fresh plan required.'}
          </div>
        )}
      </div>
    </div>
  );
};

