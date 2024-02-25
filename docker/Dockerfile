# Using the Node LTS Alpine as the base
FROM node:lts-alpine

# Install curl, jq, bash, and supervisor utilities
RUN apk add --no-cache curl jq bash supervisor util-linux \
    && rm -rf /tmp/* /var/cache/apk/*

# Set environment variables
ENV NODE_ENV=production
ENV WS_PORT=30347

# Copy startnode script and make it executable
COPY /docker/startnode /startnode
RUN chmod +x /startnode

# Set up supervisor configurations
COPY /docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Set working directory
WORKDIR /reflector-node

# Copy the application from the dist folder
COPY dist/ .

# Expose necessary ports
EXPOSE 30347

ENTRYPOINT ["/startnode"]