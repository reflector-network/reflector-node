# Node 24 LTS on Alpine 3.23 — the last Alpine release that packages loki-promtail (dropped in 3.24 after upstream EOL)
FROM node:24-alpine3.23

# Install curl, jq, bash, and supervisor utilities
RUN apk add --no-cache curl jq bash supervisor util-linux loki-promtail \
    && rm -rf /tmp/* /var/cache/apk/*

# Set environment variables
ENV NODE_ENV=production
ENV WS_PORT=30347

# Copy startnode script and make it executable
COPY /docker/startnode /startnode
RUN chmod +x /startnode

# Set up supervisor configurations
COPY /docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY /docker/promtail/config.yml.template /etc/promtail/config.yml.template

# Set working directory
WORKDIR /reflector-node

# Copy the application from the dist subdirectory to the root directory
COPY dist/ .

# Expose necessary ports
EXPOSE 30347

ENTRYPOINT ["/startnode"]