// index.js
//
// শিক্ষামূলক Ethereum Sandwich / Backrun MEV Bot
// =================================================
// এই bot mempool-এ pending transaction দেখে, একটা নির্দিষ্ট DEX router-কে
// টার্গেট করা swap পেলে সেটার profitability হিসাব করে, এবং তারপর নির্ভর করে
// TRADING_MODE-এর ওপর — হয় শুধু লগ করে (watch), নয়তো আসলে bundle বানিয়ে
// পাঠায় (live)।
//
// !!! গুরুত্বপূর্ণ সেফটি সিদ্ধান্ত !!!
// আসল bundle sign+submit করার ক্ষমতা (live mode execution) শুধুমাত্র Sepolia
// টেস্টনেটে কাজ করে। mainnet-এ TRADING_MODE=live সেট করলেও bot জোর করে
// watch mode-এ থেকে যাবে। কারণটা README.md-এ বিস্তারিত লেখা আছে — সংক্ষেপে:
// mainnet-এ sandwich attack real, non-consenting মানুষের ওপর real আর্থিক
// ক্ষতি করে, তাই এই কোডটা সেই ঝুঁকি structurally বন্ধ রাখে।
//
// bundle order সবসময় ফিক্সড: [frontTx, targetTx, backTx]

import "dotenv/config";
import { ethers } from "ethers";
import { calculateProfitability, getEthPriceUsd } from "./feeCalculator.js";

// ============================================================================
// ১) ENV VARIABLES লোড এবং ভ্যালিডেশন
// ============================================================================

const env = process.env;

const CONFIG = {
  // --- নেটওয়ার্ক ও সংযোগ ---
  NETWORK: (env.NETWORK || "sepolia").toLowerCase(), // "sepolia" | "mainnet"
  RPC_WSS_URL: env.RPC_WSS_URL, // Alchemy/Infura WebSocket URL
  PRIVATE_KEY: env.PRIVATE_KEY || null, // শুধু live mode-এ লাগবে

  // --- টার্গেট ---
  TARGET_CONTRACT: env.TARGET_CONTRACT
    ? env.TARGET_CONTRACT.toLowerCase()
    : null, // যে DEX router মনিটর করা হবে

  // --- ট্রেডিং মোড ও সেফটি ---
  TRADING_MODE: (env.TRADING_MODE || "watch").toLowerCase(), // "watch" | "live"
  CONFIRM_LIVE_TRADING: env.CONFIRM_LIVE_TRADING || "",
  MAX_TRADE_AMOUNT_USD: parseFloat(env.MAX_TRADE_AMOUNT_USD || "10"),

  // --- Profitability ---
  MIN_PROFIT_USD: parseFloat(env.MIN_PROFIT_USD || "5"),
  DEX_FEE_PERCENT: parseFloat(env.DEX_FEE_PERCENT || "0.3"),
  FLASHBOTS_TIP_GWEI: parseFloat(env.FLASHBOTS_TIP_GWEI || "2"),
  FRONT_RUN_SIZE_RATIO: parseFloat(env.FRONT_RUN_SIZE_RATIO || "1.0"), // victim-এর কত % সমান front tx

  // --- Gas ---
  FRONT_TX_GAS_LIMIT: BigInt(env.FRONT_TX_GAS_LIMIT || "250000"),
  BACK_TX_GAS_LIMIT: BigInt(env.BACK_TX_GAS_LIMIT || "250000"),
  SANDWICH_SLIPPAGE_TOLERANCE_PERCENT: parseFloat(
    env.SANDWICH_SLIPPAGE_TOLERANCE_PERCENT || "1.0"
  ),

  // --- Flashbots ---
  FLASHBOTS_RPC_URL: env.FLASHBOTS_RPC_URL,
};

function fatal(msg) {
  console.error(`❌ CONFIG ERROR: ${msg}`);
  process.exit(1);
}

if (!CONFIG.RPC_WSS_URL) fatal("RPC_WSS_URL সেট করা হয়নি (.env দেখুন)");
if (!CONFIG.TARGET_CONTRACT) fatal("TARGET_CONTRACT সেট করা হয়নি (.env দেখুন)");
if (!["sepolia", "mainnet"].includes(CONFIG.NETWORK)) {
  fatal('NETWORK শুধু "sepolia" অথবা "mainnet" হতে পারে');
}

// প্রতিটা নেটওয়ার্কের প্রত্যাশিত chain id, সংযোগের পর সত্যতা যাচাই করার জন্য
const EXPECTED_CHAIN_ID = { sepolia: 11155111n, mainnet: 1n };

// ============================================================================
// ২) সেফটি গেট — watch vs live মোড সিদ্ধান্ত
//
// এখানে দুই স্তরের সেফটি চেক আছে:
//   ক) ইউজারের নিজের চাওয়া গেট (TRADING_MODE + CONFIRM_LIVE_TRADING স্ট্রিং)
//   খ) এই কোডে হার্ড-কোডেড গেট: mainnet-এ live execution কখনোই না
// দুটোর যেকোনো একটা ফেল করলেই bot watch mode-এ fallback করবে।
// ============================================================================

let effectiveMode = "watch";
let modeReasonLog = "";

const wantsLive = CONFIG.TRADING_MODE === "live";
const confirmedCorrectly =
  CONFIG.CONFIRM_LIVE_TRADING === "YES_I_UNDERSTAND_THE_RISK";

if (!wantsLive) {
  effectiveMode = "watch";
  modeReasonLog = "TRADING_MODE=watch (ডিফল্ট) — কোনো bundle সত্যিকারে পাঠানো হবে না";
} else if (!confirmedCorrectly) {
  effectiveMode = "watch";
  modeReasonLog =
    "TRADING_MODE=live দেওয়া হয়েছে কিন্তু CONFIRM_LIVE_TRADING সঠিক স্ট্রিং না (দরকার: YES_I_UNDERSTAND_THE_RISK) — নিরাপত্তার জন্য watch mode-এ fallback";
} else if (CONFIG.NETWORK === "mainnet") {
  effectiveMode = "watch";
  modeReasonLog =
    "mainnet-এ live sandwich execution এই কোডে ইচ্ছাকৃতভাবে বন্ধ রাখা হয়েছে (README.md-এ কারণ দেখুন) — mainnet সবসময় WATCH MODE-এ চলবে, সত্যিকারের bundle submit হবে না। শুধুমাত্র Sepolia টেস্টনেটে live mode চালু করা যাবে।";
} else if (!CONFIG.PRIVATE_KEY) {
  effectiveMode = "watch";
  modeReasonLog = "live mode-এর জন্য PRIVATE_KEY দরকার কিন্তু .env-এ সেট করা নেই";
} else {
  effectiveMode = "live";
  modeReasonLog = "সব সেফটি চেক পাস — LIVE MODE (Sepolia) সক্রিয় হচ্ছে";
}

const LOG_PREFIX = effectiveMode === "live" ? "[LIVE]" : "[WATCH]";

// ============================================================================
// ৩) ABI ডেফিনিশন — Uniswap V2-স্টাইল router/factory/pair/ERC20 (মিনিমাল)
// ============================================================================

const ROUTER_ABI = [
  "function factory() view returns (address)",
  "function WETH() view returns (address)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)",
  "function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable returns (uint[] amounts)",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)",
];

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address pair)",
];

const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const routerInterface = new ethers.Interface(ROUTER_ABI);

// ============================================================================
// ৪) PROVIDER / WALLET সেটআপ
// ============================================================================

const provider = new ethers.WebSocketProvider(CONFIG.RPC_WSS_URL);

let wallet = null;
if (CONFIG.PRIVATE_KEY) {
  wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);
}

const router = new ethers.Contract(CONFIG.TARGET_CONTRACT, ROUTER_ABI, provider);

// টোকেন approval যেগুলো ইতিমধ্যে দেওয়া হয়েছে, বারবার চেক এড়াতে ক্যাশ
const approvalCache = new Set();

// ============================================================================
// ৫) STATS — hourly summary-র জন্য
// ============================================================================

const stats = {
  detected: 0,
  profitableSimulated: 0,
  liveSubmitted: 0,
  liveIncluded: 0,
  liveTotalProfitUsd: 0,
  liveTotalLossUsd: 0, // gas খরচ হয়ে গেছে কিন্তু bundle include হয়নি এমন ক্ষতি
};

// ============================================================================
// ৬) HELPER: pending tx থেকে swap decode করা
//
// শুধু "exact input" swap ভ্যারিয়েন্ট হ্যান্ডল করা হচ্ছে (এগুলোই সহজে
// sandwich করা যায়, কারণ amountIn ফিক্সড থাকে)। এবং শুধু সেইসব swap যেখানে
// input token WETH/ETH — কারণ তাহলে ETH-এর দাম দিয়ে সরাসরি USD হিসাব করা যায়,
// আলাদা price-oracle লাগবে না।
// ============================================================================

async function decodeSwapTx(tx) {
  if (!tx.data || tx.data === "0x") return null;

  let parsed;
  try {
    parsed = routerInterface.parseTransaction({ data: tx.data, value: tx.value });
  } catch {
    return null; // এই router-এর পরিচিত method না, স্কিপ
  }

  const weth = await router.WETH();

  if (parsed.name === "swapExactETHForTokens") {
    const path = parsed.args.path;
    return {
      method: parsed.name,
      tokenIn: weth,
      tokenOut: path[path.length - 1],
      amountIn: tx.value, // ETH ভ্যালু সরাসরি tx.value থেকে
      path,
    };
  }

  if (parsed.name === "swapExactTokensForTokens") {
    const path = parsed.args.path;
    if (path[0].toLowerCase() !== weth.toLowerCase()) {
      return null; // input token WETH না, স্কিপ (স্কোপ সীমিত রাখা হয়েছে)
    }
    return {
      method: parsed.name,
      tokenIn: path[0],
      tokenOut: path[path.length - 1],
      amountIn: parsed.args.amountIn,
      path,
    };
  }

  // swapExactTokensForETH, swapTokensForExactTokens ইত্যাদি এই শিক্ষামূলক
  // সংস্করণে হ্যান্ডল করা হচ্ছে না
  return null;
}

// ============================================================================
// ৭) HELPER: pool reserves বের করা
// ============================================================================

async function getPoolReserves(tokenIn, tokenOut) {
  const factoryAddr = await router.factory();
  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
  const pairAddr = await factory.getPair(tokenIn, tokenOut);

  if (pairAddr === ethers.ZeroAddress) return null; // pool নেই

  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const [reserve0, reserve1] = await pair.getReserves();
  const token0 = await pair.token0();

  // reserveA কে সবসময় tokenIn-এর reserve, reserveB কে tokenOut-এর reserve হিসেবে সাজানো
  if (token0.toLowerCase() === tokenIn.toLowerCase()) {
    return { reserveA: reserve0, reserveB: reserve1, pairAddress: pairAddr };
  } else {
    return { reserveA: reserve1, reserveB: reserve0, pairAddress: pairAddr };
  }
}

// ============================================================================
// ৮) HELPER: live mode-এ ERC20 approval নিশ্চিত করা
//
// bundle-এর ফিক্সড অর্ডার [front, target, back] ভাঙা যাবে না, তাই approve tx
// bundle-এর ভেতরে ঢোকানো যায় না। তাই approval আগে থেকেই, একটা সাধারণ (bundle
// বহির্ভূত) tx হিসেবে পাঠিয়ে রাখা হয় — প্রথমবার একটা নতুন টোকেন দেখলে সেই
// সুযোগটা miss হবে, কিন্তু পরের বার থেকে কাজ করবে।
// ============================================================================

async function ensureApproval(tokenAddress) {
  const key = tokenAddress.toLowerCase();
  if (approvalCache.has(key)) return true;

  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const allowance = await token.allowance(wallet.address, CONFIG.TARGET_CONTRACT);

  if (allowance > 0n) {
    approvalCache.add(key);
    return true;
  }

  console.log(
    `${LOG_PREFIX} 🔑 টোকেন ${tokenAddress}-এর জন্য router allowance নেই, approve tx পাঠানো হচ্ছে (এই সুযোগটা miss হবে, future opportunities কাজ করবে)...`
  );
  try {
    const tx = await token.approve(CONFIG.TARGET_CONTRACT, ethers.MaxUint256);
    await tx.wait();
    approvalCache.add(key);
  } catch (err) {
    console.error(`${LOG_PREFIX} approve tx ব্যর্থ: ${err.message}`);
  }
  return false; // এই মুহূর্তের সুযোগ মিস, cache-এ যোগ হয়ে গেছে পরের বারের জন্য
}

// ============================================================================
// ৯) HELPER: front/back tx object বানানো (unsigned populated tx)
// ============================================================================

async function buildSandwichTxs({ swap, frontAmountInA, sim, feeData }) {
  const deadline = Math.floor(Date.now() / 1000) + 120; // ২ মিনিট
  const slip = CONFIG.SANDWICH_SLIPPAGE_TOLERANCE_PERCENT / 100;

  const frontAmountOutMin =
    (sim.frontAmountOutB * BigInt(Math.round((1 - slip) * 1000))) / 1000n;
  const backAmountOutMin =
    (sim.backAmountOutA * BigInt(Math.round((1 - slip) * 1000))) / 1000n;

  // --- FRONT TX: ETH/WETH দিয়ে tokenOut কেনা ---
  const frontTx = await router.swapExactETHForTokens.populateTransaction(
    frontAmountOutMin,
    [swap.tokenIn, swap.tokenOut],
    wallet.address,
    deadline,
    { value: frontAmountInA }
  );
  frontTx.gasLimit = CONFIG.FRONT_TX_GAS_LIMIT;
  frontTx.maxFeePerGas = feeData.maxFeePerGas;
  frontTx.maxPriorityFeePerGas = feeData.priorityFeeWithTip;

  // --- BACK TX: কেনা tokenOut আবার ETH-এ বিক্রি ---
  const backTx = await router.swapExactTokensForETH.populateTransaction(
    sim.frontAmountOutB,
    backAmountOutMin,
    [swap.tokenOut, swap.tokenIn],
    wallet.address,
    deadline
  );
  backTx.gasLimit = CONFIG.BACK_TX_GAS_LIMIT;
  backTx.maxFeePerGas = feeData.maxFeePerGas;
  backTx.maxPriorityFeePerGas = feeData.priorityFeeWithTip;

  return { frontTx, backTx };
}

// ============================================================================
// ১০) মূল হ্যান্ডলার — প্রতিটা pending tx-এর জন্য চলবে
// ============================================================================

const seenHashes = new Set(); // ডুপ্লিকেট প্রসেসিং এড়াতে

async function handlePendingTx(txHash) {
  if (seenHashes.has(txHash)) return;
  seenHashes.add(txHash);
  if (seenHashes.size > 5000) seenHashes.clear(); // মেমরি লিক এড়ানো

  let tx;
  try {
    tx = await provider.getTransaction(txHash);
  } catch {
    return;
  }
  if (!tx || !tx.to) return;
  if (tx.to.toLowerCase() !== CONFIG.TARGET_CONTRACT) return; // টার্গেট কনট্র্যাক্ট না

  const swap = await decodeSwapTx(tx);
  if (!swap) return; // decode করা যায়নি বা সাপোর্টেড না

  stats.detected++;

  const poolInfo = await getPoolReserves(swap.tokenIn, swap.tokenOut);
  if (!poolInfo) {
    console.log(`${LOG_PREFIX} pool খুঁজে পাওয়া যায়নি (${swap.tokenIn} <-> ${swap.tokenOut}), স্কিপ`);
    return;
  }
  if (poolInfo.reserveA === 0n || poolInfo.reserveB === 0n) return; // খালি pool

  // front tx-এর সাইজ ঠিক করা: victim-এর amountIn-এর একটা অনুপাত
  const frontAmountInA =
    (swap.amountIn * BigInt(Math.round(CONFIG.FRONT_RUN_SIZE_RATIO * 1000))) /
    1000n;
  if (frontAmountInA === 0n) return;

  const feeDataRaw = await provider.getFeeData();
  const gasPriceWei = feeDataRaw.maxFeePerGas ?? feeDataRaw.gasPrice ?? 0n;
  const tipWei = BigInt(Math.round(CONFIG.FLASHBOTS_TIP_GWEI * 1e9));
  const feeData = {
    maxFeePerGas: gasPriceWei,
    priorityFeeWithTip: tipWei,
  };

  let profitability;
  try {
    profitability = await calculateProfitability({
      reserveA: poolInfo.reserveA,
      reserveB: poolInfo.reserveB,
      frontAmountInA,
      victimAmountInA: swap.amountIn,
      tokenADecimals: 18, // WETH/ETH সবসময় ১৮ decimals
      tokenAIsEth: true,
      frontGasLimit: CONFIG.FRONT_TX_GAS_LIMIT,
      backGasLimit: CONFIG.BACK_TX_GAS_LIMIT,
      gasPriceWei,
      flashbotsTipGwei: CONFIG.FLASHBOTS_TIP_GWEI,
      dexFeePercent: CONFIG.DEX_FEE_PERCENT,
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} profitability হিসাবে ভুল: ${err.message}`);
    return;
  }

  const p = profitability;
  const breakdownStr =
    `gas: $${p.totalGasCostUsd.toFixed(2)}, tip: $${p.tipUsd.toFixed(2)}, ` +
    `DEX fee: $${p.dexFeeUsdApprox.toFixed(2)}, slippage: $${p.slippageLossUsd.toFixed(2)}`;

  if (p.netProfitUsd < CONFIG.MIN_PROFIT_USD) {
    console.log(
      `${LOG_PREFIX} tx ${txHash.slice(0, 10)}... লাভজনক না (net: $${p.netProfitUsd.toFixed(
        2
      )} < min $${CONFIG.MIN_PROFIT_USD}), ${breakdownStr} — স্কিপ`
    );
    return;
  }

  stats.profitableSimulated++;

  const frontAmountUsd = (Number(frontAmountInA) / 1e18) * p.ethPriceUsd;

  // ---- WATCH MODE: শুধু লগ করো, কিছু পাঠানো হবে না ----
  if (effectiveMode !== "live") {
    console.log(
      `🔍 [WATCH] এই bundle পাঠানো হতো, calculated net profit: $${p.netProfitUsd.toFixed(
        2
      )} (${breakdownStr}) — কিন্তু submit করা হচ্ছে না কারণ WATCH MODE`
    );
    return;
  }

  // ---- LIVE MODE: MAX_TRADE_AMOUNT_USD চেক ----
  if (frontAmountUsd > CONFIG.MAX_TRADE_AMOUNT_USD) {
    console.log(
      `[LIVE] tx ${txHash.slice(0, 10)}... net profit $${p.netProfitUsd.toFixed(
        2
      )} ভালো, কিন্তু front trade size $${frontAmountUsd.toFixed(
        2
      )} > MAX_TRADE_AMOUNT_USD ($${CONFIG.MAX_TRADE_AMOUNT_USD}) — স্কিপ`
    );
    return;
  }

  // ---- LIVE MODE: approval নিশ্চিত করা ----
  const approved = await ensureApproval(swap.tokenOut);
  if (!approved) return; // এই সুযোগ miss, পরের বার কাজ করবে

  // ---- LIVE MODE: bundle বানানো, sign করা, Flashbots-এ পাঠানো ----
  try {
    await submitLiveBundle({ tx, swap, frontAmountInA, sim: p.sim, feeData, netProfitUsd: p.netProfitUsd });
  } catch (err) {
    console.error(`[LIVE] bundle submit-এ ভুল: ${err.message}`);
  }
}

// ============================================================================
// ১১) LIVE MODE: Flashbots bundle submission
//
// dynamic import ব্যবহার করা হচ্ছে যাতে watch-mode-only ইউজারদের এই প্যাকেজ
// ইনস্টল না থাকলেও bot ক্র্যাশ না করে।
// ============================================================================

let flashbotsProviderPromise = null;

async function getFlashbotsProvider() {
  if (!flashbotsProviderPromise) {
    flashbotsProviderPromise = (async () => {
      const { FlashbotsBundleProvider } = await import(
        "@flashbots/ethers-provider-bundle"
      );
      // authSigner = bundle-এর reputation সাইন করার জন্য আলাদা key, সরলতার
      // জন্য এখানে ট্রেডিং wallet-ই ব্যবহার করা হচ্ছে
      return FlashbotsBundleProvider.create(
        provider,
        wallet,
        CONFIG.FLASHBOTS_RPC_URL
      );
    })();
  }
  return flashbotsProviderPromise;
}

async function submitLiveBundle({ tx, swap, frontAmountInA, sim, feeData, netProfitUsd }) {
  const { frontTx, backTx } = await buildSandwichTxs({
    swap,
    frontAmountInA,
    sim,
    feeData,
  });

  const flashbots = await getFlashbotsProvider();
  const currentBlock = await provider.getBlockNumber();
  const targetBlock = currentBlock + 1;

  // ফিক্সড bundle order: [front, target(victim-এর নিজের raw tx), back]
  const bundleTxs = [
    { signer: wallet, transaction: frontTx },
    { signedTransaction: tx.raw ?? tx.serialized ?? null, hash: tx.hash }, // victim tx (already signed, re-broadcast হয়)
    { signer: wallet, transaction: backTx },
  ];

  console.log(
    `[LIVE] ⚡ bundle পাঠানো হচ্ছে block #${targetBlock}-এর জন্য, expected net profit: $${netProfitUsd.toFixed(
      2
    )}`
  );

  stats.liveSubmitted++;

  const signedBundle = await flashbots.signBundle(bundleTxs);
  const simResult = await flashbots.simulate(signedBundle, targetBlock);

  if ("error" in simResult) {
    console.error(`[LIVE] ❌ bundle simulation ব্যর্থ: ${simResult.error.message}`);
    stats.liveTotalLossUsd += netProfitUsd > 0 ? 0 : 0; // simulate-এ real gas খরচ হয়নি
    return;
  }

  const submission = await flashbots.sendRawBundle(signedBundle, targetBlock);
  const resolution = await submission.wait();

  if (resolution === 0 /* FlashbotsBundleResolution.BundleIncluded */) {
    console.log(`[LIVE] ✅ bundle block #${targetBlock}-এ include হয়েছে! Expected profit: $${netProfitUsd.toFixed(2)}`);
    stats.liveIncluded++;
    stats.liveTotalProfitUsd += netProfitUsd;
  } else {
    console.log(`[LIVE] ⚠️ bundle include হয়নি (resolution=${resolution}) — কোনো on-chain খরচ হয়নি, শুধু সুযোগ miss`);
  }
}

// ============================================================================
// ১২) HOURLY SUMMARY
// ============================================================================

function logHourlySummary() {
  console.log("=".repeat(60));
  console.log(`${LOG_PREFIX} 📊 HOURLY SUMMARY`);
  console.log(`   মোট opportunity detect হয়েছে: ${stats.detected}`);
  console.log(`   profitable simulate হয়েছে (watch/live উভয়ই): ${stats.profitableSimulated}`);
  console.log(`   live mode-এ bundle submit হয়েছে: ${stats.liveSubmitted}`);
  console.log(`   live mode-এ bundle include হয়েছে: ${stats.liveIncluded}`);
  console.log(`   live mode-এ মোট actual profit: $${stats.liveTotalProfitUsd.toFixed(2)}`);
  console.log("=".repeat(60));
}

// ============================================================================
// ১৩) LIVE MODE COUNTDOWN — startup-এ একটা শেষ সতর্কতা
// ============================================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function liveCountdown() {
  console.log("⚠️⚠️⚠️ LIVE MODE — REAL FUND ব্যবহার হবে — থামাতে Ctrl+C চাপুন");
  for (let i = 5; i >= 1; i--) {
    console.log(`শুরু হচ্ছে ${i}...`);
    await sleep(1000);
  }
}

// ============================================================================
// ১৪) MAIN — bootstrap
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("🤖 শিক্ষামূলক Sandwich/Backrun MEV Bot");
  console.log(`   নেটওয়ার্ক: ${CONFIG.NETWORK}`);
  console.log(`   টার্গেট কনট্র্যাক্ট: ${CONFIG.TARGET_CONTRACT}`);
  console.log(`   মোড: ${effectiveMode.toUpperCase()} — ${modeReasonLog}`);
  console.log("=".repeat(60));

  const network = await provider.getNetwork();
  const expected = EXPECTED_CHAIN_ID[CONFIG.NETWORK];
  if (network.chainId !== expected) {
    fatal(
      `RPC_WSS_URL-এর chain id (${network.chainId}) NETWORK=${CONFIG.NETWORK}-এর প্রত্যাশিত chain id (${expected})-এর সাথে মেলে না`
    );
  }

  if (effectiveMode === "live") {
    await liveCountdown();
  }

  const ethPrice = await getEthPriceUsd();
  console.log(`💲 বর্তমান ETH দাম: $${ethPrice.toFixed(2)}`);
  console.log(`${LOG_PREFIX} mempool মনিটরিং শুরু হচ্ছে...`);

  provider.on("pending", (txHash) => {
    handlePendingTx(txHash).catch((err) => {
      console.error(`${LOG_PREFIX} handlePendingTx-এ ভুল: ${err.message}`);
    });
  });

  provider.websocket?.on?.("error", (err) => {
    console.error(`${LOG_PREFIX} WebSocket ভুল: ${err.message}`);
  });

  setInterval(logHourlySummary, 60 * 60 * 1000);
}

main().catch((err) => {
  console.error(`❌ ফ্যাটাল ভুল: ${err.message}`);
  process.exit(1);
});
