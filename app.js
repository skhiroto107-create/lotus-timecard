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
          '<button class="big in" id="act">Notionに反映</button>'
        : '') +
      '<button class="big ghost" id="close">' + (info.staff.length ? 'キャンセル' : '閉じる') + '</button>';

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
      const res = await call('close', {
        repStaff: rep,
        startCash: cashRaw === '' ? null : Number(cashRaw),
        force,
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

  /* ---------- マニュアル ---------- */
  // 一覧はNotionの「マニュアル」から毎回取得するので、
  // 追加・削除・並べ替えはNotion側だけで完結する。
  let manualCache = null;

  async function openManuals() {
    sheet.innerHTML = '<h2>マニュアル</h2><div class="sub">読み込んでいます…</div>';
    mask.classList.add('show');

    if (!manualCache) {
      try {
        const res = await call('manuals');
        manualCache = res.manuals || [];
      } catch (err) {
        sheetError('マニュアル', err.message);
        return;
      }
    }

    if (!manualCache.length) {
      sheetError('マニュアル', 'マニュアルが登録されていません');
      return;
    }

    sheet.innerHTML =
      '<h2>マニュアル</h2>' +
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
        sheetError('マニュアル', err.message);
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
