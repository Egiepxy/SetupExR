'use strict';
const express = require('express');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const markets = new Set(['binance']);
const timeframes = new Set(['1m', '5m', '15m']);
const futuresTf = { '1m': 'Min1', '5m': 'Min5', '15m': 'Min15' };

app.use(express.json({ limit: '128kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: false }));
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'SetupExR/1.0' } });
    if (!response.ok) throw new Error(`Fonte respondeu HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function params(req) {
  const market = String(req.query.market || '').toLowerCase();
  const asset = String(req.query.asset || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/USDT$/, '');
  const tf = String(req.query.tf || '1m');
  if (!markets.has(market)) throw new Error('Mercado inválido');
  if (!asset || asset.length > 24) throw new Error('Ativo inválido');
  if (!timeframes.has(tf)) throw new Error('Tempo inválido');
  return { market, asset, tf };
}

function normalizeMexcFutures(json) {
  const d = json && json.data;
  if (!d) throw new Error('Sem candles na MEXC Futuros');
  const times = d.time || [];
  const rows = times.map((t, i) => [Number(t) * (Number(t) < 1e12 ? 1000 : 1), Number(d.open[i]), Number(d.high[i]), Number(d.low[i]), Number(d.close[i]), Number(d.vol[i] || d.amount?.[i] || 0)]);
  return rows.filter(r => r.every(Number.isFinite)).slice(-220);
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'SetupExR Light Binance V1.4', time: new Date().toISOString() }));

function atrPercent(rows, period = 14) {
  const recent = rows.slice(-(period + 1));
  if (recent.length < period + 1) return 0;
  const tr = [];
  for (let i = 1; i < recent.length; i++) {
    const high = Number(recent[i][2]), low = Number(recent[i][3]), previousClose = Number(recent[i - 1][4]);
    tr.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
  }
  const close = Number(recent.at(-1)[4]);
  return close > 0 ? (tr.reduce((a, b) => a + b, 0) / tr.length) / close * 100 : 0;
}

app.get('/api/binance/volatility', async (_req, res) => {
  try {
    const tickers = await fetchJson('https://api.binance.com/api/v3/ticker/24hr');
    const excluded = /(UP|DOWN|BULL|BEAR)USDT$/;
    const stableBases = new Set(['USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'EUR', 'BRL', 'TRY']);
    const liquid = tickers.filter(t => {
      const symbol = String(t.symbol || '');
      const base = symbol.replace(/USDT$/, '');
      return symbol.endsWith('USDT') && !excluded.test(symbol) && !stableBases.has(base) && Number(t.quoteVolume) >= 5000000 && Number(t.lastPrice) > 0;
    }).map(t => ({
      symbol: t.symbol, asset: t.symbol.replace(/USDT$/, ''), price: Number(t.lastPrice),
      rangePct: (Number(t.highPrice) - Number(t.lowPrice)) / Number(t.lastPrice) * 100,
      changePct: Number(t.priceChangePercent), quoteVolume: Number(t.quoteVolume)
    })).filter(x => Number.isFinite(x.rangePct)).sort((a, b) => b.rangePct - a.rangePct).slice(0, 20);
    const ranked = await Promise.all(liquid.map(async item => {
      try {
        const rows = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(item.symbol)}&interval=15m&limit=40`);
        return { ...item, atrPct: atrPercent(rows) };
      } catch { return { ...item, atrPct: 0 }; }
    }));
    const maxVolume = Math.max(...ranked.map(x => x.quoteVolume), 1);
    ranked.forEach(x => { x.score = x.atrPct * 0.55 + x.rangePct * 0.30 + (Math.log10(x.quoteVolume) / Math.log10(maxVolume)) * 15; });
    ranked.sort((a, b) => b.score - a.score);
    res.json({ ok: true, rows: ranked.slice(0, 10), method: 'ATR% 15m + amplitude 24h + liquidez', serverTime: Date.now() });
  } catch (error) { res.status(502).json({ ok: false, error: error.message || 'Falha ao calcular volatilidade' }); }
});

app.get('/api/market/klines', async (req, res) => {
  try {
    const { market, asset, tf } = params(req);
    let rows;
    if (market === 'binance') {
      rows = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(asset + 'USDT')}&interval=${tf}&limit=220`);
      rows = rows.map(r => [Number(r[0]), Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4]), Number(r[5])]);
    } else if (market === 'mexc_spot') {
      rows = await fetchJson(`https://api.mexc.com/api/v3/klines?symbol=${encodeURIComponent(asset + 'USDT')}&interval=${tf}&limit=220`);
      rows = rows.map(r => [Number(r[0]), Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4]), Number(r[5])]);
    } else {
      const symbol = `${asset}_USDT`;
      const seconds = { '1m': 60, '5m': 300, '15m': 900 }[tf];
      const end = Math.floor(Date.now() / 1000);
      const start = end - seconds * 220;
      rows = normalizeMexcFutures(await fetchJson(`https://contract.mexc.com/api/v1/contract/kline/${encodeURIComponent(symbol)}?interval=${futuresTf[tf]}&start=${start}&end=${end}`));
    }
    if (!Array.isArray(rows) || rows.length < 60) throw new Error('Histórico insuficiente');
    res.json({ ok: true, market, asset, tf, rows: rows.slice(-220), serverTime: Date.now() });
  } catch (error) { res.status(502).json({ ok: false, error: error.message || 'Falha ao consultar mercado' }); }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`SetupExR Light Binance V1.4 online na porta ${PORT}`));
