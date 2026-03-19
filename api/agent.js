import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import { Redis } from '@upstash/redis';

export const maxDuration = 60; 

async function sendTelegramMessage(chatId, text, botToken) {
  if (!botToken || !chatId) return; 
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  
  const keyboard = {
    inline_keyboard: [
      [{ text: "📊 Мій Портфель", callback_data: "portfolio" }, { text: "⚙️ Налаштування", callback_data: "settings" }]
    ]
  };

  await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
        chat_id: chatId, 
        text: text, 
        parse_mode: 'HTML', 
        disable_web_page_preview: true,
        reply_markup: keyboard
    })
  }).catch(err => console.error(err));
}

const t = {
    uk: { 
        rep: "🤖 <b>Звіт Агента:</b>", 
        wal: "💼 <b>Гаманець:</b>", 
        buy: "✅ <b>КУПЛЕНО:</b>", 
        sell: "✅ <b>ПРОДАНО:</b>", 
        inst: "You are an expert, conservative crypto trader AI. Analyze the token data. Answer with either 'BUY' or 'WAIT'. Then, add a new line and provide a detailed, professional 1-2 sentence analysis in UKRAINIAN explaining your decision. Focus on stability, liquidity, and safe growth. Format it beautifully with emojis." 
    },
    en: { 
        rep: "🤖 <b>Agent Report:</b>", 
        wal: "💼 <b>Wallet:</b>", 
        buy: "✅ <b>BOUGHT:</b>", 
        sell: "✅ <b>SOLD:</b>", 
        inst: "You are an expert, conservative crypto trader AI. Analyze the token data. Answer with either 'BUY' or 'WAIT'. Then, add a new line and provide a detailed, professional 1-2 sentence analysis in ENGLISH explaining your decision. Focus on stability, liquidity, and safe growth. Format it beautifully with emojis." 
    },
    el: { 
        rep: "🤖 <b>Αναφορά AI:</b>", 
        wal: "💼 <b>Πορτοφόλι:</b>", 
        buy: "✅ <b>ΑΓΟΡΑΣΤΗΚΕ:</b>", 
        sell: "✅ <b>ΠΟΥΛΗΘΗΚΕ:</b>", 
        inst: "You are an expert, conservative crypto trader AI. Analyze the token data. Answer with either 'BUY' or 'WAIT'. Then, add a new line and provide a detailed, professional 1-2 sentence analysis in GREEK explaining your decision. Focus on stability, liquidity, and safe growth. Format it beautifully with emojis." 
    }
};

export default async function handler(req, res) {
  try {
    const groqKey = process.env.GROQ_API_KEY; 
    const jupiterKey = process.env.JUPITER_API_KEY; 
    const redisUrl = process.env.KV_REST_API_URL;
    const redisToken = process.env.KV_REST_API_TOKEN;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    
    if (!groqKey) throw new Error("Missing GROQ_API_KEY!");
    if (!jupiterKey || !redisUrl || !redisToken) throw new Error("Missing API Keys!");

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
        
        const settings = userData.settings || { tradeAmount: 0.02, takeProfit: 30, stopLoss: 35 };
        
        let soldSomething = false; 
        let activeTokensCount = 0; 

        try {
            const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
            const balance = await connection.getBalance(wallet.publicKey);
            
            // --- БЛОК 1: ПЕРЕВІРКА І АВТОМАТИЧНИЙ ПРОДАЖ ---
            for (const acc of accounts.value) {
                const tokenAmountInfo = acc.account.data.parsed.info.tokenAmount;
                const mintAddress = acc.account.data.parsed.info.mint;
                
                if (tokenAmountInfo.uiAmount > 0 && mintAddress !== solMint) {
                    activeTokensCount++; 
                    
                    try {
                        const buyPriceStr = await redis.get(`buy_price_${mintAddress}_${chatId}`);
                        if (buyPriceStr) {
                            const buyPrice = parseFloat(buyPriceStr);
                            const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
                            const dexData = await dexRes.json();
                            
                            if (dexData.pairs && dexData.pairs.length > 0) {
                                const currentPrice = parseFloat(dexData.pairs[0].priceUsd);
                                const percentChange = ((currentPrice - buyPrice) / buyPrice) * 100;
                                const symbol = dexData.pairs[0].baseToken.symbol;
                                
                                if (percentChange >= settings.takeProfit || percentChange <= -settings.stopLoss) {
                                    const reason = percentChange >= settings.takeProfit ? `🎯 Take-Profit (+${percentChange.toFixed(2)}%)` : `🛡 Stop-Loss (${percentChange.toFixed(2)}%)`;
                                    
                                    const quoteRes = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${mintAddress}&outputMint=${solMint}&amount=${tokenAmountInfo.amount}&slippageBps=300`, { headers: jupHeaders });
                                    const quoteData = await quoteRes.json();
                                    
                                    if (!quoteData.error) {
                                        const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', { method: 'POST', headers: jupHeaders, body: JSON.stringify({ quoteResponse: quoteData, userPublicKey: wallet.publicKey.toString() }) });
                                        const swapData = await swapRes.json();
                                        
                                        const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
                                        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
                                        transaction.sign([wallet]);
                                        const txid = await connection.sendRawTransaction(transaction.serialize());
                                        
                                        await redis.del(`buy_price_${mintAddress}_${chatId}`);
                                        userLogs.actions.push(`${langDict.sell} ${symbol}\nПричина: ${reason}\n🔍 <a href="https://solscan.io/tx/${txid}">Tx</a>`);
                                        soldSomething = true;
                                        activeTokensCount--; 
                                    }
                                }
                            }
                        }
                    } catch (e) { console.error("Помилка продажу", e); }
                }
            }

            // --- БЛОК 2: ПОШУК ТА ПОКУПКА НОВОЇ МОНЕТИ ---
            if (!soldSomething && activeTokensCount < 3) {
                const tradeLamports = Math.floor(settings.tradeAmount * 1e9);

                // Перевіряємо чи вистачає балансу + 0.005 SOL на комісії
                if (balance >= tradeLamports + 5000000) {
                    
                    // ШУКАЄМО ТРЕНДОВІ ТОКЕНИ (замість сміття)
                    const trendRes = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana');
                    const trendData = await trendRes.json();
                    const pairs = trendData.pairs || [];
                    
                    for (const pair of pairs) {
                        if (pair.chainId !== 'solana') continue;
                        if (pair.baseToken.symbol.toUpperCase() === 'SOL' || pair.baseToken.symbol.toUpperCase() === 'WSOL') continue;

                        const tokenAddress = pair.baseToken.address;
                        if (tokenAddress === solMint) continue;

                        const liq = pair.liquidity?.usd || 0;
                        const vol = pair.volume?.h24 || 0;
                        const fdv = pair.fdv || 0; 
                        const priceChange24h = pair.priceChange?.h24 || 0;
                      
                        // Фільтри: шукаємо стабільність
                        if (liq < 15000 || vol < 30000 || fdv < 100000) continue; 
                        if (priceChange24h > 200) continue; 
                        
                        // Перевіряємо чорний список (чи ШІ вже відхиляв її)
                        const isIgnored = await redis.get(`ignored_token_${tokenAddress}`);
                        if (isIgnored) continue; 

                        // Записуємо в портфель, що ми зараз аналізуємо
                        await redis.set(`last_scan_${chatId}`, `🔎 Останній аналіз: <b>${pair.baseToken.symbol}</b>\nЛіквідність: $${Math.round(liq)}\nОб'єм: $${Math.round(vol)}`, { ex: 3600 });

                        const prompt = `
                        ${langDict.inst}
                        Token: ${pair.baseToken.symbol}
                        Liquidity: $${liq}
                        Volume 24h: $${vol}
                        Market Cap (FDV): $${fdv}
                        Change 24h: ${priceChange24h}%
                        Rule: You are looking for STABLE tokens. Do not buy high-risk meme coins that pump and dump. Prefer slow, steady growth.`;

                        // Виклик GROQ API
                        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${groqKey}`,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                model: "llama3-70b-8192", 
                                messages: [
                                    { role: "system", content: "You are an expert crypto trader." },
                                    { role: "user", content: prompt }
                                ],
                                temperature: 0.2
                            })
                        });
                        
                        const groqData = await groqRes.json();
                        
                        if (!groqData.choices || !groqData.choices[0] || !groqData.choices[0].message) break;
                        
                        const aiDecision = groqData.choices[0].message.content.trim();

                        if (aiDecision.includes("BUY")) {
                            const quoteRes = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${solMint}&outputMint=${tokenAddress}&amount=${tradeLamports}&slippageBps=150`, { headers: jupHeaders });
                            const quoteData = await quoteRes.json();

                            if (!quoteData.error) {
                                const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', { method: 'POST', headers: jupHeaders, body: JSON.stringify({ quoteResponse: quoteData, userPublicKey: wallet.publicKey.toString() }) });
                                const swapData = await swapRes.json();
                                
                                const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
                                const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
                                transaction.sign([wallet]);
                                const txid = await connection.sendRawTransaction(transaction.serialize());
                                
                                await redis.set(`buy_price_${tokenAddress}_${chatId}`, pair.priceUsd);
                                await redis.set(`last_scan_${chatId}`, `✅ <b>Куплено:</b> ${pair.baseToken.symbol}!\nШІ очікує прибутку.`, { ex: 3600 });
                                
                                userLogs.actions.push(`${langDict.buy} ${pair.baseToken.symbol}\n🎯 <b>ШІ:</b> ${aiDecision}\n🔍 <a href="https://solscan.io/tx/${txid}">Tx</a>`);
                                break; 
                            }
                        } else {
                            // Заносимо в чорний список і зберігаємо лог
                            await redis.set(`ignored_token_${tokenAddress}`, 'true', { ex: 3600 });
                            let shortAiThought = aiDecision.replace('WAIT', '').trim();
                            await redis.set(`last_scan_${chatId}`, `🔎 Останній аналіз: <b>${pair.baseToken.symbol}</b>\n🧠 <b>Думка ШІ:</b> <i>${shortAiThought}</i>`, { ex: 3600 });
                            break; 
                        }
                    }
                }
            }

        } catch (err) {
            console.error(err);
        }

        if (userLogs.actions.length > 0) {
            await sendTelegramMessage(chatId, `${langDict.rep}\n\n` + userLogs.actions.join('\n\n'), botToken);
        }
    }
    res.status(200).send('Checked all users');
  } catch (error) { 
    res.status(500).send(error.message); 
  }
}
