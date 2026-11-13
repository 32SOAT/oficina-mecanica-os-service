import {
  BadRequestError,
  UnauthorizedError,
} from '../../../common/application/errors/application.errors';
import { Cliente } from '../../../clientes/domain/cliente';
import { AuthenticateClienteCpfUseCase } from './authenticate-cliente-cpf.use-case';

describe('AuthenticateClienteCpfUseCase', () => {
  const repository = { findByDocumento: jest.fn() };
  const tokenService = { sign: jest.fn().mockReturnValue('cliente-jwt') };
  const cliente = Cliente.create({
    id: 'cliente-1',
    documento: '52998224725',
    nome: 'Cliente',
    email: 'cliente@example.com',
    celularNumero: '11999999999',
  });
  let useCase: AuthenticateClienteCpfUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new AuthenticateClienteCpfUseCase(
      repository as never,
      tokenService,
    );
  });

  it('emite JWT de cliente para CPF ativo e normalizado', async () => {
    repository.findByDocumento.mockResolvedValue(cliente);
    await expect(useCase.execute('529.982.247-25')).resolves.toEqual({
      token: 'cliente-jwt',
    });
    expect(repository.findByDocumento).toHaveBeenCalledWith('52998224725');
    expect(tokenService.sign).toHaveBeenCalledWith({
      sub: 'cliente-1',
      cpf: '52998224725',
      role: 'cliente',
    });
  });

  it.each(['', '111.111.111-11', '12345678000195'])(
    'rejeita CPF ausente, inválido ou CNPJ: %s',
    async (cpf) => {
      await expect(useCase.execute(cpf)).rejects.toBeInstanceOf(
        BadRequestError,
      );
      expect(repository.findByDocumento).not.toHaveBeenCalled();
    },
  );

  it('não emite JWT para cliente inexistente', async () => {
    repository.findByDocumento.mockResolvedValue(null);
    await expect(useCase.execute('52998224725')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(tokenService.sign).not.toHaveBeenCalled();
  });

  it('não emite JWT para cliente excluído', async () => {
    repository.findByDocumento.mockResolvedValue(
      Cliente.create({
        id: 'cliente-1',
        documento: '52998224725',
        nome: 'Cliente',
        email: 'cliente@example.com',
        celularNumero: '11999999999',
        deletedAt: new Date(),
      }),
    );
    await expect(useCase.execute('52998224725')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(tokenService.sign).not.toHaveBeenCalled();
  });
});
