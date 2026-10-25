# Rota HTTPS do webhook do Mercado Pago — infraestrutura do PRÓPRIO billing,
# pendurada na API Gateway compartilhada (repositório serverless). O Mercado Pago só
# notifica URLs https; o billing roda atrás de um LoadBalancer http no EKS, então a
# API Gateway faz o papel de terminação TLS + proxy.
#
# Sem autorizador JWT: a notificação é autenticada pela assinatura x-signature
# (quando MERCADOPAGO_WEBHOOK_SECRET está configurado) e, de qualquer forma, o
# billing nunca confia no corpo — sempre reconsulta GET /v1/payments/{id} no
# Mercado Pago antes de mudar o status do pagamento.
locals {
  webhook_enabled = var.api_gateway_id != "" && var.webhook_upstream_url != ""
}

data "aws_apigatewayv2_api" "shared" {
  count  = local.webhook_enabled ? 1 : 0
  api_id = var.api_gateway_id
}

resource "aws_apigatewayv2_integration" "mercadopago_webhook" {
  count = local.webhook_enabled ? 1 : 0

  api_id             = var.api_gateway_id
  integration_type   = "HTTP_PROXY"
  integration_method = "POST"
  integration_uri    = "${trimsuffix(var.webhook_upstream_url, "/")}/api/webhooks/mercadopago"
}

resource "aws_apigatewayv2_route" "mercadopago_webhook" {
  count = local.webhook_enabled ? 1 : 0

  api_id    = var.api_gateway_id
  route_key = "POST /api/webhooks/mercadopago"
  target    = "integrations/${aws_apigatewayv2_integration.mercadopago_webhook[0].id}"
}
