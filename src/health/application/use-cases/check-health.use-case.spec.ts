import { CheckHealthUseCase } from './check-health.use-case';

describe('CheckHealthUseCase', () => {
  it('returns status ok and an iso timestamp', () => {
    const result = new CheckHealthUseCase().execute();

    expect(result.status).toBe('ok');
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });
});
