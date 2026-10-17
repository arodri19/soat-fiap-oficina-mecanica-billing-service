output "table_name" {
  value = aws_dynamodb_table.billing.name
}

output "commands_queue_url" {
  value = aws_sqs_queue.commands.id
}

output "commands_dlq_url" {
  value = aws_sqs_queue.commands_dlq.id
}
