#!/bin/sh
set -e

# Render assigns a random $PORT per deploy and marks the service unhealthy
# if it isn't listening on exactly that port by the time the health check
# runs. Apache's Debian default config hardcodes port 80 in TWO places —
# the global Listen directive and the default vhost's <VirtualHost *:80> —
# both need rewriting before Apache starts. Falls back to 80 for a plain
# `docker run` with no $PORT set (e.g. testing this image locally).
PORT="${PORT:-80}"

sed -ri "s/^Listen [0-9]+/Listen ${PORT}/" /etc/apache2/ports.conf
sed -ri "s/<VirtualHost \*:[0-9]+>/<VirtualHost *:${PORT}>/" /etc/apache2/sites-available/000-default.conf

exec "$@"
