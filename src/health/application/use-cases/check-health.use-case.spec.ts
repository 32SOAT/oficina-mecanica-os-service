import { ConfigService } from '@nestjs/config';
import { ConfigType } from '../../../config/config.module';
import { CheckHealthUseCase } from './check-health.use-case';

describe('CheckHealthUseCase', () => {
  it('returns status ok, the service name and an iso timestamp', () => {
    const configService = {
      get: jest.fn().mockReturnValue('os-service'),
    } as unknown as ConfigService<ConfigType, true>;
    const useCase = new CheckHealthUseCase(configService);
    const result = useCase.execute();

    expect(result.status).toBe('ok');
    expect(result.service).toBe('os-service');
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });
});
