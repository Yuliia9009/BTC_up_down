// bot/bot.js
import 'dotenv/config';
import { JsonRpcProvider, Wallet, Contract } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const RPC_URL = process.env.RPC_URL || process.env.SEPOLIA_RPC;
const PK = process.env.LOCAL_PRIVATE_KEY || process.env.SEPOLIA_PRIVATE_KEY || process.env.PRIVATE_KEY;
const NEXT_DELAY = 5; // синхронизировано с контрактом (NEXT_DELAY)
const PRICE_SCALE = 10n ** 8n;
if (!RPC_URL || !PK) {
  console.error('Missing RPC_URL (or SEPOLIA_RPC) or LOCAL_PRIVATE_KEY/SEPOLIA_PRIVATE_KEY (or fallback PRIVATE_KEY) in bot/.env');
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cfgPath = path.resolve(__dirname, '../web/wwwroot/contractConfig.json');

async function waitForConfig() {
  while (true) {
    if (fs.existsSync(cfgPath)) {
      try {
        const raw = fs.readFileSync(cfgPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.address && parsed.abi) return parsed;
      } catch {}
    }
    console.log('[BOT] Waiting contractConfig.json ...');
    await new Promise(r => setTimeout(r, 1000));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDeployedCode(provider, addr) {
  while (true) {
    try {
      const code = await provider.getCode(addr);
      if (code && code !== '0x') return;
      console.log(`[BOT] Waiting for contract code at ${addr} ...`);
    } catch (e) {
      console.log(`[BOT] Waiting for RPC/code check... (${e?.message || e})`);
    }
    await sleep(1000);
  }
}

async function fetchBinancePrice() {
  const url = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  const res = await fetch(url, { signal: ctrl.signal });
  clearTimeout(timer);
  if (!res.ok) throw new Error(`Binance status ${res.status}`);
  const data = await res.json();
  const price = Number(data.price);
  if (!Number.isFinite(price)) throw new Error('Invalid price from Binance');
  return BigInt(Math.round(price * 1e8));
}

async function tick(contract, oracle, opts) {
  try {
    const rid = await contract.currentRoundId();
    const r = await contract.getRound(rid);
    const now = Math.floor(Date.now() / 1000);

    if (opts.isMock && oracle) {
      const needPrice = !r.locked || !r.settled;
      const stale = now - opts.lastPriceUpdate >= 5;
      if (needPrice && stale) {
        try {
          const price = await fetchBinancePrice();
          const tx = await oracle.setAnswer(price);
          await tx.wait();
          opts.lastPriceUpdate = now;
          console.log(`[BOT] Oracle updated from Binance: ${price} (×1e8)`);
        } catch (e) {
          console.error('[BOT] Failed to update oracle from Binance:', e?.message || e);
        }
      }
    }

    if (!r.locked && now >= Number(r.lockTime)) {
      console.log(`[BOT] Lock round ${rid}…`);
      const tx = await contract.progress();
      await tx.wait();
      console.log(`[BOT] Locked round ${rid}.`);
      return;
    }

    if (r.locked && !r.settled && now >= Number(r.settleTime)) {
      console.log(`[BOT] Settle round ${rid}…`);
      const tx = await contract.progress();
      await tx.wait();
      console.log(`[BOT] Settled round ${rid}.`);
      return;
    }

    if (r.settled && now >= Number(r.settleTime) + NEXT_DELAY) {
      console.log(`[BOT] Start next round after ${rid}…`);
      const tx = await contract.progress();
      await tx.wait();
      console.log(`[BOT] New round started.`);
      return;
    }
  } catch (e) {
    const msg = e?.reason || e?.shortMessage || e?.message || String(e);
    console.error('[BOT] Error:', msg);
  }
}

async function main() {
  const provider = new JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);
  const networkName =
    chainId === 1 ? 'mainnet' :
    chainId === 11155111 ? 'sepolia' :
    chainId === 31337 ? 'hardhat-local' :
    `chainId:${chainId}`;

  console.log(`[BOT] RPC: ${RPC_URL}`);
  console.log(`[BOT] Network detected: ${networkName} (chainId=${chainId})`);

  const { address, abi, feed, isMock } = await waitForConfig();
  await waitForDeployedCode(provider, address);
  const wallet = new Wallet(PK, provider);
  console.log(`[BOT] Contract: ${address}`);
  console.log(`[BOT] Wallet: ${await wallet.getAddress()}`);
  console.log(`[BOT] Key source: ${process.env.LOCAL_PRIVATE_KEY ? 'LOCAL_PRIVATE_KEY' : process.env.SEPOLIA_PRIVATE_KEY ? 'SEPOLIA_PRIVATE_KEY' : 'PRIVATE_KEY (fallback)'}`);

  const LOCAL_TEMPLATE = '0x5FbDB2315678afecb367f032d93F642f64180aa3'.toLowerCase();
  if (chainId !== 31337 && address.toLowerCase() === LOCAL_TEMPLATE) {
    console.error('[BOT] ERROR: contractConfig.json contains a LOCAL Hardhat address (0x5FbD...) but you are NOT on chainId 31337.');
    console.error('[BOT] Redeploy the contract to this network and ensure web/wwwroot/contractConfig.json was updated.');
    process.exit(1);
  }

  const contract = new Contract(address, abi, wallet);
  const oracle = isMock ? new Contract(feed, ['function setAnswer(int256) external'], wallet) : null;

  {
    let ok = false;
    for (let i = 1; i <= 10; i++) {
      try {
        await contract.currentRoundId();
        ok = true;
        break;
      } catch (e) {
        const msg = e?.reason || e?.shortMessage || e?.message || String(e);
        console.error(`[BOT] currentRoundId() failed (attempt ${i}/10): ${msg}`);
        await sleep(1500);
      }
    }
    if (!ok) {
      console.error("[BOT] Giving up after 10 attempts. Check ABI/address in web/wwwroot/contractConfig.json and that the contract is deployed on this network.");
      process.exit(1);
    }
  }

  console.log("[BOT] Ready. Polling progress() ...");
  const opts = { isMock: !!isMock, lastPriceUpdate: 0 };
  setInterval(() => tick(contract, oracle, opts), 7000);
}
main().catch(console.error);
