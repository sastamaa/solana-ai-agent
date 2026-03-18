import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import { Redis } from '@upstash/redis';

export const maxDuration = 60; 

async function sendTelegramMessage(chatId, text, botToken) {
  if (!botToken || !chatId) return; 
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true })
  }).catch(err => console.error(err));
}

const t = {
    uk: { rep: "🤖 <b>Звіт Агента:</b>", wal: "💼 <b>Гаманець:</b>", buy: "✅ <b>КУПЛЕНО:</b>", sell: "✅ <b>ПРОДАНО:</b>", inst: "Ти агресивний крипто-снайпер. Дай коротку відповідь (1-2 речення) УКРАЇНСЬКОЮ мовою." },
    en: { rep: "🤖 <b>Agent Report:</b>", wal: "💼 <b>Wallet:</b>", buy: "✅ <b>BOUGHT:</b>", sell: "✅ <b>SOLD:</b>", inst: "You are an aggressive crypto sniper. Give a short response (1-2 sentences) in ENGLISH." },
    el: { rep: "🤖 <b>Αναφορά AI:</b>", wal: "💼 <b>Πορτοφόλι:</b>", buy: "✅ <b>ΑΓΟΡΑΣΤΗΚΕ:</b>", sell: "✅ <b>ΠΟΥΛΗΘΗΚΕ:</b>", inst: "Είστε ένας επιθετικός crypto sniper. Δώστε μια σύντομη απάντηση (1-2 προτάσεις) στα ΕΛΛΗΝΙΚΑ." }
};

export default async function handler(req, res) {
  try {
    const groqKey = process.env.GROQ_API_KEY;
    const jupiterKey = process.env.JUPITER_API_KEY; 
    const redisUrl = process.env.KV_REST_API_URL;
    const redisToken = process.env.KV_REST_API_TOKEN;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    
    if (!groqKey || !jupiterKey || !redisUrl || !redisToken) throw new Error("Missing API Keys");

    const redis = new Redis({ url: redisUrl, token: redisToken });
    const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=15319ab4-3e9a-4c28-98e8-132d733db9b9');
    const solMint = "So11111111111111111111111111111111111111112"; 
    const jupHeaders = { 'Content-Type': 'application/json', 'x-api-key': jupiterKey };

    const userKeys = await redis.keys('user_*');
    const allUsers = userKeys.map(key => key.replace('user_', ''));
    if (allUsers.length === 0) return res.status(200).send("No users");

    for (const chatId of allUsers) {
        let userLogs = { actions: [] };
        let userDataStr = await redis.get(`user_${chatId}`);
        if (!userDataStr) continue;
        
        const userData = typeof userDataStr === 'string' ? JSON.parse(userDataStr) : userDataStr;
        if (!userData.isActive || !userData.privateKey) continue;
        
        const lang = userData.lang || 'uk'; 
        const langDict = t[lang];

        let wallet;
        try { wallet = Keypair.fromSecretKey(bs58.decode(userData.privateKey)); } catch (e) { continue; }
        
        const settings = userData.settings || { tradeAmount: 0.02, takeProfit: 20, stopLoss: 15 };
        userLogs.actions.push(`${langDict.wal} <code>${userData.walletAddress.substring(0, 4)}...${userData.walletAddress.slice(-4)}</code>`);
        
        const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
        let soldSomething = false; 
        let activeTokensCount = 0; 

        // БЛОК ПРОДАЖУ
        for (const acc of accounts.value) {
          const tokenAmountInfo = acc.account.data.parsed.info.tokenAmount;
          const mintAddress = acc.account.data.parsed.info.mint;
          
          if (tokenAmountInfo.uiAmount > 0 && mintAddress !== solMint) {
            activeTokensCount++; 
            try {
                const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
                const dexData = await dexRes.json();
                
                if (dexData.pairs && dexData.pairs.length > 0) {
                    const pair = dexData.pairs[0];
                    const currentPrice = parseFloat(pair.priceUsd);
                    const buyKey = `buy_price_${mintAddress}_${chatId}`;
                    let buyPriceStr = await redis.get(buyKey);
                    
                    if (buyPriceStr) {
                        const buyPrice = parseFloat(buyPriceStr);
                        const percentChange = ((currentPrice - buyPrice) / buyPrice) * 100;
                        
                        if (percentChange >= settings.takeProfit || percentChange <= -settings.stopLoss) {
                            const quoteRes = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${mintAddress}&outputMint=${solMint}&amount=${tokenAmountInfo.amount}&slippageBps=150`, { headers: jupHeaders });
                            const quoteData = await quoteRes.json();
                            
                            const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', { method: 'POST', headers: jupHeaders, body: JSON.stringify({ quoteResponse: quoteData, userPublicKey: wallet.publicKey.toString() }) });
                            const swapData = await swapRes.json();
                            
                            const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
                            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
                            transaction.sign([wallet]);
                            const txid = await connection.sendRawTransaction(transaction.serialize());
                            
                            const reason = percentChange >= settings.takeProfit ? `📈 Take-Profit (+${percentChange.toFixed(1)}%)` : `📉 Stop-Loss (${percentChange.toFixed(1)}%)`;
                            userLogs.actions.push(`${langDict.sell} ${pair.baseToken.symbol} | ${reason}\n🔍 <a href="https://solscan.io/tx/${txid}">Tx</a>`);
                            await redis.del(buyKey);
                            soldSomething = true;
                            activeTokensCount--; 
                        }
                    }
                }
            } catch (err) {}
          }
        }

        // БЛОК ПОШУКУ ТА ПОКУПКИ
        if (!soldSomething && activeTokensCount < 3) {
            try {
                const balance = await connection.getBalance(wallet.publicKey);
                const tradeLamports = Math.floor(settings.tradeAmount * 1e9);

                // ПЕРЕВІРКА НА БАЛАНС!
                if (balance < tradeLamports + 5000000) {
                    userLogs.actions.push(`⚠️ <b>Увага: Недостатньо SOL для покупки!</b>\nВ налаштуваннях: ${settings.tradeAmount} SOL.\nВаш баланс: ${(balance/1e9).toFixed(4)} SOL.\n<i>Будь ласка, поповніть баланс або зайдіть у "Налаштування" та зменшіть суму покупки!</i>`);
                } else {
                    const trendRes = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
                    const trendData = await trendRes.json();
                    
                    for (const p of trendData) {
                        if (p.chainId !== 'solana' || p.tokenAddress === solMint) continue;
                        
                        const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${p.tokenAddress}`);
                        const dexData = await dexRes.json();
                        
                        if (dexData.pairs && dexData.pairs.length > 0) {
                            const pair = dexData.pairs[0];
                            if (pair.baseToken.symbol.toUpperCase() === 'SOL' || pair.baseToken.symbol.toUpperCase() === 'WSOL') continue; 

                            const liq = pair.liquidity?.usd || 0;
                            const vol = pair.volume?.h24 || 0;
                            
                            if (liq < 5000 || vol < 10000) continue; 

                            const prompt = `
                            ${langDict.inst}
                            Token: ${pair.baseToken.symbol}
                            Liquidity: $${liq}
                            Volume 24h: $${vol}
                            Change 24h: ${pair.priceChange?.h24 || 0}%
                            
                            Rule: Meme coins grow fast. A 24h change up to 300% is NORMAL if volume is high! 
                            If it looks promising, reply 'BUY'. If it's dead or dangerous, reply 'WAIT'. Give reason.`;

                            const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                                method: 'POST', headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
                                body: JSON.stringify({ model: 'llama3-8b-8192', messages: [{ role: 'user', content: prompt }] })
                            });
                            
                            const groqData = await groqRes.json();
                            const aiDecision = groqData.choices[0].message.content.trim();

                            if (aiDecision.includes("BUY")) {
                                const quoteRes = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${solMint}&outputMint=${p.tokenAddress}&amount=${tradeLamports}&slippageBps=150`, { headers: jupHeaders });
                                const quoteData = await quoteRes.json();

                                if (!quoteData.error) {
                                    const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', { method: 'POST', headers: jupHeaders, body: JSON.stringify({ quoteResponse: quoteData, userPublicKey: wallet.publicKey.toString() }) });
                                    const swapData = await swapRes.json();
                                    
                                    const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
                                    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
                                    transaction.sign([wallet]);
                                    const txid = await connection.sendRawTransaction(transaction.serialize());
                                    
                                    await redis.set(`buy_price_${p.tokenAddress}_${chatId}`, pair.priceUsd);
                                    userLogs.actions.push(`${langDict.buy} ${pair.baseToken.symbol}\n🎯 <b>ШІ:</b> ${aiDecision}\n🔍 <a href="https://solscan.io/tx/${txid}">Tx</a>`);
                                    break; 
                                }
                            } else {
                                // ЯКЩО ШІ ВІДХИЛИВ МОНЕТУ - ПИШЕМО ПРО ЦЕ В ЧАТ!
                                userLogs.actions.push(`🔎 <b>Сканування:</b> ${pair.baseToken.symbol}\n🧠 <b>Думка ШІ:</b> ${aiDecision}`);
                                break; // Перевіряємо лише 1 токен за цикл, щоб не засмічувати чат
                            }
                        }
                    }
                }
            } catch (err) {}
        }

        // ВІДПРАВЛЯЄМО ЗВІТ (якщо є хоча б 2 рядки - Гаманець + Дія/Аналіз)
        if (userLogs.actions.length > 1) {
            await sendTelegramMessage(chatId, `${langDict.rep}\n\n` + userLogs.actions.join('\n\n'), botToken);
        }
    }
    res.status(200).send('Checked all users');
  } catch (error) { res.status(500).send('Error'); }
}
