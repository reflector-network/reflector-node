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
  "secret": "SA5G...1DKG",
  "port": 30347,
  "dataSources": {
    "pubnet": {
      "name": "pubnet",
      "type": "db",
      "sorobanRpc": ["http://172.16.5.4:8003/", "https://stellar-rpc.local/"]
    }
  }
}
```

Where:
- `secret` (string) - node secret key (should be unique for every node in the cluster). Keep the file readable by its
  owner only (`chmod 600`); the node never rewrites it, and closes its home directory to other users (`chmod 700`) at start
- `dataSources` (settings[]) - price data sources configuration; a source's optional `providers` block chooses its
  providers and their settings (for a Stellar source, its pool providers: see the stellar-connector README "Pool
  providers"), and must be the same on every node
- `dbSyncDelay` - no longer read: the sync delays are the same for every node (trades gossip 15 s after each minute,
  oracle and subscriptions rounds 20 s after their tick). A node whose config still has it logs a warning at boot.
- `port` (number) - [optional] TCP port for inbound connections (30347); 1024 or above in the Docker image, see
  [Default ports](#default-ports)
- `trace` (true|false) - [optional] detailed events tracing (false). A toggle from the admin dashboard is stored in
  `.state.json` in the home directory and takes precedence
- `orchestratorUrl` (string) - [optional] orchestrator endpoint, `https://` or `wss://`
  (`https://orchestrator.reflector.network`). `http://` and `ws://` are accepted for a local or staging cluster;
  to any host but this machine they are logged as a warning at boot, because the orchestrator is authenticated by TLS
  alone and it sends the node the cluster secret. Any other scheme stops the node at boot. Prefer `https://` with no path: the Docker image derives promtail's log push URL from this value
  (mapping `wss://` to `https://` and keeping any path)
- `handshakeTimeout` (number) - [optional] timeout to drop hanging incoming node connections
- `clusterConfigHash` (string) - [optional] 64-character hex hash of the cluster config this node may adopt while it
  holds none yet. Consulted only at that point; a node that already has a cluster config ignores it. Without it, a node
  with no config adopts the first one only if that config carries this node's own signature — see
  [the admin guide](docs/admin/guide/index.md#how-a-node-decides-to-trust-its-very-first-cluster-config)
 
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
    -v "REFLECTOR_WORKDIR:/reflector-node/app/home" \
    --name=reflector-node \
    reflectornet/reflector-node:latest
```
- `REFLECTOR_WORKDIR` - path to the working directory where Reflector will store config and logs


#### Default ports 

- `30347`: WebSocket port for inter-cluster communication

The node runs as the unprivileged uid 1000 with host networking, so a `port` below 1024 cannot be bound: the node fails
with EACCES and supervisord restarts it in a loop. Keep the port at 1024 or above.

Inbound WebSocket connections are limited per cluster key, never per address, so peers may share an address or sit behind a proxy. A connection that does not name a key of the current cluster is closed before any challenge, and a refused socket that has not closed is destroyed after 1 s. Each cluster key may have at most 2 unanswered handshakes; a newer one closes the oldest, so the real peer always gets a slot and answers its challenge within a round trip. A validated connection replaces the peer's previous one.

#### Volumes

- Reflector working directory, e.g. `REFLECTOR_WORKDIR:/reflector-node/app/home`

The container runs the node and promtail as its unprivileged `node` user (uid 1000). On start it gives that user the
mounted working directory and closes it to every other user (`chmod 700`), because it holds the node secret and the
cluster RSA key; on the host the directory and its files are then owned by uid 1000. The directory must therefore be
writable and chown-able by root inside the container: a read-only mount or a root-squashed network share stops the
container at start with an error naming the home. The entrypoint itself must start as root, so `docker run --user`
stops the container at start with an error saying so.

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
- Node.js 22.12 or later (required by @stellar/stellar-sdk 17)

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

## Gateways

A node can send its exchanges price requests and subscription webhooks through gateways, so its own address stays
private. The list lives in `gateways.json` in the home directory and is pushed from the admin dashboard.

- Every URL is `http:` or `https:`, carries no user information, no query string and no fragment (a bare `?` or `#`
  counts), is not a private or reserved IP literal in any IPv4 or IPv6 spelling, and is at most 2048 characters long. A list holds at most 10 URLs, and a non-empty
  list needs a string `challenge`.
- An empty or missing list, or no `gateways.json` at all, means no gateways: the node sends directly.
- A non-empty list of which no entry is usable — or a `gateways.json` the node cannot read or parse — stops webhooks and
  exchanges price fetches on that node rather than sending them directly. The node reports it to the orchestrator as a
  connection issue, and the dashboard marks the list unusable. When half the nodes or more are in that state the
  exchanges feed stops for the whole cluster.
- `http` gateways are accepted; prefer `https`, because with `http` the gateway validation token travels in plaintext.
- A gateway named by a hostname is checked by its name only. If the name resolves to a private or reserved address,
  exchanges price fetches still go through it while webhooks and metrics through it are refused. Name gateways by a
  public address or by a hostname you control.
- To check a file against these rules: `node src/utils/check-gateways.js <home>/gateways.json` (in the image:
  `/reflector-node/app/utils/check-gateways.js`). It prints the state (`none`, `usable` or `unusable`) and each
  problem by position and host, never a whole URL. It exits 1 when the list is unusable or any entry is refused, and
  when the file does not exist unless `--missing-ok` is given for a node that has none; even then the home directory
  must exist, so a mistyped home still fails. It checks IP literals only, not what a hostname resolves to.

## Admin Dashboard

[Admin Dashboard](https://node-admin.reflector.network) is a GUI that simplifies common administrative tasks, monitoring, and management of Reflector nodes.  
Check [admin guide](docs/admin/guide/index.md) for a short 101 course on node administration.

### Who can read a node's logs

The node checks every log and trace request the orchestrator relays: the operator's signature over the exact request,
the node it names, and a nonce that only moves forward per request type and signer.

- Changing a node's trace setting is accepted only when the node's own key signed the request.
- Listing or downloading a node's logs is accepted from the node's own key and from **any key of the current cluster
  config** that names the node in the request. The orchestrator lets only its configured `monitoringKey` aim a request at
  another node, but a node cannot tell which cluster key that is.
- Log messages and errors are redacted before they are written (secret seeds, RSA keys, credentials, API keys in query
  strings, every URL cut to its scheme, host and port - no path, query or user info - and the middle of IPv4 and IPv6
  addresses), and fields named `secret`, `clusterSecret`, `apiKey` or
  `gatewayValidationKey` are censored, but the logs still describe the node's activity. Treat every cluster operator as
  able to read them.
