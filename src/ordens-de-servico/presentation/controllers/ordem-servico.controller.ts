import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiResponse,
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  ApiAcceptedDataResponse,
  ApiDataResponse,
} from '../../../common/decorators/swagger-response.decorator';
import { type AuthenticatedRequest } from '../../../auth/presentation/interfaces/authenticated-request.interface';
import { Roles } from '../../../auth/presentation/decorators/roles.decorator';
import { AvancarStatusOrdemServicoUseCase } from '../../application/use-cases/avancar-status-ordem-servico.use-case';
import { CreateOrdemServicoUseCase } from '../../application/use-cases/create-ordem-servico.use-case';
import { FindAllOrdensServicoUseCase } from '../../application/use-cases/find-all-ordens-servico.use-case';
import { FindOrdemServicoByIdUseCase } from '../../application/use-cases/find-ordem-servico-by-id.use-case';
import { FindOrdemServicoHistoricoUseCase } from '../../application/use-cases/find-ordem-servico-historico.use-case';
import { SubstituirItensOrdemServicoUseCase } from '../../application/use-cases/substituir-itens-ordem-servico.use-case';
import { TransicionarOrdemServicoUseCase } from '../../application/use-cases/transicionar-ordem-servico.use-case';
import { StatusOrdemServico } from '../../domain/status-ordem-servico.enum';
import { AvancarStatusDto } from '../dto/avancar-status.dto';
import { CriarOrdemServicoDto } from '../dto/criar-ordem-servico.dto';
import { EditarItensOsDto } from '../dto/editar-itens-os.dto';
import { FiltrosOrdemServicoDto } from '../dto/filtros-ordem-servico.dto';
import { HistoricoStatusResponseDto } from '../dto/historico-status-response.dto';
import { OrdemServicoResponseDto } from '../dto/ordem-servico-response.dto';
import { SagaClient } from '../../../saga/saga.client';
import { OrdemServicoPresentationMapper } from '../mappers/ordem-servico-presentation.mapper';
import { SagaQueryService } from '../../../saga/saga-query.service';
import {
  SagaAcceptedResponseDto,
  SagaStatusResponseDto,
} from '../../../saga/presentation/saga-status-response.dto';
import { SagaAcceptedResponse } from '../../../saga/saga.client';

@ApiBearerAuth('JWT-auth')
@ApiTags('Ordens de Serviço (admin)')
@Controller('ordens')
export class OrdemServicoController {
  constructor(
    private readonly createOrdemServicoUseCase: CreateOrdemServicoUseCase,
    private readonly findAllOrdensServicoUseCase: FindAllOrdensServicoUseCase,
    private readonly findOrdemServicoByIdUseCase: FindOrdemServicoByIdUseCase,
    private readonly findOrdemServicoHistoricoUseCase: FindOrdemServicoHistoricoUseCase,
    private readonly transicionarOrdemServicoUseCase: TransicionarOrdemServicoUseCase,
    private readonly substituirItensOrdemServicoUseCase: SubstituirItensOrdemServicoUseCase,
    private readonly avancarStatusOrdemServicoUseCase: AvancarStatusOrdemServicoUseCase,
    private readonly saga: SagaClient,
    private readonly sagaQuery: SagaQueryService,
  ) {}

  @Post()
  async criar(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CriarOrdemServicoDto,
  ) {
    const os = await this.createOrdemServicoUseCase.execute(
      OrdemServicoPresentationMapper.toCreateInput(dto),
      req.user.sub,
    );
    return OrdemServicoResponseDto.fromReadModel(os);
  }

  @Get()
  @ApiOperation({
    summary: 'Listar ordens de serviço',
    description:
      'Listagem operacional: exclui OS finalizadas, entregues e canceladas (use query `status` para incluí-las). ' +
      'Ordenação: Em Execução → Aguardando Serviço → Aguardando Peças/Insumos → Aguardando Aprovação → Diagnóstico → Recebida; dentro de cada status, mais antigas primeiro.',
  })
  async listar(@Query() filtros: FiltrosOrdemServicoDto) {
    const result = await this.findAllOrdensServicoUseCase.execute(
      OrdemServicoPresentationMapper.toFiltrosInput(filtros),
    );
    return {
      data: result.data.map((item) =>
        OrdemServicoResponseDto.fromReadModel(item),
      ),
      meta: result.meta,
    };
  }

  @Get(':id')
  async detalhar(@Param('id', ParseUUIDPipe) id: string) {
    const os = await this.findOrdemServicoByIdUseCase.execute(id);
    return OrdemServicoResponseDto.fromReadModel(os);
  }

  @Get(':id/historico')
  async historico(@Param('id', ParseUUIDPipe) id: string) {
    const historico = await this.findOrdemServicoHistoricoUseCase.execute(id);
    return historico.map((item) =>
      HistoricoStatusResponseDto.fromReadModel(item),
    );
  }

  @Get(':id/sagas/:sagaId')
  @ApiOperation({
    summary: 'Consultar uma execução da Saga da ordem',
    description:
      'Exige autenticação. O retorno apresenta o estado técnico e as etapas sem expor os envelopes SQS.',
  })
  @ApiDataResponse(
    SagaStatusResponseDto,
    200,
    'Estado técnico da Saga e suas etapas ordenadas',
  )
  @ApiResponse({
    status: 404,
    description: 'Saga não encontrada para esta OS.',
  })
  async consultarSaga(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sagaId', ParseUUIDPipe) sagaId: string,
  ) {
    return SagaStatusResponseDto.fromReadModel(
      await this.sagaQuery.get(id, sagaId),
    );
  }

  @Post(':id/iniciar-diagnostico')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Iniciar diagnóstico',
    description:
      'Persiste a ação e retorna 202. A OS muda para EM_DIAGNOSTICO depois do resultado da Execução.',
  })
  @ApiAcceptedDataResponse(SagaAcceptedResponseDto)
  @ApiResponse({
    status: 409,
    description: 'Já existe uma Saga ativa para a OS.',
  })
  async iniciarDiagnostico(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.saga.abrirDiagnostico(id, req.user.sub);
  }

  @Patch(':id/itens')
  async substituirItensEmDiagnostico(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditarItensOsDto,
  ) {
    const os = await this.substituirItensOrdemServicoUseCase.execute(
      id,
      OrdemServicoPresentationMapper.toEditarItensInput(dto),
      req.user.sub,
    );
    return OrdemServicoResponseDto.fromReadModel(os);
  }

  @Post(':id/gerar-orcamento')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Gerar orçamento',
    description:
      'Conclui o diagnóstico e solicita o orçamento por SQS. O status da OS muda após os resultados das duas etapas.',
  })
  @ApiAcceptedDataResponse(SagaAcceptedResponseDto)
  @ApiResponse({
    status: 409,
    description: 'Já existe uma Saga ativa para a OS.',
  })
  async gerarOrcamento(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.saga.gerarOrcamento(id, req.user.sub);
  }

  @Roles('cliente')
  @Post(':id/aprovar-orcamento')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedDataResponse(SagaAcceptedResponseDto)
  @ApiResponse({
    status: 409,
    description: 'Já existe uma Saga ativa para a OS.',
  })
  @ApiOperation({
    summary: 'Aprovar orçamento (cliente)',
    description:
      'Exige JWT com role cliente (Lambda POST /auth/cpf). Aceita a decisão via SQS e retorna 202; o status da OS muda depois do resultado. O histórico grava o sub do token em usuario_id.',
  })
  @ApiResponse({
    status: 401,
    description: 'Token ausente, inválido ou expirado.',
  })
  @ApiResponse({
    status: 403,
    description: 'Token autenticado, mas o perfil não é cliente.',
  })
  async aprovarOrcamento(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.saga.aprovarOrcamento(id, req.user.sub);
  }

  @Roles('cliente')
  @Post(':id/reprovar-orcamento')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedDataResponse(SagaAcceptedResponseDto)
  @ApiResponse({
    status: 409,
    description: 'Já existe uma Saga ativa para a OS.',
  })
  @ApiOperation({
    summary: 'Reprovar orçamento (cliente)',
    description:
      'Exige JWT com role cliente (Lambda POST /auth/cpf). Aceita a decisão via SQS e retorna 202; a OS estorna reservas e muda o status depois do resultado. O histórico grava o sub do token em usuario_id.',
  })
  @ApiResponse({
    status: 401,
    description: 'Token ausente, inválido ou expirado.',
  })
  @ApiResponse({
    status: 403,
    description: 'Token autenticado, mas o perfil não é cliente.',
  })
  async reprovarOrcamento(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.saga.reprovarOrcamento(id, req.user.sub);
  }

  @Post(':id/iniciar-execucao')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Iniciar execução',
    description:
      'Solicita a abertura do reparo por SQS e retorna 202. A baixa de estoque e a mudança de status ocorrem depois do resultado.',
  })
  @ApiAcceptedDataResponse(SagaAcceptedResponseDto)
  @ApiResponse({
    status: 409,
    description: 'Já existe uma Saga ativa para a OS.',
  })
  async iniciarExecucao(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.saga.iniciarReparo(id, req.user.sub);
  }

  @Post(':id/finalizar')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Finalizar reparo',
    description:
      'Conclui o reparo e abre o pagamento local pendente no Billing por SQS. Retorna 202 até as duas etapas terminarem.',
  })
  @ApiAcceptedDataResponse(SagaAcceptedResponseDto)
  @ApiResponse({
    status: 409,
    description: 'Já existe uma Saga ativa para a OS.',
  })
  async finalizar(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.saga.finalizar(id, req.user.sub);
  }

  @Post(':id/entregar')
  async entregar(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.saga.exigirPagamentoAprovado(id);
    const os = await this.transicionarOrdemServicoUseCase.execute(
      id,
      StatusOrdemServico.Entregue,
      req.user.sub,
    );
    return OrdemServicoResponseDto.fromReadModel(os);
  }

  @Post(':id/cancelar')
  async cancelar(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const os = await this.transicionarOrdemServicoUseCase.execute(
      id,
      StatusOrdemServico.Cancelada,
      req.user.sub,
    );
    return OrdemServicoResponseDto.fromReadModel(os);
  }

  @Post(':id/avancar-status')
  @ApiOperation({
    summary: 'Avançar status de uma ordem',
    description:
      'Transições que dependem de Billing ou Execução respondem 202 com os identificadores da Saga. Transições locais respondem 201 com a OS atualizada.',
  })
  @ApiExtraModels(SagaAcceptedResponseDto, OrdemServicoResponseDto)
  @ApiResponse({
    status: 202,
    description: 'Transição remota aceita; consulte a Saga até a conclusão.',
    schema: {
      type: 'object',
      properties: {
        data: { $ref: getSchemaPath(SagaAcceptedResponseDto) },
      },
      required: ['data'],
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Transição local concluída.',
    schema: {
      type: 'object',
      properties: {
        data: { $ref: getSchemaPath(OrdemServicoResponseDto) },
      },
      required: ['data'],
    },
  })
  @ApiResponse({
    status: 409,
    description: 'Já existe uma Saga ativa para a OS.',
  })
  async avancar(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AvancarStatusDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    let accepted: SagaAcceptedResponse | null = null;
    switch (body.novoStatus) {
      case StatusOrdemServico.EmDiagnostico:
        accepted = await this.saga.abrirDiagnostico(id, req.user.sub);
        break;
      case StatusOrdemServico.AguardandoAprovacao:
        accepted = await this.saga.gerarOrcamento(id, req.user.sub);
        break;
      case StatusOrdemServico.Aprovada:
        accepted = await this.saga.aprovarOrcamento(id, req.user.sub);
        break;
      case StatusOrdemServico.Reprovada:
        accepted = await this.saga.reprovarOrcamento(id, req.user.sub);
        break;
      case StatusOrdemServico.EmExecucao:
        accepted = await this.saga.iniciarReparo(id, req.user.sub);
        break;
      case StatusOrdemServico.Finalizada:
        accepted = await this.saga.finalizar(id, req.user.sub);
        break;
      case StatusOrdemServico.Entregue:
        await this.saga.exigirPagamentoAprovado(id);
        break;
      default:
        break;
    }
    if (accepted) {
      response.status(HttpStatus.ACCEPTED);
      return accepted;
    }
    const os = await this.avancarStatusOrdemServicoUseCase.execute(
      id,
      body.novoStatus,
      req.user.sub,
    );
    return OrdemServicoResponseDto.fromReadModel(os);
  }
}
