# @reflector/reflector-node

> Node server for Reflector, decentralized Stellar price feed oracle

Check [architecture and general concepts overview](docs/how-it-works.md) to learn what's inside and how it works.

## Installation

```
npm i
```

## Usage

### Prerequisites:

1. Build and deploy [Reflector Oracle contract](https://github.com/reflector-network/reflector-contract).
2. Create a multisig account to protect the contract. Ensure that each signer corresponds to a distinct Reflector cluster node and 
   master weight is set to 0.

### Initial cluster configuration

Create `app.config.json` file in the `home` directory.

```json
{
  "secret": "S...G", //secret key of the node
  "dataSources": { //data sources for price data
    "coinmarketcap": {
      "type": "api",
      "secret": "COINMARKETCAP_API_KEY",
      "name": "coinmarketcap"
    },
    "pubnet": {
      "dbConnection": "postgres://stellar:@187.241.174.205:5432/stellar-core",
      "horizonUrls": ["https://soroban-testnet.stellar.org"],
      "type": "db",
      "name": "testnet"
    }
  },
  "dbSyncDelay": 15, //delay in seconds for database synchronization. Optional, default is 15
  "orchestratorUrl": "http://182.168.11.137:12274" //orchestrator URL. Optional, default is "https://orchestrator.reflector.world"
}
```

### Start Reflector node

```
npm run start
```

## Docker image

Docker configurations to run Reflector node Docker image.

### Prerequisites

- Install Docker.

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
- `5432` - port for the PostgreSQL database

**_Note:_** You need to set dbConnection in `app.config.json` to `postgres://stellar:123456@127.0.0.1:5432/stellar-core` where `123456` is the
password for the PostgreSQL database.

#### Default ports 

- `30347`: WebSocket port for inter-cluster communication

#### Volumes

- Reflector working directory, e.g. `REFLECTOR_WORKDIR:/reflector-node/app/home`

## Admin Dashboard

[Admin Dashboard](https://node-admin.reflector.world) is a GUI that simplifies common administrative tasks, monitoring, and management of Reflector nodes.
Check [admin guide](docs/admin/guide/index.md) for a short 101 course on node administration.