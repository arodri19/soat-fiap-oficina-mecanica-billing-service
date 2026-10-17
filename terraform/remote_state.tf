# Lê o IAM Role dos worker nodes do EKS (repositório infra-kube) para anexar a
# policy de acesso às filas deste serviço — os pods herdam essas permissões.
data "terraform_remote_state" "infra_kube" {
  backend = "s3"

  config = {
    bucket = var.tf_state_bucket
    key    = "oficina-mecanica/infra-kube/terraform.tfstate"
    region = var.aws_region
  }
}

data "aws_caller_identity" "current" {}
