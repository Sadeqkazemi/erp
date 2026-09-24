import { assertStepTransition } from './step-transitions';

describe('persistent workflow steps', () => {
  it('requires a running step before success and compensation before compensated', () => {
    expect(() => assertStepTransition('PENDING', 'RUNNING')).not.toThrow();
    expect(() => assertStepTransition('RUNNING', 'SUCCEEDED')).not.toThrow();
    expect(() => assertStepTransition('SUCCEEDED', 'COMPENSATING')).not.toThrow();
    expect(() => assertStepTransition('COMPENSATING', 'COMPENSATED')).not.toThrow();
  });

  it('rejects skipping execution or changing a terminal step', () => {
    expect(() => assertStepTransition('PENDING', 'SUCCEEDED')).toThrow('ILLEGAL_TRANSITION');
    expect(() => assertStepTransition('FAILED', 'SUCCEEDED')).toThrow('ILLEGAL_TRANSITION');
    expect(() => assertStepTransition('COMPENSATED', 'RUNNING')).toThrow('ILLEGAL_TRANSITION');
  });
});
