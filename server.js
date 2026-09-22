'use strict';
const express = require('express');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const markets = new Set(['binance', 'mexc_spot', 'mexc_futures']);
const BINANCE_MARKET_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
async function binanceMarket(endpoint) {
  const errors = [];
  for (const host of BINANCE_MARKET_HOSTS) {
    try { return await fetchJson(host + endpoint); }
    catch (e) { errors.push(host + ': ' + e.message);
      if (/HTTP 451/.test(e.message)) break; // Não contornar restrições legais ou geográficas.
    }
  }
  throw new Error('Dados Binance indisponíveis. ' + errors.join(' | '));
}

const timeframes = new Set(['1m', '5m', '15m']);
const futuresTf = { '1m': 'Min1', '5m': 'Min5', '15m': 'Min15', '1h': 'Min60', '4h': 'Hour4' };

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

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'SetupExR Light MultiExchange V1.9', time: new Date().toISOString() }));

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

function emaValues(values, period) {
  const k = 2 / (period + 1); let value = Number(values[0] || 0);
  return values.map((item, index) => index ? (value = Number(item) * k + value * (1 - k)) : value);
}
function rsiValue(values, period = 14) {
  if (values.length <= period) return 50;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; gain += Math.max(d, 0); loss += Math.max(-d, 0); }
  gain /= period; loss /= period; let out = 50;
  for (let i = period + 1; i < values.length; i++) { const d = values[i] - values[i - 1]; gain = (gain * (period - 1) + Math.max(d, 0)) / period; loss = (loss * (period - 1) + Math.max(-d, 0)) / period; out = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); }
  return out;
}
function recoveryMetrics(rows) {
  const closes = rows.map(r => Number(r[4])), volumes = rows.map(r => Number(r[5] || 0));
  const e9 = emaValues(closes, 9), e14 = emaValues(closes, 14), fast = emaValues(closes, 12), slow = emaValues(closes, 26);
  const macd = closes.map((_, i) => fast[i] - slow[i]), signal = emaValues(macd, 9), hist = macd.map((v, i) => v - signal[i]);
  const last = rows.at(-1), previous = rows.at(-2), avgVolume = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const recentLow = Math.min(...rows.slice(-8).map(r => Number(r[3]))), priorLow = Math.min(...rows.slice(-16, -8).map(r => Number(r[3])));
  const breakoutLevel = Math.max(...rows.slice(-6, -1).map(r => Number(r[2])));
  const breakout = Number(last[4]) > breakoutLevel;
  return { price: Number(last[4]), rsi: rsiValue(closes), previousRsi: rsiValue(closes.slice(0, -1)), e9: e9.at(-1), previousE9: e9.at(-2), e14: e14.at(-1), hist: hist.at(-1), previousHist: hist.at(-2), volumeRatio: avgVolume ? Number(last[5]) / avgVolume : 0, higherLow: recentLow > priorLow, breakout, breakoutLevel, recentLow, atrPct: atrPercent(rows), previousAtrPct: atrPercent(rows.slice(0, -1)), bullishCandle: Number(last[4]) > Number(last[1]), previousClose: Number(previous[4]) };
}
async function marketRows(market, asset, tf, limit = 120) {
  let rows;
  if (market === 'binance') rows = await binanceMarket(`/api/v3/klines?symbol=${encodeURIComponent(asset + 'USDT')}&interval=${tf}&limit=${limit}`);
  else if (market === 'mexc_spot') rows = await fetchJson(`https://api.mexc.com/api/v3/klines?symbol=${encodeURIComponent(asset + 'USDT')}&interval=${tf}&limit=${limit}`);
  else { const seconds = { '15m': 900, '1h': 3600, '4h': 14400 }[tf]; const end = Math.floor(Date.now() / 1000), start = end - seconds * limit; rows = normalizeMexcFutures(await fetchJson(`https://contract.mexc.com/api/v1/contract/kline/${encodeURIComponent(asset + '_USDT')}?interval=${futuresTf[tf]}&start=${start}&end=${end}`)); }
  return rows.map(r => [Number(r[0]), Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4]), Number(r[5])]);
}
async function recoveryCandidates(market) {
  let raw;
  if (market === 'mexc_futures') { const response = await fetchJson('https://contract.mexc.com/api/v1/contract/ticker'); raw = response.data || []; }
  else raw = market === 'binance' ? await binanceMarket('/api/v3/ticker/24hr') : await fetchJson('https://api.mexc.com/api/v3/ticker/24hr');
  return raw.map(t => { const symbol = String(t.symbol || '').replace('_', ''), asset = symbol.replace(/USDT$/, ''), price = Number(t.lastPrice ?? t.close), volume = Number(t.quoteVolume ?? t.amount24 ?? t.amount24h ?? t.volume24 ?? 0), change = Number(t.priceChangePercent ?? Number(t.riseFallRate || 0) * 100); return { symbol, asset, price, volume, change }; })
    .filter(x => x.symbol.endsWith('USDT') && x.asset && x.price > 0 && x.volume >= 5000000 && Number.isFinite(x.change) && !/(UP|DOWN|BULL|BEAR)$/.test(x.asset))
    .filter(x => x.change > -35 && x.change < 12).sort((a, b) => a.change - b.change).slice(0, 18);
}

app.get('/api/market/volatility', async (req, res) => {
  try {
    const market = String(req.query.market || 'binance').toLowerCase();
    if (!markets.has(market)) throw new Error('Mercado inválido');
    let tickers;
    if (market === 'mexc_futures') {
      const result = await fetchJson('https://contract.mexc.com/api/v1/contract/ticker');
      tickers = Array.isArray(result.data) ? result.data : [];
    } else {
      tickers = market === 'binance' ? await binanceMarket('/api/v3/ticker/24hr') : await fetchJson('https://api.mexc.com/api/v3/ticker/24hr');
    }
    const excluded = /(UP|DOWN|BULL|BEAR)USDT$/;
    const stableBases = new Set(['USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'EUR', 'BRL', 'TRY']);
    const liquid = tickers.filter(t => {
      const symbol = String(t.symbol || '').replace('_', '');
      const base = symbol.replace(/USDT$/, '');
      const price = Number(t.lastPrice ?? t.close);
      const volume = Number(t.quoteVolume ?? t.amount24 ?? t.amount24h ?? t.volume24 ?? 0);
      return symbol.endsWith('USDT') && !excluded.test(symbol) && !stableBases.has(base) && volume >= 5000000 && price > 0;
    }).map(t => ({
      symbol: String(t.symbol || '').replace('_', ''), asset: String(t.symbol || '').replace('_', '').replace(/USDT$/, ''), price: Number(t.lastPrice ?? t.close),
      rangePct: (Number(t.highPrice ?? t.high24Price ?? t.high24) - Number(t.lowPrice ?? t.lower24Price ?? t.low24)) / Number(t.lastPrice ?? t.close) * 100,
      changePct: Number(t.priceChangePercent ?? (Number(t.riseFallRate || 0) * 100)), quoteVolume: Number(t.quoteVolume ?? t.amount24 ?? t.amount24h ?? t.volume24 ?? 0)
    })).filter(x => Number.isFinite(x.rangePct)).sort((a, b) => b.rangePct - a.rangePct).slice(0, 20);
    const ranked = await Promise.all(liquid.map(async item => {
      try {
        let rows;
        if (market === 'binance') rows = await binanceMarket(`/api/v3/klines?symbol=${encodeURIComponent(item.symbol)}&interval=15m&limit=40`);
        else if (market === 'mexc_spot') rows = await fetchJson(`https://api.mexc.com/api/v3/klines?symbol=${encodeURIComponent(item.symbol)}&interval=15m&limit=40`);
        else {
          const end = Math.floor(Date.now() / 1000), start = end - 900 * 40;
          rows = normalizeMexcFutures(await fetchJson(`https://contract.mexc.com/api/v1/contract/kline/${encodeURIComponent(item.asset + '_USDT')}?interval=Min15&start=${start}&end=${end}`));
        }
        return { ...item, atrPct: atrPercent(rows) };
      } catch { return { ...item, atrPct: 0 }; }
    }));
    const maxVolume = Math.max(...ranked.map(x => x.quoteVolume), 1);
    ranked.forEach(x => { x.score = x.atrPct * 0.55 + x.rangePct * 0.30 + (Math.log10(x.quoteVolume) / Math.log10(maxVolume)) * 15; });
    ranked.sort((a, b) => b.score - a.score);
    res.json({ ok: true, market, rows: ranked.slice(0, 10), method: 'ATR% 15m + amplitude 24h + liquidez', serverTime: Date.now() });
  } catch (error) { res.status(502).json({ ok: false, error: error.message || 'Falha ao calcular volatilidade' }); }
});

app.get('/api/market/klines', async (req, res) => {
  try {
    const { market, asset, tf } = params(req);
    let rows;
    if (market === 'binance') {
      rows = await binanceMarket(`/api/v3/klines?symbol=${encodeURIComponent(asset + 'USDT')}&interval=${tf}&limit=220`);
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

app.get('/api/market/recovery', async (req, res) => {
  try {
    const market = String(req.query.market || 'binance').toLowerCase();
    const mode = String(req.query.mode || 'observe').toLowerCase();
    if (!markets.has(market)) throw new Error('Mercado inválido');
    if (!['observe', 'prepare', 'confirmed'].includes(mode)) throw new Error('Modo inválido');
    const candidates = await recoveryCandidates(market);
    const settled = await Promise.all(candidates.map(async item => {
      try {
        const [r15, r1h, r4h] = await Promise.all([marketRows(market, item.asset, '15m'), marketRows(market, item.asset, '1h'), marketRows(market, item.asset, '4h')]);
        const m15 = recoveryMetrics(r15), m1h = recoveryMetrics(r1h), m4h = recoveryMetrics(r4h);
        const checks = [
          ['RSI 15m saiu do fundo', m15.rsi > 30 && m15.rsi > m15.previousRsi],
          ['MACD 15m melhorando', m15.hist > m15.previousHist],
          ['MME 9 virou para cima', m15.e9 > m15.previousE9],
          ['MME 9 alcançando a MME 14', m15.e9 >= m15.e14 * 0.995],
          ['Primeiro fundo mais alto', m15.higherLow],
          ['Rompimento da máxima curta', m15.breakout],
          ['Volume acima de 1,2x', m15.volumeRatio >= 1.2],
          ['ATR aumentando com o movimento', m15.atrPct > m15.previousAtrPct && m15.bullishCandle],
          ['RSI de 1h melhorando', m1h.rsi > m1h.previousRsi],
          ['MACD de 4h perdendo força vendedora', m4h.hist > m4h.previousHist]
        ];
        const score = checks.filter(x => x[1]).length;
        const confirmed = score >= 8 && m15.breakout && m15.volumeRatio >= 1.2 && m1h.rsi > m1h.previousRsi;
        const preparing = !confirmed && (score >= 8 || (score >= 7 && (m15.breakout || m15.volumeRatio >= 1.2)));
        const classification = confirmed ? 'confirmed' : preparing ? 'prepare' : 'observe';
        const stage = confirmed ? '🟢 Entrada confirmada' : preparing ? '🟡 Preparar entrada' : score >= 6 ? '🔵 Observar' : score >= 4 ? 'Possível fundo' : 'Continua fraca';
        const chaseRisk = item.change >= 6;
        const action = confirmed ? 'Rompimento confirmado: procurar retorno curto ou candle de continuação antes da entrada.' : score >= 8 ? 'Aguardar rompimento da máxima curta com volume mínimo de 1,2x.' : 'Somente observação; ainda faltam confirmações.';
        const entry = Math.max(m15.price, m15.breakoutLevel * 1.001), stop = m15.recentLow * 0.999, risk = entry - stop;
        const levels = risk > 0 ? { entry, stop, target1: entry + risk, target2: entry + risk * 2, riskPct: risk / entry * 100 } : null;
        return { ...item, score, confirmed, preparing, classification, stage, chaseRisk, action, levels, signals: checks.filter(x => x[1]).map(x => x[0]), missing: checks.filter(x => !x[1]).map(x => x[0]), rsi15: m15.rsi, rsi1h: m1h.rsi, volumeRatio: m15.volumeRatio, atrPct: m15.atrPct };
      } catch { return null; }
    }));
    const rows = settled.filter(Boolean).filter(x => x.score >= 6 && x.classification === mode).sort((a, b) => b.score - a.score || b.volume - a.volume).slice(0, 10);
    res.json({ ok: true, market, mode, rows, scanned: candidates.length, serverTime: Date.now() });
  } catch (error) { res.status(502).json({ ok: false, error: error.message || 'Falha ao buscar recuperação' }); }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`SetupExR Light MultiExchange V1.9 online na porta ${PORT}`));
