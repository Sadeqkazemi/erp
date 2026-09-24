export const WORKFLOW_STATUSES = [
  'PENDING',
  'RUNNING',
  'WAITING',
  'COMPLETED',
  'FAILED',
  'COMPENSATING',
  'COMPENSATED',
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

const ALLOWED: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  PENDING: ['RUNNING'],
  RUNNING: ['WAITING', 'COMPLETED', 'FAILED', 'COMPENSATING'],
  WAITING: ['RUNNING', 'FAILED', 'COMPENSATING'],
  COMPENSATING: ['COMPENSATED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  COMPENSATED: [],
};

export function assertWorkflowTransition(from: WorkflowStatus, to: WorkflowStatus): void {
  if (!ALLOWED[from].includes(to)) {
    throw new Error('ILLEGAL_TRANSITION');
  }
}
