# @reflector/reflector-node

> Node server for Reflector, decentralized Stellar price feed oracle

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

Create `app.config.json` file in the root `reflector-node` directory.

```json
{
  "secret": "S...7", //current node secret key
  "contractSettings": {
    "admin": "G...L", //reflector oracle contract public key
    "oracleId": "C...A", //the deployed contract address
    "horizon": "https://rpc-futurenet.stellar.org:443", //horizon url
    "network": "Test SDF Future Network ; October 2022", //network passphrase
    "baseAsset": { //the contract's base asset. 1 - Stellar asset, 2 - Generic asset
      "type": 1,
      "code": "X:G...W"
    },
    "decimals": 14, //the contracts decimals
    "nodes": [ //nodes public keys (including current node)
      "G...U",
      "G...Y",
      "G...M"
    ],
    "assets": [ //supported assets
      {
        "type": 1,
        "code": "A:G...W"
      },
      {
        "type": 1,
        "code": "B:G...W"
      }
    ],
    "timeframe": 120000, //the contract's prices timeframe in ms
    "period": 120000000, //the contract's retention period in ms
    "fee": 1000000 //fee in stroops
  },
  "nodes": [ //nodes addresses
    {
      "pubkey": "G...U",
      "url": "ws://127.0.0.2"
    },
    {
      "pubkey": "G...Y",
      "url": "ws://127.0.0.3"
    },
    {
      "pubkey": "G...M",
      "url": "ws://127.0.0.4"
    }
  ],
  "dbConnectionString": "postgres://localhost:1234@localhost:5432/core", //db connection string
  "dbSyncDelay": 15, //delay for request to db. Database can be behind the blockchain
  "handshakeTimeout": 5000 //ws handshake timeout
}
```

### Start Reflector node

```
npm run start
```

## Admin HTTP API

### Authentication

For authentication Reflector utilizes ED25519 payload signing with the private key of the node.
Hex-encoded payload signature must be provided in the `Authorization` request header. 

#### Authorization Process

1. **Generate Payload**: Create a JSON payload containing request data.
2. **Sign Payload**: Use node's private key to sign the payload. Use [Albedo](https://albedo.link/) for signing, or utilize format:
    ```js
    
    const shajs = require('sha.js')
    
    const messageToSign = `${node_public_key}:${JSON.stringify(data_to_sign)}`
    const rawMessage = shajs('sha256').update(messageToSign).digest()
    const signature = node_key_pair.sign(rawMessage).toString('hex')
    
    ```
3. **Set Header**: Add the generated signature to the `Authorization` header in the API request.
    ```
    Authorization=Signature da07c682...
    ```

## Endpoints

#### Add new assets to quote

- Endpoint: `/assets`
- Method: `POST`
- Request format:
```json
{
    "assets": [{"type": 1, "code": "X:G...6"}, {"type": 2, "code": "USD"}], //assets to add
    "timestamp": 123000000 //scheduled update time
}
```

#### Update history retention period

- Endpoint: `/period`
- Method: `POST`
- Request format:
```json
{
    "period": 100000000, //new history retention period
    "timestamp": 123000000 //scheduled update time
}
```

#### Add/remove nodes to the quorum set

- Endpoint: `/nodes`
- Method: `POST`
- Request format:
```json
{
    "nodes": [
        {"node": "G...9", "url": "ws://node0:30348" }, //existing node
        {"node": "G...9", "url": "ws://node1:30348" }, //new node to add
        {"node": "G...M", "remove": true } //node to remove
    ],
    "timestamp": 123000000 //scheduled update time
}
```

#### Initialize new node from scratch

- Endpoint: `/config`
- Method: `POST`
- Request format:
```json
{
  "contractSettings": {
      "admin": "G...D",
      "oracleId": "C...O",
      "baseAsset": {
          "type": 1,
          "code": "X:G...W"
      },
      "decimals": 14,
      "horizon": "https://rpc-futurenet.stellar.org:443",
      "network": "Test SDF Future Network ; October 2022",
      "nodes": [
          "G...X",
          "G...Y"
      ],
      "assets": [
          {
              "type": 1,
              "code": "A:G...W"
          },
          {
              "type": 1,
              "code": "B:G...W"
          },
          {
              "type": 1,
              "code": "C:G...W"
          }
      ],
      "timeframe": 120000,
      "period": 120000000,
      "fee": 10000000
  },
  "nodes": [
      {
          "pubkey": "GB...X",
          "url": "ws://node0:30348"
      },
      {
          "pubkey": "GB...Y",
          "url": "ws://node1:30349"
      }
  ],
  "dbSyncDelay": 15,
  "dbConnectionString": "postgres://localhost:1234@localhost:5432/core" //if you're running Node in the 'reflector-node-stellar-core' Docker image, you don't need a connection string
}
```

#### Fetch basic server info

- Endpoint: `/`
- Does not require authentication
- Method: `GET`
- Response format:
```json
{
  "name": "reflector-node",
  "version": "v1.0.0",
  "pubkey": "G...D"
}
```

#### Fetch current server config

- Endpoint: `/config`
- Method: `GET`
- Response format:
```json
{
  "contractSettings": {
      "admin": "G...D",
      "oracleId": "C...O",
      "baseAsset": {
          "type": 1,
          "code": "X:G...W"
      },
      "decimals": 14,
      "horizon": "https://rpc-futurenet.stellar.org:443",
      "network": "Test SDF Future Network ; October 2022",
      "nodes": [
          "G...X",
          "G...Y"
      ],
      "assets": [
          {
              "type": 1,
              "code": "A:G...W"
          },
          {
              "type": 1,
              "code": "B:G...W"
          },
          {
              "type": 1,
              "code": "C:G...W"
          }
      ],
      "timeframe": 120000,
      "period": 120000000,
      "fee": 10000000
  },
  "nodes": [
      {
          "pubkey": "GB...X",
          "url": "ws://node0:30348"
      },
      {
          "pubkey": "GB...Y",
          "url": "ws://node1:30349"
      }
  ],
  "dbSyncDelay": 15
}
```

#### Fetch deployed smart contract settings

- Endpoint: `/contract-settings`
- Method: `GET`
- Response format:
```json
{
    "admin": "G...L",
    "oracleId": "C...A",
    "horizon": "https://rpc-futurenet.stellar.org:443",
    "network": "Test SDF Future Network ; October 2022",
    "baseAsset": { 
      "type": 1,
      "code": "X:G...W"
    },
    "decimals": 14,
    "nodes": [ 
      "G...U",
      "G...Y",
      "G...M"
    ],
    "assets": [ 
      {
        "type": 1,
        "code": "A:G...W"
      },
      {
        "type": 1,
        "code": "B:G...W"
      }
    ],
    "timeframe": 120000,
    "period": 120000000
}
```

#### Fetch general node statistics

- Endpoint: `/statistics`
- Method: `GET`
- Response:
```json
{
    "startTime": 1693501157690,
    "uptime": 594170,
    "lastProcessedTimestamp": 1693501680000,
    "totalProcessed": 14,
    "submittedTransactions": 7,
    "connectedNodes": [ "G...M", "G...7" ],
    "nodeStatus": "Ready",
    "oracleData": {
        "lastOracleTimestamp": 1693836480000,
        "isInitialized": true
    }
}
```

## Docker images

Docker configurations to run Reflector node software on top of Stellar-Quickstart Docker image or in standalone mode.

### Prerequisites

- Install Docker.

### Running Docker container

Example startup script for `reflector-node-stellar-core`:

```bash
docker run -it -d \
-e SECRET=S...4 \
-p 30347:30347 -p 30348:30348 \
-v "REFLECTOR_WORKDIR:/reflector-node/app/home" \
-v "STELLAR_WORKDIR:/opt/stellar" \ 
--name=reflector-node \
reflectornet/reflector-node-stellar-core:latest --futurenet --enable-soroban-rpc
```


Example startup script for `reflector-node-standalone`:

```bash
docker run -it -d \
-e SECRET=S...4 \
-p 30347:30347 -p 30348:30348 \
-v "REFLECTOR_WORKDIR:/reflector-node/app/home" \
--name=reflector-node \
reflectornet/reflector-node-standalone:latest
```

- `SECRET` - secret key of the node in the StrKey encoding format
- `REFLECTOR_WORKDIR` - path to the working directory where Reflector will store config and logs
- `STELLAR_WORKDIR` - path to StellarCore working directory to store core server data

#### Default ports 

- `30347`: REST API for administration 
- `30348`: WebSocket port for inter-cluster communication

#### Volumes

- Reflector working directory, e.g. `REFLECTOR_WORKDIR:/reflector-node/app/home`
- StellarCore working directory, e.g. `STELLAR_WORKDIR:/opt/stellar`