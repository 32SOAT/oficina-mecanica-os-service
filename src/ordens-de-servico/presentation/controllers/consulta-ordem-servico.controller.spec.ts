import { ConsultaOrdemServicoController } from './consulta-ordem-servico.controller';
import { StatusOrdemServico as S } from '../../domain/status-ordem-servico.enum';
import { ForbiddenError } from '../../../common/application/errors/application.errors';
import type { AuthenticatedRequest } from '../../../auth/presentation/interfaces/authenticated-request.interface';

const clienteRequest = {
  user: { sub: 'cliente-1', role: 'cliente', cpf: '52998224725' },
} as AuthenticatedRequest;

describe('ConsultaOrdemServicoController', () => {
  let controller: ConsultaOrdemServicoController;
  const findOrdemServicoByIdUseCase = { execute: jest.fn() };
  const findOrdemServicoHistoricoUseCase = { execute: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new ConsultaOrdemServicoController(
      findOrdemServicoByIdUseCase as never,
      findOrdemServicoHistoricoUseCase as never,
    );
  });

  it('retorna apenas campos seguros (sem CPF/email do cliente)', async () => {
    findOrdemServicoByIdUseCase.execute.mockResolvedValue({
      id: 'os-1',
      cliente_id: 'cliente-1',
      status: S.EmExecucao,
      valorTotal: 100,
      updatedAt: new Date('2026-05-01T18:30:00.000Z'),
      veiculo: { placa: 'ABC1D23', modelo: 'Corolla' },
      cliente: { documento: '12345678901', email: 'leak@example.com' },
    });
    findOrdemServicoHistoricoUseCase.execute.mockResolvedValue([
      {
        statusNovo: S.Recebida,
        createdAt: new Date('2026-04-30T10:00:00.000Z'),
      },
    ]);

    const result = await controller.consultarStatus(clienteRequest, 'os-1');
    const json = JSON.stringify(result);
    expect(json).not.toContain('12345678901');
    expect(json).not.toContain('leak@example.com');
    expect(result.veiculo.placa).toBe('ABC1D23');
    expect(result.linhaDoTempo).toHaveLength(1);
  });

  it('transforma valorTotal em número', async () => {
    findOrdemServicoByIdUseCase.execute.mockResolvedValue({
      id: 'os-1',
      cliente_id: 'cliente-1',
      status: S.Recebida,
      valorTotal: '850.00',
      updatedAt: new Date(),
      veiculo: { placa: 'X', modelo: 'Y' },
    });
    findOrdemServicoHistoricoUseCase.execute.mockResolvedValue([]);
    const result = await controller.consultarStatus(clienteRequest, 'os-1');
    expect(result.valorTotal).toBe(850);
  });

  it('nega status de uma OS pertencente a outro cliente antes de buscar o histórico', async () => {
    findOrdemServicoByIdUseCase.execute.mockResolvedValue({
      id: 'os-1',
      cliente_id: 'outro-cliente',
      status: S.Recebida,
    });
    await expect(
      controller.consultarStatus(clienteRequest, 'os-1'),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(findOrdemServicoHistoricoUseCase.execute).not.toHaveBeenCalled();
  });
});
