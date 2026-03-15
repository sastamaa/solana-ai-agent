import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export default async function handler(req, res) {
  try {
    // 1. Підключаємо гаманець
    const privateKey = process.env.SOLANA_PRIVATE_KEY;
    const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    
    // 2. Беремо дані з ринку (наприклад, токен BONK)
    const dexResponse = await fetch('https://api.dexscreener.com/latest/dex/tokens/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    const dexData = await dexResponse.json();
    const token = dexData.pairs[0];
    
    const price = parseFloat(token.priceUsd);
    const priceChange24h = token.priceChange.h24;
    const volume24h = token.volume.h24;

       // 3. Звертаємося до БЕЗКОШТОВНОГО Groq API (дуже швидкий ШІ)
    const groqKey = process.env.GROQ_API_KEY;
    
    if (!groqKey) {
       throw new Error("Не знайдено ключ GROQ_API_KEY у налаштуваннях Vercel");
    }

    const prompt = `Ти професійний крипто-трейдер на Solana. Проаналізуй цей токен:
Назва: ${token.baseToken.symbol}
Ціна: $${price}
Зміна за 24г: ${priceChange24h}%
Об'єм торгів: $${volume24h}
Дай коротку відповідь: одне слово "BUY" або "WAIT", і одне речення пояснення. Формат: "РІШЕННЯ: пояснення"`;

    // Запит до Groq (модель Llama 3 70B - дуже розумна і швидка)
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`
      },
      body: JSON.stringify({
        model: 'llama3-70b-8192', 
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const groqData = await groqResponse.json();
    
    let aiDecision = "Помилка ШІ";
    
    if (groqData.choices && groqData.choices.length > 0) {
        aiDecision = groqData.choices[0].message.content.trim();
    } else if (groqData.error) {
        aiDecision = `Помилка API: ${groqData.error.message}`;
    } else {
        aiDecision = `Невідома помилка: ${JSON.stringify(groqData)}`;
    }

    // 4. Виводимо результат
    res.status(200).json({
      agent_status: "🧠 ШІ Groq Активний",
      wallet: wallet.publicKey.toString(),
      market_data: {
        token: token.baseToken.symbol,
        price_usd: `$${price}`,
        change_24h: `${priceChange24h}%`,
        volume_24h: `$${volume24h}`
      },
      ai_analysis: aiDecision
    });

  } catch (error) {
    console.error("Помилка агента:", error);
    res.status(500).json({ error: error.message });
  }
}
