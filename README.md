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
  "secret": "SA5G...1DKG", //secret key of the node
  "port": 30347,
  "dataSources": {
    "pubnet": {
      "name": "pubnet",
      "type": "db",
      "sorobanRpc": ["http://172.16.5.4:8003/", "https://stellar-rpc.local/"],
    }
  }
}
```

Where:
- `secret` (string) - node secret key (should be unique for every node in the cluster) 
- `dataSources` (settings[]) - price data sources configuration
- `dbSyncDelay` (number) - [optional] delay in seconds for database synchronization, should be identical for all nodes in the cluster (15)
- `port` (number) - [optional] TCP port for inbound connections (30347)
- `trace` (true|false) - [optional] detailed events tracing (false)
- `handshakeTimeout` (number) - [optional] timeout to drop hanging incoming node connections
 
If you are joining the existing cluster, ask other node operators to share their basic config params, then override `secret` and data sources configuration parameters.

---

## Usage | Docker image (for node operators)

Docker configurations to run Reflector node Docker image.

Prerequisites:
- Docker

### Running Docker container

Example startup script:

```bash
docker run -it -d --network host \
    -p 30347:30347 \
    -v "REFLECTOR_WORKDIR:/reflector-node/app/home" \
    --name=reflector-node \
    reflectornet/reflector-node:latest
```
- `REFLECTOR_WORKDIR` - path to the working directory where Reflector will store config and logs


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
