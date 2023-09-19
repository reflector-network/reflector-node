# Using the Stellar image as the base
FROM stellar/quickstart:soroban-dev@sha256:99a5256d69178c785d1f21195192d34faf1cb265e467d6efc257525fb25d587c

# Install curl, jq, and other utilities
RUN apt-get update \
    && apt-get install -y curl\
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js and NPM (You can adjust the version based on your needs)
RUN curl -sL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs

# Set environment variables
ENV NODE_ENV=production
ENV API_PORT=30347
ENV WS_PORT=30348

ADD /docker/reflector-node-stellar-core/startnode /
RUN ["chmod", "+x", "startnode"]

COPY /docker/reflector-node-stellar-core/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Set working directory
WORKDIR /reflector-node

# Copy the application from the dist folder
COPY dist/ .

# Expose necessary ports

# API port
EXPOSE 30347
# Websocket port
EXPOSE 30348
# Stellar horizon port
EXPOSE 8000

ENTRYPOINT ["/startnode"]