output "billing_commands_queue_url" {
  value = aws_sqs_queue.main["billing_commands"].id
}

output "execution_commands_queue_url" {
  value = aws_sqs_queue.main["execution_commands"].id
}

output "os_results_queue_url" {
  value = aws_sqs_queue.main["os_results"].id
}

output "queue_arns" {
  value = { for name, queue in aws_sqs_queue.main : name => queue.arn }
}

output "dead_letter_queue_arns" {
  value = { for name, queue in aws_sqs_queue.dead_letter : name => queue.arn }
}
