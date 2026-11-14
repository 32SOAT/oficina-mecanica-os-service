#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
os="$root/oficina-mecanica-os-service"
billing="$root/oficina-mecanica-billing-service"
execution="$root/oficina-mecanica-execucao-service"
for directory in "$os" "$billing" "$execution"; do
  [[ -f "$directory/package-lock.json" ]] || { echo "Missing repository: $directory" >&2; exit 1; }
done
run_id="${GITHUB_RUN_ID:-local-$$}"
logs="$(mktemp -d)"
cleanup() {
  kill "${mock_pid:-}" "${os_pid:-}" "${billing_pid:-}" "${execution_pid:-}" 2>/dev/null || true
  for pair in "$os:bdd-os-$run_id" "$billing:bdd-billing-$run_id" "$execution:bdd-execution-$run_id"; do
    docker compose -f "${pair%%:*}/docker-compose.yml" -p "${pair#*:}" down -v >/dev/null 2>&1 || true
  done
  if [[ "${BDD_FAILED:-0}" == 1 ]]; then
    for file in "$logs"/*.log; do echo "=== ${file##*/} ===" >&2; tail -35 "$file" >&2; done
  fi
  rm -rf "$logs"
}
trap cleanup EXIT
trap 'BDD_FAILED=1' ERR
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test

docker compose -f "$os/docker-compose.yml" -p "bdd-os-$run_id" up -d db floci
docker compose -f "$billing/docker-compose.yml" -p "bdd-billing-$run_id" up -d db
docker compose -f "$execution/docker-compose.yml" -p "bdd-execution-$run_id" up -d dynamodb
for _ in $(seq 1 90); do
  if docker compose -f "$os/docker-compose.yml" -p "bdd-os-$run_id" exec -T floci aws --endpoint-url http://localhost:4566 sqs get-queue-url --queue-name oficina-os-results.fifo >/dev/null 2>&1; then break; fi
  sleep 2
done
docker compose -f "$os/docker-compose.yml" -p "bdd-os-$run_id" exec -T floci aws --endpoint-url http://localhost:4566 sqs get-queue-url --queue-name oficina-os-results.fifo >/dev/null
for directory in "$os" "$billing" "$execution"; do
  (cd "$directory" && npm ci && npm run build) >"$logs/$(basename "$directory")-install.log" 2>&1
done
(cd "$os" && POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=5435 POSTGRES_USER=oficina POSTGRES_PASSWORD=oficina123 POSTGRES_DB=oficina_os npm run migration:run) >"$logs/migration.log" 2>&1

(cd "$os" && node --import tsx test/support/mercado-pago-mock.ts) >"$logs/payment-mock.log" 2>&1 & mock_pid=$!
(cd "$billing" && env APP_PORT=3002 POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=5433 POSTGRES_USER=oficina POSTGRES_PASSWORD=oficina123 POSTGRES_DB=oficina_billing SAGA_TOKEN=oficina-local MERCADOPAGO_ACCESS_TOKEN=APP_USR-bdd MERCADOPAGO_API_BASE_URL=http://127.0.0.1:3099 SQS_ENDPOINT_URL=http://127.0.0.1:4566 SQS_REGION=us-east-1 SQS_WORKER_ENABLED=true SQS_COMMANDS_QUEUE_URL=http://127.0.0.1:4566/000000000000/oficina-billing-commands.fifo SQS_RESULTS_QUEUE_URL=http://127.0.0.1:4566/000000000000/oficina-os-results.fifo npm run start:prod) >"$logs/billing.log" 2>&1 & billing_pid=$!
(cd "$execution" && env APP_PORT=3003 DYNAMODB_ENDPOINT=http://127.0.0.1:8000 DYNAMODB_REGION=us-east-1 DYNAMODB_TABLE=execucao DYNAMODB_SAGA_COMMANDS_TABLE=execucao_saga_commands SAGA_TOKEN=oficina-local SQS_ENDPOINT_URL=http://127.0.0.1:4566 SQS_REGION=us-east-1 SQS_WORKER_ENABLED=true SQS_COMMANDS_QUEUE_URL=http://127.0.0.1:4566/000000000000/oficina-execution-commands.fifo SQS_RESULTS_QUEUE_URL=http://127.0.0.1:4566/000000000000/oficina-os-results.fifo npm run start:prod) >"$logs/execution.log" 2>&1 & execution_pid=$!
(cd "$os" && env APP_PORT=3001 POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=5435 POSTGRES_USER=oficina POSTGRES_PASSWORD=oficina123 POSTGRES_DB=oficina_os POSTGRES_SYNC=0 JWT_SECRET=bdd-local-secret RESEND_API_KEY=re_bdd RESEND_FROM=onboarding@resend.dev NOTIFICACAO_EMAIL_MECANICOS=mecanicos@example.com NOTIFICACAO_EMAIL_ADMIN=admin@example.com BILLING_BASE_URL=http://127.0.0.1:3002 EXECUCAO_BASE_URL=http://127.0.0.1:3003 SAGA_TOKEN=oficina-local SQS_ENDPOINT_URL=http://127.0.0.1:4566 SQS_REGION=us-east-1 SQS_BILLING_COMMAND_QUEUE_URL=http://127.0.0.1:4566/000000000000/oficina-billing-commands.fifo SQS_EXECUTION_COMMAND_QUEUE_URL=http://127.0.0.1:4566/000000000000/oficina-execution-commands.fifo SQS_RESULTS_QUEUE_URL=http://127.0.0.1:4566/000000000000/oficina-os-results.fifo SQS_OUTBOX_RELAY_ENABLED=true SQS_RESULTS_CONSUMER_ENABLED=true npm run start:prod) >"$logs/os.log" 2>&1 & os_pid=$!

for address in 127.0.0.1:3099/health 127.0.0.1:3001/api/v1/health 127.0.0.1:3002/api/v1/health 127.0.0.1:3003/api/v1/health; do
  ready=0
  for _ in $(seq 1 90); do
    if curl --fail --silent "http://$address" >/dev/null; then ready=1; break; fi
    sleep 2
  done
  [[ "$ready" == 1 ]] || { echo "Service unavailable: $address" >&2; exit 1; }
done
(cd "$os" && JWT_SECRET=bdd-local-secret npm run test:bdd) >"$logs/bdd.log" 2>&1
cat "$logs/bdd.log"
