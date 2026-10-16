# Tripwire

A live feed of **Robinhood Chain** contracts that just changed their rules: code swapped behind a proxy, upgrade admins moved, owners handed off or renounced, contracts paused. Paste any token to see who controls it right now and every time its rules changed since launch.

## What it catches

| Event | Signal |
|---|---|
| `Upgraded(address)` | **Code swapped**: a proxy now runs different code |
| `AdminChanged(address,address)` | **Admin moved**: someone else can upgrade it now |
| `Paused(address)` / `Unpaused(address)` | Transfers or trading stopped / restarted |
| `OwnershipTransferred(address,address)` | **Owner changed**, or **renounced** (sent to `0x0` or `0x…dead`) |

Setup that happens in the launch transaction (ownership minted from zero, first admin, `BeaconUpgraded` from a new beacon proxy, in the contract's earliest tx) is recognised as **launch-time setup** and kept out of the feed. In a contract lookup it shows as the launch, and Tripwire reports how long after launch the rules first changed.

Code swaps from EIP-7702 smart wallets (EOAs whose code is a `0xef0100…` delegation) are hidden. They are wallets upgrading, not contracts.

## How it works

Everything runs in your browser. No server, no wallet connect, nothing to sign.

1. **Feed:** `eth_getLogs` across the whole chain for the tracked event topics. The public RPC (`rpc.mainnet.chain.robinhood.com`, chain 4663) allows 30k blocks (~50 min) per chain-wide query, so 24h is ~29 windows, newest first.
2. **Labels:** `eth_getCode` (one address per new implementation, which is enough to spot smart wallets), `symbol()`, then DexScreener for market cap. Wallet, symbol and size labels are cached in `localStorage`. Market data is always fresh.
3. **Lookup:** the EIP-1967 implementation/admin/beacon slots, `owner()`, `paused()`, plus that contract's full event history in 10M-block windows, walking back until the launch is found.
4. **Live:** polls for new blocks every 15s while the tab is visible.

The RPC has a small call budget (about 10 calls/s sustained, at most ~24 calls per batch). Bursts get a Cloudflare reply with a broken `*,*` CORS header. All requests go through one shared throttle that cools down together on failure.

## Run locally

```bash
python -m http.server 5291
```

```bash
npm test
```

Static files only: `index.html`, `style.css`, `app.js`, `view.js`, `core.js`, `classify.js`.

An event is a signal to look closer, not a verdict. Not financial advice. Not affiliated with Robinhood.
