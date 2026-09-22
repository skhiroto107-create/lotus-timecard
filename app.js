(function () {
  const STAFF = ['れん', 'ひろと', 'よしき', 'まさ', 'あやか', 'いちご', 'はると', 'きらと', 'こうだい'];
  const STORES = ['藤井寺店', '恵我之荘店'];

  const storeScreen = document.getElementById('store-screen');
  const mainScreen  = document.getElementById('main-screen');
  const wallEl      = document.getElementById('wallday');
  const clockEl     = document.getElementById('clock');
  const todayEl     = document.getElementById('today');
  const storeBadge  = document.getElementById('storeBadge');
  const storeName   = document.getElementById('storeName');
  const manualBtn   = document.getElementById('manualBtn');
  const todoBtn     = document.getElementById('todoBtn');
  const calBtn      = document.getElementById('calBtn');
  const cashBtn     = document.getElementById('cashBtn');
  const closeBtn    = document.getElementById('closeBtn');
  const bannerEl    = document.getElementById('banner');
  const gridEl      = document.getElementById('grid');
  const mask        = document.getElementById('mask');
  const sheet       = document.getElementById('sheet');
  const toastEl     = document.getElementById('toast');

  let store = localStorage.getItem('lotus_tc_store');
  if (!STORES.includes(store)) store = null;

  let records = {};
  let busy = false;
  let currentDay = '';

  /* ---------- タップ音（デジタル伝票アプリと同一の合成音） ----------
     音声ファイルは使わず Web Audio API でその場生成する。
     約30msの減衰ノイズを 1800Hz バンドパスに通した「カチッ」というクリック音。
     iOS Safari はユーザー操作の中でしか鳴らせないため、
     AudioContext は最初のタップ時に作って以後使い回す。 */
  let audioCtx = null;
  function playTapSound() {
    try {
      if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioCtx = new Ctx();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const now = audioCtx.currentTime;

      const duration = 0.03;
      const bufferSize = Math.max(1, Math.floor(audioCtx.sampleRate * duration));
      const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        const envelope = Math.pow(1 - i / bufferSize, 2);
        data[i] = (Math.random() * 2 - 1) * envelope;
      }
      const noise = audioCtx.createBufferSource();
      noise.buffer = buffer;

      const filter = audioCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1800;
      filter.Q.value = 1.1;

      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0.7, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      noise.connect(filter);
      filter.connect(gain);
      gain.connect(audioCtx.destination);
      noise.start(now);
      noise.stop(now + duration + 0.01);
    } catch (e) {
      console.error(e);
    }
  }

  // iOS Safari は要素にタッチハンドラが無いと :active が効かないため空ハンドラを登録
  document.body.addEventListener('touchstart', function () {}, { passive: true });

  // 個別に配線する代わりに、画面全体の1つのリスナーで全ボタンをカバーする
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn && !btn.disabled) playTapSound();
  }, true);

  /* ---------- 時計 ---------- */
  const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'];

  // 'YYYY-MM-DD' から曜日を求める。ローカル時刻で組み立てるのでタイムゾーンでずれない。
  function weekdayOf(dateStr) {
    const p = String(dateStr || '').split('-').map(Number);
    if (p.length !== 3 || p.some((n) => !Number.isFinite(n))) return '';
    return WEEKDAY[new Date(p[0], p[1] - 1, p[2]).getDay()];
  }

  // 画面に出す営業日の表記（例: 2026-09-04(金)）
  function dayLabel(dateStr) {
    const w = weekdayOf(dateStr);
    return dateStr + (w ? '(' + w + ')' : '');
  }

  function tick() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    wallEl.textContent =
      d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + '(' + WEEKDAY[d.getDay()] + ')';
    clockEl.textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  setInterval(tick, 1000);
  tick();

  /* ---------- サーバー呼び出し ---------- */
  async function call(action, extra) {
    const res = await fetch('/api/timecard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action, store }, extra || {})),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '不明なエラー');
    return data;
  }

  function yen(n) { return '¥' + Number(n || 0).toLocaleString('ja-JP'); }

  function toast(msg, bad) {
    toastEl.textContent = msg;
    toastEl.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toastEl._h);
    toastEl._h = setTimeout(() => { toastEl.className = ''; }, 4200);
  }

  function closeSheet() { mask.classList.remove('show'); }
  mask.addEventListener('click', (e) => { if (e.target === mask) closeSheet(); });

  /* ---------- 店舗選択 ---------- */
  function applyStore(s) {
    store = s;
    localStorage.setItem('lotus_tc_store', s);
    storeName.textContent = s;
    storeBadge.classList.toggle('alt', s === '恵我之荘店');
    storeScreen.classList.add('hidden');
    mainScreen.classList.remove('hidden');
    gridEl.innerHTML = '<div class="loading">読み込み中…</div>';
    refresh();
  }

  document.querySelectorAll('.store-choice').forEach((b) => {
    b.addEventListener('click', () => applyStore(b.dataset.store));
  });

  storeBadge.addEventListener('click', () => {
    mainScreen.classList.add('hidden');
    storeScreen.classList.remove('hidden');
  });

  /* ---------- 打刻 ---------- */
  function renderGrid() {
    gridEl.innerHTML = '';
    STAFF.forEach((name) => {
      const r = records[name];
      const working = r && r.in && !r.out;
      const done    = r && r.in && r.out;

      const c = document.createElement('button');
      c.className = 'card' + (working ? ' working' : done ? ' done' : '');
      c.innerHTML = '<div class="nm"></div><div class="st"><span class="dot"></span><span class="lbl"></span></div>';
      c.querySelector('.nm').textContent = name;
      c.querySelector('.lbl').textContent =
        working ? r.in + ' 〜 勤務中'
        : done  ? r.in + ' 〜 ' + r.out + (r.hours != null ? '（' + r.hours + 'h）' : '')
        : '未出勤';
      c.addEventListener('click', () => openPunchSheet(name));
      gridEl.appendChild(c);
    });
  }

  function openPunchSheet(name) {
    const r = records[name] || {};
    const working = r.in && !r.out;
    const done    = r.in && r.out;

    sheet.innerHTML =
      '<h2></h2><div class="sub"></div>' +
      (done
        ? '<button class="big ghost" id="close">閉じる</button>'
        : '<button class="big ' + (working ? 'out' : 'in') + '" id="act"></button>' +
          '<button class="big ghost" id="close">キャンセル</button>');

    sheet.querySelector('h2').textContent = name;
    // 店舗の取り違えを防ぐため、どの操作でも必ず店舗名を確認画面に出す
    sheet.querySelector('.sub').textContent =
      store + '　営業日 ' + dayLabel(currentDay) + '\n' + (
        done      ? '退勤済みです（' + r.in + ' 〜 ' + r.out + '）　修正はNotionから'
        : working ? r.in + ' に出勤中です。退勤を記録します'
        : '出勤を記録します');

    const act = sheet.querySelector('#act');
    if (act) {
      act.textContent = working ? '退勤する' : '出勤する';
      act.addEventListener('click', () => punch(name, working ? 'out' : 'in'));
    }
    sheet.querySelector('#close').addEventListener('click', closeSheet);
    mask.classList.add('show');
  }

  async function punch(name, action) {
    if (busy) return;
    busy = true;
    const act = sheet.querySelector('#act');
    if (act) { act.disabled = true; act.textContent = '送信中…'; }
    try {
      const res = await call(action, { staff: name });
      closeSheet();
      toast(res.message + '　' + res.time);
      await refresh();
    } catch (err) {
      closeSheet();
      toast(err.message, true);
    } finally { busy = false; }
  }

  async function refresh() {
    if (!store) return;
    bannerEl.innerHTML = '';
    try {
      const res = await call('status');
      records = {};
      (res.records || []).forEach((r) => { records[r.staff] = r; });
      currentDay = res.businessDate;
      todayEl.textContent = '営業日 ' + dayLabel(currentDay);
    } catch (err) {
      todayEl.textContent = '接続エラー';
      bannerEl.innerHTML = '<div class="banner">⚠ ' + err.message + '</div>';
      records = {};
    }
    renderGrid();
    updateTodoBadge();
  }

  /* ---------- 日締め ---------- */
  function sheetError(title, msg) {
    sheet.innerHTML = '<h2>' + title + '</h2><div class="sub"></div>' +
      '<button class="big ghost" id="close">閉じる</button>';
    sheet.querySelector('.sub').textContent = msg;
    sheet.querySelector('#close').addEventListener('click', closeSheet);
  }

  async function openClose() {
    sheet.innerHTML = '<h2>日締め</h2><div class="sub">集計しています…</div>';
    mask.classList.add('show');

    let info;
    try {
      info = await call('closeInfo');
    } catch (err) {
      sheetError('日締め', err.message);
      return;
    }

    const s = info.summary;
    const opts = info.staff.map((x) =>
      '<option value="' + x.staff + '"' + (x.staff === info.repDefault ? ' selected' : '') + '>' +
      x.staff + (x.hours != null ? '（' + x.hours + 'h）' : '') + '</option>').join('');

    sheet.innerHTML =
      '<h2>日締め</h2>' +
      '<div class="sub">' + store + '　営業日 ' + dayLabel(info.businessDate) + '</div>' +
      (info.closedBy ? '<div class="warn">すでに ' + info.closedBy + ' さんの行に反映済みです。実行すると上書きします。</div>' : '') +
      (info.staff.length ? '' : '<div class="warn">この営業日の出勤記録がありません。先に出勤打刻をしてください。</div>') +
      '<table class="sum">' +
        '<tr><td>組数 / 人数</td><td>' + s.組数 + '組 / ' + s.人数 + '名（新規' + s.新規 + '）</td></tr>' +
        '<tr><td>通常売上</td><td>' + yen(s.通常売上) + '</td></tr>' +
        '<tr><td>開店時間以降売上</td><td>' + yen(s.開店時間以降売上) + '</td></tr>' +
        '<tr><td>シャンパン金額</td><td>' + yen(s.シャンパン金額) + '</td></tr>' +
        '<tr><td>スタッフ割引額</td><td>' + yen(s.スタッフ割引額) + '</td></tr>' +
        '<tr><td>メダル枚数</td><td>' + s.メダル枚数 + '枚</td></tr>' +
      '</table>' +
      (info.staff.length
        ? '<div class="field"><label>売上をまとめるスタッフ</label><select id="rep">' + opts + '</select></div>' +
          '<div class="field"><label>スタートレジ金</label>' +
          '<input id="cash" type="number" inputmode="numeric" placeholder="未入力" value="' +
          (info.startCash != null ? info.startCash : '') + '"></div>' +
          '<div class="field"><label>稼働時間（1時間単位）</label><div class="hlist" id="hlist"></div></div>' +
          '<button class="big in" id="act">Notionに反映</button>'
        : '') +
      '<button class="big ghost" id="close">' + (info.staff.length ? 'キャンセル' : '閉じる') + '</button>';

    // スタッフごとの稼働時間入力。空欄のままなら既存の値をそのまま残す。
    const hlist = sheet.querySelector('#hlist');
    if (hlist) {
      info.staff.forEach((x) => {
        const row = document.createElement('div');
        row.className = 'hrow';
        const nm = document.createElement('span');
        nm.textContent = x.staff;
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.inputMode = 'numeric';
        inp.step = '1';
        inp.min = '0';
        inp.dataset.staff = x.staff;
        inp.placeholder = '時間';
        if (x.hours != null) inp.value = x.hours;
        row.appendChild(nm);
        row.appendChild(inp);
        hlist.appendChild(row);
      });
    }

    sheet.querySelector('#close').addEventListener('click', closeSheet);
    const act = sheet.querySelector('#act');
    if (act) act.addEventListener('click', () => runClose(!!info.closedBy));
  }

  async function runClose(force) {
    if (busy) return;
    busy = true;
    const act = sheet.querySelector('#act');
    const rep = sheet.querySelector('#rep').value;
    const cashRaw = sheet.querySelector('#cash').value;
    act.disabled = true;
    act.textContent = '送信中…';
    try {
      const hours = {};
      sheet.querySelectorAll('#hlist input').forEach((i) => {
        if (i.value !== '') hours[i.dataset.staff] = Number(i.value);
      });

      const res = await call('close', {
        repStaff: rep,
        startCash: cashRaw === '' ? null : Number(cashRaw),
        force,
        hours,
      });
      closeSheet();
      toast(res.message);
      await refresh();
    } catch (err) {
      closeSheet();
      toast(err.message, true);
    } finally { busy = false; }
  }

  /* ---------- レジ金 ---------- */
  function openCash() {
    sheet.innerHTML =
      '<h2>スタートレジ金</h2>' +
      '<div class="sub">' + store + '　営業日 ' + dayLabel(currentDay) + '</div>' +
      '<div class="field"><label>スタートレジ金</label>' +
      '<input id="cash" type="number" inputmode="numeric" placeholder="例 25000"></div>' +
      '<button class="big in" id="act">保存</button>' +
      '<button class="big ghost" id="close">キャンセル</button>';

    sheet.querySelector('#close').addEventListener('click', closeSheet);
    sheet.querySelector('#act').addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      const act = sheet.querySelector('#act');
      const v = sheet.querySelector('#cash').value;
      act.disabled = true;
      act.textContent = '送信中…';
      try {
        const res = await call('setStartCash', { amount: Number(v || 0) });
        closeSheet();
        toast(res.message);
        await refresh();
      } catch (err) {
        closeSheet();
        toast(err.message, true);
      } finally { busy = false; }
    });
    mask.classList.add('show');
  }

  /* ---------- ToDoカレンダー ----------
     データはNotionの「タスク」データソース。店舗未設定のタスクは両店に出る。 */
  let calMonth = null;
  let calTasks = [];
  let calSelected = null;

  function monthLabel(m) {
    const p = m.split('-');
    return Number(p[0]) + '年' + Number(p[1]) + '月';
  }

  function shiftMonth(m, delta) {
    const p = m.split('-').map(Number);
    const d = new Date(p[0], p[1] - 1 + delta, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  async function openCalendar(month) {
    calMonth = month || (currentDay ? currentDay.slice(0, 7) : null);
    if (!calMonth) {
      const n = new Date();
      calMonth = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0');
    }
    calSelected = null;

    sheet.classList.add('wide');
    sheet.innerHTML = '<h2>ToDoカレンダー</h2><div class="sub">読み込んでいます…</div>';
    mask.classList.add('show');

    try {
      const res = await call('tasks', { month: calMonth });
      calTasks = res.tasks || [];
    } catch (err) {
      sheetError('ToDoカレンダー', err.message);
      sheet.classList.remove('wide');
      return;
    }
    renderCalendar();
  }

  function renderCalendar() {
    const p = calMonth.split('-').map(Number);
    const firstDay = new Date(p[0], p[1] - 1, 1);
    const daysInMonth = new Date(p[0], p[1], 0).getDate();
    const startPad = firstDay.getDay();
    const today = currentDay || '';

    const byDay = {};
    calTasks.forEach((t) => {
      if (!byDay[t.due]) byDay[t.due] = [];
      byDay[t.due].push(t);
    });

    let cells = '';
    for (let i = 0; i < startPad; i++) cells += '<div class="cday pad"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = calMonth + '-' + String(d).padStart(2, '0');
      const list = byDay[ds] || [];
      const open = list.filter((t) => t.status !== '完了').length;
      const cls = 'cday' + (ds === today ? ' today' : '') + (ds === calSelected ? ' sel' : '');
      cells += '<button class="' + cls + '" data-day="' + ds + '">' +
        '<span class="cnum">' + d + '</span>' +
        (list.length ? '<span class="cdot' + (open ? '' : ' done') + '">' + (open || list.length) + '</span>' : '') +
        '</button>';
    }

    sheet.innerHTML =
      '<h2>ToDoカレンダー</h2>' +
      '<div class="sub">' + store + '</div>' +
      '<div class="cnav">' +
        '<button class="cbtn" id="prev">‹</button>' +
        '<span class="cmonth">' + monthLabel(calMonth) + '</span>' +
        '<button class="cbtn" id="next">›</button>' +
      '</div>' +
      '<div class="cweek"><span>日</span><span>月</span><span>火</span><span>水</span><span>木</span><span>金</span><span>土</span></div>' +
      '<div class="cgrid">' + cells + '</div>' +
      '<div class="clist" id="clist"></div>' +
      '<button class="big ghost" id="close">閉じる</button>';

    sheet.querySelector('#prev').addEventListener('click', () => openCalendar(shiftMonth(calMonth, -1)));
    sheet.querySelector('#next').addEventListener('click', () => openCalendar(shiftMonth(calMonth, 1)));
    sheet.querySelector('#close').addEventListener('click', () => {
      sheet.classList.remove('wide');
      closeSheet();
    });
    sheet.querySelectorAll('.cday[data-day]').forEach((b) => {
      b.addEventListener('click', () => { calSelected = b.dataset.day; renderCalendar(); });
    });

    renderDayList(byDay[calSelected] || null);
  }

  function renderDayList(list) {
    const box = sheet.querySelector('#clist');
    if (!box || !calSelected) return;

    box.innerHTML = '<div class="tsec">' + dayLabel(calSelected) + '</div>';

    (list || []).forEach((t) => {
      const row = document.createElement('button');
      row.className = 'titem' + (t.status === '完了' ? ' on' : '');
      row.innerHTML = '<span class="tbox"></span><span class="ttext"></span>';
      row.querySelector('.ttext').textContent =
        t.title + (t.staff ? '　/　' + t.staff : '') + (t.store ? '' : '　（共通）');
      row.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        const next = t.status === '完了' ? '未着手' : '完了';
        try {
          await call('taskStatus', { pageId: t.id, status: next });
          t.status = next;
          row.classList.toggle('on', next === '完了');
          renderCalendar();
        } catch (err) {
          toast(err.message, true);
        } finally { busy = false; }
      });
      box.appendChild(row);
    });

    if (!list || !list.length) {
      const empty = document.createElement('div');
      empty.className = 'cempty';
      empty.textContent = 'この日のタスクはありません';
      box.appendChild(empty);
    }

    const add = document.createElement('div');
    add.className = 'cadd';
    add.innerHTML =
      '<input id="ctitle" type="text" placeholder="タスクを追加">' +
      '<select id="cstaff"><option value="">担当なし</option>' +
      STAFF.map((n) => '<option value="' + n + '">' + n + '</option>').join('') +
      '</select>' +
      '<button class="cbtn add" id="cadd">追加</button>';
    box.appendChild(add);

    add.querySelector('#cadd').addEventListener('click', async () => {
      if (busy) return;
      const title = add.querySelector('#ctitle').value.trim();
      if (!title) { toast('タスク名を入力してください', true); return; }
      busy = true;
      try {
        const res = await call('taskAdd', {
          title: title,
          staff: add.querySelector('#cstaff').value || null,
          due: calSelected,
        });
        toast(res.message);
        const keep = calSelected;
        await openCalendar(calMonth);
        calSelected = keep;
        renderCalendar();
      } catch (err) {
        toast(err.message, true);
      } finally { busy = false; }
    });
  }

  calBtn.addEventListener('click', () => openCalendar());

  /* ---------- 日次業務 ----------
     内容は「店舗通常営業マニュアル（勤務オペレーション編）」に準拠。
     チェック状態は 店舗 × 営業日 ごとにこの端末へ保存される。 */
  const TODO_SECTIONS = [
    { title: '\u2460 出勤時', items: [
      { id: 'sign',     text: '店舗看板を出す／CLOSEDをOPENに変える' },
      { id: 'light',    text: '店舗ライトを点灯しオープン状態にする' },
      { id: 'power',    text: '各種電源を入れる' },
      { id: 'toilet',   text: 'トイレ確認（便器・床・手洗い場）' },
      { id: 'trash',    text: 'トイレ内ゴミ箱・フロア床の汚れ確認' },
      { id: 'cash',     text: 'レジ金スタートの金額確認／入力' },
      { id: 'water',    text: 'マドラーなどの水換え' },
      { id: 'snsOpen',  text: 'Instagramにオープン告知（担当者名も記載）', store: '恵我之荘店' },
    ]},
    { title: '\u2461 勤務時', items: [
      { id: 'duty',     text: '', duty: true },
      { id: 'sns',      text: 'Instagram更新（1回以上）' },
      { id: 'lo',       text: '開店20分前にラストオーダー（開店時間は臨機応変に）' },
    ]},
    { title: '\u2462 退勤時', items: [
      { id: 'signIn',    text: '店舗看板をしまう／OPENをCLOSEDに変える' },
      { id: 'settle',    text: 'タブレット伝票で日締めをする／勤務時間入力' },
      { id: 'cashCheck', text: '「本日の売り上げ」とスタートレジ金の合計が実際の最終レジ金と合っているかを確認する' },
      { id: 'wash',      text: '洗い物' },
      { id: 'drink',     text: '各種ドリンクの補充' },
      { id: 'clean',     text: 'トイレ内・フロア内の清掃' },
      { id: 'powerOff',  text: '各種電源を切る' },
      { id: 'fan',       text: '換気扇を1か所つけておく', store: '恵我之荘店' },
    ]},
  ];

  // 曜日当番（0=日）。火曜は当番なし。
  const DUTY = {
    0: 'フロア全体の掃除機がけ',
    1: 'トイレ掃除（便器・床・手洗い場）',
    3: 'トイレ掃除（便器・床・手洗い場）',
    4: 'フロア全体の掃除機がけ',
    5: 'トイレ掃除（便器・床・手洗い場）',
    6: '仕入れ確認（必須・報告まで行う）',
  };

  function dutyOf(dateStr) {
    const p = String(dateStr || '').split('-').map(Number);
    if (p.length !== 3 || p.some((n) => !Number.isFinite(n))) return null;
    return DUTY[new Date(p[0], p[1] - 1, p[2]).getDay()] || null;
  }

  function todoItems() {
    const duty = dutyOf(currentDay);
    const out = [];
    TODO_SECTIONS.forEach((sec) => {
      const items = [];
      sec.items.forEach((it) => {
        if (it.store && it.store !== store) return;
        if (it.duty) {
          if (!duty) return;
          items.push({ id: it.id, text: '曜日当番：' + duty });
          return;
        }
        items.push({ id: it.id, text: it.text });
      });
      if (items.length) out.push({ title: sec.title, items: items });
    });
    return out;
  }

  function todoKey() { return 'lotus_tc_todo_' + store + '_' + currentDay; }

  function todoState() {
    try { return JSON.parse(localStorage.getItem(todoKey()) || '{}'); } catch (e) { return {}; }
  }

  function saveTodoState(st) {
    try { localStorage.setItem(todoKey(), JSON.stringify(st)); } catch (e) { /* 保存できなくても操作は続行 */ }
  }

  function updateTodoBadge() {
    if (!store || !currentDay) { todoBtn.textContent = '\u2705 日次業務'; return; }
    const st = todoState();
    let total = 0, done = 0;
    todoItems().forEach((sec) => sec.items.forEach((it) => { total += 1; if (st[it.id]) done += 1; }));
    todoBtn.textContent = '\u2705 日次業務 ' + done + '/' + total;
    todoBtn.classList.toggle('primary', total > 0 && done === total);
  }

  function openTodo() {
    const st = todoState();
    sheet.classList.add('wide');
    sheet.innerHTML =
      '<h2>日次業務</h2>' +
      '<div class="sub">' + store + '　営業日 ' + dayLabel(currentDay) + '</div>' +
      '<div class="tlist" id="tlist"></div>' +
      '<button class="big ghost" id="reset">チェックを全部外す</button>' +
      '<button class="big ghost" id="close">閉じる</button>';

    const list = sheet.querySelector('#tlist');
    todoItems().forEach((sec) => {
      const h = document.createElement('div');
      h.className = 'tsec';
      h.textContent = sec.title;
      list.appendChild(h);

      sec.items.forEach((it) => {
        const row = document.createElement('button');
        row.className = 'titem' + (st[it.id] ? ' on' : '');
        row.innerHTML = '<span class="tbox"></span><span class="ttext"></span>';
        row.querySelector('.ttext').textContent = it.text;
        row.addEventListener('click', () => {
          const cur = todoState();
          if (cur[it.id]) delete cur[it.id]; else cur[it.id] = true;
          saveTodoState(cur);
          row.classList.toggle('on', !!cur[it.id]);
          updateTodoBadge();
        });
        list.appendChild(row);
      });
    });

    sheet.querySelector('#reset').addEventListener('click', () => {
      saveTodoState({});
      updateTodoBadge();
      openTodo();
    });
    sheet.querySelector('#close').addEventListener('click', () => {
      sheet.classList.remove('wide');
      closeSheet();
    });
    mask.classList.add('show');
  }

  /* ---------- マニュアル・ルール ---------- */
  // 一覧はNotionの「マニュアル」から毎回取得するので、
  // 追加・削除・並べ替えはNotion側だけで完結する。
  let manualCache = null;

  async function openManuals() {
    sheet.innerHTML = '<h2>マニュアル・ルール</h2><div class="sub">読み込んでいます…</div>';
    mask.classList.add('show');

    if (!manualCache) {
      try {
        const res = await call('manuals');
        manualCache = res.manuals || [];
      } catch (err) {
        sheetError('マニュアル・ルール', err.message);
        return;
      }
    }

    if (!manualCache.length) {
      sheetError('マニュアル・ルール', 'マニュアル・ルールが登録されていません');
      return;
    }

    sheet.innerHTML =
      '<h2>マニュアル・ルール</h2>' +
      '<div class="sub">タップすると内容を表示します</div>' +
      '<div class="mlist" id="mlist"></div>' +
      '<button class="big ghost" id="close">閉じる</button>';

    const list = sheet.querySelector('#mlist');
    manualCache.forEach((m) => {
      const b = document.createElement('button');
      b.className = 'mitem';
      b.textContent = m.title;
      b.addEventListener('click', () => openManual(m));
      list.appendChild(b);
    });

    sheet.querySelector('#close').addEventListener('click', closeSheet);
  }

  // 本文はNotionへ飛ばずアプリ内に表示する。一度読んだものは覚えておく。
  const manualBody = {};

  async function openManual(m) {
    sheet.classList.add('wide');
    sheet.innerHTML = '<h2 class="mtitle"></h2><div class="sub">読み込んでいます…</div>';
    sheet.querySelector('.mtitle').textContent = m.title;

    if (!manualBody[m.id]) {
      try {
        const res = await call('manual', { pageId: m.id });
        manualBody[m.id] = res.html;
      } catch (err) {
        sheetError('マニュアル・ルール', err.message);
        sheet.classList.remove('wide');
        return;
      }
    }

    sheet.innerHTML =
      '<h2 class="mtitle"></h2>' +
      '<div class="mbody"></div>' +
      '<button class="big ghost" id="back">← 一覧に戻る</button>' +
      '<button class="big ghost" id="close">閉じる</button>';

    sheet.querySelector('.mtitle').textContent = m.title;
    sheet.querySelector('.mbody').innerHTML = manualBody[m.id];
    sheet.scrollTop = 0;

    sheet.querySelector('#back').addEventListener('click', () => {
      sheet.classList.remove('wide');
      openManuals();
    });
    sheet.querySelector('#close').addEventListener('click', () => {
      sheet.classList.remove('wide');
      closeSheet();
    });
  }

  todoBtn.addEventListener('click', openTodo);
  manualBtn.addEventListener('click', openManuals);
  closeBtn.addEventListener('click', openClose);
  cashBtn.addEventListener('click', openCash);

  /* ---------- 起動 ---------- */
  if (store) applyStore(store);

  // 1分ごとに自動更新（他端末からの打刻も反映）
  setInterval(() => {
    if (store && !mask.classList.contains('show') && !busy) refresh();
  }, 60000);
})();
