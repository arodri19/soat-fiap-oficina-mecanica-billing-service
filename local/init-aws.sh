#!/bin/sh
# Filas e tabela do billing no LocalStack (mesmos nomes do Terraform).
set -eu
P="oficina-mecanica-dev"
for q in billing-commands os-saga-replies; do
  awslocal sqs create-queue --queue-name "$P-$q-dlq" >/dev/null
  awslocal sqs create-queue --queue-name "$P-$q" >/dev/null
done
awslocal dynamodb create-table --table-name "$P-billing" --billing-mode PAY_PER_REQUEST \
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S AttributeName=gsi1pk,AttributeType=S AttributeName=gsi1sk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
  --global-secondary-indexes '[{"IndexName":"gsi1","KeySchema":[{"AttributeName":"gsi1pk","KeyType":"HASH"},{"AttributeName":"gsi1sk","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]' >/dev/null
echo "billing: filas e tabela criadas"
