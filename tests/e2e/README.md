# Cluster end-to-end runner

Drives the local three-node cluster from `tests/cluster/clusterData` through node changes, every kind of cluster config
update, governance votes, node outages and data-provider changes, against Stellar testnet, and writes a pass/fail report
per scenario to `tests/e2e/reports/`.

## Before a run

- Docker Desktop with host networking enabled (Settings → Resources → Network).
- The image built from the code under test: `npm run build && npm run build-docker-image`.
- A node-orchestrator checkout at `../node-orchestrator` with its dependencies installed and a `home/app.config.json`,
  and its MongoDB running. The runner starts its own orchestrator from that checkout on `http://localhost:12274`, in
  a working directory under `tests/cluster/clusterData/e2e/orchestrator`, with a copy of that config pointed at a
  database of its own; nothing else may answer on the port.
- A pubnet Soroban RPC on `http://localhost:8003` for the `pubnet` data source.
- For U8: `node tests/e2e/build-wasm.js` once (needs `../reflector-contract`, the Stellar CLI and the `wasm32v1-none`
  Rust target).

## Commands

| Command | What it does |
|---|---|
| `node tests/e2e/run.js bootstrap` | Starts the runner's orchestrator if needed, points the cluster at localhost, posts its config as the first one, starts the containers on the host network |
| `node tests/e2e/run.js bootstrap --reset` | The same on a database no earlier run used |
| `node tests/e2e/run.js stop-orchestrator` | Stops the runner's orchestrator |
| `node tests/e2e/run.js` | Every scenario, in catalogue order (several hours) |
| `node tests/e2e/run.js N1 U3` | Only these |
| `node tests/e2e/run.js --from U4` | From U4 on |
| `node tests/e2e/run.js --list` | The catalogue |
| `--withdraw-open` | Withdraws a proposal left open by an interrupted run before starting |

The cluster state carries over between runs: each scenario works out its change from what the chain and the
orchestrator hold, and skips with a reason when it cannot run (for example, no spare node key). Ctrl-C restores the
current scenario before exiting.

The health check between scenarios fails the run on a node that is not on the current config, an oracle that missed a
tick, or an unexpected error line. Errors that only say a data source's RPC did not answer are listed in the report as
environment notes instead.

With host networking the containers share one network namespace, so only the first node's promtail can bind its port;
log shipping from the other nodes is off during a run.
