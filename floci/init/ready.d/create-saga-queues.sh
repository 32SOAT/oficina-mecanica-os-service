#!/bin/bash
set -euo pipefail

region="${AWS_DEFAULT_REGION:-us-east-1}"
account_id="000000000000"
endpoint="http://localhost:4566"

create_dlq() {
  aws --endpoint-url "$endpoint" sqs create-queue \
    --queue-name "$1" \
    --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false","MessageRetentionPeriod":"1209600","SqsManagedSseEnabled":"true"}' \
    >/dev/null
}

create_main_queue() {
  local queue_name="$1"
  local dlq_name="$2"
  local dlq_arn="arn:aws:sqs:${region}:${account_id}:${dlq_name}"
  local attributes

  attributes="{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"MessageRetentionPeriod\":\"345600\",\"VisibilityTimeout\":\"60\",\"ReceiveMessageWaitTimeSeconds\":\"20\",\"SqsManagedSseEnabled\":\"true\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${dlq_arn}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

  aws --endpoint-url "$endpoint" sqs create-queue \
    --queue-name "$queue_name" \
    --attributes "$attributes" \
    >/dev/null

  local dlq_url="${endpoint}/${account_id}/${dlq_name}"
  local source_arn="arn:aws:sqs:${region}:${account_id}:${queue_name}"
  local redrive_allow
  redrive_allow="{\"RedriveAllowPolicy\":\"{\\\"redrivePermission\\\":\\\"byQueue\\\",\\\"sourceQueueArns\\\":[\\\"${source_arn}\\\"]}\"}"
  aws --endpoint-url "$endpoint" sqs set-queue-attributes \
    --queue-url "$dlq_url" \
    --attributes "$redrive_allow" \
    >/dev/null
}

create_dlq oficina-billing-commands-dlq.fifo
create_dlq oficina-execution-commands-dlq.fifo
create_dlq oficina-os-results-dlq.fifo

create_main_queue oficina-billing-commands.fifo oficina-billing-commands-dlq.fifo
create_main_queue oficina-execution-commands.fifo oficina-execution-commands-dlq.fifo
create_main_queue oficina-os-results.fifo oficina-os-results-dlq.fifo
