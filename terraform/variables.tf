variable "project_name" {
  description = "Nome do projeto — prefixo de todos os recursos AWS"
  type        = string
  default     = "oficina-mecanica"
}

variable "aws_region" {
  description = "Região AWS"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Ambiente: dev | staging | prod"
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "O valor deve ser dev, staging ou prod."
  }
}

variable "tf_state_bucket" {
  description = "Bucket S3 dos states Terraform (o mesmo do infra-kube, lido via terraform_remote_state)"
  type        = string
}

variable "max_receive_count" {
  description = "Tentativas de processamento antes de a mensagem ir para a DLQ"
  type        = number
  default     = 5
}
