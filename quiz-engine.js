// quiz-engine.js
// LOGIC GENERIK - jangan diubah per paket kuis. Semua data soal/kunci datang dari
// Apps Script, lewat URL yang di-resolve oleh resolveScriptUrl(): APPS_SCRIPT_URL
// dari config.js (paket M5 lama) kalau ada, kalau tidak fallback ke parameter
// ?src= di query string (dipakai quiz-runner M6.2+).
//
// Bergantung pada struktur HTML & class CSS yang sama seperti di quiz.html:
//   #progress, #content, #introPage, #resultPage, #backBtn, #nextBtn,
//   #nama, #kelas, #studentInfo, #score, #review, .page, .card, .option, dst.
// Elemen berikut OPSIONAL, dipakai kalau ada (mis. di quiz-runner/index.html, M6.2.3),
// aman diabaikan kalau tidak ada (mis. quiz.html paket M5 lama):
//   #quizTitle, #quizBrand, #quizDesc, #badgePG, #badgeEssay.

(function () {
  let soalPG = [];      // [{no, soal, opsi:{A,B,C,D}}]
  let soalEssay = [];   // [{no, soal}]
  let allQuestions = []; // gabungan PG + essay, urut, dipakai untuk navigasi & progress
  let jawaban = {};      // {no: "A" | "teks essay"}
  let current = 0;       // 0 = intro, 1..N = soal, N+1 = result
  let submitting = false;
  let SCRIPT_URL = null;    // di-resolve oleh resolveScriptUrl() saat init
  let IS_RUNNER_MODE = false; // true kalau URL datang dari ?src= (bukan config.js)

  function el(id) { return document.getElementById(id); }

  function pages() {
    return [...document.querySelectorAll(".page")];
  }

  // ====== RESOLVE URL APPS SCRIPT ======
  // Prioritas:
  //   1. APPS_SCRIPT_URL dari config.js — paket M5 lama yang sudah beredar,
  //      tetap harus jalan tanpa perubahan (backward-compatible). Kalau lewat jalur
  //      ini, IS_RUNNER_MODE tetap false -> loadConfig() tidak dipanggil (16.6/16.7:
  //      quiz.html lama tidak punya tab Config yang relevan untuk ditampilkan).
  //   2. Parameter ?src= di query string — dipakai oleh quiz-runner terpusat (M6.2+,
  //      lihat blueprint bagian 16.6). URLSearchParams.get() sudah otomatis decode.
  //      Jalur ini menandai IS_RUNNER_MODE = true.
  function resolveScriptUrl() {
    if (typeof APPS_SCRIPT_URL !== "undefined" && APPS_SCRIPT_URL) {
      IS_RUNNER_MODE = false;
      return APPS_SCRIPT_URL;
    }
    IS_RUNNER_MODE = true;
    const src = new URLSearchParams(window.location.search).get("src");
    return src ? src.trim() : null;
  }

  // ====== LOAD CONFIG (mode runner saja) ======
  // Dipanggil paralel dengan loadSoal(), tidak saling blocking. Gagal/timeout di sini
  // TIDAK BOLEH bikin quiz-runner blank/error -- fallback diam-diam ke teks generik
  // yang sudah ada di HTML (lihat blueprint 16.6 & getConfigData() di Code.gs yang
  // juga selalu balikin default kalau tab Config kosong).
  async function loadConfig() {
    if (!IS_RUNNER_MODE || !SCRIPT_URL) return;
    try {
      const res = await fetch(SCRIPT_URL + "?action=config");
      const data = await res.json();
      if (!data.ok || !data.config) return;
      applyConfig(data.config);
    } catch (err) {
      // sengaja diam -- biarkan teks generik bawaan HTML tetap tampil
    }
  }

  function applyConfig(config) {
    // Semua elemen di sini opsional (lihat komentar header file) -- setiap akses
    // di-guard dengan "if" supaya aman dipakai bareng quiz.html lama (M5) yang
    // tidak punya elemen-elemen ini sama sekali.
    if (config.judul_kuis) {
      document.title = config.judul_kuis;
      const titleEl = el("quizTitle");
      if (titleEl) titleEl.textContent = config.judul_kuis;
    }
    if (config.brand) {
      const brandEl = el("quizBrand");
      if (brandEl) brandEl.textContent = config.brand;
    }
    if (config.deskripsi) {
      const descEl = el("quizDesc");
      if (descEl) descEl.textContent = config.deskripsi;
    }
    if (config.warna_tema) {
      document.documentElement.style.setProperty("--accent", config.warna_tema);
    }
  }

  // Badge jumlah soal ("N Pilihan Ganda" / "N Essay") -- dihitung dari data soal asli
  // (bukan dari Config), jadi selalu akurat berapa pun jumlah soalnya. Dipanggil
  // setelah loadSoal() sukses. Elemen opsional, sama seperti applyConfig().
  function updateBadges() {
    const pgBadge = el("badgePG");
    if (pgBadge) pgBadge.textContent = soalPG.length + " Pilihan Ganda";
    const essayBadge = el("badgeEssay");
    if (essayBadge) essayBadge.textContent = soalEssay.length + " Essay";
  }

  // ====== LOAD SOAL ======

  async function loadSoal() {
    if (!SCRIPT_URL) {
      // Pesan dibedakan per mode (M6.2.4): di runner tidak ada config.js sama sekali,
      // jadi menyebutnya cuma bikin bingung -- fokus ke penyebab yang relevan buat mode ini.
      const msg = IS_RUNNER_MODE
        ? "Link kuis ini tidak lengkap (parameter ?src= tidak ada). Minta link kuis yang benar dari guru."
        : "URL Apps Script tidak ditemukan. Pastikan config.js berisi APPS_SCRIPT_URL.";
      setIntroLoading(false, msg);
      return;
    }
    setIntroLoading(true);
    try {
      const res = await fetch(SCRIPT_URL + "?action=getSoal");
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Gagal memuat soal");
      soalPG = data.soalPG || [];
      soalEssay = data.soalEssay || [];
      // M6.2.4: getSoalData() di Code.gs TIDAK throw kalau Sheet "Soal" ada tapi
      // masih kosong (belum diisi baris soal) -- balikin ok:true dengan array kosong.
      // Tanpa guard ini, nextBtn akan tampak aktif normal ("Mulai Quiz") padahal next()
      // diam-diam menolak lanjut kalau allQuestions kosong -- siswa klik, tidak terjadi
      // apa-apa, tanpa pesan. Tangani eksplisit di sini supaya ada pesan yang jelas.
      if (soalPG.length === 0 && soalEssay.length === 0) {
        setIntroLoading(false, 'Kuis ini belum ada soal (Sheet "Soal" masih kosong). Hubungi guru/pembuat kuis.');
        return;
      }
      allQuestions = [...soalPG, ...soalEssay];
      buildPages();
      updateBadges();
      setIntroLoading(false);
    } catch (err) {
      setIntroLoading(false, "Gagal memuat soal. Cek koneksi internet, lalu muat ulang halaman.\n(" + err + ")");
    }
  }

  function setIntroLoading(loading, errorMsg) {
    const btn = el("nextBtn");
    if (!btn) return;
    if (errorMsg) {
      btn.disabled = true;
      let box = el("loadError");
      if (!box) {
        box = document.createElement("p");
        box.id = "loadError";
        box.style.color = "var(--bad, #e55353)";
        box.style.fontSize = "13px";
        el("introPage").querySelector(".card").appendChild(box);
      }
      box.textContent = errorMsg;
      return;
    }
    btn.disabled = loading;
    btn.textContent = loading ? "Memuat soal..." : "Mulai Quiz";
  }

  // ====== BANGUN HALAMAN SOAL SECARA DINAMIS ======

  function buildPages() {
    const content = document.querySelector(".content");
    const resultPage = el("resultPage");

    allQuestions.forEach((q, i) => {
      const index = i + 1;
      const isEssay = q.opsi === undefined;
      const section = document.createElement("section");
      section.className = "page";
      section.dataset.index = String(index);

      const label = isEssay ? "Essay" : "Pilihan Ganda";
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML =
        `<div class="question-no">Soal ${index} dari ${allQuestions.length}${isEssay ? " • Essay" : ""}</div>` +
        `<h2>${escapeHtml(q.soal)}</h2>`;

      if (isEssay) {
        const textarea = document.createElement("textarea");
        textarea.dataset.q = q.no;
        textarea.placeholder = "Tulis jawabanmu di sini...";
        textarea.value = jawaban[q.no] || "";
        textarea.addEventListener("input", () => {
          jawaban[q.no] = textarea.value;
        });
        card.appendChild(textarea);
      } else {
        const box = document.createElement("div");
        box.className = "options";
        box.dataset.q = q.no;
        Object.entries(q.opsi).forEach(([letter, text]) => {
          const optLabel = document.createElement("label");
          optLabel.className = "option";
          optLabel.innerHTML =
            `<input type="radio" name="q${q.no}" value="${letter}"><span class="letter">${letter}</span>${escapeHtml(text)}`;
          optLabel.onclick = () => {
            box.querySelectorAll(".option").forEach(x => x.classList.remove("selected"));
            optLabel.classList.add("selected");
            jawaban[q.no] = letter;
          };
          box.appendChild(optLabel);
        });
        card.appendChild(box);
      }

      section.appendChild(card);
      content.insertBefore(section, resultPage);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  // ====== NAVIGASI ======

  function show(index) {
    const total = allQuestions.length;
    pages().forEach(p => p.classList.remove("active"));
    const p = index === total + 1 ? el("resultPage") : pages()[index];
    p.classList.add("active");
    current = index;

    el("progress").style.width = (index === total + 1 ? 100 : (total ? index / total * 100 : 0)) + "%";
    el("backBtn").disabled = index === 0;
    el("nextBtn").textContent =
      index === 0 ? "Mulai Quiz" : index === total ? "Kumpulkan Jawaban" : "Lanjut";

    const isResult = index === total + 1;
    el("backBtn").style.display = isResult ? "none" : "";
    el("nextBtn").style.display = isResult ? "none" : "";

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function next() {
    const total = allQuestions.length;
    if (current === 0) {
      if (soalPG.length === 0 && soalEssay.length === 0) return; // belum selesai load
      show(1);
      return;
    }
    if (current < total) {
      show(current + 1);
      return;
    }
    finish();
  }

  function back() {
    if (current > 0) show(current - 1);
  }

  // ====== SUBMIT ======

  async function finish() {
    if (submitting) return;
    submitting = true;
    const btn = el("nextBtn");
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Mengirim...";

    const nama = el("nama").value.trim() || "Siswa";
    const kelas = el("kelas").value.trim() || "-";

    if (!SCRIPT_URL) {
      alert("URL Apps Script tidak ditemukan. Muat ulang halaman ini lewat link kuis yang benar.");
      btn.disabled = false;
      btn.textContent = originalText;
      submitting = false;
      return;
    }

    try {
      const res = await fetch(SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" }, // hindari CORS preflight
        body: JSON.stringify({ nama, kelas, jawaban })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Gagal mengirim jawaban");
      renderResult(nama, kelas, data);
      show(allQuestions.length + 1);
    } catch (err) {
      alert("Gagal mengirim jawaban. Cek koneksi internet lalu coba lagi.\n(" + err + ")");
      btn.disabled = false;
      btn.textContent = originalText;
      submitting = false;
      return;
    }
    submitting = false;
  }

  function renderResult(nama, kelas, data) {
    el("studentInfo").textContent = `${nama} • ${kelas}`;
    el("score").textContent = `${data.skor}/${data.totalSoalPG * 10}`;

    let reviewHtml = "<h3>Hasil Pilihan Ganda</h3>";
    (data.review || []).forEach(r => {
      if (r.benar) {
        reviewHtml += `<div class="correct"><strong>Soal ${r.no}: Benar ✓</strong></div>`;
      } else {
        reviewHtml += `<div class="wrong"><strong>Soal ${r.no}: Salah ✗</strong> — Jawaban benar: ${r.jawabanBenar}</div>`;
      }
    });
    if (soalEssay.length > 0) {
      reviewHtml += '<p class="small">Essay belum dinilai otomatis.</p>';
    }
    el("review").innerHTML = reviewHtml;
  }

  // ====== INIT ======

  window.next = next;
  window.back = back;

  document.addEventListener("DOMContentLoaded", () => {
    show(0);
    SCRIPT_URL = resolveScriptUrl();
    loadConfig(); // fire-and-forget, tidak nunggu ini selesai buat mulai loadSoal()
    loadSoal();
  });
})();
