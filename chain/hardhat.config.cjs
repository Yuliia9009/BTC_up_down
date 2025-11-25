require("dotenv/config");
require("@nomicfoundation/hardhat-toolbox");

const {
  RPC_URL,
  LOCAL_PRIVATE_KEY,
  SEPOLIA_RPC,
  SEPOLIA_PRIVATE_KEY,
  FORK,
} = process.env;

const useFork = FORK === "1" && !!SEPOLIA_RPC;

console.log(
  "[cfg] useFork:",
  useFork,
  "| RPC_URL:",
  !!RPC_URL,
  "| LOCAL_PRIVATE_KEY:",
  !!LOCAL_PRIVATE_KEY,
  "| SEPOLIA_RPC:",
  !!SEPOLIA_RPC,
  "| SEPOLIA_PRIVATE_KEY:",
  !!SEPOLIA_PRIVATE_KEY
);

const networks = {
  hardhat: {
    ...(useFork ? { forking: { url: SEPOLIA_RPC } } : {}),
  },
  localhost: {
    url: "http://127.0.0.1:8545",
    ...(LOCAL_PRIVATE_KEY ? { accounts: [LOCAL_PRIVATE_KEY] } : {}),
  },
};

if (SEPOLIA_RPC) {
  networks.sepolia = {
    url: SEPOLIA_RPC,
    ...(SEPOLIA_PRIVATE_KEY ? { accounts: [SEPOLIA_PRIVATE_KEY] } : {}),
  };
}

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks,
};
