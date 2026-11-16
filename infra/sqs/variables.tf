variable "name_prefix" {
  description = "Prefix used for the Saga queues and IAM policies."
  type        = string
  default     = "oficina"
}

variable "max_receive_count" {
  description = "Number of receives before SQS moves a message to its DLQ."
  type        = number
  default     = 5
}

variable "message_retention_seconds" {
  description = "Retention for the three source queues."
  type        = number
  default     = 345600
}

variable "visibility_timeout_seconds" {
  description = "Visibility timeout for Saga command and result processing."
  type        = number
  default     = 60
}

variable "os_role_name" {
  description = "IAM role name used by the OS service."
  type        = string
}

variable "billing_role_name" {
  description = "IAM role name used by the Billing service."
  type        = string
}

variable "execution_role_name" {
  description = "IAM role name used by the Execution service."
  type        = string
}
