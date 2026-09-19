// wizard.js - Setup Wizard (M6.3, blueprint 16.5)
// Halaman statis terpusat (digabung dengan quiz-runner di hosting yang sama, M6.4).
// Tidak butuh backend sendiri: request setConfig & getSoal dikirim LANGSUNG dari browser
// guru ke URL Apps Script guru -- wizard tidak pernah menyimpan data (judul, warna, dst)
// di server manapun.
//
// Alur (lihat blueprint 16.5):
//   1. Validasi ringan format URL Apps Script SEBELUM kirim request.
//   2. POST {action:"setConfig", config:{judul_kuis, brand, deskripsi, warna_tema}}.
//      Content-Type text/plain (bukan application/json) supaya tidak kena preflight
//      OPTIONS yang tidak ditangani Apps Script -- sama seperti quiz-engine.js.
//   3. Self-test getSoal() sekali. Kalau gagal (atau Sheet "Soal" kosong), tampilkan
//      peringatan "link sudah jadi, tapi soal belum lengkap -- cek tab Kunci di Sheet".
//   4. Tampilkan link akhir kuis: RUNNER_BASE_URL?src=<APPS_SCRIPT_URL di-encode>.

// IS YANG PUNYA DOMAIN: ganti nilai ini ke URL halaman quiz-runner yang sudah
// di-deploy (M6.4). Format link akhir: <RUNNER_BASE_URL>?src=<url apps script>.
const RUNNER_BASE_URL = "https://angonrasa.github.io/asesmen/";

// M7.2 (blueprint bagian 17): URL Web App shortener terpisah (backend-shortener/,
// lihat PANDUAN-DEPLOY-SHORTENER.md). GANTI nilai ini ke URL /exec asli setelah
// deploy (langkah 6 di panduan itu) -- sebelum itu diganti, submit form akan
// selalu gagal di tahap "Membuat link pendek..." (fetch ke placeholder ini gagal).
// Dipakai di form submit handler (M7.4, blueprint 17.5) untuk memanggil shorten().
const SHORTENER_URL = "https://script.google.com/macros/s/AKfycbwMtuZZUxEFe9APpdwkCY7nGZJsECwzzG5IyoXA2b8eB02N1qQhYNhtXMbB1MPhovk6/exec";

(function () {
  const form = document.getElementById("wizardForm");
  const scriptUrlInput = document.getElementById("scriptUrl");
  const judulInput = document.getElementById("judul");
  const brandInput = document.getElementById("brand");
  const deskripsiInput = document.getElementById("deskripsi");
  const warnaInput = document.getElementById("warna");
  const warnaText = document.getElementById("warnaText");
  const kodeCustomInput = document.getElementById("kodeCustom");
  const kodeCustomError = document.getElementById("kodeCustomError");
  const urlError = document.getElementById("urlError");
  const formError = document.getElementById("formError");
  const submitBtn = document.getElementById("submitBtn");
  const resultCard = document.getElementById("resultCard");
  const finalLink = document.getElementById("finalLink");
  const qrContainer = document.getElementById("qrContainer");
  const downloadQrBtn = document.getElementById("downloadQrBtn");
  const copyBtn = document.getElementById("copyBtn");
  const selfTestWarn = document.getElementById("selfTestWarn");
  const resetLink = document.getElementById("resetLink");

  let busy = false;

  warnaInput.addEventListener("input", () => {
    warnaText.textContent = warnaInput.value;
  });

  // Validasi ringan sebelum submit (blueprint 16.5): URL harus diawali
  // https://script.google.com/macros/s/ dan diakhiri /exec.
  function isValidScriptUrl(url) {
    return url.startsWith("https://script.google.com/macros/s/") && url.endsWith("/exec");
  }

  // M7.4 (blueprint 17.5): kode custom opsional, format harus sama dengan yang
  // ditegakkan backend shortener (huruf/angka/dash, 3-30 karakter) -- kalau tidak
  // divalidasi di sini juga, guru baru tahu salah format setelah setConfig() jalan.
  function isValidKodeCustom(kode) {
    return /^[a-zA-Z0-9-]{3,30}$/.test(kode);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;

    urlError.textContent = "";
    kodeCustomError.textContent = "";
    formError.textContent = "";

    const scriptUrl = scriptUrlInput.value.trim();
    if (!scriptUrl) {
      urlError.textContent = "Tempel URL Apps Script dulu.";
      return;
    }
    if (!isValidScriptUrl(scriptUrl)) {
      urlError.textContent = "URL sepertinya bukan URL deployment Apps Script yang benar (harus dimulai https://script.google.com/macros/s/ dan diakhiri /exec).";
      return;
    }

    const kodeCustom = kodeCustomInput.value.trim();
    if (kodeCustom && !isValidKodeCustom(kodeCustom)) {
      kodeCustomError.textContent = 'Kode custom hanya boleh huruf, angka, dan tanda "-", panjang 3-30 karakter.';
      return;
    }

    const config = {
      judul_kuis: judulInput.value.trim(),
      brand: brandInput.value.trim(),
      deskripsi: deskripsiInput.value.trim(),
      warna_tema: warnaInput.value
    };

    setBusy(true, "Menyimpan pengaturan...");
    try {
      const res = await fetch(scriptUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "setConfig", config: config })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Gagal menyimpan pengaturan");

      // Self-test getSoal() sekali (blueprint 16.5 langkah 3).
      let warnMsg = null;
      try {
        const testRes = await fetch(scriptUrl + "?action=getSoal");
        const testData = await testRes.json();
        if (!testData.ok) {
          throw new Error(testData.error || "getSoal gagal");
        }
        const adaSoal = (testData.soalPG && testData.soalPG.length > 0) ||
                        (testData.soalEssay && testData.soalEssay.length > 0);
        if (!adaSoal) {
          warnMsg = 'Link sudah jadi, tapi soal belum lengkap — cek tab Kunci di Sheet.';
        }
      } catch (err) {
        warnMsg = 'Link sudah jadi, tapi soal belum lengkap atau belum bisa dimuat (' + err + '). Cek tab Kunci di Sheet.';
      }

      // M7.4 (blueprint 17.5): setelah setConfig() sukses, minta kode pendek ke
      // shortener terpisah (17.4). Kalau kode custom sudah dipakai guru lain,
      // gagal DI SINI dengan pesan jelas -- guru tetap di form untuk ganti kode,
      // BUKAN dilanjutkan diam-diam pakai kode lain (keputusan blueprint 17.4).
      setBusy(true, "Membuat link pendek...");
      let kodeFinal;
      try {
        const shortenRes = await fetch(SHORTENER_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ action: "shorten", kode_custom: kodeCustom, src: scriptUrl })
        });
        const shortenData = await shortenRes.json();
        if (!shortenData.ok) throw new Error(shortenData.error || "Gagal membuat link pendek");
        kodeFinal = shortenData.kode;
      } catch (err) {
        kodeCustomError.textContent = "Gagal membuat link pendek: " + err + ". Coba ganti kode custom (atau kosongkan), lalu kirim ulang. Pengaturan kuis Anda sudah tersimpan.";
        return;
      }

      showResult(kodeFinal, warnMsg);
    } catch (err) {
      formError.textContent = "Gagal menyimpan pengaturan ke Apps Script: " + err;
    } finally {
      setBusy(false);
    }
  });

  // M7.4: dipanggil 2x berturut dalam satu submit (setConfig lalu shorten),
  // jadi dataset.original hanya boleh direkam sekali per siklus busy, bukan
  // ketiban label perantara ("Menyimpan pengaturan..." dst).
  function setBusy(bool, label) {
    const submitButton = form.querySelector("button[type=submit]");
    busy = bool;
    submitButton.disabled = bool;
    if (bool) {
      if (!submitButton.dataset.original) {
        submitButton.dataset.original = submitButton.textContent;
      }
      if (label) submitButton.textContent = label;
    } else if (submitButton.dataset.original) {
      submitButton.textContent = submitButton.dataset.original;
      delete submitButton.dataset.original;
    }
  }

  function showResult(kode, warnMsg) {
    const link = RUNNER_BASE_URL + "?" + kode;
    finalLink.value = link;
    renderQr(link);
    selfTestWarn.classList.toggle("hidden", !warnMsg);
    if (warnMsg) selfTestWarn.textContent = warnMsg;

    form.classList.add("hidden");
    resultCard.classList.remove("hidden");
  }

  // M7.6 (blueprint 17.7): pakai qrcode-lib.js yang di-vendor lokal (lihat
  // PANDUAN-DEPLOY-SHORTENER.md untuk cara download sekali, bukan CDN saat runtime).
  // API-nya: qrcode(typeNumber, errorCorrectionLevel) -> addData() -> make() -> createSvgTag().
  // typeNumber 0 = auto pilih ukuran sesuai panjang teks. SVG dipilih (bukan
  // PNG/canvas) supaya hasil download tetap tajam kalau di-zoom/print guru.
  function renderQr(link) {
    if (typeof qrcode === "undefined") {
      qrContainer.innerHTML = '<p class="small">QR code tidak bisa dibuat -- qrcode-lib.js belum terpasang. Lihat PANDUAN-DEPLOY-SHORTENER.md.</p>';
      downloadQrBtn.classList.add("hidden");
      return;
    }
    try {
      const qr = qrcode(0, "M");
      qr.addData(link);
      qr.make();
      const svg = qr.createSvgTag(6, 16); // cellSize 6px, margin 16px
      qrContainer.innerHTML = svg;

      const svgDataUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      downloadQrBtn.onclick = () => {
        const a = document.createElement("a");
        a.href = svgDataUrl;
        a.download = "qr-kuis.svg";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      };
      downloadQrBtn.classList.remove("hidden");
    } catch (err) {
      qrContainer.innerHTML = '<p class="small">Gagal membuat QR code (' + err + ').</p>';
      downloadQrBtn.classList.add("hidden");
    }
  }

  copyBtn.addEventListener("click", () => {
    finalLink.select();
    finalLink.setSelectionRange(0, finalLink.value.length);
    try {
      navigator.clipboard.writeText(finalLink.value)
        .then(() => { copyBtn.textContent = "Tersalin"; })
        .catch(() => { document.execCommand("copy"); copyBtn.textContent = "Tersalin"; });
    } catch (err) {
      document.execCommand("copy");
      copyBtn.textContent = "Tersalin";
    }
    setTimeout(() => { copyBtn.textContent = "Salin"; }, 2000);
  });

  resetLink.addEventListener("click", (e) => {
    e.preventDefault();
    form.classList.remove("hidden");
    resultCard.classList.add("hidden");
    formError.textContent = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
})();