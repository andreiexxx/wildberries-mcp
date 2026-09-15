#!/usr/bin/env node
'use strict';

// Wildberries для Claude — MCP-сервер.
//
// Работает на вашем компьютере. Токен WB берётся из настроек расширения
// (переменная окружения WB_TOKEN) и отправляется только в API Wildberries —
// больше никуда. Зависимостей нет: весь код в этом файле, его можно прочитать
// целиком и убедиться в этом самому.
//
// Протокол: MCP поверх stdio, по одной строке JSON на сообщение. В stdout
// пишутся ТОЛЬКО ответы протокола. Любые логи — в stderr, иначе Claude
// получит мусор вместо ответа и отключит расширение.

const VERSION = '1.0.0';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// Если поле в настройках не заполнено, Claude может передать шаблон как есть.
function envValue(name) {
  const v = String(process.env[name] || '').trim();
  return v.startsWith('${') ? '' : v;
}

const TOKEN = envValue('WB_TOKEN');
const ALLOW_WRITE = /^(true|1|yes)$/i.test(envValue('WB_ALLOW_WRITE'));

function log(...parts) {
  process.stderr.write(`[wildberries] ${parts.join(' ')}\n`);
}

// ── Ошибки ────────────────────────────────────────────────────────────────
// WbError — понятная человеку причина, её показываем в Claude как есть.
class WbError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ── Токен ─────────────────────────────────────────────────────────────────
// Токен WB — это JWT. Подпись не проверяем, читаем только полезную нагрузку:
// тип токена, категории доступа, флаг «только чтение» и срок действия.
const CATEGORY_BITS = [
  [1, 'Контент'],
  [2, 'Аналитика'],
  [3, 'Цены и скидки'],
  [4, 'Маркетплейс'],
  [5, 'Статистика'],
  [6, 'Продвижение'],
  [7, 'Вопросы и отзывы'],
  [9, 'Чат с покупателями'],
  [10, 'Поставки'],
  [11, 'Возвраты покупателями'],
  [12, 'Документы'],
];
const TOKEN_KINDS = { 1: 'базовый', 2: 'тестовый', 3: 'персональный', 4: 'сервисный' };

function decodeToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const s = Number(p.s) || 0;
    return {
      kind: Number(p.acc) || 0,
      kindLabel: TOKEN_KINDS[p.acc] || 'неизвестный',
      categories: CATEGORY_BITS.filter(([bit]) => (s >> bit) & 1).map(([, name]) => name),
      readOnly: Boolean((s >> 30) & 1),
      exp: typeof p.exp === 'number' ? p.exp : null,
    };
  } catch {
    return null;
  }
}

function tokenWarnings(info) {
  if (!info) {
    return ['Токен не похож на токен WB. Скорее всего он скопирован не целиком — скопируйте заново.'];
  }
  const out = [];
  if (info.exp && info.exp * 1000 < Date.now()) {
    out.push('Срок действия токена истёк. Создайте новый в кабинете WB и вставьте его в настройках расширения.');
  } else if (info.exp) {
    const days = Math.floor((info.exp * 1000 - Date.now()) / 86_400_000);
    if (days <= 14) out.push(`Токен перестанет работать через ${days} дн. Заранее создайте новый.`);
  }
  if (info.kind === 4) {
    out.push('Это сервисный токен: он работает только с тем сервисом из каталога WB, для которого создан. Нужен персональный.');
  }
  if (info.kind === 2) out.push('Это тестовый токен: он ходит в песочницу WB, реальных данных магазина там нет.');
  if (info.categories.length === 0) out.push('В токене не отмечена ни одна категория доступа — читать будет нечего.');
  return out;
}

// ── Даты ──────────────────────────────────────────────────────────────────
// «Сегодня» считаем по Москве: так же, как считает сам кабинет WB.
function mskDay(daysAgo = 0) {
  return new Date(Date.now() + 3 * 3_600_000 - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

function dateArg(value, fallback, label) {
  const s = value === undefined || value === null || value === '' ? fallback : String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new WbError(`${label}: нужна дата в формате ГГГГ-ММ-ДД, а пришло «${s}».`);
  }
  return s;
}

// ── Клиент WB API ─────────────────────────────────────────────────────────
// Грабли, на которые уже наступили:
// 1. Заголовок авторизации — сырой токен, БЕЗ «Bearer». С префиксом WB отвечает 401.
// 2. У каждой категории API свой адрес.
// 3. Таймаут обязателен: зависший запрос к рекламе иначе висит минутами.
const HOSTS = {
  common: 'https://common-api.wildberries.ru',
  statistics: 'https://statistics-api.wildberries.ru',
  content: 'https://content-api.wildberries.ru',
  analytics: 'https://seller-analytics-api.wildberries.ru',
  advert: 'https://advert-api.wildberries.ru',
  feedbacks: 'https://feedbacks-api.wildberries.ru',
  prices: 'https://discounts-prices-api.wildberries.ru',
};

function humanStatus(status) {
  if (status === 401) {
    return 'WB не принял токен: он истёк (токен живёт 180 дней), удалён или скопирован не целиком. Создайте новый и вставьте его в настройках расширения.';
  }
  if (status === 403) {
    return 'У токена нет доступа к этому разделу. Создайте токен заново и отметьте нужные категории.';
  }
  if (status === 429) return 'WB временно ограничил частоту запросов. Подождите минуту и повторите.';
  if (status >= 500) return 'WB сейчас не отвечает. Это на их стороне, попробуйте позже.';
  return `WB ответил ошибкой ${status}.`;
}

async function wb(host, path, { method = 'GET', body, timeoutMs = 30_000 } = {}) {
  if (!TOKEN) {
    throw new WbError(
      'Токен WB не указан. Откройте в Claude: Настройки (Settings) → Расширения (Extensions) → Wildberries → Настроить (Configure) и вставьте токен.',
    );
  }
  let res;
  try {
    res = await fetch(`${HOSTS[host]}${path}`, {
      method,
      headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const s = String(e);
    throw new WbError(
      s.includes('Timeout') || s.includes('abort')
        ? `WB не ответил за ${Math.round(timeoutMs / 1000)} секунд. Попробуйте ещё раз.`
        : 'Не удалось связаться с WB. Проверьте интернет или VPN: с некоторыми VPN сервера WB недоступны.',
    );
  }
  const text = await res.text();
  if (!res.ok) {
    // Тело ошибки — только в лог. Токена в нём нет, но подробности человеку не нужны.
    log(`${host}${path.split('?')[0]} → ${res.status}: ${text.slice(0, 300)}`);
    throw new WbError(humanStatus(res.status), res.status);
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new WbError('WB вернул ответ, который не удалось разобрать.');
  }
}

// ── Проверка подключения ──────────────────────────────────────────────────
async function checkConnection() {
  const info = decodeToken(TOKEN);
  let connection;
  try {
    await wb('common', '/ping');
    connection = 'WB принял токен, всё работает';
  } catch (e) {
    connection = e instanceof WbError ? e.message : 'Не удалось проверить';
  }
  return {
    связь: connection,
    типТокена: info ? info.kindLabel : null,
    доступ: info ? info.categories : [],
    токенТолькоНаЧтение: info ? info.readOnly : null,
    действуетДо: info && info.exp ? new Date(info.exp * 1000).toISOString().slice(0, 10) : null,
    изменения: ALLOW_WRITE
      ? 'разрешены в настройках расширения (ставки, паузы, цены)'
      : 'выключены — Claude только читает данные',
    предупреждения: tokenWarnings(info),
  };
}

// ── Продажи ───────────────────────────────────────────────────────────────
// Ловушка: dateFrom — дата ИЗМЕНЕНИЯ записи, а не продажи, и верхней границы
// у метода нет. Поэтому обе границы периода применяем сами.
async function sales(from, to) {
  const rows = await wb('statistics', `/api/v1/supplier/sales?dateFrom=${encodeURIComponent(from)}`, {
    timeoutMs: 60_000,
  });
  const list = Array.isArray(rows) ? rows : [];
  const inRange = list.filter((s) => {
    const d = String(s.date || '').slice(0, 10);
    return d >= from && d <= to;
  });
  // Возвраты приходят тем же списком — считаем отдельно.
  const sold = inRange.filter((s) => String(s.saleID || '').startsWith('S'));
  const returned = inRange.filter((s) => String(s.saleID || '').startsWith('R'));
  const sum = (a) => Math.round(a.reduce((n, s) => n + (Number(s.forPay) || 0), 0));
  return {
    период: `${from} — ${to}`,
    продаж: sold.length,
    кПеречислению: sum(sold),
    возвратов: returned.length,
    суммаВозвратов: Math.abs(sum(returned)),
    всегоЗаписей: inRange.length,
  };
}

// ── Остатки ───────────────────────────────────────────────────────────────
async function stocks() {
  const r = await wb('analytics', '/api/analytics/v1/stocks-report/wb-warehouses', {
    method: 'POST',
    body: { limit: 1000, offset: 0 },
  });
  const items = (r && r.data && r.data.items) || [];
  return {
    строк: items.length,
    примеры: items.slice(0, 25),
    подсказка: items.length >= 1000 ? 'Показана первая тысяча строк — в кабинете их больше.' : undefined,
  };
}

// ── Товары ────────────────────────────────────────────────────────────────
async function products(limit) {
  const r = await wb('content', '/content/v2/get/cards/list', {
    method: 'POST',
    body: { settings: { cursor: { limit: Math.min(Math.max(limit, 1), 100) }, filter: { withPhoto: -1 } } },
  });
  const cards = (r && r.cards) || [];
  return {
    карточек: cards.length,
    товары: cards.map((c) => ({
      nmID: c.nmID,
      артикул: c.vendorCode,
      название: c.title,
      предмет: c.subjectName,
      бренд: c.brand,
    })),
  };
}

// ── Реклама ───────────────────────────────────────────────────────────────
async function adBalance() {
  const r = await wb('advert', '/adv/v1/balance');
  return {
    счёт: (r && r.balance) || 0,
    баланс: (r && r.net) || 0,
    валюта: (r && r.currency) || 'RUB',
    пояснение: 'Счёт — деньги для рекламы. Баланс — общий остаток на аккаунте.',
  };
}

function campaignStatus(code) {
  if (code === 9) return 'активна';
  if (code === 11) return 'пауза';
  return String(code);
}

async function campaignList() {
  const r = await wb('advert', '/api/advert/v2/adverts?statuses=9,11');
  return (r && r.adverts) || [];
}

async function campaigns() {
  const list = await campaignList();
  return {
    кампаний: list.length,
    кампании: list.slice(0, 60).map((a) => ({
      // Поле идентификатора в v2 называется id, а не advert_id.
      id: a.id,
      название: a.settings && a.settings.name,
      статус: campaignStatus(a.status),
      артикулов: (a.nm_settings || []).length,
    })),
  };
}

// Статистика рекламы. Ограничения WB, которые нельзя нарушать:
//   • примерно один запрос в минуту — поэтому ответ кэшируем на полторы минуты;
//   • не больше 50 кампаний за запрос — делим на части сами. Если обрезать
//     список, у «лишних» кампаний молча окажется нулевой расход и неверный ДРР.
const statsCache = new Map();

async function adStats(from, to) {
  const key = `${from}:${to}`;
  const hit = statsCache.get(key);
  if (hit && Date.now() - hit.at < 90_000) return hit.data;

  const list = await campaignList();
  const meta = new Map();
  for (const a of list) {
    if (typeof a.id === 'number') {
      meta.set(a.id, { name: a.settings && a.settings.name, status: campaignStatus(a.status) });
    }
  }
  const ids = Array.from(meta.keys());
  if (ids.length === 0) return { период: `${from} — ${to}`, кампаний: 0, кампании: [] };

  const stats = [];
  let limited = false;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const part = await wb('advert', `/adv/v3/fullstats?ids=${chunk.join(',')}&beginDate=${from}&endDate=${to}`, {
        timeoutMs: 60_000,
      });
      if (Array.isArray(part)) stats.push(...part);
    } catch (e) {
      // Упёрлись в лимит — отдаём, что успели, и честно об этом говорим.
      if (e instanceof WbError && e.status === 429) {
        limited = true;
        break;
      }
      throw e;
    }
  }

  const rows = stats.map((s) => {
    const spend = Math.round(Number(s.sum) || 0);
    const revenue = Math.round(Number(s.sum_price) || 0);
    const m = meta.get(s.advertId) || {};
    return {
      id: s.advertId,
      название: m.name,
      статус: m.status,
      расход: spend,
      заказов: s.orders || 0,
      выручка: revenue,
      дрр: revenue > 0 ? Math.round((spend / revenue) * 1000) / 10 : null,
      показов: s.views || 0,
      кликов: s.clicks || 0,
      ctr: s.ctr ? Math.round(s.ctr * 100) / 100 : 0,
    };
  });
  rows.sort((a, b) => b.расход - a.расход);

  const spend = rows.reduce((n, r) => n + r.расход, 0);
  const revenue = rows.reduce((n, r) => n + r.выручка, 0);
  const data = {
    период: `${from} — ${to}`,
    кампаний: rows.length,
    итогоРасход: spend,
    итогоВыручка: revenue,
    итогоДРР: revenue > 0 ? Math.round((spend / revenue) * 1000) / 10 : null,
    кампании: rows,
    пояснение:
      'ДРР считается по заказам: расход разделить на выручку по заказам. У кампаний без выручки ДРР пустой — делить не на что.',
    предупреждение: limited
      ? 'Часть кампаний не поместилась в лимит запросов WB. Показано не всё — повторите через минуту.'
      : undefined,
  };
  if (!limited) statsCache.set(key, { at: Date.now(), data });
  return data;
}

// ── Отзывы и вопросы ──────────────────────────────────────────────────────
async function reviews(answered, take) {
  const r = await wb(
    'feedbacks',
    `/api/v1/feedbacks?isAnswered=${answered}&take=${Math.min(Math.max(take, 1), 100)}&skip=0&order=dateDesc`,
  );
  const d = (r && r.data) || {};
  const list = d.feedbacks || [];
  return {
    безОтвета: d.countUnanswered,
    показано: list.length,
    отзывы: list.map((f) => ({
      id: f.id,
      звёзд: f.productValuation,
      дата: String(f.createdDate || '').slice(0, 10),
      товар: f.productDetails && f.productDetails.productName,
      nmID: f.productDetails && f.productDetails.nmId,
      текст: f.text,
      плюсы: f.pros,
      минусы: f.cons,
    })),
  };
}

async function questions(answered, take) {
  const r = await wb(
    'feedbacks',
    `/api/v1/questions?isAnswered=${answered}&take=${Math.min(Math.max(take, 1), 100)}&skip=0&order=dateDesc`,
  );
  const d = (r && r.data) || {};
  const list = d.questions || [];
  return {
    безОтвета: d.countUnanswered,
    показано: list.length,
    вопросы: list.map((q) => ({
      id: q.id,
      дата: String(q.createdDate || '').slice(0, 10),
      товар: q.productDetails && q.productDetails.productName,
      nmID: q.productDetails && q.productDetails.nmId,
      вопрос: q.text,
    })),
  };
}

// ── Воронка карточек ──────────────────────────────────────────────────────
// Третья версия метода ждёт голую дату (со временем — ошибка 400), а поле
// называется nmIds со строчной s. Ответ лежит в data.products.
async function funnel(from, to, nmIds) {
  const r = await wb('analytics', '/api/analytics/v3/sales-funnel/products', {
    method: 'POST',
    timeoutMs: 60_000,
    body: { nmIds, timezone: 'Europe/Moscow', selectedPeriod: { start: from, end: to } },
  });
  const items = (r && r.data && r.data.products) || [];
  return {
    период: `${from} — ${to}`,
    карточек: items.length,
    воронка: items.slice(0, 40).map((c) => {
      const p = c.product || {};
      const st = (c.statistic && c.statistic.selected) || {};
      return {
        nmID: p.nmId,
        артикул: p.vendorCode,
        название: p.title,
        рейтинг: p.feedbackRating,
        переходов: st.openCount,
        вКорзину: st.cartCount,
        заказов: st.orderCount,
        суммаЗаказов: st.orderSum,
        выкупов: st.buyoutCount,
        суммаВыкупов: st.buyoutSum,
        отмен: st.cancelCount,
        средняяЦена: st.avgPrice,
        заказовВДень: st.avgOrdersCountPerDay,
      };
    }),
  };
}

// ── Изменения в кабинете ──────────────────────────────────────────────────
// Всё ниже меняет магазин. Работает, только если в настройках расширения
// включён пункт «Разрешить изменения». Предохранители захардкожены: модель,
// ошибившаяся в порядке величины, не должна суметь поставить ставку в сто
// тысяч или уронить цену вдвое.
const BID_MAX_RUB = 5000;
const PRICE_MAX_CHANGE_PCT = 50;

function assertWriteAllowed() {
  if (!ALLOW_WRITE) {
    throw new WbError(
      'Изменения выключены — сейчас Claude может только читать данные. Чтобы разрешить менять ставки, паузы и цены: Claude → Настройки (Settings) → Расширения (Extensions) → Wildberries → Настроить (Configure) → включите «Разрешить изменения» и сохраните.',
    );
  }
  const info = decodeToken(TOKEN);
  if (info && info.readOnly) {
    throw new WbError(
      'Токен создан с уровнем доступа «Только чтение», поэтому WB не даст ничего изменить. Создайте новый токен с уровнем «Чтение и запись» и вставьте его в настройках расширения.',
    );
  }
}

async function setBid(campaignId, cpm) {
  if (!Number.isFinite(cpm) || cpm <= 0) throw new WbError('Ставка должна быть положительным числом.');
  if (cpm > BID_MAX_RUB) {
    throw new WbError(
      `Ставка ${cpm} ₽ больше предохранителя в ${BID_MAX_RUB} ₽. Если это осознанно — поменяйте в кабинете WB вручную.`,
    );
  }
  const r = await wb('advert', `/api/advert/v2/adverts?ids=${campaignId}`);
  const a = ((r && r.adverts) || [])[0];
  if (!a) throw new WbError(`Кампания ${campaignId} не найдена. Возможно, это артикул, а не номер кампании.`);
  const nmIds = (a.nm_settings || []).map((n) => n.nm_id).filter((n) => typeof n === 'number');
  if (nmIds.length === 0) throw new WbError(`В кампании ${campaignId} нет карточек — ставку ставить не на что.`);
  const placement = a.bid_type === 'manual' ? 'search' : 'combined';

  await wb('advert', '/api/advert/v1/bids', {
    method: 'POST',
    body: {
      bids: [
        {
          advert_id: campaignId,
          nm_bids: nmIds.slice(0, 50).map((nm_id) => ({ nm_id, bid_kopecks: Math.round(cpm * 100), placement })),
        },
      ],
    },
  });
  return {
    сделано: `Ставка кампании «${(a.settings && a.settings.name) || campaignId}» изменена на ${cpm} ₽`,
    карточек: Math.min(nmIds.length, 50),
    размещение: placement,
    примечание: 'WB применяет ставку в течение 30 секунд.',
  };
}

async function setCampaignState(campaignId, action) {
  await wb('advert', `/adv/v0/${action}?id=${campaignId}`);
  return { сделано: action === 'pause' ? `Кампания ${campaignId} на паузе` : `Кампания ${campaignId} запущена` };
}

async function setPrice(nmId, price, discount) {
  if (!Number.isFinite(price) || price <= 0) throw new WbError('Цена должна быть положительным числом.');
  if (discount !== undefined && (!Number.isFinite(discount) || discount < 0 || discount > 95)) {
    throw new WbError('Скидка должна быть от 0 до 95 процентов.');
  }
  // Сверяемся с текущей ценой: резкое изменение почти всегда ошибка в нуле.
  const cur = await wb('prices', `/api/v2/list/goods/filter?limit=10&filterNmID=${nmId}`);
  const goods = (cur && cur.data && cur.data.listGoods) || [];
  const now = goods[0] && goods[0].sizes && goods[0].sizes[0] && goods[0].sizes[0].price;
  if (typeof now === 'number' && now > 0) {
    const delta = (Math.abs(price - now) / now) * 100;
    if (delta > PRICE_MAX_CHANGE_PCT) {
      throw new WbError(
        `Сейчас цена ${now} ₽, новая ${price} ₽ — это изменение на ${Math.round(delta)}%. Предохранитель не пропускает больше ${PRICE_MAX_CHANGE_PCT}%. Проверьте, не ошиблись ли в нуле.`,
      );
    }
  }
  const item = { nmID: nmId, price: Math.round(price) };
  if (discount !== undefined) item.discount = Math.round(discount);
  await wb('prices', '/api/v2/upload/task', { method: 'POST', body: { data: [item] } });
  return {
    сделано: `Цена артикула ${nmId} отправлена на изменение: ${item.price} ₽${
      discount !== undefined ? `, скидка ${item.discount}%` : ''
    }`,
    былаЦена: now === undefined ? null : now,
    примечание: 'WB применяет цену не мгновенно, обычно в течение нескольких минут.',
  };
}

// ── Инструменты ───────────────────────────────────────────────────────────
const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const PERIOD = {
  from: { type: 'string', description: 'Начало периода, ГГГГ-ММ-ДД. По умолчанию 7 дней назад.' },
  to: { type: 'string', description: 'Конец периода, ГГГГ-ММ-ДД. По умолчанию сегодня.' },
};

const TOOLS = [
  {
    name: 'wb_check',
    title: 'Проверка подключения',
    description:
      'Проверяет, что токен WB работает: принимает ли его WB, какие разделы доступны, до какого числа он действует и разрешены ли изменения. Вызывай первым, если что-то не получается.',
    annotations: READ,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wb_sales',
    title: 'Продажи',
    description: 'Продажи и возвраты за период: количество и сумма к перечислению продавцу.',
    annotations: READ,
    inputSchema: { type: 'object', properties: { ...PERIOD } },
  },
  {
    name: 'wb_stocks',
    title: 'Остатки',
    description: 'Остатки товаров на складах Wildberries на текущий момент.',
    annotations: READ,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wb_products',
    title: 'Товары',
    description: 'Карточки товаров: артикул WB (nmID), артикул продавца, название, предмет, бренд.',
    annotations: READ,
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Сколько карточек вернуть, до 100. По умолчанию 50.' } },
    },
  },
  {
    name: 'wb_ad_balance',
    title: 'Баланс рекламы',
    description: 'Сколько денег на рекламном счёте и на балансе аккаунта.',
    annotations: READ,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wb_campaigns',
    title: 'Рекламные кампании',
    description:
      'Активные и приостановленные рекламные кампании: номер, название, статус, сколько артикулов. Без расходов — они в wb_ad_stats.',
    annotations: READ,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wb_ad_stats',
    title: 'Статистика рекламы и ДРР',
    description:
      'Главный отчёт по рекламе: по каждой кампании расход, заказы, выручка, ДРР, показы, клики, CTR и итоги по кабинету. WB разрешает примерно один такой запрос в минуту, поэтому ответ кэшируется на полторы минуты.',
    annotations: READ,
    inputSchema: { type: 'object', properties: { ...PERIOD } },
  },
  {
    name: 'wb_reviews',
    title: 'Отзывы',
    description: 'Отзывы покупателей: оценка, текст, плюсы и минусы, товар. По умолчанию — те, на которые ещё нет ответа.',
    annotations: READ,
    inputSchema: {
      type: 'object',
      properties: {
        answered: { type: 'boolean', description: 'true — уже отвеченные. По умолчанию false.' },
        take: { type: 'number', description: 'Сколько отзывов, до 100. По умолчанию 30.' },
      },
    },
  },
  {
    name: 'wb_questions',
    title: 'Вопросы покупателей',
    description: 'Вопросы покупателей по товарам. По умолчанию — те, на которые ещё нет ответа.',
    annotations: READ,
    inputSchema: {
      type: 'object',
      properties: {
        answered: { type: 'boolean', description: 'true — уже отвеченные. По умолчанию false.' },
        take: { type: 'number', description: 'Сколько вопросов, до 100. По умолчанию 30.' },
      },
    },
  },
  {
    name: 'wb_funnel',
    title: 'Воронка карточек',
    description:
      'Воронка продаж по карточкам за период: переходы, корзины, заказы, выкупы, отмены, средняя цена. Можно ограничить списком артикулов.',
    annotations: READ,
    inputSchema: {
      type: 'object',
      properties: {
        ...PERIOD,
        nmIds: { type: 'array', items: { type: 'number' }, description: 'Артикулы WB. Пусто — все карточки.' },
      },
    },
  },
  {
    name: 'wb_set_bid',
    title: 'Изменить ставку',
    description:
      'МЕНЯЕТ СТАВКУ рекламной кампании (в рублях за 1000 показов). Работает, только если в настройках расширения разрешены изменения. Предохранитель: не выше 5000 ₽. Вызывай, только если человек явно попросил изменить ставку.',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        campaignId: { type: 'number', description: 'Номер рекламной кампании (из wb_campaigns)' },
        cpm: { type: 'number', description: 'Новая ставка в рублях за 1000 показов' },
      },
      required: ['campaignId', 'cpm'],
    },
  },
  {
    name: 'wb_campaign_state',
    title: 'Пауза или запуск кампании',
    description:
      'СТАВИТ НА ПАУЗУ или ЗАПУСКАЕТ рекламную кампанию. Работает, только если в настройках расширения разрешены изменения. Вызывай, только если человек явно попросил.',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        campaignId: { type: 'number', description: 'Номер рекламной кампании (из wb_campaigns)' },
        action: { type: 'string', enum: ['pause', 'start'], description: 'pause — пауза, start — запуск' },
      },
      required: ['campaignId', 'action'],
    },
  },
  {
    name: 'wb_set_price',
    title: 'Изменить цену',
    description:
      'МЕНЯЕТ ЦЕНУ товара. Работает, только если в настройках расширения разрешены изменения. Предохранитель: изменение больше чем на 50% от текущей цены не пройдёт. Вызывай, только если человек явно попросил.',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        nmId: { type: 'number', description: 'Артикул WB (nmID)' },
        price: { type: 'number', description: 'Новая цена до скидки, в рублях' },
        discount: { type: 'number', description: 'Скидка в процентах. Необязательно.' },
      },
      required: ['nmId', 'price'],
    },
  },
];

const WRITE_TOOLS = new Set(['wb_set_bid', 'wb_campaign_state', 'wb_set_price']);

const INSTRUCTIONS = [
  'Это доступ к кабинету продавца Wildberries.',
  'Если задача касается данных WB — продажи, остатки, товары, реклама, ставки, ДРР, отзывы, вопросы, воронка, цены — используй эти инструменты.',
  'НЕ проси у человека токен WB и не предлагай вписать его в файлы или переменные: токен уже сохранён в настройках расширения на этом компьютере.',
  'Если инструмент вернул ошибку — перескажи её человеку своими словами; для диагностики вызови wb_check.',
  'Инструменты wb_set_bid, wb_campaign_state и wb_set_price действительно меняют магазин. Перед вызовом убедись, что человек прямо об этом попросил, и назови, что именно изменишь.',
].join(' ');

async function runTool(name, args) {
  const a = args && typeof args === 'object' ? args : {};

  if (WRITE_TOOLS.has(name)) assertWriteAllowed();

  switch (name) {
    case 'wb_check':
      return checkConnection();
    case 'wb_sales': {
      const to = dateArg(a.to, mskDay(0), 'Конец периода');
      return sales(dateArg(a.from, mskDay(7), 'Начало периода'), to);
    }
    case 'wb_stocks':
      return stocks();
    case 'wb_products':
      return products(Number(a.limit) || 50);
    case 'wb_ad_balance':
      return adBalance();
    case 'wb_campaigns':
      return campaigns();
    case 'wb_ad_stats': {
      const to = dateArg(a.to, mskDay(0), 'Конец периода');
      return adStats(dateArg(a.from, mskDay(7), 'Начало периода'), to);
    }
    case 'wb_reviews':
      return reviews(a.answered === true || a.answered === 'true', Number(a.take) || 30);
    case 'wb_questions':
      return questions(a.answered === true || a.answered === 'true', Number(a.take) || 30);
    case 'wb_funnel': {
      const to = dateArg(a.to, mskDay(0), 'Конец периода');
      const nm = Array.isArray(a.nmIds) ? a.nmIds.map(Number).filter(Number.isFinite) : [];
      return funnel(dateArg(a.from, mskDay(7), 'Начало периода'), to, nm);
    }
    case 'wb_set_bid':
      return audited(name, a, () => setBid(Number(a.campaignId), Number(a.cpm)));
    case 'wb_campaign_state':
      return audited(name, a, () => setCampaignState(Number(a.campaignId), a.action === 'start' ? 'start' : 'pause'));
    case 'wb_set_price':
      return audited(name, a, () =>
        setPrice(Number(a.nmId), Number(a.price), a.discount === undefined ? undefined : Number(a.discount)),
      );
    default:
      throw new WbError(`Неизвестный инструмент: ${name}`);
  }
}

// Каждое изменение пишем в лог расширения: по нему видно, кто и когда
// двигал ставку или цену.
async function audited(name, args, fn) {
  try {
    const result = await fn();
    log(`[изменение] ${name} ${JSON.stringify(args)} → ${result.сделано}`);
    return result;
  } catch (e) {
    log(`[изменение не прошло] ${name} ${JSON.stringify(args)} → ${e.message}`);
    throw e;
  }
}

// ── Протокол MCP ──────────────────────────────────────────────────────────
async function dispatch(method, params) {
  switch (method) {
    case 'initialize': {
      const asked = params && params.protocolVersion;
      return {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'wildberries-mcp', title: 'Wildberries', version: VERSION },
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'resources/list':
      return { resources: [] };
    case 'prompts/list':
      return { prompts: [] };
    case 'tools/call': {
      const name = String((params && params.name) || '');
      try {
        const data = await runTool(name, params && params.arguments);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (e) {
        // Ошибку инструмента отдаём результатом с пометкой, а не ошибкой
        // протокола: иначе Claude не покажет причину человеку.
        if (!(e instanceof WbError)) log(`ошибка в ${name}:`, (e && e.stack) || e);
        const text = e instanceof WbError ? e.message : 'Не удалось выполнить запрос. Попробуйте ещё раз.';
        return { content: [{ type: 'text', text }], isError: true };
      }
    }
    default:
      throw new RpcError(-32601, `Метод не поддерживается: ${method}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return;
  // Уведомление (без id) ответа не требует.
  if (!Object.prototype.hasOwnProperty.call(msg, 'id')) return;
  try {
    const result = await dispatch(msg.method, msg.params || {});
    send({ jsonrpc: '2.0', id: msg.id, result });
  } catch (e) {
    if (e instanceof RpcError) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code, message: e.message } });
    } else {
      log('внутренняя ошибка:', (e && e.stack) || e);
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Внутренняя ошибка сервера' } });
    }
  }
}

function onLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Не удалось разобрать сообщение' } });
    return;
  }
  for (const msg of Array.isArray(parsed) ? parsed : [parsed]) handle(msg);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) onLine(line);
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('unhandledRejection', (e) => log('необработанная ошибка:', (e && e.stack) || e));

log(
  `запущен v${VERSION}; токен ${TOKEN ? 'указан' : 'НЕ указан'}; изменения ${ALLOW_WRITE ? 'разрешены' : 'выключены'}`,
);
