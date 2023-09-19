# @reflector/reflector-node

> Reflector node server

## Installation

```bash
npm i
```

## Usage

### Prerequisites:

1. Begin by building and deploying the [Reflector Oracle contract](https://github.com/reflector-network/reflector-contract).
2. Next, create a multisig account which will serve as the administrative account for the contract. Ensure that each signer corresponds to a node.

### Configuration

Create app.config.json file in the root folder
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

### Start node

```bash
npm run start
```

## API

## Authentication

We use payload signing with the private key of the node as authentication. The signature must be added to the Authentication header. 

### Authentication Process

1. **Generate Payload**: Create a JSON payload containing the necessary data for the request.

2. **Sign Payload**: Use node's private key to sign the payload. Use [Albedo](https://albedo.link/) for signing, or follow next format:

```js

const shajs = require('sha.js')

const messageToSign = `${node_public_key}:${JSON.stringify(data_to_sign)}`
const messageBuffer = shajs('sha256').update(messageToSign).digest()
const signature = node_key_pair.sign(message).toString('hex')

```

3. **Include Signature in Header**: Add the generated signature to the Authentication header in the API request.

Example: 
```bash
curl -X GET "https://reflector.node.com/updateAssets" \
-H "Content-Type: application/json" \
-H "Authentication: Signature YOUR_HEX_SIGNATURE"
...
```

## Endpoints

#### Update assets

Creates pending assets update

- Endpoint: `/assets`
- AllowAnonymous: false
- Method: `post`
- Post data:
```json
{
    "assets": [{"type": 1, "code": "X:G...6"}, {"type": 2, "code": "USD"}], //assets to add
    "timestamp": 123000000 //when update must be submitted
}
```
Responses nothing 

#### Update period

Creates pending period update

- Endpoint: `/period`
- AllowAnonymous: false
- Method: `post`
- Post data:
```json
{
    "period": 100000000, //new period to set
    "timestamp": 123000000 //when update must be submitted
}
```

#### Update nodes

Creates pending nodes update

- Endpoint: `/nodes`
- AllowAnonymous: false
- Method: `post`
- Post data:
```json
{
    "nodes": [
        {"node": "G...9", "url": "ws://node0:30348" }, //presented node
        {"node": "G...9", "url": "ws://node1:30348" }, //new node to add
        {"node": "G...M", "remove": true } //node to remove
    ],
    "timestamp": 123000000 //when update must be submitted
}
```

#### Init config

Saves config to app.config.json, and switches node to Ready state

- Endpoint: `/config`
- AllowAnonymous: false
- Method: `post`
- Post data:
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

#### Get app name

Returns name and version

- Endpoint: `/`
- AllowAnonymous: true
- Method: `get`
- Response:
```json
{
  "name": "reflector-node",
  "version": "v1.0.0",
  "pubkey": "G...D"
}
```

#### Get current config

Returns the current contract settings

- Endpoint: `/config`
- AllowAnonymous: false
- Method: `get`
- Response:
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


#### Get current settings

Returns the current contract settings

- Endpoint: `/contract-settings`
- AllowAnonymous: false
- Method: `get`
- Response:
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

#### Statistics

Returns current node statistics

- Endpoint: `/statistics`
- AllowAnonymous: false
- Method: `get`
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

# Reflector-Node Docker

This repository provides Docker configurations to run Reflector-Node along with the Stellar service.

## Prerequisites

- Docker installed on your machine.

## Running the Docker Container


Example running reflector-node-stellar-core:

```bash
docker run -it -d \
-e SECRET=S...4 \
-p 30347:30347 -p 30348:30348 \
-v "YOUR_PATH_TO_REFLECTOR_DIRECTORY:/reflector-node/app/home" \
-v "YOUR_PATH_TO_STELLAR_DATA:/opt/stellar" \ 
--name=reflector-node \
reflectornet/reflector-node-stellar-core:latest --futurenet --enable-soroban-rpc
```


Example running reflector-node-standalone:

```bash
docker run -it -d \
-e SECRET=S...4 \
-p 30347:30347 -p 30348:30348 \
-v "YOUR_PATH_TO_REFLECTOR_DIRECTORY:/reflector-node/app/home" \
--name=reflector-node \
reflectornet/reflector-node-standalone:latest
```

Replace `SECRET` with the node's secret, `YOUR_PATH_TO_REFLECTOR_DIRECTORY` with the path to the reflector home folder and `YOUR_PATH_TO_STELLAR_DATA` with the path to your stellar data folder.

## Exposed Ports

- `30347`: API port 
- `30348`: WebSocket port

## Volumes

You need to mount two volumes:

1. Reflector home directory: `YOUR_PATH_TO_REFLECTOR_DIRECTORY:/reflector-node/app/home`
2. Stellar data: `YOUR_PATH_TO_STELLAR_DATA:/opt/stellar`

Make sure to replace `YOUR_PATH_TO_REFLECTOR_DIRECTORY` and `YOUR_PATH_TO_STELLAR_DATA` with appropriate paths from your host machine.