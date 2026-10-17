# Menor privilégio: consome só a própria fila, publica só na fila de respostas
# da saga e acessa só a própria tabela.
data "aws_iam_policy_document" "billing" {
  statement {
    sid = "ConsumeBillingCommands"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueUrl",
      "sqs:GetQueueAttributes"
    ]
    resources = [aws_sqs_queue.commands.arn]
  }

  statement {
    sid       = "PublishSagaReplies"
    actions   = ["sqs:SendMessage", "sqs:GetQueueUrl"]
    resources = ["arn:aws:sqs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:${local.prefix}-os-saga-replies"]
  }

  statement {
    sid = "BillingTable"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query"
    ]
    resources = [
      aws_dynamodb_table.billing.arn,
      "${aws_dynamodb_table.billing.arn}/index/*"
    ]
  }
}

resource "aws_iam_policy" "billing" {
  name        = "${local.prefix}-billing-service"
  description = "Acesso do billing-service à sua fila SQS e tabela DynamoDB"
  policy      = data.aws_iam_policy_document.billing.json
}

resource "aws_iam_role_policy_attachment" "billing_nodes" {
  role       = data.terraform_remote_state.infra_kube.outputs.node_role_name
  policy_arn = aws_iam_policy.billing.arn
}
