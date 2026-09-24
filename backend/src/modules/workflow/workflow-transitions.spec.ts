import { assertWorkflowTransition } from './workflow-transitions';

describe('workflow engine transitions', () => {
  it('allows the engine to start and complete without storing a business decision', () => {
    expect(() => assertWorkflowTransition('PENDING', 'RUNNING')).not.toThrow();
    expect(() => assertWorkflowTransition('RUNNING', 'COMPLETED')).not.toThrow();
  });

  it('rejects an illegal transition', () => {
    expect(() => assertWorkflowTransition('PENDING', 'COMPLETED')).toThrow('ILLEGAL_TRANSITION');
  });
});
