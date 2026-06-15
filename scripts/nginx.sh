#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="$(dirname "$0")/../docker-compose.local.yml"
NAME="jtrack-nginx"

case "${1:-help}" in
  # Docker mode — only nginx in a container, services on host
  docker-start)
    echo "Starting nginx in Docker..."
    docker compose -f "$COMPOSE_FILE" up -d
    echo "nginx running at http://localhost"
    ;;
  docker-stop)
    echo "Stopping nginx..."
    docker compose -f "$COMPOSE_FILE" down
    echo "nginx stopped"
    ;;
  docker-restart)
    "$0" docker-stop
    "$0" docker-start
    ;;
  docker-logs)
    docker logs -f "$NAME"
    ;;

  # Native mode — nginx installed on host via apt
  native-start)
    echo "Starting native nginx..."
    sudo systemctl start nginx
    echo "nginx running at http://localhost"
    ;;
  native-stop)
    echo "Stopping native nginx..."
    sudo systemctl stop nginx
    echo "nginx stopped"
    ;;
  native-restart)
    sudo systemctl restart nginx
    echo "nginx restarted"
    ;;
  native-status)
    sudo systemctl status nginx
    ;;
  native-logs)
    sudo tail -f /var/log/nginx/access.log
    ;;
  native-setup)
    "$(dirname "$0")/setup-nginx-native.sh"
    ;;

  # Docker compose mode — all services + nginx in Docker
  compose-up)
    docker compose up -d
    ;;
  compose-down)
    docker compose down
    ;;
  compose-logs)
    docker compose logs -f
    ;;

  *)
    echo "Usage: $0 <command>"
    echo ""
    echo "Native nginx (services run via pnpm dev):"
    echo "  native-setup                   Install & configure nginx (run once)"
    echo "  native-start | stop | restart  Control native nginx"
    echo "  native-status                  Check nginx status"
    echo "  native-logs                    Tail nginx access log"
    echo ""
    echo "Docker nginx only (services run via pnpm dev):"
    echo "  docker-start | stop | restart  Control nginx container"
    echo "  docker-logs                    Tail nginx container logs"
    echo ""
    echo "All services in Docker:"
    echo "  compose-up | down              Start/stop all containers"
    echo "  compose-logs                   Tail all container logs"
    ;;
esac
