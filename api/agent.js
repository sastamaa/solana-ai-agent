// api/agent.js
export default async function handler(req, res) {
  // 1. Скан Dexscreener (hot tokens)
  const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/SOL');
  const data = await response.json();
  const hotToken = data.pairs[0]; // Перший hot

  // 2. ШІ-аналіз (твій Grok API або mock)
  const aiPrompt = `Аналізуй ${hotToken.baseToken.symbol}: price ${hotToken.priceUsd}, volume ${hotToken.volume.h24}. Buy 0.01 SOL чи wait?`;
  // Замість fetch Grok: const aiDecision = 'buy'; // Я дам промпт
  const aiDecision = 'buy'; // З ШІ

  if (aiDecision === 'buy') {
    // 3. Auto-swap через Jupiter (твій wallet key)
    console.log(`Auto-buy ${hotToken.baseToken.symbol} 0.01 SOL`);
    // Тут Jupiter SDK code (нижче)
  }

  res.json({ status: 'scanned', decision: aiDecision });
}
