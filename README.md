# শিক্ষামূলক Sandwich/Backrun MEV Bot (Ethereum + ethers.js v6)

এই প্রজেক্টটা তৈরি হয়েছে MEV (Maximal Extractable Value) এবং সাধারণত
"sandwich attack" নামে পরিচিত জিনিসটা কীভাবে কাজ করে তা **শেখার জন্য**।
এটা কোনো production-ready trading টুল না।

## ⚠️ সবচেয়ে জরুরি অংশ — আগে এটা পড়ুন

- এই কোড **শিক্ষামূলক**। বাস্তব mainnet-এ চালালে real fund হারানোর ঝুঁকি
  আছে — gas খরচ হয়ে যেতে পারে, bundle include নাও হতে পারে, বা calculation
  ভুল হলে লোকসান হতে পারে।
- **Sandwich attack অনেক DEX-এর Terms of Service ভায়োলেট করে।** কিছু
  DEX/frontend/aggregator স্পষ্টভাবে এই ধরনের আচরণ নিষিদ্ধ করে এবং wallet/IP
  ব্লক করতে পারে।
- **আধুনিক DEX-এ anti-MEV protection থাকে** (যেমন: private mempool/RPC
  ব্যবহার, batch auction, MEV-Blocker, CoW Swap-এর মতো design, slippage
  protection ইত্যাদি) — এসবের কারণে এই bot বাস্তবে **কার্যকর নাও হতে পারে**,
  বিশেষ করে বড় DEX-গুলোতে।
- এই কোডে ইচ্ছাকৃতভাবে একটা হার্ড রেস্ট্রিকশন আছে: **mainnet-এ আসল bundle
  sign+submit করা যায় না**, শুধু detect/simulate/log করা যায়। কারণ নিচে
  "কেন এত সতর্কতা" সেকশনে বিস্তারিত লেখা আছে।
- **MAX_TRADE_AMOUNT_USD ছোট রেখে শুরু করুন** (default $10) — এটা একটা
  hard cap যা লোকসানের সর্বোচ্চ সীমা বেঁধে দেয়, কিন্তু সম্পূর্ণ ঝুঁকি দূর করে না।

এটা ব্যবহার করলে সম্পূর্ণ দায়ভার আপনার নিজের।

---

## ১. ইনস্টল করা

```bash
cd mev-sandwich-bot-educational
npm install
cp .env.example .env
```

তারপর `.env` ফাইল খুলে নিজের ভ্যালু দিন (RPC URL, target router address ইত্যাদি)।

> `@flashbots/ethers-provider-bundle` প্যাকেজটা ethers v5-এর জন্য মূলত বানানো
> হয়েছিল। ethers v6-এর সাথে কাজ করার জন্য npm-এ বর্তমানে যে সংস্করণ/fork
> maintained আছে সেটা ব্যবহার করুন — `npm install` করার আগে
> `npm view @flashbots/ethers-provider-bundle versions` দিয়ে চেক করে নিন,
> কারণ এই ইকোসিস্টেম দ্রুত বদলায়।

## ২. Sepolia টেস্টনেটে টেস্ট করা (recommended শুরু বিন্দু)

1. একটা Alchemy বা Infura অ্যাকাউন্ট বানান, Sepolia-এর জন্য একটা WebSocket
   endpoint নিন (`wss://eth-sepolia.g.alchemy.com/v2/...`)। `.env`-এ
   `RPC_WSS_URL` আর `NETWORK=sepolia` সেট করুন।
2. Sepolia faucet থেকে কিছু টেস্ট ETH নিন (উদাহরণ: Alchemy Sepolia Faucet,
   Google Cloud Web3 Faucet)।
3. একটা Uniswap V2-স্টাইল router Sepolia-তে খুঁজে বের করুন অথবা নিজে deploy
   করুন, `TARGET_CONTRACT`-এ দিন।
4. `TRADING_MODE=watch` (ডিফল্ট) রেখে চালান:
   ```bash
   npm start
   ```
   bot mempool দেখবে, profitability হিসাব করবে, কিন্তু কিছু পাঠাবে না —
   শুধু `[WATCH]` prefix দিয়ে লগ করবে।
5. যখন watch mode-এর log দেখে বুঝবেন logic ঠিকমতো কাজ করছে, তখনই live
   mode-এ যাওয়ার কথা ভাবুন (নিচের সেকশন দেখুন)। নিজে Sepolia-তে একটা টেস্ট
   swap tx পাঠিয়ে দেখতে পারেন bot সেটা ধরছে কিনা।

## ৩. Watch Mode থেকে Live Mode-এ যাওয়া

Live mode-এ যেতে **দুটো শর্ত** পূরণ করতে হবে:

```env
TRADING_MODE=live
CONFIRM_LIVE_TRADING=YES_I_UNDERSTAND_THE_RISK
```

দুটোর একটাও missing বা ভুল হলে bot নিজে থেকে watch mode-এ fallback করবে এবং
কেন করলো তা লগে লিখবে। এছাড়াও:

- **`NETWORK=mainnet` হলে live mode কখনোই চালু হবে না** — কোডে এটা হার্ড-লক
  করা আছে (`index.js`-এর "সেফটি গেট" সেকশন দেখুন)। শুধু Sepolia-তে live mode
  কাজ করে।
- Live mode চালু হলে স্টার্টআপে ৫ সেকেন্ডের countdown দেখাবে — এই সময়ের
  মধ্যে Ctrl+C চেপে থামানো যায়।
- Live mode-এ `MAX_TRADE_AMOUNT_USD`-এর বেশি সাইজের কোনো bundle থাকলে সেটা
  net profit যতই ভালো হোক, স্কিপ হয়ে যাবে।

### কেন এত সতর্কতা?

Sandwich bot সাধারণ watch-only research টুলের চেয়ে আলাদা, কারণ এটার আসল
কাজই হলো mempool-এ থাকা **অন্য মানুষের** pending transaction-কে টার্গেট করে
তাদের চেয়ে ভালো rate পাওয়া, যার ফলে সেই মানুষ খারাপ rate পান (slippage)।
mainnet-এ এটা:

- real মানুষের real টাকার ওপর প্রভাব ফেলে, যারা কখনো এতে সম্মতি দেননি,
- অনেক প্রোটোকলের ToS ভঙ্গ করতে পারে,
- এবং নিজের জন্যও ঝুঁকিপূর্ণ (gas খরচ হয়ে bundle include না হওয়া, ভুল
  calculation-এ লোকসান)।

তাই এই রিপোজিটরিতে mainnet-এর জন্য শুধু **observe/simulate/log** রাখা
হয়েছে — এটা দিয়ে আপনি পুরোপুরি বুঝতে পারবেন বাস্তব mainnet mempool-এ কী
ধরনের সুযোগ থাকতো এবং কত profit হতো, বাস্তবে কারো ক্ষতি না করেই। আসল
sign+submit শুধু Sepolia-তে, নিজের টেস্ট fund দিয়ে, নিজের টেস্ট tx-এর
ওপর — যা সম্পূর্ণ নিরাপদ শেখার পরিবেশ।

## ৪. Fee/Profitability Calculation কীভাবে কাজ করে

সব লজিক `feeCalculator.js`-এ। সহজ ভাষায়:

1. **Pool simulation**: bot Uniswap V2-এর constant-product ফর্মুলা
   (`x * y = k`) ব্যবহার করে তিনটা ধাপ ক্রমান্বয়ে simulate করে —
   front tx → victim tx → back tx — এবং প্রতিটার পরে pool reserve কীভাবে
   বদলায় তা হিসাব করে। এখান থেকেই বোঝা যায় bot-এর back tx-এ কত টাকা ফেরত
   আসবে (gross revenue)।
2. **Gas cost**: front + back — দুটো tx-এরই `gasLimit × gasPrice` হিসাব
   করে ETH-এ, তারপর USD-এ কনভার্ট।
3. **Flashbots tip**: `FLASHBOTS_TIP_GWEI` অনুযায়ী block builder-কে দেওয়া
   extra fee, এটাও gas limit অনুযায়ী হিসাব হয়ে USD-এ কনভার্ট হয়।
4. **DEX fee**: প্রতিটা swap-এ `DEX_FEE_PERCENT` (ডিফল্ট 0.3%) কেটে রাখা
   হয় — এটা আসলে ধাপ ১-এর simulation-এর ভেতরেই বেক করা আছে (Uniswap
   ফর্মুলাতেই fee ধরা থাকে), কিন্তু breakdown-এ আলাদা করে দেখানো হয় যাতে
   বোঝা যায় কত টাকা fee হিসেবে গেছে।
5. **Slippage/price impact**: bot নিজের front tx আর victim-এর tx দুটোই
   pool-এর price নড়িয়ে দেয়, ফলে bot-এর back tx তুলনামূলক খারাপ rate পায় —
   এটাও breakdown-এ আলাদা লাইনে দেখানো হয়।
6. **Net Profit**:
   ```
   Net Profit = Gross Revenue (simulation থেকে) − Gas cost (front+back) − Flashbots tip
   ```
   (DEX fee ও slippage ইতিমধ্যে gross revenue-র হিসাবের মধ্যে ধরা আছে, তাই
   আলাদা করে আবার বিয়োগ করা হয় না — breakdown-এ শুধু transparency-র জন্য
   আলাদা দেখানো হয়।)
7. `Net Profit < MIN_PROFIT_USD` হলে বান্ডেল স্কিপ হয়ে যায়।

## ৫. Log Prefix

প্রতিটা লাইনে `[WATCH]` বা `[LIVE]` prefix থাকবে যাতে সবসময় স্পষ্ট বোঝা যায়
bot কোন মোডে চলছে। প্রতি ঘন্টায় একটা summary log আসবে — কতগুলো opportunity
detect হলো, কতগুলো profitable simulate হলো, live mode-এ কতগুলো submit ও
include হলো এবং তাদের প্রকৃত ফলাফল।

## ৬. ফাইল স্ট্রাকচার

| ফাইল | কাজ |
|---|---|
| `index.js` | মূল লজিক — mempool monitor, decode, sandwich build, watch/live সেফটি গেট |
| `feeCalculator.js` | profitability/fee গণনার সব লজিক (আলাদা module, readability-র জন্য) |
| `.env.example` | সব প্রয়োজনীয় env variable-এর উদাহরণ ও ব্যাখ্যা |
| `package.json` | dependencies |

## ৭. সীমাবদ্ধতা (স্কোপ ইচ্ছাকৃতভাবে সীমিত রাখা হয়েছে)

- শুধু Uniswap V2-স্টাইল constant-product router সাপোর্ট করে (V3, Curve,
  Balancer ইত্যাদি না)।
- শুধু ETH/WETH-কে input token হিসেবে ব্যবহার করা swap ধরা হয় (যেমন
  `swapExactETHForTokens`, বা `swapExactTokensForTokens` যেখানে path[0] =
  WETH), কারণ তাহলে সরাসরি ETH-এর দাম দিয়ে USD হিসাব করা যায়, আলাদা
  price-oracle লাগে না।
- `swapTokensForExactTokens`/`swapETHForExactTokens`-এর মতো "exact output"
  swap হ্যান্ডল করা হয় না।
- Sepolia mainnet-এর মতো liquid না, তাই বাস্তব সুযোগ কম পাবেন — এটা মূলত
  mechanism শেখার জন্য।

## ৮. ফাইনাল ডিসক্লেইমার

এই কোড **as-is** দেওয়া হচ্ছে, কোনো ওয়ারেন্টি ছাড়া। এটা ফাইন্যান্সিয়াল
অ্যাডভাইস না। mainnet-এ চালালে real money হারানোর সম্পূর্ণ ঝুঁকি আপনার —
ছোট amount দিয়ে, ছোট `MAX_TRADE_AMOUNT_USD` দিয়ে, এবং সংশ্লিষ্ট আইন ও
প্রোটোকলের নিয়ম-কানুন মেনে ব্যবহার করুন।
# mav-bot-
