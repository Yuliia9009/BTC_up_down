import hre from "hardhat";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Реальный BTC/USD фид в Sepolia (Chainlink)
const ORACLE_SEPOLIA = "0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43";

async function main() {
  const netName = hre.network.name;
  console.log(`[deploy] Network: ${netName}`);

  // 1) Пытаемся использовать реальный фид (сработает на форке Sepolia и в настоящей Sepolia)
  let feedAddr;
  try {
    const abi = [
      "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"
    ];
    const signer = (await hre.ethers.getSigners())[0];
    const feed = new hre.ethers.Contract(ORACLE_SEPOLIA, abi, signer);

    // если это не форк/не доступен фид — тут упадём в catch
    await feed.latestRoundData();
    feedAddr = ORACLE_SEPOLIA;
    console.log(`[deploy] Using real Chainlink feed: ${feedAddr}`);
  } catch (e) {
    // 2) Чистая локалка — разворачиваем мок
    console.log(`[deploy] Real feed not available. Deploying MockOracle on ${netName}...`);
    const Mock = await hre.ethers.getContractFactory("MockOracle");
    const mock = await Mock.deploy();
    await mock.waitForDeployment();
    feedAddr = await mock.getAddress();
    console.log(`[deploy] MockOracle deployed at: ${feedAddr}`);
    // Seed initial price so lock/settle read a non-zero value (60,000 * 1e8)
    await (await mock.setAnswer(60000n * 10n**8n)).wait();
    console.log("[deploy] MockOracle seeded with price: $60000 (×1e8)");
  }

  // 3) Деплой основного контракта
  const BtcUpDown = await hre.ethers.getContractFactory("BtcUpDown");
  const c = await BtcUpDown.deploy(feedAddr);
  await c.waitForDeployment();

  const address = await c.getAddress();
  console.log(`[deploy] BtcUpDown deployed to: ${address}`);

  // 4) Пишем конфиг для фронта
  const artifact = await hre.artifacts.readArtifact("BtcUpDown");
  const isMock = feedAddr.toLowerCase() !== ORACLE_SEPOLIA.toLowerCase();
  const config = { address, abi: artifact.abi, feed: feedAddr, isMock };

  const outPath = path.resolve(__dirname, "..", "..", "web", "wwwroot", "contractConfig.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(config, null, 2));
  console.log("[deploy] Wrote config to:", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});