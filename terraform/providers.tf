terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Injetado via -backend-config no CI/CD:
  # bucket = TF_STATE_BUCKET, key = "oficina-mecanica/billing-service/terraform.tfstate"
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project      = var.project_name
      Environment  = var.environment
      Microservice = "billing-service"
      ManagedBy    = "Terraform"
    }
  }
}
