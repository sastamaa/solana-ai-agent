import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

export default async function handler(req, res) {
  try {
    const privateKey = process.env.SOLANA_PRIVATE_KEY;
    if (!privateKey) throw new Error("Немає ключа гаманця");
    const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    const connection = new Connection('https://api.mainnet-beta.solana.com');
    
    // 1. РАДАР: Шукаємо гарячі монети на Solana
    // Робимо пошук по активних парах
    const searchRes = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana');
    const searchData = await searchRes.json();
    
    // Фільтруємо: тільки Solana, об'єм > $50k, ліквідність > $10k (щоб уникати 100% скаму)
    const activePairs = searchData.pairs.filter(p => 
        p.chainId === 'solana' && 
        p.volume && p.volume.h24 > 50000 &&
        p.liquidity && p.liquidity.usd > 10000
    );

    if (activePairs.length === 0) {
         return res.status(200).json({ status: "WAIT", reason: "Радар не знайшов безпечних монет." });
    }

    // Беремо випадкову монету з ТОП-5 найактивніших (щоб бот щоразу дивився на різні токени)
    const randomIndex = Math.floor(Math.random() * Math.min(5, activePairs.length));
    const targetToken = activePairs[randomIndex];

    const tokenAddress = targetToken.baseToken.address;
    const symbol = targetToken.baseToken.symbol;
    const price = targetToken.priceUsd;
    const change24h = targetToken.priceChange.h24;
    const volume24h = targetToken.volume.h24;
    const liquidity = targetToken.liquidity.usd;

    // 2. ЗАПИТ ДО ШІ
    const groqKey = process.env.GROQ_API_KEY;
    const prompt = `Ти ШІ-мисливець за мемкоінами на Solana. Радар знайшов токен: ${symbol}. 
Ціна: $${price}. Зміна за 24г: ${change24h}%. 
Об'єм торгів: $${volume24h}. Ліквідність: $${liquidity}.
Твоє завдання: якщо об'єм зростає, ліквідність стабільна, а ціна показує позитивну динаміку (але не більше 300%, щоб не купити на самому піку) - пиши "BUY". Інакше - пиши "WAIT". 
Дай коротку відповідь: одне слово "BUY" або "WAIT", і одне речення пояснення. Формат: "РІШЕННЯ: пояснення".`;

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile', 
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const groqData = await groqResponse.json();
    let aiDecision = groqData.choices[0].message.content.trim();
    let actionTaken = "Торгівля не проводилась (ШІ чекає кращого моменту)";
    let txUrl = null;

    // 3. КУПІВЛЯ (Якщо ШІ вирішив BUY)
    if (aiDecision.includes("BUY")) {
        actionTaken = `ШІ вирішив купувати ${symbol}! Створюю транзакцію...`;
        try {
            // Зверни увагу: outputMint тепер динамічний (tokenAddress)
            // slippageBps=300 означає 3% (для мемкоінів потрібне більше прослизання)
            const quoteResponse = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${tokenAddress}&amount=10000000&slippageBps=300`);
            const quoteData = await quoteResponse.json();
            
            if (quoteData.error) {
                throw new Error(`Jupiter не може обміняти цей токен: ${quoteData.error}`);
            }

            const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quoteResponse: quoteData,
                    userPublicKey: wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                })
            });
            const { swapTransaction } = await swapResponse.json();

            const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
            transaction.sign([wallet]);

            const rawTransaction = transaction.serialize();
            const txid = await connection.sendRawTransaction(rawTransaction, {
                skipPreflight: true,
                maxRetries: 2
            });

            actionTaken = `✅ Успішно куплено ${symbol}!`;
            txUrl = `https://solscan.io/tx/${txid}`;

        } catch (tradeError) {
            console.error("Trade Error:", tradeError);
            actionTaken = `❌ Помилка під час купівлі ${symbol}: ${tradeError.message}`;
        }
    }

    // 4. ВИВІД ЗВІТУ
    res.status(200).json({
      agent_status: "🎯 ШІ-Снайпер Активний",
      wallet: wallet.publicKey.toString(),
      target_found: {
        symbol: symbol,
        contract_address: tokenAddress,
        price_usd: `$${price}`,
        change_24h: `${change24h}%`,
        volume_24h: `$${volume24h}`,
        liquidity: `$${liquidity}`
      },
      ai_analysis: aiDecision,
      trade_action: actionTaken,
      transaction_link: txUrl || "Немає"
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
