locals {
  prefix = "${var.project_name}-${var.environment}"
}

# Banco NoSQL próprio do billing-service (requisito: cada microsserviço com seu
# banco; ao menos um NoSQL). Single-table design — ver README:
#   pk = ORDER#<orderId>, sk = BUDGET | PAYMENT#<paymentId>
#   gsi1 (gsi1pk = BUDGET|PAYMENT, gsi1sk = createdAt) para listagens.
# PAY_PER_REQUEST: custo zero sem tráfego — combina com a infra sob demanda.
resource "aws_dynamodb_table" "billing" {
  name         = "${local.prefix}-billing"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = var.environment == "prod"
  }

  server_side_encryption {
    enabled = true
  }
}
