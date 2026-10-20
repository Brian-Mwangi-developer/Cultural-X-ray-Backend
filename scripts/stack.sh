#!/usr/bin/env bash
# One entry point for the containers.
#   stack.sh up [infra|monitoring|app|all]   default: infra + monitoring
#   stack.sh down [--volumes]                stop everything (optionally wipe data)
#   stack.sh status | logs <service> | urls
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$ROOT/.env" ]] || bash "$ROOT/scripts/init-env.sh"
COMPOSE=(docker compose -f "$ROOT/devops/docker-compose.yml" --env-file "$ROOT/.env")

profiles() {
  case "${1:-default}" in
    infra) echo "--profile infra" ;;
    monitoring) echo "--profile infra --profile monitoring" ;;
    app) echo "--profile infra --profile app" ;;
    all) echo "--profile infra --profile monitoring --profile app" ;;
    default) echo "--profile infra --profile monitoring" ;;
    *) echo "unknown profile '$1'" >&2; exit 1 ;;
  esac
}

urls() {
  cat <<URLS

  RabbitMQ management  http://localhost:15682   (user: xray, password: RABBITMQ_PASSWORD in backend/.env)
  Prometheus           http://localhost:9095    (alerts: /alerts, targets: /targets)
  Grafana              http://localhost:3005    (user: admin, password: GRAFANA_ADMIN_PASSWORD in backend/.env)
  Redis                localhost:6390           (password: REDIS_PASSWORD)
  API                  http://localhost:4000/health   worker http://localhost:4001/health
URLS
}

case "${1:-up}" in
  up)
    # shellcheck disable=SC2046
    "${COMPOSE[@]}" $(profiles "${2:-default}") up -d --build --wait --wait-timeout 180
    "${COMPOSE[@]}" --profile infra --profile monitoring --profile app ps
    urls ;;
  down)
    "${COMPOSE[@]}" --profile infra --profile monitoring --profile app down ${2:-} ;;
  status|ps)
    "${COMPOSE[@]}" --profile infra --profile monitoring --profile app ps ;;
  logs)
    "${COMPOSE[@]}" --profile infra --profile monitoring --profile app logs -f --tail=200 "${2:?service name}" ;;
  urls)
    urls ;;
  *)
    sed -n '2,6p' "$0"; exit 1 ;;
esac
