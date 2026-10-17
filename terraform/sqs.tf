# Fila de comandos do billing (CreateBudget, RequestPayment, CancelBudget,
# RefundPayment) — publicada pelo orquestrador do os-service.
resource "aws_sqs_queue" "commands_dlq" {
  name                      = "${local.prefix}-billing-commands-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "commands" {
  name                       = "${local.prefix}-billing-commands"
  visibility_timeout_seconds = 60 # chamadas ao Mercado Pago podem levar alguns segundos
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.commands_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "commands_dlq" {
  queue_url = aws_sqs_queue.commands_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.commands.arn]
  })
}
