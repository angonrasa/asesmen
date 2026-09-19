// coretan-engine.js
// Engine paket "Bahas Soal" (M8, blueprint bagian 18) -- SENGAJA TERPISAH dari
// engine/quiz-engine.js (keputusan M8.1, blueprint 18.2), bukan menyatu, supaya
// bisa berkembang independen. Karena itu beberapa logic (resolve URL/kode lewat
// shortener) SENGAJA diduplikasi dari quiz-engine.js, bukan di-share -- konsisten
// dengan pola "tanpa build tools" proyek ini (SHORTENER_URL juga diduplikasi
// persis sama di wizard.js).
//
// Fokus paket ini: papan tulis untuk GURU membahas ulang soal di depan kelas,
// bukan mereplikasi UI kartu quiz-runner (keputusan M8.1). Tidak ada input
// nama/kelas, tidak ada submit jawaban -- murni baca soal (getSoal()) + coret.

(function () {
  // Sama persis dengan SHORTENER_URL di wizard.js & quiz-engine.js -- satu
  // shortener yang sama dipakai 3 halaman ini. Kalau shortener di-deploy ulang
  // ke URL baru, GANTI DI 3 TEMPAT (wizard.js, quiz-engine.js, file ini).
  const SHORTENER_URL = "https://script.google.com/macros/s/AKfycbwMtuZZUxEFe9APpdwkCY7nGZJsECwzzG5IyoXA2b8eB02N1qQhYNhtXMbB1MPhovk6/exec";

  let SCRIPT_URL = null;
  let soalPG = [], soalEssay = [], allQuestions = [];
  let current = 0;

  // M8.4: strokes disimpan sebagai VEKTOR (titik relatif 0..1 terhadap ukuran
  // board), bukan pixel/dataURL -- supaya tetap presisi kalau board di-resize
  // (rotasi layar, TV vs proyektor beda resolusi), dan supaya "Hapus Semua
  // Coretan" & undo-per-stroke gampang diimplementasikan nanti.
  let strokesByQuiz = {}; // { [nomorSoal]: [stroke, ...] }
  let currentStrokes = [];
  let activeStroke = null;
  let activePointerId = null;
  let quizKey = null; // key localStorage, turunan hash SCRIPT_URL

  let tool = "pen", color = "#1c1c1e", size = 4;

  // ====== GESTUR & VIEW (zoom/geser) -- bisa disetel di sini ======
  const MIN_SCALE = 0.3, MAX_SCALE = 4;
  const TAP_MAX_MS = 350;       // ketukan 2 jari: jari harus terangkat secepat ini
  const TAP_SLOP = 12;          // px: geser lebih dari ini = bukan ketukan (cubit/geser)
  const PAIR_MAX_GAP_MS = 300;  // 2 jari harus mendarat hampir bersamaan
  const DOUBLE_TAP_MS = 350;    // jeda maks antar 2 ketukan agar dihitung ketuk 2x (redo)
  const SCRIBBLE_MIN_TURNS = 4; // jumlah "balik arah" minimal agar dianggap coret-coret hapus
  const SCRIBBLE_PAD = 12;      // px layar: toleransi area coret-coret

  // Stroke stabilizer (permintaan guru: goresan "auto stabil dan konstan").
  // Titik baru tidak langsung dipakai mentah dari posisi pointer, tapi
  // "ditarik" sebagian ke sana dari titik sebelumnya (exponential smoothing)
  // -- meredam getaran tangan. Makin kecil nilainya, makin rapi tapi makin
  // ada jeda ("lag") mengikuti gerakan cepat; makin besar, makin responsif
  // tapi makin sedikit efek perapiannya. 1.0 = mati (persis posisi pointer).
  const STABILIZER_ALPHA = 0.45;

  // View = zoom (s) + geser (tx, ty), dalam px layar. s=1,tx=0,ty=0 = tampilan
  // asli (persis seperti sebelum ada zoom). Koordinat stroke TETAP relatif 0..1
  // terhadap "halaman" (= ukuran board saat s=1), jadi data lama tetap valid;
  // bedanya sekarang boleh bernilai <0 atau >1 (menggores di luar halaman
  // saat di-zoom out).
  let view = { s: 1, tx: 0, ty: 0 };
  let viewByQuiz = {};          // view per soal (memori saja, tidak disimpan)
  let pageW = 0, pageH = 0;     // ukuran halaman dasar (px CSS)

  // Undo/redo per soal (memori saja). Aksi: {type:"add", stroke, index} atau
  // {type:"remove", items:[{stroke, index}]} (hasil coret-coret hapus).
  const undoStacks = {}, redoStacks = {};

  // M8.5 (direvisi 18.2b): gambar referensi SENGAJA di memori saja (bukan
  // localStorage) -- "sementara ke soal yang sedang dibahas", hilang saat
  // sesi ditutup (18.2). Sekarang berupa ARRAY per soal (bukan satu objek)
  // supaya guru bisa menempel beberapa gambar sekaligus untuk menjelaskan
  // satu proses (mis. beberapa tahap difusi), tanpa gambar lama terganti.
  let refImagesByQuiz = {}; // { [nomorSoal]: [ {id, url, x, y, w, h}, ... ] } -- x/y/w/h relatif 0..1
  let imgIdSeq = 0;

  let canvas, ctx;

  function el(id) { return document.getElementById(id); }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  // ====== HASH KECIL UNTUK KEY LOCALSTORAGE ======
  // SCRIPT_URL asli 100+ karakter -- dipendekkan jadi key yang rapi. Tabrakan
  // hash 32-bit secara teori mungkin tapi praktis nyaris nol untuk jumlah kuis
  // yang dipakai satu guru di satu perangkat.
  function hashStr(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h * 31 + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }

  // ====== RESOLVE URL APPS SCRIPT (mirror quiz-engine.js, versi ringkas) ======
  // Paket ini TIDAK mendukung mode config.js (APPS_SCRIPT_URL) karena tidak
  // relevan untuk paket-legacy-M5 -- hanya mode ?src= dan ?<kode> shortener.
  async function resolveScriptUrl() {
    const params = new URLSearchParams(window.location.search);
    const src = params.get("src");
    if (src) return src.trim();

    const raw = window.location.search.startsWith("?") ? window.location.search.slice(1) : "";
    if (!raw || raw.includes("=")) return null;

    return await resolveKode_(raw);
  }

  async function resolveKode_(kode) {
    try {
      const res = await fetch(SHORTENER_URL + "?action=resolve&kode=" + encodeURIComponent(kode));
      const data = await res.json();
      return data.ok ? data.src : null;
    } catch (err) {
      return null;
    }
  }

  // ====== GATE (input link/kode, mirror homeKode di quiz-runner) ======
  function initGate() {
    el("gateBtn").addEventListener("click", () => {
      const errEl = el("gateError");
      const raw = el("gateKode").value.trim();
      errEl.hidden = true;
      if (!raw) {
        errEl.textContent = "Isi dulu link atau kode kuisnya.";
        errEl.hidden = false;
        return;
      }
      const qIdx = raw.indexOf("?");
      const query = (qIdx >= 0 ? raw.slice(qIdx + 1) : raw).trim();
      if (!query) {
        errEl.textContent = "Link atau kode yang ditempel tidak dikenali.";
        errEl.hidden = false;
        return;
      }
      window.location.href = window.location.pathname + "?" + query;
    });
  }

  // ====== LOAD SOAL ======
  async function loadSoal() {
    try {
      const res = await fetch(SCRIPT_URL + "?action=getSoal");
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Gagal memuat soal");
      soalPG = data.soalPG || [];
      soalEssay = data.soalEssay || [];
      allQuestions = [...soalPG, ...soalEssay];
      if (allQuestions.length === 0) {
        el("boardLoading").textContent = 'Kuis ini belum ada soal (Sheet "Soal" masih kosong).';
        return;
      }
      quizKey = "coretan_" + hashStr(SCRIPT_URL);
      loadStrokesFromStorage();
      renderQuestion(0);
    } catch (err) {
      el("boardLoading").textContent =
        "Gagal memuat soal. Cek koneksi internet, lalu muat ulang halaman.\n(" + err + ")";
    }
  }

  function loadStrokesFromStorage() {
    try {
      const raw = localStorage.getItem(quizKey);
      strokesByQuiz = raw ? JSON.parse(raw) : {};
    } catch (err) {
      strokesByQuiz = {};
    }
  }

  function saveStrokesToStorage() {
    try {
      localStorage.setItem(quizKey, JSON.stringify(strokesByQuiz));
    } catch (err) {
      // localStorage penuh/nonaktif (mode incognito dsb) -- diamkan, coretan
      // tetap kepakai normal untuk sisa sesi ini, cuma tidak persist.
    }
  }

  // ====== RENDER SOAL AKTIF ======
  function renderQuestion(index) {
    // Simpan view soal yang sedang ditinggalkan; batalkan ketukan/coretan yang
    // masih menggantung supaya tidak "bocor" ke soal berikutnya.
    if (allQuestions[current]) viewByQuiz[allQuestions[current].no] = { ...view };
    clearTimeout(tapTimer);
    tapCount = 0;
    activeStroke = null;
    activePointerId = null;

    current = index;
    const q = allQuestions[index];
    const isEssay = q.opsi === undefined;

    let html = `<div class="q-no">Soal ${index + 1} dari ${allQuestions.length}${isEssay ? " • Essay" : ""}</div>`;
    html += `<h2>${escapeHtml(q.soal)}</h2>`;
    if (!isEssay) {
      html += '<div class="q-opsi">';
      Object.entries(q.opsi).forEach(([letter, text]) => {
        html += `<div class="q-opsi-item"><span class="letter">${letter}</span>${escapeHtml(text)}</div>`;
      });
      html += "</div>";
    }
    el("boardContent").innerHTML = html;

    el("boardTitle").textContent = `Soal ${index + 1} dari ${allQuestions.length}`;
    el("prevBtn").disabled = index === 0;
    el("nextBtn").disabled = index === allQuestions.length - 1;

    currentStrokes = strokesByQuiz[q.no] || [];
    // Soal yang belum pernah dibuka mewarisi level zoom sekarang (geser
    // dimulai dari pojok kiri-atas); soal yang pernah dibuka balik ke view-nya.
    view = viewByQuiz[q.no] ? { ...viewByQuiz[q.no] } : { s: view.s, tx: 0, ty: 0 };
    resizeCanvas();
    applyView(true);
    renderRefImage();
  }

  // ====== CANVAS: SETUP & GAMBAR ======
  function initCanvas() {
    canvas = el("boardCanvas");
    ctx = canvas.getContext("2d");

    window.addEventListener("resize", () => { resizeCanvas(); applyView(true); });

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }

  // devicePixelRatio-aware supaya coretan tidak buram di layar HD (TV/proyektor).
  // Canvas = seukuran board (viewport) dan TIDAK ikut ditransformasi CSS;
  // zoom/geser diterapkan lewat ctx.setTransform di redrawCanvas() supaya
  // coretan tetap tajam di semua level zoom dan bisa menjangkau area di luar
  // halaman asli.
  function resizeCanvas() {
    const board = canvas.parentElement;
    pageW = board.clientWidth;
    pageH = board.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(pageW * dpr);
    canvas.height = Math.round(pageH * dpr);
    canvas.style.width = pageW + "px";
    canvas.style.height = pageH + "px";
  }

  // Titik layar -> koordinat relatif halaman (membalik zoom & geser).
  function relPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return [
      ((e.clientX - rect.left - view.tx) / view.s) / pageW,
      ((e.clientY - rect.top - view.ty) / view.s) / pageH
    ];
  }

  function onPointerDown(e) {
    // Tool "select" (18.2b) -- bukan tool coret, biarkan event lolos ke
    // elemen gambar referensi di atasnya (yang saat ini pointer-events:auto).
    if (tool === "select") return;
    // Jari pertama boleh langsung menggores. Kalau ternyata jari kedua menyusul
    // (cubit / ketuk 2 jari), goresan itu dibatalkan di startGesture().
    if (e.pointerType === "touch" && !canDrawWithTouch(e.pointerId)) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    activePointerId = e.pointerId;
    // Ketebalan = nilai slider APA ADANYA, dalam SATUAN HALAMAN (px pada zoom
    // 100%), TIDAK dibagi zoom. Jadi ukuran brush yang sama selalu menghasilkan
    // goresan setebal yang sama relatif terhadap halaman/teks soal, di zoom
    // berapa pun goresan itu dibuat -- dan sesudah dibuat pun ikut membesar/
    // mengecil sebanding dengan halaman (lihat drawStroke).
    // Riwayat: dulu dibagi zoom saat goresan dibuat -> ketebalan konstan di
    // LAYAR, akibatnya brush yang sama jadi tipis kalau menulis saat zoom in
    // dan tebal kalau menulis saat zoom out (tidak konsisten). Jangan dikembalikan.
    activeStroke = { tool, color, size, points: [relPoint(e)] };
  }

  function onPointerMove(e) {
    if (!activeStroke || e.pointerId !== activePointerId) return;
    const raw = relPoint(e);
    const pts = activeStroke.points;
    const prev = pts[pts.length - 1];
    // Stabilizer: titik yang disimpan bukan `raw` mentah, tapi hasil "tarikan"
    // sebagian dari titik sebelumnya ke arah `raw` (lihat STABILIZER_ALPHA).
    pts.push([
      prev[0] + (raw[0] - prev[0]) * STABILIZER_ALPHA,
      prev[1] + (raw[1] - prev[1]) * STABILIZER_ALPHA
    ]);
    redrawCanvas();
  }

  function onPointerUp(e) {
    if (!activeStroke || e.pointerId !== activePointerId) return;
    const stroke = activeStroke;
    activeStroke = null;
    activePointerId = null;

    if (stroke.points.length > 1) {
      // Shortcut hapus: coret-coret (zig-zag) dengan spidol di atas coretan
      // yang sudah ada = hapus coretan di area itu, goresan coret-coretnya
      // sendiri tidak disimpan.
      if (stroke.tool === "pen" && tryScribbleErase(stroke)) {
        redrawCanvas();
        return;
      }
      recordAction({ type: "add", stroke, index: currentStrokes.length });
      currentStrokes.push(stroke);
      commitStrokes();
      return;
    }

    // Ketukan tanpa gerakan (1 titik) -- dulu dibuang begitu saja, padahal
    // guru butuh ini untuk menulis titik pada huruf "i", titik akhir kalimat,
    // dll. Sekarang disimpan juga, digambar sebagai titik solid (lihat
    // drawStroke) alih-alih diabaikan.
    recordAction({ type: "add", stroke, index: currentStrokes.length });
    currentStrokes.push(stroke);
    commitStrokes();
  }

  // 3 tool (blueprint 18.2/17.7... err 18.3): pen = tinta biasa, highlight =
  // stabilo (lebih tebal, transparan, blend "multiply" supaya teks di
  // bawahnya tetap kebaca), eraser = destination-out (menghapus pixel yang
  // sudah digambar, bukan cuma menimpa warna putih).
  function drawStroke(stroke) {
    const w = pageW, h = pageH;
    const pts = stroke.points;
    if (!pts.length) return;

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // stroke.size dalam satuan halaman (lihat onPointerDown). Transform
    // zoom di redrawCanvas() (ctx.setTransform) yang mengalikannya ke ukuran
    // layar -- jadi ketebalan otomatis proporsional dengan zoom, sama seperti
    // teks soal. JANGAN dibagi view.s di sini.
    const lw = stroke.size;
    if (stroke.tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.globalAlpha = 1;
      ctx.lineWidth = lw * 2.2;
    } else if (stroke.tool === "highlight") {
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = lw * 3;
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.lineWidth = lw;
    }
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;

    if (pts.length === 1) {
      // Ketukan tanpa gerakan -- gambar titik solid seukuran ketebalan
      // goresan (bukan diabaikan), supaya huruf "i", titik akhir kalimat,
      // dll bisa ditulis dengan sekali ketuk, bukan harus dicoret.
      ctx.beginPath();
      ctx.arc(pts[0][0] * w, pts[0][1] * h, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      return;
    }

    // Mid-point quadratic smoothing: tiap titik jadi titik kontrol menuju
    // titik tengah ke titik berikutnya, bukan disambung garis lurus (lineTo)
    // -- menghaluskan sudut-sudut kecil hasil tangan bergetar, melengkapi
    // stabilizer di input (onPointerMove) yang sudah meredam sebelum sampai
    // sini. Kombinasi keduanya = goresan lebih "auto stabil dan konstan".
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
    let i = 1;
    for (; i < pts.length - 1; i++) {
      const midX = (pts[i][0] + pts[i + 1][0]) / 2 * w;
      const midY = (pts[i][1] + pts[i + 1][1]) / 2 * h;
      ctx.quadraticCurveTo(pts[i][0] * w, pts[i][1] * h, midX, midY);
    }
    ctx.lineTo(pts[i][0] * w, pts[i][1] * h);
    ctx.stroke();

    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  function redrawCanvas() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.tx, dpr * view.ty);
    currentStrokes.forEach(drawStroke);
    if (activeStroke) drawStroke(activeStroke);
  }

  // Selama gestur, redraw dibatasi 1x per frame supaya cubit tetap mulus.
  let rafId = 0;
  function scheduleRedraw() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; redrawCanvas(); });
  }

  // ====== VIEW: ZOOM & GESER ======
  function clampView() {
    view.s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.s));
    // Halaman asli minimal 80px tetap kelihatan, supaya tidak "tersesat" di
    // area kosong -- tapi tetap bisa menjangkau ruang luas di sekelilingnya.
    const minVis = 80;
    view.tx = Math.min(pageW - minVis, Math.max(minVis - pageW * view.s, view.tx));
    view.ty = Math.min(pageH - minVis, Math.max(minVis - pageH * view.s, view.ty));
  }

  // Teks soal & gambar referensi ikut transform CSS yang sama dengan canvas.
  function applyView(sync) {
    clampView();
    const t = `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`;
    el("boardContent").style.transform = t;
    const refs = el("refImages");
    refs.style.transform = t;
    refs.style.setProperty("--inv", String(1 / view.s)); // tombol gambar tetap ukuran layar
    if (sync) redrawCanvas(); else scheduleRedraw();
  }

  // Lepas cubit dekat 100% -> "nempel" ke tampilan asli (mudah kembali normal).
  function snapView() {
    if (Math.abs(view.s - 1) < 0.06) {
      view.s = 1;
      if (Math.abs(view.tx) < 24 && Math.abs(view.ty) < 24) { view.tx = 0; view.ty = 0; }
    }
    applyView(true);
  }

  // ====== RIWAYAT: UNDO / REDO ======
  function stacksFor(no) {
    return {
      undo: undoStacks[no] || (undoStacks[no] = []),
      redo: redoStacks[no] || (redoStacks[no] = [])
    };
  }

  function recordAction(action) {
    const st = stacksFor(allQuestions[current].no);
    st.undo.push(action);
    st.redo.length = 0; // aksi baru memutus rantai redo
    if (st.undo.length > 100) st.undo.shift();
  }

  // currentStrokes selalu dimutasi di tempat (splice/push) supaya tetap satu
  // referensi dengan strokesByQuiz[no]; fungsi ini yang menyimpan & menggambar.
  function commitStrokes() {
    const no = allQuestions[current].no;
    if (currentStrokes.length) strokesByQuiz[no] = currentStrokes;
    else delete strokesByQuiz[no];
    saveStrokesToStorage();
    redrawCanvas();
  }

  function doUndo() {
    const st = stacksFor(allQuestions[current].no);
    let action = st.undo.pop();
    if (!action) {
      // Riwayat kosong (mis. halaman baru dibuka ulang, coretan lama dimuat
      // dari localStorage): mundurkan coretan terakhir yang tersimpan.
      if (!currentStrokes.length) { showToast("Tidak ada yang bisa di-undo"); return; }
      action = { type: "add", stroke: currentStrokes[currentStrokes.length - 1], index: currentStrokes.length - 1 };
    }
    if (action.type === "add") {
      const i = currentStrokes.indexOf(action.stroke);
      if (i >= 0) currentStrokes.splice(i, 1);
    } else {
      // Kembalikan coretan yang terhapus ke posisi semula (urut naik supaya
      // indeks asli tetap valid).
      action.items.slice().sort((a, b) => a.index - b.index).forEach(it => {
        currentStrokes.splice(Math.min(it.index, currentStrokes.length), 0, it.stroke);
      });
    }
    st.redo.push(action);
    commitStrokes();
    showToast("Undo");
  }

  function doRedo() {
    const st = stacksFor(allQuestions[current].no);
    const action = st.redo.pop();
    if (!action) { showToast("Tidak ada yang bisa di-redo"); return; }
    if (action.type === "add") {
      currentStrokes.splice(Math.min(action.index, currentStrokes.length), 0, action.stroke);
    } else {
      action.items.forEach(it => {
        const i = currentStrokes.indexOf(it.stroke);
        if (i >= 0) currentStrokes.splice(i, 1);
      });
    }
    st.undo.push(action);
    commitStrokes();
    showToast("Redo");
  }

  let toastTimer = null;
  function showToast(msg) {
    const t = el("toast");
    t.textContent = msg;
    t.classList.remove("is-hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("is-hidden"), 1000);
  }

  // ====== CORET-CORET HAPUS (SCRIBBLE-TO-ERASE) ======
  // Zig-zag = goresan yang beberapa kali balik arah tajam. Dihitung di
  // satuan px LAYAR (bukan halaman) karena yang relevan adalah gerak jari.
  function isScribble(stroke) {
    const k = view.s;
    const pts = stroke.points.map(p => [p[0] * pageW * k, p[1] * pageH * k]);

    // Sederhanakan: titik baru hanya dihitung kalau >= 8px dari titik terakhir.
    const s = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const l = s[s.length - 1];
      if (Math.hypot(pts[i][0] - l[0], pts[i][1] - l[1]) >= 8) s.push(pts[i]);
    }
    if (s.length < 8) return false;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    s.forEach(p => {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    });
    if (Math.hypot(maxX - minX, maxY - minY) < 40) return false;

    // Hitung "balik arah": sudut antar 2 segmen berurutan > ~110 derajat.
    // Jarak minimal 3 titik (~24px) antar balik arah -> setiap lintasan
    // zig-zag minimal ~24px, coretan kecil/gemetar tidak ikut terhitung.
    let turns = 0, lastTurn = -10;
    for (let i = 1; i < s.length - 1; i++) {
      const ax = s[i][0] - s[i - 1][0], ay = s[i][1] - s[i - 1][1];
      const bx = s[i + 1][0] - s[i][0], by = s[i + 1][1] - s[i][1];
      const cos = (ax * bx + ay * by) / ((Math.hypot(ax, ay) * Math.hypot(bx, by)) || 1);
      if (cos < -0.35 && i - lastTurn >= 3) { turns++; lastTurn = i; }
    }
    return turns >= SCRIBBLE_MIN_TURNS;
  }

  // Hapus coretan lama yang >= 60% titiknya ada di dalam kotak coret-coret.
  // Return true kalau ada yang terhapus. Kalau tidak ada coretan di bawahnya
  // (mis. mencoret teks soal), goresan diperlakukan sebagai tinta biasa.
  // Stroke eraser dilewati (menghapusnya justru memunculkan lagi tinta yang
  // sudah dihapus); stabilo TIDAK memicu ini karena zig-zag stabilo dipakai
  // untuk mewarnai area.
  function tryScribbleErase(stroke) {
    if (!isScribble(stroke)) return false;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    stroke.points.forEach(p => {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    });
    const padX = SCRIBBLE_PAD / (pageW * view.s);
    const padY = SCRIBBLE_PAD / (pageH * view.s);
    minX -= padX; maxX += padX; minY -= padY; maxY += padY;

    const items = [];
    currentStrokes.forEach((st, index) => {
      if (st.tool === "eraser" || !st.points.length) return;
      let inside = 0;
      st.points.forEach(p => {
        if (p[0] >= minX && p[0] <= maxX && p[1] >= minY && p[1] <= maxY) inside++;
      });
      if (inside / st.points.length >= 0.6) items.push({ stroke: st, index });
    });
    if (!items.length) return false;

    const drop = new Set(items.map(it => it.stroke));
    for (let i = currentStrokes.length - 1; i >= 0; i--) {
      if (drop.has(currentStrokes[i])) currentStrokes.splice(i, 1);
    }
    recordAction({ type: "remove", items });
    commitStrokes();
    showToast("Coretan dihapus");
    return true;
  }

  // ====== GESTUR 2 JARI: CUBIT (zoom+geser), KETUK 1x (undo), KETUK 2x (redo) ======
  // Pelacak sentuhan ada di level board (fase capture) supaya cubit juga jalan
  // walau jari mendarat di atas gambar referensi. Hanya pointerType "touch":
  // stylus & mouse tetap menggores seperti biasa (tidak jadi gestur).
  const touches = new Map(); // pointerId -> {x, y, t0, ignored}
  let gesture = null;        // {ids, t0, d0, mx0, my0, view0, moved}
  let gestureLock = false;   // true = sisa jari setelah gestur diabaikan sampai semua terangkat
  let tapCount = 0, tapTimer = null;

  function canDrawWithTouch(id) {
    const t = touches.get(id);
    return !!t && !t.ignored && !gesture && !gestureLock;
  }

  function initGestures() {
    const board = el("board");
    board.addEventListener("pointerdown", onTouchDown, true);
    window.addEventListener("pointermove", onTouchMove);
    window.addEventListener("pointerup", onTouchEnd);
    window.addEventListener("pointercancel", onTouchEnd);
    window.addEventListener("blur", () => { touches.clear(); gesture = null; gestureLock = false; });
    board.addEventListener("wheel", onWheel, { passive: false });
  }

  function onTouchDown(e) {
    if (e.pointerType !== "touch") return;
    const t = { x: e.clientX, y: e.clientY, t0: e.timeStamp, ignored: false };
    const valid = [...touches.values()].filter(v => !v.ignored);

    let startsGesture = false;
    if (gestureLock || gesture || valid.length >= 2) {
      t.ignored = true;                        // jari ke-3 / sisa jari setelah gestur
    } else if (valid.length === 1) {
      if (t.t0 - valid[0].t0 <= PAIR_MAX_GAP_MS) startsGesture = true;
      else t.ignored = true;                   // menyusul telat = kemungkinan telapak tangan
    }
    touches.set(e.pointerId, t);
    if (startsGesture) startGesture();
  }

  function startGesture() {
    const entries = [...touches.entries()].filter(([, v]) => !v.ignored);
    const [idA, a] = entries[0], [idB, b] = entries[1];
    const rect = el("board").getBoundingClientRect();
    gesture = {
      ids: [idA, idB],
      t0: b.t0,
      d0: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1),
      mx0: (a.x + b.x) / 2 - rect.left,
      my0: (a.y + b.y) / 2 - rect.top,
      view0: { ...view },
      moved: false
    };
    // Batalkan goresan yang sempat dimulai jari pertama (belum disimpan).
    if (activeStroke) { activeStroke = null; activePointerId = null; redrawCanvas(); }
  }

  function onTouchMove(e) {
    if (e.pointerType !== "touch") return;
    const t = touches.get(e.pointerId);
    if (!t) return;
    t.x = e.clientX; t.y = e.clientY;
    if (!gesture || !gesture.ids.includes(e.pointerId)) return;

    const a = touches.get(gesture.ids[0]), b = touches.get(gesture.ids[1]);
    const rect = el("board").getBoundingClientRect();
    const mx = (a.x + b.x) / 2 - rect.left, my = (a.y + b.y) / 2 - rect.top;
    const d = Math.hypot(a.x - b.x, a.y - b.y);

    // Di bawah ambang geser masih dianggap calon "ketukan", jangan digeser dulu.
    if (!gesture.moved) {
      if (Math.abs(d - gesture.d0) > TAP_SLOP || Math.hypot(mx - gesture.mx0, my - gesture.my0) > TAP_SLOP) {
        gesture.moved = true;
      } else {
        return;
      }
    }

    // Titik halaman yang tadi ada di bawah titik tengah kedua jari harus tetap
    // di bawah titik tengah sekarang -> zoom terasa "berporos" di jari, dan
    // menggeser 2 jari otomatis menggeser halaman.
    const v0 = gesture.view0;
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v0.s * d / gesture.d0));
    const px = (gesture.mx0 - v0.tx) / v0.s, py = (gesture.my0 - v0.ty) / v0.s;
    view.s = s;
    view.tx = mx - px * s;
    view.ty = my - py * s;
    applyView(false);
  }

  function onTouchEnd(e) {
    if (e.pointerType !== "touch") return;
    if (!touches.has(e.pointerId)) return;

    if (gesture && gesture.ids.includes(e.pointerId)) {
      const isTap = e.type === "pointerup" && !gesture.moved && (e.timeStamp - gesture.t0) <= TAP_MAX_MS;
      const wasMoved = gesture.moved;
      gesture = null;
      gestureLock = true;                      // jari yang tersisa tidak boleh menggores
      if (wasMoved) snapView();
      if (isTap) onTwoFingerTap();
    }
    touches.delete(e.pointerId);
    if (touches.size === 0) { gestureLock = false; gesture = null; }
  }

  // 1 ketukan = undo, 2 ketukan beruntun = redo. Undo baru dieksekusi setelah
  // jeda DOUBLE_TAP_MS untuk memastikan tidak ada ketukan kedua.
  function onTwoFingerTap() {
    if (!allQuestions[current]) return;
    tapCount++;
    clearTimeout(tapTimer);
    if (tapCount >= 2) {
      tapCount = 0;
      doRedo();
      return;
    }
    tapTimer = setTimeout(() => { tapCount = 0; doUndo(); }, DOUBLE_TAP_MS);
  }

  // Mouse/trackpad (TV + mouse, desktop): Ctrl+scroll (atau pinch trackpad) =
  // zoom di posisi kursor, scroll biasa = geser.
  function onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const rect = el("board").getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      const step = Math.max(-30, Math.min(30, -e.deltaY)) * 0.01;
      const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.s * Math.exp(step)));
      const px = (cx - view.tx) / view.s, py = (cy - view.ty) / view.s;
      view.s = s; view.tx = cx - px * s; view.ty = cy - py * s;
    } else {
      view.tx -= e.deltaX;
      view.ty -= e.deltaY;
    }
    applyView(false);
  }

  // ====== TOOLBAR ======
  // Tool "select" (18.2b) menggeser mode: gambar referensi jadi bisa
  // disentuh/digeser/diresize HANYA saat tool ini aktif (lihat class
  // .editable di CSS) -- di luar itu gambar "tembus" terhadap sentuhan
  // supaya tidak menghalangi goresan pena/stabilo/penghapus di atasnya.
  function setTool(t) {
    tool = t;
    document.querySelectorAll(".dock-btn[data-tool]").forEach(b => {
      b.classList.toggle("active", b.dataset.tool === t);
    });
    el("refImages").classList.toggle("editable", t === "select");
    // Kanvas coretan sekarang di layer PALING ATAS (z-index tertinggi, supaya
    // goresan selalu kelihatan di atas gambar referensi) -- kalau dibiarkan
    // begitu saat tool "Pilih Gambar" aktif, kanvas akan menelan semua
    // sentuhan sebelum sampai ke gambar di bawahnya. Makanya di tool ini
    // kanvas sengaja "ditembuskan" (pointer-events:none).
    canvas.style.pointerEvents = t === "select" ? "none" : "";
  }

  function initToolbar() {
    document.querySelectorAll(".dock-btn[data-tool]").forEach(btn => {
      btn.addEventListener("click", () => setTool(btn.dataset.tool));
    });
    setTool(tool); // sinkronkan class .editable di awal (tool default = "pen")

    // Panel warna & ukuran: progressive disclosure -- tersembunyi sampai
    // tombol titik warna (colorToggle) di dock disentuh, ditutup lagi
    // otomatis setelah pilih warna supaya dock tidak penuh menu terus.
    const panel = el("colorPanel");
    el("colorToggle").addEventListener("click", () => {
      panel.classList.toggle("is-hidden");
    });

    document.querySelectorAll(".swatch").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".swatch").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        color = btn.dataset.color;
        el("colorDot").style.background = color;
        panel.classList.add("is-hidden");
      });
    });

    el("sizeRange").addEventListener("input", (e) => { size = Number(e.target.value); });

    // M8.4: "Hapus Semua Coretan" -- beda dari tool penghapus/eraser (yang
    // cuma menghapus sebagian coretan di satu soal). Ini menghapus SEMUA
    // soal di kuis ini sekaligus, makanya perlu konfirmasi.
    el("clearAllBtn").addEventListener("click", () => {
      if (!confirm("Hapus semua coretan di SEMUA soal kuis ini? Tidak bisa dibatalkan.")) return;
      strokesByQuiz = {};
      currentStrokes = [];
      Object.keys(undoStacks).forEach(k => delete undoStacks[k]);
      Object.keys(redoStacks).forEach(k => delete redoStacks[k]);
      try { localStorage.removeItem(quizKey); } catch (err) { /* diamkan */ }
      redrawCanvas();
    });

    el("prevBtn").addEventListener("click", () => { if (current > 0) renderQuestion(current - 1); });
    el("nextBtn").addEventListener("click", () => { if (current < allQuestions.length - 1) renderQuestion(current + 1); });

    // "../" mengasumsikan struktur folder packages/coretan/ sejajar dengan
    // index.html root quiz-runner (sama seperti wizard/ terhadap root, M6.4).
    el("homeBtn").addEventListener("click", () => { window.location.href = "../"; });

    el("imgInput").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      const no = allQuestions[current].no;
      const list = refImagesByQuiz[no] || (refImagesByQuiz[no] = []);
      // M8.5 direvisi (18.2b): DITAMBAHKAN ke daftar, bukan mengganti gambar
      // sebelumnya -- guru bisa menempel beberapa gambar untuk satu soal
      // (mis. menjelaskan proses bertahap). Tiap gambar baru diberi offset
      // kecil supaya tidak numpuk persis di atas gambar yang sudah ada.
      const offset = 0.03 * list.length;
      list.push({
        id: "img" + (++imgIdSeq),
        url,
        x: (-view.tx / view.s) / pageW + (0.08 + offset) / view.s,
        y: (-view.ty / view.s) / pageH + (0.08 + offset) / view.s,
        w: 0.4 / view.s,
        h: 0.3 / view.s
      });
      // Guru baru saja nambah gambar -- pindah otomatis ke tool "Pilih Gambar"
      // supaya bisa langsung digeser/diresize ke posisi yang pas.
      setTool("select");
      renderRefImage();
      e.target.value = "";
    });
  }

  // ====== GAMBAR REFERENSI (M8.5 direvisi 18.2b: multi-gambar, sesi-saja) ======
  function renderRefImage() {
    const container = el("refImages");
    container.innerHTML = "";
    const list = refImagesByQuiz[allQuestions[current].no] || [];
    list.forEach(ref => container.appendChild(buildRefImageWrap(ref)));
  }

  function buildRefImageWrap(ref) {
    const wrap = document.createElement("div");
    wrap.className = "ref-img-wrap";
    applyRefStyle(wrap, ref);

    const img = document.createElement("img");
    img.src = ref.url;
    wrap.appendChild(img);

    const removeBtn = document.createElement("button");
    removeBtn.className = "ref-img-remove";
    removeBtn.type = "button";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const list = refImagesByQuiz[allQuestions[current].no] || [];
      const i = list.indexOf(ref);
      if (i >= 0) list.splice(i, 1);
      renderRefImage();
    });
    wrap.appendChild(removeBtn);

    const resizeHandle = document.createElement("div");
    resizeHandle.className = "ref-img-resize";
    wrap.appendChild(resizeHandle);

    // Drag & resize dasar, koordinat relatif terhadap board (bukan window)
    // supaya tetap benar kalau board di-resize sesudahnya.
    let dragging = null;
    wrap.addEventListener("pointerdown", (e) => {
      if (e.target === removeBtn) return;
      e.stopPropagation();
      if (gesture || gestureLock) return; // jari kedua = cubit, bukan geser gambar
      wrap.setPointerCapture(e.pointerId);
      dragging = {
        isResize: e.target === resizeHandle,
        startX: e.clientX,
        startY: e.clientY,
        orig: { x: ref.x, y: ref.y, w: ref.w, h: ref.h },
        boardRect: el("board").getBoundingClientRect()
      };
    });
    wrap.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      if (gesture) { dragging = null; return; } // jari kedua mendarat: batalkan geser gambar
      // Selisih layar dibagi (ukuran board x zoom) = selisih relatif halaman.
      const dx = (e.clientX - dragging.startX) / (dragging.boardRect.width * view.s);
      const dy = (e.clientY - dragging.startY) / (dragging.boardRect.height * view.s);
      if (dragging.isResize) {
        ref.w = Math.max(0.04, dragging.orig.w + dx);
        ref.h = Math.max(0.04, dragging.orig.h + dy);
      } else {
        // Gambar boleh dipindah ke area luas di luar halaman asli (saat zoom out).
        ref.x = Math.min(2, Math.max(-1 - ref.w, dragging.orig.x + dx));
        ref.y = Math.min(2, Math.max(-1 - ref.h, dragging.orig.y + dy));
      }
      applyRefStyle(wrap, ref);
    });
    wrap.addEventListener("pointerup", () => { dragging = null; });
    wrap.addEventListener("pointercancel", () => { dragging = null; });

    return wrap;
  }

  function applyRefStyle(wrap, ref) {
    wrap.style.left = ref.x * 100 + "%";
    wrap.style.top = ref.y * 100 + "%";
    wrap.style.width = ref.w * 100 + "%";
    wrap.style.height = ref.h * 100 + "%";
  }

  // ====== INIT ======
  document.addEventListener("DOMContentLoaded", async () => {
    if (!window.location.search) {
      initGate();
      return;
    }
    // Bug lama: pakai atribut `hidden` di sini kalah spesifisitas lawan CSS
    // .gate{display:flex} / .board-page{...} -- dua halaman kelihatan
    // bersamaan. Class .is-hidden{display:none!important} di CSS selalu menang.
    el("gatePage").classList.add("is-hidden");
    el("boardPage").classList.remove("is-hidden");

    initCanvas();
    initGestures();
    initToolbar();

    SCRIPT_URL = await resolveScriptUrl();
    if (!SCRIPT_URL) {
      el("boardLoading").textContent =
        "Link tidak valid atau sudah tidak berlaku. Minta link kuis yang baru dari guru.";
      return;
    }
    loadSoal();
  });
})();
