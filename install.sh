#!/usr/bin/env bash
# Установка Wildberries MCP на свой сервер. Проверено под Ubuntu 22.04 / 24.04.
#
#   sudo bash install.sh        — установить или переустановить
#   sudo bash install.sh url    — ещё раз показать адрес для коннектора
#   sudo bash install.sh update — обновить код и перезапустить
set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '\n\033[1;31m→\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m✗\033[0m %s\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запустите от root: sudo bash install.sh"

load_env() {
  [ -f .env ] || die "Нет файла .env. Запустите: sudo bash install.sh"
  set -a; . ./.env; set +a
  [ -n "${DOMAIN:-}" ]        || die "В .env пустой DOMAIN"
  [ -n "${WB_TOKEN:-}" ]      || die "В .env пустой WB_TOKEN"
  [ "${#MCP_SECRET}" -ge 24 ] || die "В .env пустой или короткий MCP_SECRET"
}

print_url() {
  load_env
  echo
  echo "Адрес для коннектора (это ключ доступа — никому не пересылайте):"
  echo
  printf '   \033[1mhttps://%s/mcp?key=%s\033[0m\n\n' "$DOMAIN" "$MCP_SECRET"
}

case "${1:-install}" in
  url)    print_url; exit 0 ;;
  update) say "Обновляю код…"
          git pull --ff-only
          docker compose up -d --build
          say "Готово."; exit 0 ;;
  install) ;;
  *) die "Неизвестная команда: $1. Есть: url, update" ;;
esac

# 1. Docker и утилиты
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  say "Ставлю Docker — пара минут…"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 openssl dnsutils >/dev/null
  systemctl enable --now docker >/dev/null
fi
command -v openssl >/dev/null || apt-get install -y -qq openssl >/dev/null

# 2. Настройки
if [ -f .env ]; then
  say "Файл .env уже есть — беру настройки из него."
else
  say "Нужны две вещи: домен и токен WB."
  read -rp "  Домен для сервера (например, wb.mysite.ru): " DOMAIN
  DOMAIN=$(printf '%s' "$DOMAIN" | sed -e 's#^https\?://##' -e 's#/.*$##' | tr -d ' \r\n')
  read -rsp "  Токен WB API (ввод не отображается): " WB_TOKEN; echo
  WB_TOKEN=$(printf '%s' "$WB_TOKEN" | tr -d ' \r\n')
  [ -n "$DOMAIN" ] && [ -n "$WB_TOKEN" ] || die "Домен и токен обязательны."
  MCP_SECRET=$(openssl rand -hex 24)
  ( umask 077
    printf 'DOMAIN=%s\nWB_TOKEN=%s\nMCP_SECRET=%s\nWB_ALLOW_WRITE=false\n' \
      "$DOMAIN" "$WB_TOKEN" "$MCP_SECRET" > .env )
  say "Настройки сохранены в .env (доступ только у root)."
fi
load_env

# 3. Домен должен смотреть на этот сервер, иначе HTTPS не выдадут
MYIP=$(hostname -I 2>/dev/null | awk '{print $1}')
if command -v dig >/dev/null; then
  DNSIP=$(dig +short "$DOMAIN" A | tail -1)
  if [ -z "$DNSIP" ]; then
    warn "Домен $DOMAIN пока никуда не указывает. Создайте A-запись на $MYIP и подождите 5–30 минут."
  elif [ "$DNSIP" != "$MYIP" ]; then
    warn "Домен $DOMAIN указывает на $DNSIP, а у сервера адрес $MYIP. Проверьте A-запись."
  fi
fi

# 4. Порты 80 и 443 — для сертификата и работы
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

# 5. Запуск
say "Собираю и запускаю…"
docker compose up -d --build

# 6. Ждём, пока сервер внутри ответит
for _ in $(seq 1 30); do
  if docker compose exec -T wb-mcp node -e \
      "fetch('http://127.0.0.1:8000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
    READY=1; break
  fi
  sleep 2
done
[ "${READY:-0}" = 1 ] || die "Сервер не поднялся. Логи: docker compose logs wb-mcp"

# 7. Проверяем снаружи по HTTPS — сертификат выдаётся до минуты
say "Сервер работает. Проверяю HTTPS…"
for _ in $(seq 1 20); do
  if curl -fsS --max-time 5 "https://$DOMAIN/health" >/dev/null 2>&1; then HTTPS=1; break; fi
  sleep 3
done
if [ "${HTTPS:-0}" = 1 ]; then
  say "HTTPS работает."
else
  warn "HTTPS пока не отвечает. Обычно это DNS: дождитесь A-записи и выполните"
  warn "  docker compose restart caddy"
fi

print_url
echo "Дальше: Claude → Настройки → Connectors → Add custom connector → вставить адрес."
if grep -qiE '^WB_ALLOW_WRITE=(true|1|yes)' .env; then
  warn "Изменения ВКЛЮЧЕНЫ: по этому адресу можно менять ставки и цены."
else
  echo "Claude только читает данные. Разрешить изменения: WB_ALLOW_WRITE=true в .env, затем docker compose up -d"
fi
