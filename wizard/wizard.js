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

(function () {
  const form = document.getElementById("wizardForm");
  const scriptUrlInput = document.getElementById("scriptUrl");
  const judulInput = document.getElementById("judul");
  const brandInput = document.getElementById("brand");
  const deskripsiInput = document.getElementById("deskripsi");
  const warnaInput = document.getElementById("warna");
  const warnaText = document.getElementById("warnaText");
  const urlError = document.getElementById("urlError");
  const formError = document.getElementById("formError");
  const submitBtn = document.getElementById("submitBtn");
  const resultCard = document.getElementById("resultCard");
  const finalLink = document.getElementById("finalLink");
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

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;

    urlError.textContent = "";
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

      showResult(scriptUrl, warnMsg);
    } catch (err) {
      formError.textContent = "Gagal menyimpan pengaturan ke Apps Script: " + err;
    } finally {
      setBusy(false);
    }
  });

  function setBusy(bool, label) {
    const submitButton = form.querySelector("button[type=submit]");
    busy = bool;
    submitButton.disabled = bool;
    if (label) {
      submitButton.dataset.original = submitButton.textContent;
      submitButton.textContent = label;
    } else if (submitButton.dataset.original) {
      submitButton.textContent = submitButton.dataset.original;
    }
  }

  function showResult(scriptUrl, warnMsg) {
    const link = RUNNER_BASE_URL + "?src=" + encodeURIComponent(scriptUrl);
    finalLink.value = link;
    selfTestWarn.classList.toggle("hidden", !warnMsg);
    if (warnMsg) selfTestWarn.textContent = warnMsg;

    form.classList.add("hidden");
    resultCard.classList.remove("hidden");
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