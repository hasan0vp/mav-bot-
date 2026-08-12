// feeCalculator.js
//
// সব profitability / fee গণনার লজিক এই ফাইলে, index.js থেকে আলাদা করে রাখা হয়েছে
// শুধু readability এবং টেস্ট করার সুবিধার জন্য।
//
// এখানে ধরে নেওয়া হয়েছে টার্গেট DEX Uniswap V2-স্টাইল constant-product AMM
// (x * y = k)। অন্য ধরনের DEX (Uniswap V3 concentrated liquidity, Curve
// stableswap ইত্যাদি) হলে getAmountOut() ফাংশনটা আলাদাভাবে লিখতে হবে।

import fetch from "node-fetch";

// ---------------------------------------------------------------------------
// ETH-এর USD দাম আনার জন্য — CoinGecko public API ব্যবহার করা হয়েছে।
// বারবার কল করলে rate-limit খাওয়ার সম্ভাবনা আছে, তাই ৬০ সেকেন্ড ক্যাশ রাখা হলো।
// ইন্টারনেট/API না থাকলে fallback হিসেবে একটা approximate দাম ব্যবহার হবে,
// যাতে টেস্টনেটে অফলাইন-এর কাছাকাছি অবস্থাতেও bot ক্র্যাশ না করে।
// ---------------------------------------------------------------------------
let _cachedEthPrice = null;
let _cachedAt = 0;
const PRICE_CACHE_MS = 60_000;
const FALLBACK_ETH_PRICE_USD = 3000; // শুধু API ফেইল করলে ব্যবহার হবে

export async function getEthPriceUsd() {
  const now = Date.now();
  if (_cachedEthPrice && now - _cachedAt < PRICE_CACHE_MS) {
    return _cachedEthPrice;
  }

  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { timeout: 5000 }
    );
    const data = await res.json();
    const price = data?.ethereum?.usd;
    if (typeof price === "number" && price > 0) {
      _cachedEthPrice = price;
      _cachedAt = now;
      return price;
    }
    throw new Error("অপ্রত্যাশিত API রেসপন্স");
  } catch (err) {
    console.warn(
      `⚠️ ETH দাম আনতে ব্যর্থ (${err.message}), fallback দাম $${FALLBACK_ETH_PRICE_USD} ব্যবহার করা হচ্ছে`
    );
    return FALLBACK_ETH_PRICE_USD;
  }
}

// ---------------------------------------------------------------------------
// একটা tx-এর gas cost বের করা (wei এ), তারপর ETH-এ কনভার্ট
// ---------------------------------------------------------------------------
export function gasCostInEth(gasLimit, gasPriceWei) {
  const costWei = BigInt(gasLimit) * BigInt(gasPriceWei);
  return Number(costWei) / 1e18;
}

// ---------------------------------------------------------------------------
// Uniswap V2 constant-product ফর্মুলা:
//   amountOut = (amountIn * (1 - fee) * reserveOut) / (reserveIn + amountIn * (1 - fee))
// feePercent যেমন 0.3 মানে 0.3%
// reserveIn/reserveOut/amountIn সব BigInt (wei-এর মতো integer unit ধরে নেওয়া)
// ---------------------------------------------------------------------------
export function getAmountOut(amountIn, reserveIn, reserveOut, feePercent) {
  amountIn = BigInt(amountIn);
  reserveIn = BigInt(reserveIn);
  reserveOut = BigInt(reserveOut);

  // fee basis points বের করা, যেমন 0.3% => feeBps = 30 (10000 এর মধ্যে)
  const feeBps = BigInt(Math.round(feePercent * 100)); // 0.3 -> 30
  const BPS_DENOMINATOR = 10000n;

  const amountInWithFee = amountIn * (BPS_DENOMINATOR - feeBps);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * BPS_DENOMINATOR + amountInWithFee;

  if (denominator === 0n) return 0n;
  return numerator / denominator;
}

// ---------------------------------------------------------------------------
// পুরো sandwich simulate করা: front tx -> victim tx -> back tx
// পুল reserves ধারাবাহিকভাবে আপডেট হয় প্রতিটা swap-এর পরে, ঠিক যেমন আসল
// blockchain-এ একই ব্লকে তিনটা tx ক্রমান্বয়ে execute হলে হতো।
//
// ধরে নেওয়া হচ্ছে: pool = tokenA <-> tokenB, victim এবং bot দুজনেই
// tokenA দিয়ে tokenB কেনে (front + victim), পরে bot তার কেনা tokenB
// বিক্রি করে tokenA ফেরত নেয় (back)।
// ---------------------------------------------------------------------------
export function simulateSandwich({
  reserveA,
  reserveB,
  frontAmountInA,
  victimAmountInA,
  feePercent,
}) {
  reserveA = BigInt(reserveA);
  reserveB = BigInt(reserveB);
  frontAmountInA = BigInt(frontAmountInA);
  victimAmountInA = BigInt(victimAmountInA);

  // ধাপ ১: bot-এর front tx — A দিয়ে B কেনে
  const frontAmountOutB = getAmountOut(frontAmountInA, reserveA, reserveB, feePercent);
  let poolA = reserveA + frontAmountInA;
  let poolB = reserveB - frontAmountOutB;

  // ধাপ ২: victim-এর tx — bot-এর front tx-এর কারণে খারাপ rate পাবে
  const victimAmountOutB = getAmountOut(victimAmountInA, poolA, poolB, feePercent);
  poolA = poolA + victimAmountInA;
  poolB = poolB - victimAmountOutB;

  // ধাপ ৩: bot-এর back tx — আগে কেনা সব B বিক্রি করে A ফেরত নেয়
  const backAmountOutA = getAmountOut(frontAmountOutB, poolB, poolA, feePercent);

  return {
    frontAmountOutB, // bot front tx-এ কত tokenB পেলো
    victimAmountOutB, // victim কত tokenB পেলো (sandwich ছাড়া যা পেতো তার চেয়ে কম)
    backAmountOutA, // bot back tx-এ ফেরত কত tokenA পেলো
    grossRevenueA: backAmountOutA - frontAmountInA, // fee-includedgross profit, tokenA এককে
  };
}

// ---------------------------------------------------------------------------
// মূল ফাংশন — index.js এখানেই সব ইনপুট দিয়ে ডাকবে।
//
// ইনপুট (সবগুলো প্রয়োজন):
//   reserveA, reserveB          -> pool-এর বর্তমান reserves (wei ইউনিটে, BigInt)
//   frontAmountInA               -> bot front tx-এ কত tokenA (wei) ঢালবে
//   victimAmountInA              -> victim-এর tx থেকে decode করা amountIn (wei)
//   tokenADecimals                -> tokenA কত decimals (USD কনভার্শনের জন্য)
//   tokenAIsEth                  -> tokenA যদি WETH/ETH হয়, তাহলে সরাসরি ETH price দিয়ে USD বের করা যায়
//   frontGasLimit, backGasLimit  -> দুটো tx-এর gas limit
//   gasPriceWei                  -> current gas price (wei)
//   flashbotsTipGwei             -> block builder-কে extra tip (gwei)
//   dexFeePercent                 -> প্রতি swap-এ DEX fee % (তথ্যের জন্য, ইতিমধ্যে
//                                    getAmountOut()-এর মধ্যে হিসাব হয়ে গেছে)
//   ethPriceUsd                   -> ETH-এর USD দাম (gas/tip কে USD-এ আনতে)
//   tokenAPriceUsd                -> tokenA-এর প্রতি ইউনিট USD দাম (revenue USD-এ আনতে)
//
// রিটার্ন করে একটা breakdown অবজেক্ট, যেখানে netProfitUsd সহ সবকিছুর details থাকে।
// ---------------------------------------------------------------------------
export async function calculateProfitability({
  reserveA,
  reserveB,
  frontAmountInA,
  victimAmountInA,
  tokenADecimals = 18,
  tokenAIsEth = true,
  frontGasLimit,
  backGasLimit,
  gasPriceWei,
  flashbotsTipGwei,
  dexFeePercent,
  tokenAPriceUsd = null, // না দিলে এবং tokenAIsEth=true হলে ETH price ব্যবহার হবে
}) {
  const ethPriceUsd = await getEthPriceUsd();
  const effectiveTokenAPriceUsd = tokenAIsEth ? ethPriceUsd : tokenAPriceUsd;

  if (effectiveTokenAPriceUsd == null) {
    throw new Error(
      "tokenAPriceUsd দেওয়া হয়নি এবং tokenAIsEth=false — USD-এ কনভার্ট করা যাচ্ছে না"
    );
  }

  // ১) sandwich simulate করে gross revenue (tokenA এককে, fee already deducted)
  const sim = simulateSandwich({
    reserveA,
    reserveB,
    frontAmountInA,
    victimAmountInA,
    feePercent: dexFeePercent,
  });

  const tokenAUnit = 10 ** tokenADecimals;
  const grossRevenueTokenA = Number(sim.grossRevenueA) / tokenAUnit;
  const grossRevenueUsd = grossRevenueTokenA * effectiveTokenAPriceUsd;

  // ২) gas costs (front + back tx দুটোই bot-এর নিজের tx)
  const frontGasCostEth = gasCostInEth(frontGasLimit, gasPriceWei);
  const backGasCostEth = gasCostInEth(backGasLimit, gasPriceWei);
  const frontGasCostUsd = frontGasCostEth * ethPriceUsd;
  const backGasCostUsd = backGasCostEth * ethPriceUsd;
  const totalGasCostUsd = frontGasCostUsd + backGasCostUsd;

  // ৩) Flashbots tip — block builder-কে দেওয়া extra priority fee
  //    এটা সাধারণত front + back দুটো tx মিলিয়ে একটা তবে এখানে simplicity-র
  //    জন্য প্রতিটা tx-এর gas limit অনুযায়ী আলাদা tip ধরা হলো
  const tipWeiPerGas = BigInt(Math.round(flashbotsTipGwei * 1e9));
  const totalTipWei =
    (BigInt(frontGasLimit) + BigInt(backGasLimit)) * tipWeiPerGas;
  const tipEth = Number(totalTipWei) / 1e18;
  const tipUsd = tipEth * ethPriceUsd;

  // ৪) DEX fee — শুধু তথ্যের জন্য দেখানো (getAmountOut()-এর ভেতরে ইতিমধ্যে
  //    বিয়োগ হয়ে গেছে, তাই netProfit থেকে আবার বিয়োগ করা হচ্ছে না — শুধু
  //    ইউজারকে breakdown-এ কত fee দেওয়া হয়েছে তা দেখানোর জন্য)
  const dexFeeFrontTokenA =
    (Number(frontAmountInA) / tokenAUnit) * (dexFeePercent / 100);
  const dexFeeBackTokenA =
    (Number(sim.frontAmountOutB) / tokenAUnit) * (dexFeePercent / 100); // approx, tokenB এককে হলেও একই স্কেলে দেখানো হলো
  const dexFeeUsdApprox =
    (dexFeeFrontTokenA + dexFeeBackTokenA) * effectiveTokenAPriceUsd;

  // ৫) Slippage / price-impact loss — victim-এর tx bot-এর front tx-এর কারণে
  //    কম tokenB পেলো, সেই difference-টাই মূলত bot-এর প্রফিটের উৎস।
  //    এখানে আলাদা করে দেখানো হচ্ছে bot নিজে কতটা price impact-এর শিকার হলো
  //    নিজের back tx-এ (victim + bot দুজনের ট্রেডের কারণে pool যতটা সরে গেছে)।
  const noImpactBackAmountOutA = getAmountOut(
    sim.frontAmountOutB,
    BigInt(reserveB),
    BigInt(reserveA),
    dexFeePercent
  );
  const slippageLossTokenA =
    Number(noImpactBackAmountOutA - sim.backAmountOutA) / tokenAUnit;
  const slippageLossUsd = Math.max(0, slippageLossTokenA * effectiveTokenAPriceUsd);

  // ৬) সব মিলিয়ে net profit
  const netProfitUsd =
    grossRevenueUsd - totalGasCostUsd - tipUsd; // slippage ইতিমধ্যে grossRevenue-তে বেক করা আছে (simulateSandwich সিকোয়েন্সিয়াল), dexFee-ও তাই — শুধু breakdown-এ আলাদা দেখানো হচ্ছে

  return {
    netProfitUsd,
    grossRevenueUsd,
    frontGasCostUsd,
    backGasCostUsd,
    totalGasCostUsd,
    tipUsd,
    dexFeeUsdApprox,
    slippageLossUsd,
    ethPriceUsd,
    sim, // raw simulation ডেটা, ডিবাগিং-এর জন্য
  };
}
