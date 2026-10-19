output "table_name" {
  value = aws_dynamodb_table.billing.name
}

output "commands_queue_url" {
  value = aws_sqs_queue.commands.id
}

output "commands_dlq_url" {
  value = aws_sqs_queue.commands_dlq.id
}

output "public_base_url" {
  description = "URL pública https do billing (PUBLIC_BASE_URL → notification_url das preferências do Mercado Pago). Vazio quando a rota não foi criada."
  value       = local.webhook_enabled ? data.aws_apigatewayv2_api.shared[0].api_endpoint : ""
}

output "mercadopago_webhook_url" {
  description = "URL do webhook (opcional cadastrar no painel do Mercado Pago — a notification_url da preferência já basta)"
  value       = local.webhook_enabled ? "${data.aws_apigatewayv2_api.shared[0].api_endpoint}/api/webhooks/mercadopago" : ""
}
