import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

export const maxDuration = 15; // Даємо функції більше часу на виконання


// ==========================================
// ФУНКЦІЯ: ВІДПРАВКА ЗВІТУ В TELEGRAM
// ==========================================
async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
      console.log("Ключі Telegram не налаштовані.");
      return; 
  }
  
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Використовуємо parse_mode: HTML, щоб зробити текст красивим
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true })
  }).catch(err => console.error("Помилка відправки в Telegram:", err));
}

export default async function handler(req, res) {
  let logs = { actions: [] }; // Сюди ми збираємо всі дії для звіту

  try {
    const privateKey = process.env.SOLANA_PRIVATE_KEY;
    const groqKey = process.env.GROQ_API_KEY;
    
    if (!privateKey || !groqKey) {
        throw new Error("Не вистачає ключів Solana або Groq у Vercel!");
    }
    
    const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl);
    const solMint = "So11111111111111111111111111111111111111112";

    // ==========================================
    // СТАДІЯ 1: МЕНЕДЖЕР ПОРТФЕЛЯ (ПЕРЕВІРКА І ПРОДАЖ)
    // ==========================================
    logs.actions.push("🔍 <b>Перевірка портфеля:</b>");
    
    // Отримуємо всі токени з гаманця
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
    });

    let hasTokensToSell = false;

    for (const acc of accounts.value) {
      const tokenAmountInfo = acc.account.data.parsed.info.tokenAmount;
      const mintAddress = acc.account.data.parsed.info.mint;
      
      // Якщо у нас є якийсь токен (не SOL) з балансом
      if (tokenAmountInfo.uiAmount > 0 && mintAddress !== solMint) {
        hasTokensToSell = true;
        
        // Дізнаємось ринкову ціну токена
        const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
        const dexData = await dexRes.json();
        
        if (dexData.pairs && dexData.pairs.length > 0) {
            const pair = dexData.pairs[0];
            const change24h = pair.priceChange.h24;
            
            // ЛОГІКА ПРОДАЖУ: Якщо ціна виросла на >15% АБО впала на >10%
            if (change24h >= 15 || change24h <= -10) {
                logs.actions.push(`🚨 Вирішено <b>ПРОДАТИ</b> ${pair.baseToken.symbol}! Зміна ціни: ${change24h}%`);
                
                try {
                    // Котирування на продаж ВСЬОГО балансу цього токена
const quoteRes = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${mintAddress}&outputMint=${solMint}&amount=${tokenAmountInfo.amount}&slippageBps=1000`);                    const quoteData = await quoteRes.json();
const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ quoteResponse: quoteData, userPublicKey: wallet.publicKey.toString() })
                    });
                    const { swapTransaction } = await swapRes.json();

                    const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
                    transaction.sign([wallet]);
                    const txid = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
                    
                    logs.actions.push(`✅ Успішно продано! \nTX: https://solscan.io/tx/${txid}`);
                    
                    // Відправляємо звіт і завершуємо (щоб не купувати відразу)
                    const reportText = `🤖 <b>Звіт Агента:</b>\n\n` + logs.actions.join('\n\n');
                    await sendTelegramMessage(reportText);
                    return res.status(200).json(logs); 

                } catch (err) {
                    logs.actions.push(`❌ Помилка продажу: ${err.message}`);
                }
            } else {
                logs.actions.push(`🟡 Токен ${pair.baseToken.symbol} тримаємо (HOLD). Зміна: ${change24h}%`);
            }
        }
      }
    }

    // Дисципліна: якщо маємо токени, але не продаємо - не витрачаємо інші SOL
    if (hasTokensToSell) {
        logs.actions.push("\n⏸ В гаманці є активи. Нові покупки призупинено.");
        const reportText = `🤖 <b>Звіт Агента:</b>\n\n` + logs.actions.join('\n');
        await sendTelegramMessage(reportText);
        return res.status(200).json(logs);
    }
    // ==========================================
    // СТАДІЯ 2: СНАЙПЕР (КУПІВЛЯ НОВОГО ТОКЕНА)
    // ==========================================
    logs.actions.push("\n🎯 <b>Режим Снайпера (Гаманець чистий):</b>");
    
    // Шукаємо активні токени на Dexscreener
    const searchRes = await fetch('https://api.dexscreener.com/latest/dex/search?q=raydium');
    const searchData = await searchRes.json();
    
    // ФІЛЬТРУЄМО: тільки надійні пули з великою ліквідністю
    const activePairs = searchData.pairs.filter(p => 
        p.chainId === 'solana' && 
        p.volume && p.volume.h24 > 50000 && 
        p.liquidity && p.liquidity.usd > 50000 && // Ставимо 50k для безпеки
        p.baseToken.symbol !== 'SOL' && 
        p.baseToken.symbol !== 'WSOL' && 
        p.baseToken.symbol !== 'USDC'
    );
    
    if (activePairs.length === 0) {
        logs.actions.push("Ринок порожній. Нічого не знайдено.");
        const reportText = `🤖 <b>Звіт Агента:</b>\n\n` + logs.actions.join('\n');
        await sendTelegramMessage(reportText);
        return res.status(200).json(logs);
    }

    // Обираємо випадковий токен
    const targetToken = activePairs[Math.floor(Math.random() * activePairs.length)];
    
    // РОБИМО ТЕСТ НА СУМІСНІСТЬ З JUPITER (Щоб не питати ШІ дарма)
    try {
        const testQuote = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${solMint}&outputMint=${targetToken.baseToken.address}&amount=20000000&slippageBps=1000`);
        const testData = await testQuote.json();
        
        if (testData.error) {
             throw new Error("Jupiter не підтримує цю монету.");
        }
    } catch (e) {
        logs.actions.push(`Токен ${targetToken.baseToken.symbol} не підтримується Jupiter. Шукаю інший наступного разу.`);
        const reportText = `🤖 <b>Звіт Агента:</b>\n\n` + logs.actions.join('\n');
        await sendTelegramMessage(reportText);
        return res.status(200).json(logs);
    }

    // ЯКЩО JUPITER ДАВ ДОБРО - ЗАПИТУЄМО ШІ
    const prompt = `Ти трейдер на Solana. Токен: ${targetToken.baseToken.symbol}. Ціна: $${targetToken.priceUsd}. Зміна: ${targetToken.priceChange.h24}%. Об'єм: $${targetToken.volume.h24}. Напиши "BUY", якщо бачиш потенціал росту. Інакше "WAIT". Формат: "РІШЕННЯ: пояснення"`;

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }] })
    });
    
    const groqData = await groqResponse.json();
    const aiDecision = groqData.choices[0].message.content;
    
    logs.actions.push(`Токен: <b>${targetToken.baseToken.symbol}</b>\n🧠 Аналіз ШІ: ${aiDecision}`);

    // Якщо ШІ каже BUY
    if (aiDecision.includes("BUY")) {
        try {
            logs.actions.push(`⏳ Створюю транзакцію для ${targetToken.baseToken.symbol}...`);
            
            // Запитуємо котирування ще раз для самої транзакції
            const quoteRes = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${solMint}&outputMint=${targetToken.baseToken.address}&amount=20000000&slippageBps=1000`);
            const quoteData = await quoteRes.json();
            
            const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    quoteResponse: quoteData, 
                    userPublicKey: wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: "auto",
                    dynamicSlippage: { maxBps: 1000 }
                })
            });
            
            if (!swapRes.ok) throw new Error("Не вдалося створити Swap-транзакцію");

            const { swapTransaction } = await swapRes.json();

            logs.actions.push(`⏳ Відправляю в блокчейн...`);
            const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
            transaction.sign([wallet]);
            
            const txid = await connection.sendRawTransaction(transaction.serialize(), { 
                skipPreflight: true,
                maxRetries: 2
            });
            
            logs.actions.push(`\n✅ <b>УСПІШНО КУПЛЕНО!</b> Потрачено 0.02 SOL.\nTX: https://solscan.io/tx/${txid}`);
        } catch (err) {
             logs.actions.push(`\n❌ Помилка покупки: ${err.message}`);
        }
    }


    // ==========================================
    // ФІНАЛ: ВІДПРАВКА ЗВІТУ
    // ==========================================
    const finalReport = `🤖 <b>Звіт Агента:</b>\n\n` + logs.actions.join('\n');
    await sendTelegramMessage(finalReport);

    res.status(200).json(logs);

  } catch (error) {
    // Відправляємо помилку в Телеграм, щоб ти знала, якщо бот впаде
    await sendTelegramMessage(`⚠️ <b>Критична помилка агента:</b>\n${error.message}`);
    res.status(500).json({ error: error.message });
  }
}
