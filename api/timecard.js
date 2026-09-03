// Lotus タイムカード API
// 環境変数 NOTION_TOKEN に Notionコネクトのシークレット（ntn_...）を設定してください。

const NOTION_VERSION = '2025-09-03';
const TZ = 'Asia/Tokyo';

// 「Lotus シフト管理・計上入力」
const DATA_SOURCE_ID = '391f21c0-bd91-8099-93ac-000bd1ace536';
// 「デジタル注文履歴」
const ORDERS_DATA_SOURCE_ID = '1a51ee95-e778-4ed2-9bdc-adb0db5aa59e';

// 営業日の切り替え時刻。6 なら朝6時までの打刻は前日の営業日になる。
const BUSINESS_DAY_OFFSET_HOURS = 6;

const STAFF = ['れん', 'ひろと', 'よしき', 'まさ', 'あやか', 'いちご', 'はると', 'きらと', 'こうだい'];
const STORES = ['藤井寺店', '恵我之荘店'];

// シフト管理DBの列名
const P = {
  title: '稼働/欠勤',
  store: '店舗',
  staff: 'スタッフ',
  date: '日付',
  in: '出勤時刻',
  out: '退勤時刻',
  hours: '稼働時間(1h→1)',
  normal: '通常売上',
  after: '開店時間以降売上',
  champagne: 'シャンパン金額',
  discount: 'スタッフ割引額',
  medal: 'メダル枚数',
  startCash: 'スタート/レジ金',
};

// デジタル注文履歴の列名
const O = {
  store: '店舗',
  date: '日付',
  status: '状態',
  people: '人数',
  newRepeat: '新規/リピート',
  normal: '通常売上',
  after: '開店時間以降売上',
  champagne: 'シャンパン金額',
  discount: 'スタッフ割引額',
  medal: 'メダル枚数',
};

/* ---------------- 日時 ---------------- */

// 'sv-SE' ロケールは "YYYY-MM-DD HH:mm:ss" を返すので加工しやすい
function jstStamp(ms) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(ms));
}

function businessDateFor(ms) {
  return jstStamp(ms - BUSINESS_DAY_OFFSET_HOURS * 3600 * 1000).slice(0, 10);
}
function businessDate()     { return businessDateFor(Date.now()); }
function prevBusinessDate() { return businessDateFor(Date.now() - 24 * 3600 * 1000); }

// 日本には夏時間がないため +09:00 固定で問題ない
function nowIso() {
  return jstStamp(Date.now()).replace(' ', 'T') + '+09:00';
}
function hhmm() {
  return jstStamp(Date.now()).slice(11, 16);
}
function fmtTime(iso) {
  return jstStamp(new Date(iso).getTime()).slice(11, 16);
}
function hoursBetween(startIso, endIso) {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return Math.round((ms / 3600000) * 100) / 100;
}

/* ---------------- Notion ---------------- */

async function notion(path, method, payload) {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error('サーバーに NOTION_TOKEN が設定されていません');

  const res = await fetch('https://api.notion.com/v1' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Notionエラー: ' + (body.message || res.status));
  return body;
}

async function queryRows(store, staff, day) {
  const and = [{ property: P.date, date: { equals: day } }];
  if (store) and.push({ property: P.store, select: { equals: store } });
  if (staff) and.push({ property: P.staff, select: { equals: staff } });

  const body = await notion("/data_sources/" + DATA_SOURCE_ID + "/query", 'POST', {
    filter: { and },
    page_size: 100,
  });
  return body.results || [];
}

async function createPage(store, staff, day, inIso) {
  return notion('/pages', 'POST', {
    parent: { type: 'data_source_id', data_source_id: DATA_SOURCE_ID },
    properties: {
      [P.title]: { title: [{ text: { content: '通常' } }] },
      [P.store]: { select: { name: store } },
      [P.staff]: { select: { name: staff } },
      [P.date]:  { date: { start: day } },
      [P.in]:    { date: { start: inIso } },
    },
  });
}

function updatePage(pageId, properties) {
  return notion('/pages/' + pageId, 'PATCH', { properties });
}

function numOf(props, key) {
  const p = props[key];
  return p && typeof p.number === 'number' ? p.number : null;
}

function toRecord(page) {
  const p = page.properties || {};
  const inIso = p[P.in]?.date?.start ?? null;
  const outIso = p[P.out]?.date?.start ?? null;
  return {
    id: page.id,
    staff: p[P.staff]?.select?.name ?? '',
    store: p[P.store]?.select?.name ?? '',
    inIso,
    outIso,
    in: inIso ? fmtTime(inIso) : null,
    out: outIso ? fmtTime(outIso) : null,
    hours: numOf(p, P.hours),
    normal: numOf(p, P.normal),
    startCash: numOf(p, P.startCash),
  };
}

/* ---------------- 注文履歴の集計 ---------------- */

async function queryOrders(store, day) {
  const results = [];
  let cursor = null;

  do {
    const payload = {
      filter: {
        and: [
          { property: O.date,   date:   { equals: day } },
          { property: O.store,  select: { equals: store } },
          { property: O.status, select: { equals: '会計済み' } },
        ],
      },
      page_size: 100,
    };
    if (cursor) payload.start_cursor = cursor;

    const body = await notion("/data_sources/" + ORDERS_DATA_SOURCE_ID + "/query", 'POST', payload);
    results.push(...(body.results || []));
    cursor = body.has_more ? body.next_cursor : null;
  } while (cursor);

  return results;
}

function summarize(orders) {
  const s = {
    組数: orders.length, 人数: 0, 新規: 0,
    通常売上: 0, 開店時間以降売上: 0, シャンパン金額: 0, スタッフ割引額: 0, メダル枚数: 0,
  };

  for (const o of orders) {
    const p = o.properties || {};
    s.人数 += numOf(p, O.people) || 0;
    if (p[O.newRepeat]?.select?.name === '新規') s.新規 += 1;
    s.通常売上         += numOf(p, O.normal)    || 0;
    s.開店時間以降売上 += numOf(p, O.after)     || 0;
    s.シャンパン金額   += numOf(p, O.champagne) || 0;
    s.スタッフ割引額   += numOf(p, O.discount)  || 0;
    s.メダル枚数       += numOf(p, O.medal)     || 0;
  }

  return s;
}

/* ---------------- 日締め ---------------- */

async function collectDay(store, day) {
  const [pages, orders] = await Promise.all([queryRows(store, null, day), queryOrders(store, day)]);
  const records = pages.map(toRecord);

  const sorted = records.filter(r => r.inIso).sort((a, b) => (a.inIso < b.inIso ? -1 : 1));
  const repRow = sorted[0] || records[0] || null;
  const closedRow = records.find(r => r.normal !== null) || null;
  const cashRow = records.find(r => r.startCash !== null) || null;
  const rep = closedRow || repRow;

  return {
    records,
    summary: summarize(orders),
    repRow,
    closedRow,
    repDefault: rep ? rep.staff : null,
    closedBy: closedRow ? closedRow.staff : null,
    startCash: cashRow ? cashRow.startCash : null,
  };
}

function clearedSalesProps() {
  const props = {};
  for (const k of [P.normal, P.after, P.champagne, P.discount, P.medal]) {
    props[k] = { number: null };
  }
  return props;
}

async function closeDay(store, day, repStaff, startCash, force) {
  const info = await collectDay(store, day);

  if (!info.records.length) throw new Error(day + " の出勤記録がありません");
  if (info.closedRow && !force) {
    throw new Error(day + " はすでに日締め済みです（" + info.closedRow.staff + " の行）");
  }

  const wanted = repStaff || info.repDefault;
  const target = info.records.find(r => r.staff === wanted);
  if (!target) throw new Error(wanted + " さんは " + day + " に出勤していません");

  // 代表行を変える場合は、前の行の売上をクリアする
  if (info.closedRow && info.closedRow.id !== target.id) {
    await updatePage(info.closedRow.id, clearedSalesProps());
  }

  const s = info.summary;
  const props = {
    [P.normal]:    { number: s.通常売上 },
    [P.after]:     { number: s.開店時間以降売上 },
    [P.champagne]: { number: s.シャンパン金額 },
    [P.discount]:  { number: s.スタッフ割引額 },
    [P.medal]:     { number: s.メダル枚数 },
  };

  const cash = startCash === null || startCash === undefined || startCash === ''
    ? info.startCash
    : Number(startCash);
  if (cash !== null && Number.isFinite(cash)) props[P.startCash] = { number: cash };

  await updatePage(target.id, props);

  return {
    message: day + " 日締め完了（" + target.staff + " の行に反映）",
    businessDate: day,
    staff: target.staff,
    summary: s,
  };
}

/* ---------------- 各アクション ---------------- */

async function actStatus(store) {
  const day = businessDate();
  const rows = await queryRows(store, null, day);
  return { businessDate: day, records: rows.map(toRecord) };
}

async function actPunchIn(staff, store) {
  const day = businessDate();
  const existing = (await queryRows(store, staff, day))[0];

  if (existing) {
    const rec = toRecord(existing);
    if (rec.in && !rec.out) throw new Error(staff + " さんは既に出勤中です（" + rec.in + "〜）");
    if (rec.in && rec.out)  throw new Error(staff + " さんは本日すでに退勤済みです");
    await updatePage(existing.id, { [P.in]: { date: { start: nowIso() } } });
  } else {
    await createPage(store, staff, day, nowIso());
  }
  return { message: staff + " さん 出勤", time: hhmm() };
}

async function actPunchOut(staff, store) {
  const day = businessDate();
  const existing = (await queryRows(store, staff, day))[0];
  if (!existing) throw new Error(staff + " さんの本日の出勤記録がありません");

  const rec = toRecord(existing);
  if (!rec.inIso) throw new Error(staff + " さんはまだ出勤打刻をしていません");
  if (rec.outIso) throw new Error(staff + " さんは既に退勤済みです（" + rec.out + "）");

  const outIso = nowIso();
  const worked = hoursBetween(rec.inIso, outIso);

  await updatePage(existing.id, {
    [P.out]:   { date: { start: outIso } },
    [P.hours]: { number: worked },
  });

  return { message: staff + " さん 退勤（稼働 " + worked + "h）", time: hhmm(), hours: worked };
}

async function actCloseInfo(store) {
  const day = businessDate();
  const info = await collectDay(store, day);
  return {
    businessDate: day,
    store,
    summary: info.summary,
    staff: info.records.map(r => ({ staff: r.staff, in: r.in, out: r.out, hours: r.hours })),
    repDefault: info.repDefault,
    closedBy: info.closedBy,
    startCash: info.startCash,
  };
}

async function actSetStartCash(store, amount) {
  const info = await collectDay(store, businessDate());
  const target = info.closedRow || info.repRow;
  if (!target) throw new Error('この営業日の出勤記録がありません。先に出勤打刻をしてください');

  const n = Number(amount);
  if (!Number.isFinite(n)) throw new Error('金額が正しくありません');

  await updatePage(target.id, { [P.startCash]: { number: n } });
  return { message: "レジ金 ¥" + n.toLocaleString('ja-JP') + " を記録（" + target.staff + " の行）" };
}

// 押し忘れ対策。Vercel Cron から GET で叩かれる。
async function actAutoClose() {
  const day = prevBusinessDate();
  const log = [];
  for (const store of STORES) {
    try {
      const res = await closeDay(store, day, null, null, false);
      log.push(res.message);
    } catch (err) {
      log.push("[" + store + "] スキップ: " + err.message);
    }
  }
  return { businessDate: day, log };
}

/* ---------------- ハンドラ ---------------- */

export default async function handler(req, res) {
  // Vercel Cron からの定期実行（毎朝の自動日締め）
  if (req.method === 'GET') {
    if (req.query?.action === 'autoClose') {
      try {
        return res.status(200).json({ ok: true, ...(await actAutoClose()) });
      } catch (err) {
        return res.status(200).json({ ok: false, error: err.message });
      }
    }
    return res.status(200).json({ ok: true, staff: STAFF, stores: STORES, businessDate: businessDate() });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST してください' });
  }

  const { action, store, staff, repStaff, startCash, force, amount } = req.body || {};

  try {
    if (action !== 'status' && !STORES.includes(store)) {
      throw new Error('店舗が正しくありません');
    }

    let data;
    switch (action) {
      case 'status':       data = await actStatus(store); break;
      case 'in':           data = await actPunchIn(staff, store); break;
      case 'out':          data = await actPunchOut(staff, store); break;
      case 'closeInfo':    data = await actCloseInfo(store); break;
      case 'close':        data = await closeDay(store, businessDate(), repStaff, startCash, force); break;
      case 'setStartCash': data = await actSetStartCash(store, amount); break;
      default: throw new Error('不明な操作: ' + action);
    }
    return res.status(200).json({ ok: true, ...data });
  } catch (err) {
    // 画面側でメッセージを出すため、HTTPは200のまま ok:false で返す
    return res.status(200).json({ ok: false, error: err.message });
  }
}

