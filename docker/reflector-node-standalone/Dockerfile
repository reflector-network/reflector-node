# Using the Node LTS Alpine as the base
FROM node:lts-alpine

# Install curl, jq, bash, and supervisor utilities
RUN apk add --no-cache curl jq bash supervisor util-linux \
    && rm -rf /tmp/* /var/cache/apk/*

# Set environment variables
ENV NODE_ENV=production
ENV API_PORT=30347
ENV WS_PORT=30348

# Copy startnode script and make it executable
COPY /docker/reflector-node-standalone/startnode /startnode
RUN chmod +x /startnode

# Set up supervisor configurations
COPY /docker/reflector-node-standalone/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Set working directory
WORKDIR /reflector-node

# Copy the application from the dist folder
COPY dist/ .

# Expose necessary ports
EXPOSE 30347
EXPOSE 30348

ENTRYPOINT ["/startnode"]