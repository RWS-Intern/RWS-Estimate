# syntax=docker/dockerfile:1
#
# Packages this PHP app (index.html + /api + /admin + /assets, same layout
# as the Hostinger deploy in DEPLOY.md) as a container for Render's "Web
# Service" product. See DEPLOY-RENDER.md for the actual deploy steps.

# ---- Stage 1: Composer dependencies ----------------------------------------
# Installed fresh here rather than trusting a committed vendor/ — this
# repo's .gitignore excludes /vendor/ (same as the Hostinger flow, where
# `composer install` is run manually), so building it inside the image
# guarantees dependencies that actually match this image's PHP version.
FROM composer:2 AS vendor
WORKDIR /app
COPY composer.json composer.lock* ./
RUN composer install \
      --no-dev \
      --optimize-autoloader \
      --no-interaction \
      --no-progress \
      --prefer-dist

# ---- Stage 2: the application image ----------------------------------------
FROM php:8.2-apache

# PHP extensions this app actually calls:
#   curl      - Anthropic + Supabase REST calls (api/supabase.php, extract.php)
#   mbstring  - smalot/pdfparser dependency
#   fileinfo  - MIME sniffing (extract.php, upload_bill.php)
#   zip
RUN apt-get update && apt-get install -y --no-install-recommends \
        libonig-dev \
        libzip-dev \
        libcurl4-openssl-dev \
        libmagic-dev \
    && docker-php-ext-install curl mbstring fileinfo zip \
    && rm -rf /var/lib/apt/lists/*

# mod_rewrite on, and let a future .htaccess actually take effect (Apache's
# Debian default is AllowOverride None everywhere).
RUN a2enmod rewrite \
    && sed -ri 's/AllowOverride None/AllowOverride All/g' /etc/apache2/apache2.conf

WORKDIR /var/www/html

# The whole project becomes the document root — index.html, /api, /admin,
# /assets are all served from web root, exactly like on Hostinger.
COPY . /var/www/html/
COPY --from=vendor /app/vendor /var/www/html/vendor

RUN chown -R www-data:www-data /var/www/html

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 80
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["apache2-foreground"]
