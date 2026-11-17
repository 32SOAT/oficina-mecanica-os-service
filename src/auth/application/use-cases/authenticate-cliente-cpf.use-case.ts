import { Inject, Injectable } from '@nestjs/common';
import {
  BadRequestError,
  UnauthorizedError,
} from '../../../common/application/errors/application.errors';
import {
  CLIENTE_REPOSITORY,
  ClienteRepository,
} from '../../../clientes/application/ports/cliente.repository';
import { Cpf } from '../../../clientes/domain/value-objects/cpf';
import { TOKEN_SERVICE, TokenService } from '../ports/token.service.port';

@Injectable()
export class AuthenticateClienteCpfUseCase {
  constructor(
    @Inject(CLIENTE_REPOSITORY) private readonly clientes: ClienteRepository,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenService,
  ) {}

  async execute(rawCpf: string): Promise<{ token: string }> {
    if (!rawCpf?.trim() || !Cpf.isValid(rawCpf)) {
      throw new BadRequestError('CPF inválido.');
    }

    const cpf = Cpf.normalize(rawCpf);
    const cliente = await this.clientes.findByDocumento(cpf);
    if (!cliente?.id || cliente.deletedAt !== null) {
      throw new UnauthorizedError('Cliente não encontrado ou inativo.');
    }

    return {
      token: this.tokens.sign({ sub: cliente.id, cpf, role: 'cliente' }),
    };
  }
}
