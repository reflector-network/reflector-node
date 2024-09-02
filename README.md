# @reflector/reflector-node

> Node server for [Reflector](https://reflector.network), decentralized Stellar price feed oracle

Check [architecture and general concepts overview](docs/how-it-works.md) to learn what's inside and how it works.

## Usage | Prerequisites

1. Build and deploy [Reflector Oracle contract](https://github.com/reflector-network/reflector-contract).
2. Create a multisig account to protect the contract. Ensure that each signer corresponds to a distinct Reflector cluster node and 
   master weight is set to 0.

### Initial cluster configuration

Prepare `app.config.json` file and save it to the `home` directory which will be utilized by Reflector node. 

```json
{
  "secret": "S...G",
  "dataSources": {
    "pubnet": {
      "dbConnection": "postgres://stellar:@{server_ip_address}:{server_port}/stellar-core",
      "sorobanRpc": ["https://soroban-testnet.stellar.org"],
      "type": "db",
      "name": "testnet"
    },
    "exchanges": {
      "name": "exchanges",
      "type": "api"
    }
  },
   "gateways": [
     "https://194.85.0.258:8081",
     "https://12.257.32.171:9023"
   ],
  "gatewayAuthMessage": "gateway_validation",
  "rsaKey": "DT4E...Ykl=", //RSA secret key for subscription webhook decryption
  "dbSyncDelay": 15,
  "trace": false
}
```

Where:
- `secret` - the secret key of the node
- `dataSources` - price data sources cofigurations
- `gateways` - configuration of external gateways required for secure data retrieval and subscriptions execution
- `gatewayAuthMessage` - [optional] message salt used in the gateway validation key encryption
- `dbSyncDelay` - [optional] delay in seconds for database synchronization (should be identical for all nodes in the cluster)
 
If you are joining the existing cluster, ask other node operators to share their basic config params, then override `secret` and data sources configuration parameters.

---

## Usage | Docker image (for node operators)

Docker configurations to run Reflector node Docker image.

Prerequisites:
- Docker

### Running Docker container

Example startup script:

```bash
docker run -it -d \
    -p 30347:30347 \
    -v "REFLECTOR_WORKDIR:/reflector-node/app/home" \
    --name=reflector-node \
    reflectornet/reflector-node:latest
```
- `REFLECTOR_WORKDIR` - path to the working directory where Reflector will store config and logs

If you want to use Stellar Docker image as DB source, you can use the following command:

```bash
docker run -it -d \
    -e POSTGRES_PASSWORD=123456 \
    -p 5432:5432 \
    -v "STELLAR_WORKDIR:/opt/stellar" \
    --name stellar \
    stellar/quickstart:soroban-dev \
    --testnet
```

- `POSTGRES_PASSWORD` - password for the PostgreSQL database
- `STELLAR_WORKDIR` - path to the working directory where Stellar will store data
- `5432` - port of the local PostgreSQL database

**_Note:_** You need to set `dbConnection` in `app.config.json` to `postgres://stellar:123456@127.0.0.1:5432/stellar-core` where `123456` is the
password for the PostgreSQL database.

#### Default ports 

- `30347`: WebSocket port for inter-cluster communication

#### Volumes

- Reflector working directory, e.g. `REFLECTOR_WORKDIR:/reflector-node/app/home`

### Updating node

1. Pull the latest docker image from Docker Hub
   ```bash
   docker pull reflectornet/reflector-node:latest
   ```
2. Stop current node container
   ```bash
   docker stop {container_id_or_name}
   ```
3. Remove current container
   ```bash
   docker rm {container_id_or_name}
   ```
4. Start new container  
   Use the same startup command for the updated container (general startup command format is [described above](#running-docker-container))

---

## Usage | Standalone (for node developers)

Prerequisites:
- NodeJS 18+

1. Checkout this repository
   ```bash
   git checkout git@github.com:reflector-network/reflector-node.git
   ```
2. Install dependencies
   ```bash
   npm i
   ```
3. Start Reflector node
   ```bash
   npm run start
   ```
--- 

## Admin Dashboard

[Admin Dashboard](https://node-admin.reflector.network) is a GUI that simplifies common administrative tasks, monitoring, and management of Reflector nodes.  
Check [admin guide](docs/admin/guide/index.md) for a short 101 course on node administration.
