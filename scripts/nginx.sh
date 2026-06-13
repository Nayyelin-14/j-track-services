#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="$(dirname "$0")/../docker-compose.local.yml"
NAME="jtrack-nginx"

case "${1:-start}" in
  start)
    echo "Starting nginx..."
    docker compose -f "$COMPOSE_FILE" up -d
    echo "nginx running at http://localhost"
    ;;
  stop)
    echo "Stopping nginx..."
    docker compose -f "$COMPOSE_FILE" down
    echo "nginx stopped"
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  logs)
    docker logs -f "$NAME"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|logs}"
    exit 1
    ;;
esac
