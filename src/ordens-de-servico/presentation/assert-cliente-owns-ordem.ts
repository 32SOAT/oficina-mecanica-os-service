import { ForbiddenError } from '../../common/application/errors/application.errors';

export function assertClienteOwnsOrdem(
  clienteId: string,
  ordem: { cliente_id: string },
): void {
  if (ordem.cliente_id !== clienteId) {
    throw new ForbiddenError('A ordem de serviço não pertence ao cliente.');
  }
}
