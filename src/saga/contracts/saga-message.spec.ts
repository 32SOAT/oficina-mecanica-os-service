import {
  isSagaCommandMessage,
  isSagaResultMessage,
  SagaCommandType,
  SagaStepStatus,
} from './saga-message';

const envelope = {
  messageId: '7d9f9748-b2d2-46ab-8106-fd5dad738b19',
  commandId: 'a707820e-fbe3-483a-b5ae-3a69a3eb947c',
  sagaId: 'dc0bfdd8-f0b9-48eb-8231-9e66297554f8',
  osId: '9abeb153-d57f-4a92-b32a-918fc9e4abc0',
  occurredAt: '2026-11-07T12:00:00.000Z',
  correlationId: 'request-1',
  causationId: null,
  schemaVersion: 1,
};

describe('Saga message contracts', () => {
  it('accepts a version 1 command with the payload required by its type', () => {
    expect(
      isSagaCommandMessage({
        ...envelope,
        type: SagaCommandType.BillingQuoteGenerate,
        payload: { valorTotal: 125.5 },
      }),
    ).toBe(true);
  });

  it('rejects a command whose payload does not match its type', () => {
    expect(
      isSagaCommandMessage({
        ...envelope,
        type: SagaCommandType.BillingQuoteGenerate,
        payload: {},
      }),
    ).toBe(false);
  });

  it('rejects non-UUID identifiers persisted in UUID columns', () => {
    expect(
      isSagaCommandMessage({
        ...envelope,
        messageId: 'not-a-uuid',
        type: SagaCommandType.ExecutionOpen,
        payload: { etapa: 'DIAGNOSTICO' },
      }),
    ).toBe(false);
  });

  it('rejects commands from an unsupported schema version', () => {
    expect(
      isSagaCommandMessage({
        ...envelope,
        schemaVersion: 2,
        type: SagaCommandType.ExecutionOpen,
        payload: { etapa: 'DIAGNOSTICO' },
      }),
    ).toBe(false);
  });

  it('does not accept values that Joi would only make valid by coercion', () => {
    expect(
      isSagaCommandMessage({
        ...envelope,
        schemaVersion: '1',
        type: SagaCommandType.BillingQuoteGenerate,
        payload: { valorTotal: '125.50' },
      }),
    ).toBe(false);
  });

  it('accepts a successful result correlated to a command', () => {
    expect(
      isSagaResultMessage({
        ...envelope,
        type: 'SAGA_STEP_RESULT',
        outcome: SagaStepStatus.Concluida,
        payload: {},
      }),
    ).toBe(true);
  });

  it('requires retry metadata when a result reports a failure', () => {
    expect(
      isSagaResultMessage({
        ...envelope,
        type: 'SAGA_STEP_RESULT',
        outcome: SagaStepStatus.Falha,
        payload: { code: 'BILLING_UNAVAILABLE', message: 'Indisponível' },
      }),
    ).toBe(false);
  });
});
