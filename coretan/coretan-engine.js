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
  // Posisi layar (px) & timestamp goresan aktif terakhir -- dipakai
  // onPointerMove untuk hitung kecepatan gerak (fitur Goresan Cepat).
  let lastMoveX = 0, lastMoveY = 0, lastMoveT = 0;
  let quizKey = null; // key localStorage, turunan hash SCRIPT_URL

  let tool = "pen";

  // ====== PENGATURAN ALAT (submenu spidol / stabilo / penghapus) ======
  // Tiap alat punya pengaturan sendiri (warna stabilo tidak ikut warna
  // spidol). Semua slider berskala 0-100 kecuali `size` (px halaman, 2-24).
  //   taper      : efek lancip (khusus spidol). 0 = mati -> pena biasa rata.
  //   dynamic    : lebar dinamis (khusus spidol) -- gerak pelan lebih tebal,
  //                gerak cepat lebih tipis. 0 = mati -> lebar tetap.
  //   smooth     : "Konstan" -- penghalusan sesudah jari diangkat. 0 = mati.
  //   stabilizer : peredaman getaran real-time. 0 = mati.
  //   quick      : "Goresan Cepat" -- seberapa banyak peredaman dilepas saat
  //                jari bergerak cepat. 0 = peredaman sama di semua kecepatan.
  // Nilai default kira-kira sama dengan konstanta lama, kecuali taper yang
  // sengaja dibuat lebih lembut dari versi sebelumnya.
  const DEFAULT_SETTINGS = {
    pen:       { color: "#1c1c1e", size: 4, taper: 45, dynamic: 50, smooth: 40, stabilizer: 75, quick: 80 },
    highlight: { color: "#ffd60a", size: 4, smooth: 40, stabilizer: 75, quick: 80 },
    eraser:    { size: 4, smooth: 40, stabilizer: 75, quick: 80 }
  };
  // Preset satu ketuk (submenu spidol). Hanya mengubah pengaturan bentuk &
  // kehalusan, WARNA tidak ikut berubah. Nilai bisa disetel di sini.
  const PRESETS = {
    tulisan: { size: 4,  taper: 35, dynamic: 50, smooth: 35, stabilizer: 55, quick: 85 },
    sketsa:  { size: 3,  taper: 60, dynamic: 70, smooth: 20, stabilizer: 30, quick: 90 },
    tebal:   { size: 10, taper: 20, dynamic: 25, smooth: 50, stabilizer: 70, quick: 70 }
  };
  const SETTINGS_KEY = "coretan_settings_v1";
  let settings = loadSettings();
  let activeCfg = null; // pengaturan alat yang dipakai goresan yang sedang berjalan
  let activeSpeed = 0;  // kecepatan jari yang sudah dihaluskan (px layar/ms)
  let activeWf = 1;     // faktor lebar titik terakhir (1 = lebar normal)

  // ====== RASA MENULIS: PREDIKSI, HAPTIK, PALM REJECTION -- bisa disetel ======
  // Prediksi ujung: garis yang SEDANG digambar disambung ke posisi jari yang
  // sebenarnya (menutup lag stabilizer) lalu diekstrapolasi PREDICT_MS ke
  // depan (maks PREDICT_MAX_PX px layar). Hanya tampilan sementara -- yang
  // disimpan tetap titik hasil stabilizer.
  const PREDICT_MS = 14;
  const PREDICT_MAX_PX = 24;
  const HAPTIC = { undo: 12, redo: [12, 50, 12], erase: 22 }; // ms getar
  // Palm rejection: sentuhan (touch) diabaikan selama stylus menyentuh/melayang
  // + PALM_GRACE_MS sesudahnya, dan sentuhan dengan area kontak >= PALM_SIZE_PX
  // (px CSS, lebar/tinggi elips kontak dari browser) dianggap telapak.
  const PALM_GRACE_MS = 500;
  const PALM_SIZE_PX = 56;
  let activeRaw = null;          // posisi jari terakhir (relatif halaman), tanpa stabilizer
  let activeVx = 0, activeVy = 0; // kecepatan jari (px layar/ms), untuk ekstrapolasi
  let predictTimer = null;
  let penDown = false, lastPenT = -1e9;

  // Cache tinta: semua goresan yang sudah selesai digambar SEKALI ke kanvas
  // luar-layar (baseCanvas). Selama menulis, tiap gerakan cuma menempel cache
  // + menggambar goresan yang sedang berjalan -- bukan menggambar ulang semua
  // goresan. Cache dibuat ulang bila goresan berubah (undo/redo/hapus) atau
  // view (zoom/geser/resize) berubah.
  let baseCanvas = null, baseCtx = null, baseValid = false;
  let baseView = { s: 1, tx: 0, ty: 0 };

  function loadSettings() {
    const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      Object.keys(out).forEach(t => {
        if (!saved[t]) return;
        Object.keys(out[t]).forEach(k => {
          const v = saved[t][k];
          if (k === "color") {
            if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)) out[t][k] = v;
          } else if (typeof v === "number" && isFinite(v)) {
            out[t][k] = k === "size" ? Math.min(24, Math.max(2, v)) : Math.min(100, Math.max(0, v));
          }
        });
      });
    } catch (err) { /* rusak / dinonaktifkan -> pakai default */ }
    return out;
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (err) { /* diamkan */ }
  }

  // Mode "Papan Kosong" (blueprint 20.7): satu papan tulis tunggal, tidak
  // terikat ke soal/kuis manapun. Kunci localStorage tetap ("coretan_kosong"),
  // bukan diturunkan dari SCRIPT_URL, supaya guru bisa lanjut nyoret dari
  // sesi sebelumnya kapan saja dibuka lewat opsi ini.
  let isBlank = false;

  // ====== GESTUR & VIEW (zoom/geser) -- bisa disetel di sini ======
  const MIN_SCALE = 0.3, MAX_SCALE = 4;
  const TAP_MAX_MS = 350;       // ketukan 2 jari: jari harus terangkat secepat ini
  const TAP_SLOP = 12;          // px: geser lebih dari ini = bukan ketukan (cubit/geser)
  const PAIR_MAX_GAP_MS = 300;  // 2 jari harus mendarat hampir bersamaan
  const DOUBLE_TAP_MS = 350;    // jeda maks antar 2 ketukan agar dihitung ketuk 2x (redo)
  const SCRIBBLE_MIN_TURNS = 4; // jumlah "balik arah" minimal agar dianggap coret-coret hapus
  const SCRIBBLE_PAD = 12;      // px layar: toleransi area coret-coret

  // Stroke stabilizer (permintaan guru: goresan "auto stabil dan konstan").
  // Tiga lapis, semuanya disetel dari submenu alat (lihat settings):
  //  - stabilizer: peredaman REAL-TIME selagi menggores. Titik baru tidak
  //    dipakai mentah dari posisi pointer, tapi "ditarik" sebagian ke sana dari
  //    titik sebelumnya (exponential smoothing). Makin tinggi makin rapi tapi
  //    makin ada jeda ("lag") mengikuti jari.
  //  - quick ("Goresan Cepat", padanan ibisPaint): begitu jari bergerak cepat,
  //    peredaman dilepas supaya goresan tidak tertinggal jauh di belakang jari.
  //    Interpolasi linear antara SLOW_SPEED_PX_MS dan FAST_SPEED_PX_MS (satuan:
  //    px LAYAR per ms, dari jarak+selisih waktu antar pointermove).
  //  - smooth ("Konstan", padanan "Stabilisator" mode Setelah ibisPaint): jalan
  //    SESUDAH jari diangkat -- seluruh titik dihaluskan sekali lagi (moving
  //    average ke tetangga kiri-kanan). Satuan: jumlah titik tetangga per sisi.
  const SLOW_SPEED_PX_MS = 0.15;
  const FAST_SPEED_PX_MS = 1.2;
  const POST_SMOOTH_MAX_RADIUS = 8;

  // ====== LEBAR DINAMIS (spidol) ======
  // Kecepatan jari (px LAYAR/ms) -> faktor lebar titik. Pelan = lebih tebal
  // (tinta menumpuk), cepat = lebih tipis (tinta tersapu), mirip tekanan pena
  // di layar yang tidak punya sensor tekanan. `dyn` 0-100 = seberapa besar
  // efeknya; pada 100 faktornya berkisar 1.4 (diam) sampai 0.5 (>=1.6 px/ms),
  // dan sekitar 1.0 pada kecepatan menulis biasa (~0.7 px/ms).
  const DYN_FULL_SPEED = 1.6;
  function dynWidthTarget(speed, dyn) {
    const t = Math.min(1, Math.max(0, speed / DYN_FULL_SPEED));
    const e = t * t * (3 - 2 * t);
    return 1 + (dyn / 100) * (0.4 - 0.9 * e);
  }

  // Nilai slider (0-100) -> alpha. alpha 1 = persis posisi pointer (mati).
  // Default (75, 80) ~ konstanta lama 0.3 (pelan) dan 0.85 (cepat).
  function stabAlphas(cfg) {
    const slow = 1 - 0.92 * (cfg.stabilizer / 100);
    const fast = slow + (1 - slow) * (cfg.quick / 100);
    return { slow, fast };
  }
  function postSmoothRadius(cfg) {
    return Math.round(POST_SMOOTH_MAX_RADIUS * cfg.smooth / 100);
  }

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

  // ====== SELECTOR ("Bahas Apa?") ======
  // Titik masuk paling awal kalau dibuka tanpa query string sama sekali
  // (blueprint 20.7). Materi & KisiKata masih placeholder -- belum ada
  // sumber data (tab Materi / integrasi KisiKata belum dikerjakan, 20.7/22.3).
  function initSelector() {
    el("selectBahasSoal").addEventListener("click", () => {
      el("selectorPage").classList.add("is-hidden");
      el("gatePage").classList.remove("is-hidden");
      initGate();
    });
    el("selectPapanKosong").addEventListener("click", () => {
      window.location.href = window.location.pathname + "?kosong";
    });
    el("selectMateri").addEventListener("click", () => {
      alert("Bahas Materi segera hadir.");
    });
    el("selectKisiKata").addEventListener("click", () => {
      alert("Bahas KisiKata segera hadir.");
    });
  }

  // ====== GATE (input link/kode, mirror homeKode di quiz-runner) ======
  function initGate() {
    el("gateBackBtn").addEventListener("click", () => {
      window.location.href = window.location.pathname;
    });
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

    if (isBlank) {
      // Papan Kosong: tidak ada teks soal untuk ditampilkan -- cuma halaman
      // kosong siap dicoret. Panah navigasi otomatis tersembunyi karena
      // allQuestions cuma berisi 1 "halaman" (lihat CSS .hud-nav:disabled).
      el("boardContent").innerHTML = "";
      el("boardTitle").textContent = "Papan Kosong";
    } else {
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
    }
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
    baseValid = false;
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
    // Mulai menulis -> submenu alat menghilang (lihat closeToolPanel).
    closeToolPanel();
    const cfg = settings[tool];
    activeCfg = cfg;
    // Titik = [x, y, faktor lebar]. Faktor lebar (elemen ke-3) hanya dipakai
    // spidol; goresan lama tanpa elemen ini dibaca sebagai 1.
    const p0 = relPoint(e);
    activeRaw = [p0[0], p0[1]];
    activeVx = 0; activeVy = 0;
    p0.push(1);
    activeSpeed = 0;
    activeWf = 1;
    activeStroke = { tool, color: cfg.color || "#000000", size: cfg.size, points: [p0] };
    // Nilai lancip & lebar dinamis disimpan per goresan supaya goresan lama
    // tidak berubah bentuk kalau slider digeser sesudahnya.
    if (tool === "pen") {
      activeStroke.taper = cfg.taper;
      activeStroke.dyn = cfg.dynamic;
    }
    // Posisi layar (bukan relPoint -- itu satuan halaman yang berubah kalau
    // di-zoom, sedangkan kecepatan mau dihitung konsisten dalam px LAYAR)
    // + waktu, dipakai onPointerMove untuk mendeteksi "goresan cepat".
    lastMoveX = e.clientX;
    lastMoveY = e.clientY;
    lastMoveT = e.timeStamp;
  }

  function onPointerMove(e) {
    if (!activeStroke || e.pointerId !== activePointerId) return;
    const raw = relPoint(e);
    const pts = activeStroke.points;
    const prev = pts[pts.length - 1];

    // Goresan Cepat: alpha digeser dari nilai goresan pelan ke nilai goresan
    // cepat (lihat stabAlphas) berdasar kecepatan gerak layar sejak titik
    // sebelumnya -- interpolasi linear, diklem ke [0,1] di kedua ujung.
    const dt = Math.max(1, e.timeStamp - lastMoveT);
    const ddx = e.clientX - lastMoveX, ddy = e.clientY - lastMoveY;
    const dist = Math.hypot(ddx, ddy);
    const speed = dist / dt;
    activeVx = activeVx * 0.5 + (ddx / dt) * 0.5;
    activeVy = activeVy * 0.5 + (ddy / dt) * 0.5;
    activeRaw = raw;
    // Jari berhenti = tidak ada pointermove lagi; hilangkan ekstrapolasi
    // supaya garis tidak "menggantung" di depan jari.
    clearTimeout(predictTimer);
    predictTimer = setTimeout(() => {
      activeVx = 0; activeVy = 0;
      if (activeStroke) redrawCanvas();
    }, 60);
    lastMoveX = e.clientX;
    lastMoveY = e.clientY;
    lastMoveT = e.timeStamp;
    const t = Math.min(1, Math.max(0, (speed - SLOW_SPEED_PX_MS) / (FAST_SPEED_PX_MS - SLOW_SPEED_PX_MS)));
    const al = stabAlphas(activeCfg || settings.pen);
    const alpha = al.slow + (al.fast - al.slow) * t;

    // Stabilizer: titik yang disimpan bukan `raw` mentah, tapi hasil "tarikan"
    // sebagian dari titik sebelumnya ke arah `raw` (alpha adaptif di atas).
    // Lebar dinamis: kecepatan dihaluskan dulu (event pointermove tidak rata
    // selang waktunya), lalu faktor lebar ikut "ditarik" pelan ke target supaya
    // tepi goresan tidak bergerigi.
    if (activeStroke.tool === "pen" && activeCfg && activeCfg.dynamic > 0) {
      activeSpeed += (speed - activeSpeed) * 0.35;
      activeWf += (dynWidthTarget(activeSpeed, activeCfg.dynamic) - activeWf) * 0.3;
    }
    pts.push([
      prev[0] + (raw[0] - prev[0]) * alpha,
      prev[1] + (raw[1] - prev[1]) * alpha,
      Math.round(activeWf * 100) / 100
    ]);
    scheduleRedraw(); // maks 1x per frame (stylus bisa kirim >120 event/detik)
  }

  function onPointerUp(e) {
    if (!activeStroke || e.pointerId !== activePointerId) return;
    const stroke = activeStroke;
    const rawEnd = e.type === "pointerup" ? relPoint(e) : activeRaw;
    activeStroke = null;
    activePointerId = null;
    clearTimeout(predictTimer);
    activeRaw = null;

    if (stroke.points.length > 1) {
      // Ujung menyusul jari: stabilizer membuat titik terakhir tertinggal
      // dari tempat jari diangkat -- sambung sampai ke posisi jari.
      if (rawEnd) catchUpToFinger(stroke, rawEnd);
      // Shortcut hapus: coret-coret (zig-zag) dengan spidol di atas coretan
      // yang sudah ada = hapus coretan di area itu, goresan coret-coretnya
      // sendiri tidak disimpan.
      if (stroke.tool === "pen" && tryScribbleErase(stroke)) {
        redrawCanvas();
        return;
      }
      // Post-process (padanan mode Setelah ibisPaint): baru dihaluskan
      // sesudah lolos cek coret-hapus di atas -- kalau dihaluskan duluan,
      // zig-zag coret-hapus bisa ikut "dibulatkan" dan gagal terdeteksi.
      postSmoothStroke(stroke);
      recordAction({ type: "add", stroke, index: currentStrokes.length });
      currentStrokes.push(stroke);
      commitStrokes(stroke);
      return;
    }

    // Ketukan tanpa gerakan (1 titik) -- dulu dibuang begitu saja, padahal
    // guru butuh ini untuk menulis titik pada huruf "i", titik akhir kalimat,
    // dll. Sekarang disimpan juga, digambar sebagai titik solid (lihat
    // drawStroke) alih-alih diabaikan.
    recordAction({ type: "add", stroke, index: currentStrokes.length });
    currentStrokes.push(stroke);
    commitStrokes(stroke);
  }

  // Sambung titik terakhir (hasil stabilizer, tertinggal) ke posisi jari saat
  // diangkat, dibagi jadi beberapa langkah kecil (~6px layar) supaya jadi
  // ekor yang halus, bukan satu garis patah. Lebar mengikuti titik terakhir.
  function catchUpToFinger(stroke, rawEnd) {
    const pts = stroke.points;
    const last = pts[pts.length - 1];
    const dx = (rawEnd[0] - last[0]) * pageW * view.s;
    const dy = (rawEnd[1] - last[1]) * pageH * view.s;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.5) return;
    const steps = Math.min(10, Math.max(1, Math.round(dist / 6)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      pts.push([last[0] + (rawEnd[0] - last[0]) * t, last[1] + (rawEnd[1] - last[1]) * t, last[2]]);
    }
  }

  // Versi sementara goresan aktif untuk DIGAMBAR (bukan disimpan): titik-titik
  // stabilizer + posisi jari sebenarnya + ekstrapolasi singkat ke depan.
  function livePreviewStroke() {
    const pts = activeStroke.points;
    if (!activeRaw || pts.length < 2) return activeStroke;
    const last = pts[pts.length - 1];
    const ext = pts.slice();
    ext.push([activeRaw[0], activeRaw[1], last[2]]);
    let ex = activeVx * PREDICT_MS, ey = activeVy * PREDICT_MS;
    const m = Math.hypot(ex, ey);
    if (m > 0.5) {
      if (m > PREDICT_MAX_PX) { ex *= PREDICT_MAX_PX / m; ey *= PREDICT_MAX_PX / m; }
      ext.push([activeRaw[0] + ex / (pageW * view.s), activeRaw[1] + ey / (pageH * view.s), last[2]]);
    }
    return Object.assign({}, activeStroke, { points: ext });
  }

  // ====== POST-PROCESS SMOOTHING (padanan "Stabilisator" mode Setelah) ======
  // Dipanggil SEKALI di onPointerUp, sesudah goresan selesai (bukan sambil
  // jalan seperti stabilizer). Tiap titik digeser ke rata-rata posisi
  // titik-titik tetangganya (moving average) -- meratakan getaran kecil yang
  // lolos dari redaman real-time, tanpa mengubah bentuk besar goresan.
  // Titik pertama & terakhir SENGAJA tidak ikut digeser, supaya goresan tetap
  // mulai & berakhir persis di titik jari turun/naik (endpoint presisi tetap
  // penting, mis. buat nyambung ke goresan berikutnya).
  function postSmoothStroke(stroke) {
    const pts = stroke.points;
    const r = postSmoothRadius(settings[stroke.tool] || settings.pen);
    if (r <= 0 || pts.length < 3) return;
    const smoothed = pts.map((p, i) => {
      if (i === 0 || i === pts.length - 1) return p;
      let sx = 0, sy = 0, sw = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const j = i + k;
        if (j < 0 || j >= pts.length) continue;
        sx += pts[j][0]; sy += pts[j][1];
        sw += pts[j][2] === undefined ? 1 : pts[j][2];
        n++;
      }
      return [sx / n, sy / n, Math.round(sw / n * 100) / 100];
    });
    stroke.points = smoothed;
  }

  // 3 tool (blueprint 18.2/17.7... err 18.3): pen = tinta biasa, highlight =
  // stabilo (lebih tebal, transparan, blend "multiply" supaya teks di
  // bawahnya tetap kebaca), eraser = destination-out (menghapus pixel yang
  // sudah digambar, bukan cuma menimpa warna putih).
  // ====== GORESAN LANCIP + LEBAR DINAMIS (pen) ======
  // Digambar sebagai satu bentuk terisi yang lebarnya berubah di sepanjang
  // goresan. Lebar tiap titik = ketebalan x faktor lebar titik (kecepatan, lihat
  // dynWidthTarget) x profil runcing di ujung.
  //
  // `a` (0-1) = nilai slider Lancip / 100; 0 = tanpa runcing (tapi lebar
  // dinamis tetap jalan). Satu nilai mengatur dua hal:
  //   - PANJANG runcing: `a` x 6 x ketebalan, dibatasi porsi panjang goresan
  //     (ujung 38%, pangkal 25%) supaya goresan pendek tidak jadi "jarum" utuh.
  //     Pangkal lebih pendek dari ujung: pena asli membuka cepat di awal dan
  //     menyapu panjang di akhir.
  //   - KETIPISAN ujung: 0.6 x (1-a)^3 x lebar penuh -- di atas Lancip ~35
  //     ujungnya praktis nol, jadi runcing yang sampai ke titik, bukan dipotong.
  // Profil runcing CEMBUNG (campuran 1-(1-t)^2 dan smoothstep): dari ujung lebar cepat membuka lalu
  // melandai halus ke badan goresan, seperti sapuan kuas -- bukan baji lurus.
  function drawTaperedPen(pts, w, h, lw, color, a) {
    // Titik -> px halaman; titik yang nyaris menumpuk dibuang supaya arah
    // tegak lurusnya tidak jadi acak.
    const P = [];
    for (const p of pts) {
      const x = p[0] * w, y = p[1] * h;
      const last = P[P.length - 1];
      if (!last || Math.hypot(x - last[0], y - last[1]) > 0.05) {
        P.push([x, y, p[2] === undefined ? 1 : p[2]]);
      }
    }
    const n = P.length;
    if (n < 2) return; // goresan nyaris diam di tempat -- tidak ada yang digambar

    const cum = [0];
    for (let i = 1; i < n; i++) {
      cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    }
    const total = cum[n - 1];

    const half = lw / 2;
    const tip = 0.6 * Math.pow(1 - a, 3);
    const endLen = Math.min(total * 0.42, Math.max(lw * 2 * a, total * 0.34 * a));
    const startLen = endLen * 0.6;
    const prof = (t) => {
      const c = Math.min(1, Math.max(0, t));
      const convex = 1 - (1 - c) * (1 - c);
      const smooth = c * c * (3 - 2 * c);
      return tip + (1 - tip) * (0.6 * convex + 0.4 * smooth);
    };
    const halfW = cum.map((d, i) => half * P[i][2] * Math.min(
      startLen > 0 ? prof(d / startLen) : 1,
      endLen > 0 ? prof((total - d) / endLen) : 1
    ));

    // Sisi kiri/kanan: tiap titik digeser tegak lurus arah gerak. Arah diambil
    // dari titik 2 langkah sebelum & sesudahnya (bukan 1) supaya sisi goresan
    // tidak bergerigi oleh getaran kecil.
    const left = [], right = [];
    for (let i = 0; i < n; i++) {
      const p0 = P[Math.max(0, i - 2)];
      const p1 = P[Math.min(n - 1, i + 2)];
      const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      left.push([P[i][0] + nx * halfW[i], P[i][1] + ny * halfW[i]]);
      right.push([P[i][0] - nx * halfW[i], P[i][1] - ny * halfW[i]]);
    }

    // Sisi kiri maju, sisi kanan mundur, disambung jadi satu bentuk tertutup
    // lalu diisi. Sisi digambar kurva mid-point (bukan lineTo lurus) supaya
    // tidak berfaset.
    const trace = (arr, first) => {
      if (first) ctx.moveTo(arr[0][0], arr[0][1]); else ctx.lineTo(arr[0][0], arr[0][1]);
      for (let i = 1; i < arr.length - 1; i++) {
        ctx.quadraticCurveTo(arr[i][0], arr[i][1],
          (arr[i][0] + arr[i + 1][0]) / 2, (arr[i][1] + arr[i + 1][1]) / 2);
      }
      ctx.lineTo(arr[arr.length - 1][0], arr[arr.length - 1][1]);
    };
    ctx.beginPath();
    trace(left, true);
    trace(right.slice().reverse(), false);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    // Ujung tumpul ditutup bulat, bukan dipotong lurus.
    [0, n - 1].forEach(i => {
      if (halfW[i] < 0.15) return;
      ctx.beginPath();
      ctx.arc(P[i][0], P[i][1], halfW[i], 0, Math.PI * 2);
      ctx.fill();
    });
  }

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

    // Spidol dengan Lancip > 0 atau Lebar dinamis > 0 -- lebar berubah di
    // sepanjang goresan, meniru pena tinta asli. Keduanya 0 = jatuh ke render
    // pena biasa di bawah (lebar rata). Digambar sebagai bentuk terisi
    // (bukan ctx.stroke() lebar tetap) supaya ketebalannya bisa berubah di
    // sepanjang goresan. Stabilo & penghapus SENGAJA tetap rata (stabilo
    // memang berbentuk flat, penghapus tidak perlu efek ini) -- lanjut ke
    // render lama di bawah.
    const taper = stroke.tool === "pen"
      ? (typeof stroke.taper === "number" ? stroke.taper : DEFAULT_SETTINGS.pen.taper)
      : 0;
    const dyn = stroke.tool === "pen" && stroke.dyn > 0;
    if (taper > 0 || dyn) {
      drawTaperedPen(pts, w, h, lw, stroke.color, taper / 100);
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

  function baseIsCurrent() {
    return baseValid && baseView.s === view.s && baseView.tx === view.tx && baseView.ty === view.ty;
  }

  // Gambar ulang SEMUA goresan selesai ke cache luar-layar (drawStroke memakai
  // `ctx` global, jadi ditukar sebentar -- pola sama dengan drawPanelPreview).
  function renderBase() {
    const dpr = window.devicePixelRatio || 1;
    if (!baseCanvas) { baseCanvas = document.createElement("canvas"); baseCtx = baseCanvas.getContext("2d"); }
    if (baseCanvas.width !== canvas.width || baseCanvas.height !== canvas.height) {
      baseCanvas.width = canvas.width;
      baseCanvas.height = canvas.height;
    }
    baseCtx.setTransform(1, 0, 0, 1, 0, 0);
    baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
    baseCtx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.tx, dpr * view.ty);
    const real = ctx;
    ctx = baseCtx;
    try { currentStrokes.forEach(drawStroke); } finally { ctx = real; }
    baseView = { s: view.s, tx: view.tx, ty: view.ty };
    baseValid = true;
  }

  // Tempel satu goresan baru ke cache (urutan tetap benar: goresan baru selalu
  // paling akhir), tanpa membangun ulang cache.
  function drawOnBase(stroke) {
    const dpr = window.devicePixelRatio || 1;
    baseCtx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.tx, dpr * view.ty);
    const real = ctx;
    ctx = baseCtx;
    try { drawStroke(stroke); } finally { ctx = real; }
  }

  function redrawCanvas() {
    const dpr = window.devicePixelRatio || 1;
    if (!baseIsCurrent()) renderBase();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(baseCanvas, 0, 0);
    if (activeStroke) {
      ctx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.tx, dpr * view.ty);
      drawStroke(livePreviewStroke());
    }
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
    // Geser SENGAJA tidak diklem ke suatu batas "halaman" lagi -- guru boleh
    // menjelajah bebas ke segala arah tanpa mentok, di semua mode (soal
    // ataupun Papan Kosong). Supaya tidak tersesat, ada tombol reset ke
    // ukuran normal (lihat resetViewBtn di initToolbar) alih-alih dibatasi
    // otomatis seperti sebelumnya.
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
  // `appended` = goresan yang baru saja ditambahkan di akhir daftar: cukup
  // ditempel ke cache. Perubahan lain (undo/redo/hapus) membuang cache.
  function commitStrokes(appended) {
    const no = allQuestions[current].no;
    if (currentStrokes.length) strokesByQuiz[no] = currentStrokes;
    else delete strokesByQuiz[no];
    saveStrokesToStorage();
    if (appended && baseIsCurrent()) drawOnBase(appended);
    else baseValid = false;
    redrawCanvas();
  }

  function doUndo() {
    const st = stacksFor(allQuestions[current].no);
    let action = st.undo.pop();
    if (!action) {
      // Riwayat kosong (mis. halaman baru dibuka ulang, coretan lama dimuat
      // dari localStorage): mundurkan coretan terakhir yang tersimpan.
      if (!currentStrokes.length) { showToast("Tidak ada yang bisa di-undo"); return false; }
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
    return true;
  }

  function doRedo() {
    const st = stacksFor(allQuestions[current].no);
    const action = st.redo.pop();
    if (!action) { showToast("Tidak ada yang bisa di-redo"); return false; }
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
    return true;
  }

  // Getar singkat sebagai konfirmasi gestur tak terlihat. Diam-diam tidak
  // melakukan apa-apa di perangkat/browser tanpa Vibration API (mis. iOS).
  function haptic(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (err) { /* diamkan */ }
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
    haptic(HAPTIC.erase);
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
    window.addEventListener("blur", () => { touches.clear(); gesture = null; gestureLock = false; penDown = false; });
    board.addEventListener("wheel", onWheel, { passive: false });
  }

  // Palm rejection. Stylus menyentuh/melayang -> semua sentuhan jari yang ada
  // dan yang menyusul diabaikan (telapak yang menempel saat menulis).
  function penNear(now) {
    return penDown || (now - lastPenT) < PALM_GRACE_MS;
  }
  function isPalmLike(e) {
    return Math.max(e.width || 0, e.height || 0) >= PALM_SIZE_PX;
  }

  function onTouchDown(e) {
    if (e.pointerType === "pen") {
      penDown = true;
      lastPenT = e.timeStamp;
      touches.forEach(v => { v.ignored = true; });
      if (gesture) { gesture = null; gestureLock = true; }
      return;
    }
    if (e.pointerType !== "touch") return;
    const t = { x: e.clientX, y: e.clientY, t0: e.timeStamp, ignored: false };
    const valid = [...touches.values()].filter(v => !v.ignored);

    let startsGesture = false;
    if (penNear(e.timeStamp) || isPalmLike(e)) {
      t.ignored = true;                        // telapak / sentuhan dekat stylus
    } else if (gestureLock || gesture || valid.length >= 2) {
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
    if (e.pointerType === "pen") { lastPenT = e.timeStamp; return; } // termasuk melayang
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
    if (e.pointerType === "pen") { penDown = false; lastPenT = e.timeStamp; return; }
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
      if (doRedo()) haptic(HAPTIC.redo);
      return;
    }
    tapTimer = setTimeout(() => { tapCount = 0; if (doUndo()) haptic(HAPTIC.undo); }, DOUBLE_TAP_MS);
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
  // Baris submenu yang tampil per alat (data-key di index.html).
  const PANEL_ROWS = {
    pen: ["preset", "color", "size", "taper", "dynamic", "smooth", "stabilizer", "quick"],
    highlight: ["color", "size", "smooth", "stabilizer", "quick"],
    eraser: ["size"]
  };
  let panelOpen = false;

  function openToolPanel() {
    panelOpen = true;
    el("toolPanel").classList.remove("is-hidden");
    syncToolPanel();
  }

  function closeToolPanel() {
    panelOpen = false;
    const panel = el("toolPanel");
    if (panel) panel.classList.add("is-hidden");
  }

  // Isi submenu = pengaturan alat yang aktif: baris yang relevan, nilai
  // slider, swatch aktif, dan pratinjau goresan.
  function syncToolPanel() {
    const cfg = settings[tool];
    const rows = PANEL_ROWS[tool];
    if (!cfg || !rows) return;
    const panel = el("toolPanel");
    panel.querySelectorAll("[data-key]").forEach(row => {
      row.classList.toggle("is-hidden", !rows.includes(row.dataset.key));
    });
    Object.entries({ size: "setSize", taper: "setTaper", dynamic: "setDyn", smooth: "setSmooth", stabilizer: "setStab", quick: "setQuick" })
      .forEach(([key, id]) => {
        if (!(key in cfg)) return;
        el(id).value = cfg[key];
        panel.querySelector('[data-key="' + key + '"] output').textContent = cfg[key];
      });
    panel.querySelectorAll(".swatch").forEach(b => {
      b.classList.toggle("active", !!cfg.color && b.dataset.color.toLowerCase() === cfg.color.toLowerCase());
    });
    el("panelPreview").classList.toggle("is-hidden", tool === "eraser");
    updatePresetChips();
    drawPanelPreview();
  }

  // Chip preset menyala kalau semua nilai slider spidol persis sama dengan
  // preset itu (otomatis mati begitu ada slider yang digeser).
  function updatePresetChips() {
    document.querySelectorAll(".preset-chip").forEach(b => {
      const p = PRESETS[b.dataset.preset];
      const on = tool === "pen" && !!p && Object.keys(p).every(k => settings.pen[k] === p[k]);
      b.classList.toggle("active", on);
    });
  }

  // Pratinjau memakai drawStroke yang SAMA dengan goresan asli (kanvas
  // ctx ditukar sebentar) -- jadi yang terlihat di sini persis hasil menulis.
  // Titik contoh dinyatakan relatif ke pageW/pageH karena drawStroke
  // mengalikannya dengan ukuran halaman. Stabilizer/Konstan/Goresan Cepat
  // bergantung pada gerak jari, jadi tidak bisa dipratinjau statis.
  function drawPanelPreview() {
    const cv = el("panelPreview");
    if (!cv || tool === "eraser" || !pageW || !pageH) return;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return; // panel sedang tersembunyi
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    const pctx = cv.getContext("2d");
    pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pctx.clearRect(0, 0, W, H);
    const N = 56, pts = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const x = 20 + t * (W - 40);
      const y = H / 2 + Math.sin(t * Math.PI * 2.6) * H * 0.2 * (0.6 + 0.4 * t);
      // Kecepatan contoh: pelan di awal, cepat di tengah, pelan lagi di akhir.
      const wf = tool === "pen" ? dynWidthTarget(0.05 + 1.5 * Math.sin(t * Math.PI), settings.pen.dynamic) : 1;
      pts.push([x / pageW, y / pageH, wf]);
    }
    const cfg = settings[tool];
    const sample = { tool, color: cfg.color, size: cfg.size, points: pts };
    if (tool === "pen") { sample.taper = cfg.taper; sample.dyn = cfg.dynamic; }
    const real = ctx;
    ctx = pctx;
    try { drawStroke(sample); } finally { ctx = real; }
  }

  // Titik warna kecil di bawah ikon spidol/stabilo (pengganti tombol warna
  // yang dulu ada di dock).
  function updateDockColors() {
    document.querySelectorAll(".dock-btn[data-tool]").forEach(b => {
      const cfg = settings[b.dataset.tool];
      if (cfg && cfg.color) b.style.setProperty("--c", cfg.color);
    });
  }

  function setTool(t) {
    tool = t;
    document.querySelectorAll(".dock-btn[data-tool]").forEach(b => {
      b.classList.toggle("active", b.dataset.tool === t);
    });
    el("refImages").classList.toggle("editable", t === "select");
    // Submenu ikut alat: alat tanpa submenu (pilih gambar) menutupnya, alat
    // lain (mis. dari spidol pindah ke stabilo) memuat ulang isinya.
    if (!PANEL_ROWS[t]) closeToolPanel(); else if (panelOpen) syncToolPanel();
    // Kanvas coretan sekarang di layer PALING ATAS (z-index tertinggi, supaya
    // goresan selalu kelihatan di atas gambar referensi) -- kalau dibiarkan
    // begitu saat tool "Pilih Gambar" aktif, kanvas akan menelan semua
    // sentuhan sebelum sampai ke gambar di bawahnya. Makanya di tool ini
    // kanvas sengaja "ditembuskan" (pointer-events:none).
    canvas.style.pointerEvents = t === "select" ? "none" : "";
  }

  function initToolbar() {
    // Reset ke ukuran normal (s=1, tx=0, ty=0) -- pengganti klem geser lama
    // (clampView) yang sekarang dihapus supaya guru bebas menjelajah ke
    // segala arah; tombol ini jadi satu-satunya cara "pulang" kalau tersesat.
    el("resetViewBtn").addEventListener("click", () => {
      view = { s: 1, tx: 0, ty: 0 };
      applyView(true);
    });

    document.querySelectorAll(".dock-btn[data-tool]").forEach(btn => {
      btn.addEventListener("click", () => {
        const t = btn.dataset.tool;
        const wasActive = tool === t;
        setTool(t);
        if (!PANEL_ROWS[t]) return;
        // Ketuk alat yang sedang terbuka submenunya = tutup; selain itu buka.
        if (wasActive && panelOpen) closeToolPanel(); else openToolPanel();
      });
    });
    setTool(tool); // sinkronkan class .editable di awal (tool default = "pen")

    // Submenu alat: muncul saat tombol alat diketuk, hilang begitu mulai
    // menulis (lihat onPointerDown) atau pindah ke alat tanpa submenu.
    const SLIDERS = { size: "setSize", taper: "setTaper", dynamic: "setDyn", smooth: "setSmooth", stabilizer: "setStab", quick: "setQuick" };
    Object.keys(SLIDERS).forEach(key => {
      const input = el(SLIDERS[key]);
      input.addEventListener("input", () => {
        const v = Number(input.value);
        settings[tool][key] = v;
        el("toolPanel").querySelector('[data-key="' + key + '"] output').textContent = v;
        updatePresetChips();
        drawPanelPreview();
      });
      input.addEventListener("change", saveSettings);
    });

    document.querySelectorAll(".preset-chip").forEach(btn => {
      btn.addEventListener("click", () => {
        const p = PRESETS[btn.dataset.preset];
        if (!p || tool !== "pen") return;
        Object.assign(settings.pen, p); // warna tidak ikut
        syncToolPanel();
        saveSettings();
      });
    });

    document.querySelectorAll(".swatch").forEach(btn => {
      btn.addEventListener("click", () => {
        if (!settings[tool] || !("color" in settings[tool])) return;
        settings[tool].color = btn.dataset.color;
        syncToolPanel();
        updateDockColors();
        saveSettings();
      });
    });
    updateDockColors();

    // M8.4: "Hapus Semua Coretan" -- beda dari tool penghapus/eraser (yang
    // cuma menghapus sebagian coretan di satu soal). Ini menghapus SEMUA
    // soal di kuis ini sekaligus, makanya perlu konfirmasi.
    el("clearAllBtn").addEventListener("click", () => {
      // Papan Kosong tidak "berganti" saat navigasi seperti soal -- satu-
      // satunya cara memulai halaman baru adalah tombol ini (blueprint 20.7,
      // "Bersihkan Layar"). Pesannya disesuaikan supaya jelas beda dari
      // "Hapus Semua Coretan" yang di-scope ke satu kuis (M8.4).
      const msg = isBlank
        ? "Bersihkan papan kosong ini? Tidak bisa dibatalkan."
        : "Hapus semua coretan di SEMUA soal kuis ini? Tidak bisa dibatalkan.";
      if (!confirm(msg)) return;
      strokesByQuiz = {};
      currentStrokes = [];
      Object.keys(undoStacks).forEach(k => delete undoStacks[k]);
      Object.keys(redoStacks).forEach(k => delete redoStacks[k]);
      try { localStorage.removeItem(quizKey); } catch (err) { /* diamkan */ }
      baseValid = false;
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

  // ====== PAPAN KOSONG (blueprint 20.7) ======
  // Tidak butuh SCRIPT_URL/soal sama sekali -- langsung buka papan dengan
  // 1 "halaman" sintetis (no: "kosong") supaya semua fungsi lain (stroke,
  // undo/redo, gambar referensi, dst) yang sudah mengasumsikan
  // allQuestions[current].no tetap jalan apa adanya, tanpa cabang khusus.
  function enterBlankBoard() {
    isBlank = true;
    el("selectorPage").classList.add("is-hidden");
    el("gatePage").classList.add("is-hidden");
    el("boardPage").classList.remove("is-hidden");

    initCanvas();
    initGestures();
    initToolbar();

    allQuestions = [{ no: "kosong" }];
    quizKey = "coretan_kosong";
    loadStrokesFromStorage();
    renderQuestion(0);
  }

  // ====== INIT ======
  document.addEventListener("DOMContentLoaded", async () => {
    const rawQuery = window.location.search.startsWith("?") ? window.location.search.slice(1) : "";

    // Tanpa query string sama sekali: titik masuk paling awal, tampilkan
    // selector "Bahas Apa?" (blueprint 20.7) alih-alih langsung gate seperti
    // sebelumnya.
    if (!rawQuery) {
      initSelector();
      return;
    }

    // "?kosong": dipicu dari selector (lihat initSelector) -- reload dengan
    // query ini supaya bisa langsung dibuka lagi lain kali tanpa lewat
    // selector dulu (mis. dibookmark), sama seperti pola ?src=/?<kode>.
    if (rawQuery === "kosong") {
      enterBlankBoard();
      return;
    }

    // Flow kuis biasa (?src=... atau ?<kode>, lewat gate atau link langsung
    // dari guru/Wizard). Bug lama: pakai atribut `hidden` di sini kalah
    // spesifisitas lawan CSS .gate{display:flex} / .board-page{...} -- dua
    // halaman kelihatan bersamaan. Class .is-hidden{display:none!important}
    // di CSS selalu menang.
    el("selectorPage").classList.add("is-hidden");
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
