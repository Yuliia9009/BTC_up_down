(() => {
    // ===== helpers =====
    const id = (s) => document.getElementById(s);
    const qs = (s) => document.querySelector(s);
    const toast = (msg) => {
        if (toastEl) toastEl.textContent = msg;
        console.log("[UI]", msg);
    };
    const fmtEth = (wei) => ethers.formatEther(wei);
    const mask = (addr) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "—");

    const netNameByChainId = (chainId) => {
        if (chainId === 1n) return "Ethereum Mainnet";
        if (chainId === 11155111n) return "Sepolia";
        if (chainId === 31337n) return "Hardhat Localhost";
        return `chainId:${chainId}`;
    };

    const ensureContractDeployedOnThisNetwork = async (provider, addr) => {
        const code = await provider.getCode(addr);
        if (!code || code === "0x") {
            throw new Error(
                "По адресу из contractConfig.json на выбранной сети нет кода контракта. " +
                    "Задеплой контракт на этой сети и обнови web/wwwroot/contractConfig.json."
            );
        }
    };

    // ===== DOM =====
    const acctEl = id("acct");
    const networkEl = id("network");
    const contractAddrEl = id("contractAddr");
    const ridEl = id("rid");
    const phaseEl = id("phase");
    const countdownEl = id("countdown");
    const priceLockEl = id("priceLock");
    const priceSettleEl = id("priceSettle");
    const poolUpEl = id("poolUp");
    const poolDownEl = id("poolDown");
    const shareUpEl = id("shareUp");
    const shareDownEl = id("shareDown");
    const bankEl = id("bank");
    const feeCalcEl = id("feeCalc");
    const toastEl = id("toast");
    const feesEl = id("fees");
    const ownerShortEl = id("ownerShort");
    const winnersTbody = qs("#winners tbody");
    const balanceEl = id("balance");

    const connectBtn = id("connectBtn");
    const betUpBtn = id("betUp");
    const betDownBtn = id("betDown");
    const claimBtn = id("claimBtn");
    const withdrawBtn = id("withdrawBtn");
    const progressBtn = id("progressBtn");
    const amountEl = id("amount");
    const depAmountEl = id("depAmount");
    const depBtn = id("depBtn");
    const cashoutAmountEl = id("cashoutAmount");
    const cashoutBtn = id("cashoutBtn");
    const stopBtn = id("stopBtn");

    // ===== state =====
    let provider;
    let signer;
    let contract;
    let cfg;
    let account;
    let owner;
    const feeBps = 100n;
    let lastRound = null;
    const knownAddrs = new Set();
    let txBusy = false;
    const NEXT_DELAY = 5; // синхронизировано с контрактом
    const DRIFT_SEC = 1;  // страховка от ранних вызовов
    let balanceWei = 0n;

    // ===== config =====
    const loadConfig = async () => {
        try {
            const res = await fetch("contractConfig.json");
            if (!res.ok) {
                toast("contractConfig.json не найден. Сначала задеплой контракт скриптом deploy.js.");
                return;
            }
            cfg = await res.json();
            contractAddrEl.textContent = cfg.address;
        } catch (e) {
            toast("Не удалось загрузить contractConfig.json");
            console.error(e);
        }
    };

    // ===== connect =====
    const connect = async () => {
        if (!cfg?.address) {
            toast("Нет конфига контракта. Сначала задеплой контракт.");
            return;
        }
        if (!window.ethereum) {
            alert("Нужен MetaMask");
            return;
        }

        try {
            const curChainId = await window.ethereum.request({ method: "eth_chainId" });
            if (curChainId.toLowerCase() !== "0x7a69") {
                try {
                    await window.ethereum.request({
                        method: "wallet_switchEthereumChain",
                        params: [{ chainId: "0x7A69" }],
                    });
                } catch (switchErr) {
                    if (switchErr && switchErr.code === 4902) {
                        await window.ethereum.request({
                            method: "wallet_addEthereumChain",
                            params: [
                                {
                                    chainId: "0x7A69",
                                    chainName: "Hardhat Localhost",
                                    rpcUrls: ["http://127.0.0.1:8545"],
                                    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
                                },
                            ],
                        });
                    } else {
                        console.warn("switch chain failed:", switchErr);
                    }
                }
            }
        } catch (e) {
            console.warn("eth_chainId check failed:", e);
        }

        provider = new ethers.BrowserProvider(window.ethereum);
        await provider.send("eth_requestAccounts", []);
        signer = await provider.getSigner();
        account = await signer.getAddress();
        acctEl.textContent = account;

        const net = await provider.getNetwork();
        const netLabel = netNameByChainId(net.chainId);
        if (networkEl) networkEl.textContent = netLabel;
        document.title = `BTC Up/Down — dApp (${netLabel})`;

        await ensureContractDeployedOnThisNetwork(provider, cfg.address);
        contract = new ethers.Contract(cfg.address, cfg.abi, signer);

        try {
            owner = await contract.owner();
            ownerShortEl.textContent = mask(owner);
        } catch (e) {
            toast("Не удалось прочитать owner() — проверь ABI/адрес в contractConfig.json");
            console.error(e);
            return;
        }

        await refresh();
        await loadTop();
        subscribe();

        if (window.ethereum?.on) {
            window.ethereum.on("accountsChanged", () => location.reload());
            window.ethereum.on("chainChanged", () => location.reload());
        }
    };

    // ===== refresh =====
    const refresh = async () => {
        if (!contract) return;

        try {
            const rid = await contract.currentRoundId();
            ridEl.textContent = `#${rid}`;

            const r = await contract.getRound(rid);
            lastRound = r;

            const bankBI = r.poolUp + r.poolDown;
            const feeCalcBI = (bankBI * feeBps) / 10000n;

            poolUpEl.textContent = ethers.formatEther(r.poolUp);
            poolDownEl.textContent = ethers.formatEther(r.poolDown);
            bankEl.textContent = fmtEth(bankBI);
            feeCalcEl.textContent = fmtEth(feeCalcBI);
            priceLockEl.textContent = r.locked ? r.priceLock.toString() : "—";
            priceSettleEl.textContent = r.settled ? r.priceSettle.toString() : "—";

            const tot = Number(bankBI);
            const up = Number(r.poolUp);
            const dn = Number(r.poolDown);
            shareUpEl.textContent = tot > 0 ? `${((up / tot) * 100).toFixed(1)}%` : "—";
            shareDownEl.textContent = tot > 0 ? `${((dn / tot) * 100).toFixed(1)}%` : "—";

            const now = Math.floor(Date.now() / 1000);
            let phase;
            let nextTs;
            if (!r.locked) {
                phase = "Фаза ставок";
                nextTs = Number(r.lockTime);
            } else if (!r.settled) {
                phase = "Ожидание settle";
                nextTs = Number(r.settleTime);
            } else {
                phase = "Пауза перед новым раундом";
                nextTs = Number(r.settleTime) + NEXT_DELAY;
            }
            phaseEl.textContent = phase;
            const left = Math.max(0, nextTs - now);
            countdownEl.textContent = left > 0 ? `${left} сек` : "0 сек";

            const feesWei = await contract.feesAccrued();
            feesEl.textContent = fmtEth(feesWei);

            if (account) {
                balanceWei = await contract.balance(account);
                balanceEl.textContent = fmtEth(balanceWei);
            }
        } catch (e) {
            const msg = e?.reason || e?.shortMessage || e?.message || String(e);
            if (!/execution reverted|NO_ACTION|CALL_EXCEPTION|missing revert data|BAD_DATA/i.test(msg)) {
                console.error("[refresh]", e);
            }
        }
    };

    // ===== auto progress =====
    const autoProgress = async () => {
        if (!lastRound || !contract || txBusy) return;
        const now = Math.floor(Date.now() / 1000);

        try {
            if (!lastRound.locked && now >= Number(lastRound.lockTime) + DRIFT_SEC) {
                txBusy = true;
                const tx = await contract.progress();
                await tx.wait();
                toast("lock → OK");
                await refresh();
                return;
            }
            if (lastRound.locked && !lastRound.settled && now >= Number(lastRound.settleTime) + DRIFT_SEC) {
                txBusy = true;
                const tx = await contract.progress();
                await tx.wait();
                toast("settle → OK");
                await refresh();
                return;
            }
            if (lastRound.settled && now >= Number(lastRound.settleTime) + NEXT_DELAY + DRIFT_SEC) {
                txBusy = true;
                const tx = await contract.progress();
                await tx.wait();
                toast("new round → OK");
                await refresh();
            }
        } catch {
            // ignore expected NO_ACTION-type errors
        } finally {
            txBusy = false;
        }
    };

    // ===== actions =====
    const pickClaimRid = async () => {
        const curr = await contract.currentRoundId();
        const currentRound = await contract.getRound(curr);
        if (currentRound.settled) return curr;
        if (curr > 1n) {
            const prev = await contract.getRound(curr - 1n);
            if (prev.settled) return curr - 1n;
        }
        throw new Error("Нет завершённых раундов для claim");
    };

    const bet = async (side) => {
        if (txBusy || !contract) return;
        try {
            txBusy = true;
            const eth = (amountEl.value || "0.00002").trim();
            const tx = await contract.bet(side, ethers.parseEther(eth));
            toast(`Tx: ${tx.hash}`);
            await tx.wait();
            toast("Ставка отправлена");
            await refresh();
        } catch (e) {
            toast(`Ставка не прошла: ${e?.shortMessage || e?.message || e}`);
        } finally {
            txBusy = false;
        }
    };

    const claim = async () => {
        if (txBusy || !contract) return;
        try {
            txBusy = true;
            const rid = await pickClaimRid();
            const tx = await contract.claim(rid);
            toast(`Claim tx: ${tx.hash}`);
            await tx.wait();
            toast("Выплата получена");
            await refresh();
            await loadTop();
        } catch (e) {
            toast(`Claim не прошёл: ${e?.shortMessage || e?.message || e}`);
        } finally {
            txBusy = false;
        }
    };

    const withdraw = async () => {
        if (txBusy || !contract) return;
        if (!account || account.toLowerCase() !== owner?.toLowerCase()) {
            alert("Только владелец");
            return;
        }
        try {
            txBusy = true;
            const tx = await contract.withdrawFees(account);
            toast(`Withdraw tx: ${tx.hash}`);
            await tx.wait();
            toast("Комиссия выведена");
            await refresh();
        } catch (e) {
            toast(`Вывод комиссии не прошёл: ${e?.shortMessage || e?.message || e}`);
        } finally {
            txBusy = false;
        }
    };

    const deposit = async () => {
        if (txBusy || !contract) return;
        try {
            txBusy = true;
            const eth = (depAmountEl.value || "0").trim();
            const val = ethers.parseEther(eth || "0");
            if (val <= 0n) throw new Error("Введите сумму > 0");
            const tx = await contract.deposit({ value: val });
            toast(`Депозит tx: ${tx.hash}`);
            await tx.wait();
            toast("Депозит зачислен");
            await refresh();
        } catch (e) {
            toast(`Депозит не прошёл: ${e?.shortMessage || e?.message || e}`);
        } finally {
            txBusy = false;
        }
    };

    const cashout = async (all = false) => {
        if (txBusy || !contract) return;
        try {
            txBusy = true;
            if (all) {
                const tx = await contract.withdrawAll();
                toast(`Вывод всех средств tx: ${tx.hash}`);
                await tx.wait();
            } else {
                const eth = (cashoutAmountEl.value || "0").trim();
                const val = ethers.parseEther(eth || "0");
                if (val <= 0n) throw new Error("Введите сумму > 0");
                const tx = await contract.withdraw(val);
                toast(`Вывод tx: ${tx.hash}`);
                await tx.wait();
            }
            toast("Средства выведены");
            await refresh();
        } catch (e) {
            toast(`Вывод не прошёл: ${e?.shortMessage || e?.message || e}`);
        } finally {
            txBusy = false;
        }
    };

    // ===== winners =====
    const loadTop = async () => {
        if (!contract || !provider) return;
        try {
            const currBlock = await provider.getBlockNumber();
            const from = Math.max(0, currBlock - 5000);
            const betFilter = contract.filters.Bet();
            const claimFilter = contract.filters.Claimed();
            const [bets, claims] = await Promise.all([
                contract.queryFilter(betFilter, from, "latest"),
                contract.queryFilter(claimFilter, from, "latest"),
            ]);
            for (const ev of bets) knownAddrs.add(ev.args.user.toLowerCase());
            for (const ev of claims) knownAddrs.add(ev.args.user.toLowerCase());
        } catch {
            // ignore transient RPC errors
        }

        const rows = [];
        for (const addr of knownAddrs) {
            try {
                const wins = await contract.winsCount(addr);
                rows.push({ addr, wins: Number(wins) });
            } catch {
                // ignore failures per address
            }
        }
        rows.sort((a, b) => b.wins - a.wins);
        const top = rows.slice(0, 10);

        winnersTbody.innerHTML = "";
        for (const row of top) {
            const tr = document.createElement("tr");
            tr.innerHTML = `<td>${mask(row.addr)}</td><td>${row.wins}</td>`;
            winnersTbody.appendChild(tr);
        }
    };

    // ===== events =====
    const subscribe = () => {
        if (!contract) return;
        contract.on("Bet", async () => {
            await refresh();
        });
        contract.on("Locked", async () => {
            await refresh();
        });
        contract.on("Settled", async () => {
            await refresh();
        });
        contract.on("Claimed", async () => {
            await refresh();
            await loadTop();
        });
    };

    // ===== wire UI =====
    connectBtn.onclick = connect;
    betUpBtn.onclick = () => bet(0);
    betDownBtn.onclick = () => bet(1);
    claimBtn.onclick = claim;
    withdrawBtn.onclick = withdraw;
    depBtn.onclick = deposit;
    cashoutBtn.onclick = () => cashout(false);
    stopBtn.onclick = () => cashout(true);
    progressBtn.onclick = async () => {
        if (!contract || txBusy) return;
        try {
            txBusy = true;
            const tx = await contract.progress();
            toast(`progress() tx: ${tx.hash}`);
            await tx.wait();
            await refresh();
        } catch (e) {
            const msg = (e?.reason || e?.shortMessage || e?.message || "").toString();
            if (msg.includes("NO_ACTION")) {
                toast("Рано: условия перехода ещё не наступили");
            } else {
                toast(`progress() не выполнен: ${msg}`);
            }
        } finally {
            txBusy = false;
        }
    };

    setInterval(() => {
        if (contract) refresh();
    }, 1000);
    setInterval(autoProgress, 3000);

    // ===== bootstrap =====
    (async () => {
        await loadConfig();
    })();
})();
