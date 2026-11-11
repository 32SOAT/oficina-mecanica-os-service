locals {
  queues = {
    billing_commands   = "${var.name_prefix}-billing-commands"
    execution_commands = "${var.name_prefix}-execution-commands"
    os_results         = "${var.name_prefix}-os-results"
  }
}

resource "aws_sqs_queue" "dead_letter" {
  for_each = local.queues

  name                        = "${each.value}-dlq.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  message_retention_seconds   = 1209600
  sqs_managed_sse_enabled     = true
}

resource "aws_sqs_queue" "main" {
  for_each = local.queues

  name                        = "${each.value}.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  message_retention_seconds   = var.message_retention_seconds
  visibility_timeout_seconds  = var.visibility_timeout_seconds
  receive_wait_time_seconds   = 20
  sqs_managed_sse_enabled     = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead_letter[each.key].arn
    maxReceiveCount     = var.max_receive_count
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "dead_letter" {
  for_each = local.queues

  queue_url = aws_sqs_queue.dead_letter[each.key].id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.main[each.key].arn]
  })
}

resource "aws_iam_policy" "os_saga_sqs" {
  name = "${var.name_prefix}-os-saga-sqs"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = [aws_sqs_queue.main["billing_commands"].arn, aws_sqs_queue.main["execution_commands"].arn]
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.main["os_results"].arn
      }
    ]
  })
}

resource "aws_iam_policy" "billing_saga_sqs" {
  name = "${var.name_prefix}-billing-saga-sqs"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.main["billing_commands"].arn
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.main["os_results"].arn
      }
    ]
  })
}

resource "aws_iam_policy" "execution_saga_sqs" {
  name = "${var.name_prefix}-execution-saga-sqs"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.main["execution_commands"].arn
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.main["os_results"].arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "os_saga_sqs" {
  role       = var.os_role_name
  policy_arn = aws_iam_policy.os_saga_sqs.arn
}

resource "aws_iam_role_policy_attachment" "billing_saga_sqs" {
  role       = var.billing_role_name
  policy_arn = aws_iam_policy.billing_saga_sqs.arn
}

resource "aws_iam_role_policy_attachment" "execution_saga_sqs" {
  role       = var.execution_role_name
  policy_arn = aws_iam_policy.execution_saga_sqs.arn
}
