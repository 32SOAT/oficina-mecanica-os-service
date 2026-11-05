# language: pt
Funcionalidade: Fluxo da ordem entre OS, execução e billing

  Cenário: O veículo só sai depois do pagamento aprovado
    Dado uma ordem recebida com peça em estoque
    Quando o administrador inicia o diagnóstico
    E o administrador gera o orçamento
    E o cliente aprova o orçamento
    E o administrador inicia a execução
    E o administrador finaliza a ordem
    Então a ordem fica "FINALIZADA"
    E o pagamento no billing fica "PENDENTE"
    E o billing guarda o mesmo valor total da ordem
    E o diagnóstico e o reparo estão concluídos na execução
    Quando o administrador tenta entregar o veículo
    Então a entrega é recusada e a ordem continua "FINALIZADA"
    Quando o pagamento é confirmado
    E o administrador entrega o veículo
    Então a ordem fica "ENTREGUE"
    E o pagamento no billing fica "APROVADO"
    E o orçamento no billing fica "APROVADO"

  Cenário: Pagamento recusado bloqueia a entrega
    Dado uma ordem finalizada com pagamento pendente
    Quando o pagamento é recusado
    E o administrador tenta entregar o veículo
    Então a entrega é recusada e a ordem continua "FINALIZADA"
    E o pagamento no billing fica "RECUSADO"

  Cenário: A reposição da peça libera a ordem para o serviço
    Dado uma ordem aguardando peça
    Quando o administrador repõe a peça em falta
    Então a ordem fica "AGUARDANDO_SERVICO"

  Cenário: Sem peça disponível a execução não começa
    Dado uma ordem em diagnóstico sem peça disponível
    Quando o administrador gera o orçamento
    E o cliente aprova o orçamento
    Então a ordem fica "AGUARDANDO_PECAS_INSUMOS"
    E o orçamento no billing fica "APROVADO"
    Quando o administrador tenta iniciar a execução
    Então a execução é recusada e a ordem continua "AGUARDANDO_PECAS_INSUMOS"

  Cenário: Orçamento reprovado pode ser cancelado
    Dado uma ordem aguardando aprovação
    Quando o cliente reprova o orçamento
    Então a ordem fica "REPROVADA"
    E o orçamento no billing fica "REPROVADO"
    Quando o administrador cancela a ordem
    Então a ordem fica "CANCELADA"
