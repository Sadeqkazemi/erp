export const STEP_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'COMPENSATING', 'COMPENSATED'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

const ALLOWED: Record<StepStatus, readonly StepStatus[]> = {
  PENDING: ['RUNNING', 'FAILED'],
  RUNNING: ['SUCCEEDED', 'FAILED'],
  SUCCEEDED: ['COMPENSATING'],
  FAILED: [],
  COMPENSATING: ['COMPENSATED', 'FAILED'],
  COMPENSATED: [],
};

export function assertStepTransition(from: StepStatus, to: StepStatus): void {
  if (!ALLOWED[from].includes(to)) throw new Error('ILLEGAL_TRANSITION');
}
