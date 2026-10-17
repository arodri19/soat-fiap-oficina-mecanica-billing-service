# language: pt
Funcionalidade: Orçamento e pagamento da OS na saga
  Como billing-service, participante da saga orquestrada pelo os-service
  Quero gerar o orçamento, cobrar via Mercado Pago e compensar quando pedido
  Para que nenhuma OS fique cobrada sem execução nem executada sem pagamento

  Contexto:
    Dado que o os-service abriu a OS 42 com "Troca de Óleo" de R$ 80.00 e 2 "Óleo 5W40" de R$ 45.00

  Cenário: Orçamento aprovado e pago no Mercado Pago
    Quando o comando "CreateBudget" chega na fila do billing
    Então a resposta "BudgetCreated" é publicada com total de R$ 170.00
    Quando o comando "RequestPayment" chega na fila do billing
    Então a resposta "PaymentRequested" é publicada com o link de pagamento
    E o orçamento fica "APPROVED"
    Quando o Mercado Pago notifica o pagamento como "approved"
    Então a resposta "PaymentConfirmed" é publicada
    E a cobrança fica "APPROVED"

  Cenário: Cartão recusado gera falha para a saga compensar
    Quando o comando "CreateBudget" chega na fila do billing
    E o comando "RequestPayment" chega na fila do billing
    E o Mercado Pago notifica o pagamento como "rejected"
    Então a resposta "PaymentFailed" é publicada
    Quando o comando "CancelBudget" chega na fila do billing
    Então a resposta "BudgetCancelled" é publicada
    E o orçamento fica "CANCELLED"

  Cenário: Estorno como compensação depois da execução ser recusada
    Quando o comando "CreateBudget" chega na fila do billing
    E o comando "RequestPayment" chega na fila do billing
    E o Mercado Pago notifica o pagamento como "approved"
    E o comando "RefundPayment" chega na fila do billing
    Então a resposta "PaymentRefunded" é publicada
    E a cobrança fica "REFUNDED"
    E o orçamento fica "CANCELLED"

  Cenário: Comando reentregue pelo SQS não duplica o orçamento
    Quando o comando "CreateBudget" chega na fila do billing
    E o comando "CreateBudget" chega na fila do billing
    Então existe apenas 1 orçamento para a OS 42
