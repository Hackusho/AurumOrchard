# 🌳 Aurum Orchard

### Aurum Orchard is a modular, nature-inspired ecosystem for automated arbitrage, reinvestment, and venture incubation. It transforms blockchain profits into sustainable growth through a regenerative financial cycle.

# 🌟 Vision

### Aurum Orchard isn’t just an arbitrage bot — it’s a living system. Inspired by the metaphor of a tree, profits flow like nutrients: from roots, through the trunk, into branches, and ultimately bear fruit. This design ensures scalability, accountability, and continuous reinvestment into innovation.

# 🌱 Core Components

## Midas Seed Project 🌱
### The arbitrage engine.

- Executes flashloan & cross-DEX strategies

- Scans for profitable token price discrepancies

- Prioritizes speed, safety, and slippage protection

## Root System 🌳
### The extractor.

- Collects profits from Midas Seed executions

- Locks in gains and validates trade success

- Ensures risk is contained at the foundation

## Goldstem 🌟
### The funnel.

- Allocates profits using structured splits (e.g., 20/40/40)

- Sends yield to wallets for owner draw, reinvestment, and R&D

- Acts as the financial “trunk” of the orchard

## Branches 🌿
### The incubator.

- Funds new R&D projects and experimental ventures

- Incubates tools, bots, and innovation pipelines

- Extends the orchard’s reach beyond arbitrage

## Fruit 🍎
### The profit.

- Tangible yields from validated strategies and ventures
 
- Transparent logging of ecosystem gains

## Replanting Cycle 🔄
### The reinvestment engine.

- Loops profits back into growth using structured logic
 
- Creates compounding cycles for sustainable expansion

## The Grove 🌲 (optional, future)

### Represents fully launched, independent ventures spun out of the Orchard

# ⚙️ Technical Stack

- Smart Contracts: Solidity (Arbitrum, Ethereum L2s)

- Execution Layer: Node.js + Web3.js / ethers.js

- Dispatcher System: Routes opportunities to the right bots

- Bot Executors: Specialized strategies (pair arb, trio arb, cross-chain, volatility)

- Risk & Safety: Flashloan safety checks, slippage guards, capital locks

- Infrastructure: Dockerized microservices, Redis/Postgres for logging

# 🚀 Roadmap

## Phase 1: ARB-v1 — Seed + Root wallets with manual profit handling

## Phase 2: ARB-v2 — Goldstem smart contract + automated splits

## Phase 3: Expansion into multi-chain arb, advanced dispatching, and R&D branches

## Phase 4: Fully regenerative loop with Grove-level ventures

# 📜 Philosophy

### Aurum Orchard blends AI, blockchain, and finance with the discipline of first principles engineering. By structuring profits like the cycles of nature, it creates a self-sustaining ecosystem where every trade nourishes future growth.

# 🗂️ Repository Overview

- `bot/` – Python trading bot that orchestrates seed/root wallets, performs flash‑loan checks, and routes profits through Goldstem.
- `contracts/` – Hardhat project containing the `Goldstem.sol` splitter and `FlashloanExecutor.sol` for Uniswap V3 round‑trip arbitrage.
- `frontend/` – Vite + React interface for interacting with Goldstem and viewing split events.
- `wallet_generator.js` – Node script to create and print a new wallet address, private key, and mnemonic.
- `script.js` – Simple example querying ETH balances on Arbitrum, Base, and Optimism via Etherscan.
- `jules-scratch/` – Experimental scripts such as Playwright‑based frontend verification.

# 🚀 Getting Started

## Install dependencies

### Node

```bash
npm install
cd contracts && npm install
cd ../frontend && npm install
```

### Python

```bash
pip install -r requirements.txt
pip install -r bot/requirements.txt
```

## Running the trading bot

Set environment variables such as `ARBITRUM_MAINNET_RPC_URL`, `SEED_KEY`, `ROOT_KEY`, `GOLDSTEM_ADDRESS`, `FLASH_EXECUTOR_ADDRESS`, `FLASH_ASSET`, and `FLASH_AMOUNT_WEI`, then execute:

The bot now merges any addresses supplied via `ROUTE_MIDS_CSV` with a cached list of high-liquidity tokens stored in `bot/tokenlist.json`. If the cache is missing it is fetched from an external token list. Expanding this set of intermediate tokens improves route coverage and helps discover more arbitrage opportunities.

```bash
python bot/main.py
```

Polling defaults to once per second. Override with `POLL_MS` and enable adaptive
adjustments by setting `ADAPTIVE_POLL=1`. When adaptive mode is on, the bot
shortens the delay after profitable trades and gradually lengthens it after
missed opportunities. `MIN_POLL_MS` and `MAX_POLL_MS` bound this range.

## Hardhat tasks & tests

From the `contracts` directory:

```bash
npx hardhat test
npx hardhat flash:dryrun
```

## Frontend

```bash
cd frontend
npm run dev
```

## Utility scripts

- Generate a wallet: `node wallet_generator.js`
- Query cross‑chain balances: `node script.js`
