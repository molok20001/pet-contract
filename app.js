/* ══════════════════════════════════════════
   app.js — 主程式入口
   職責：初始化所有副程式，處理送出流程
   ──────────────────────────────────────────
   流程：
   1. 頁面載入 → 從 Worker GET /config 取得店家設定和條文
   2. 填入頁首店家名稱、填入今天日期
   3. 條文交給 clause-renderer.js 渲染
   4. 使用者填表 + 簽名 → 送出
   5. 前端生成 PDF → POST 給 Worker → 顯示完成
══════════════════════════════════════════ */

// Worker API 網址（統一在這裡修改）
const WORKER_URL = 'https://pet-contract.pet-cont-mor.workers.dev';

// 目前店家 ID（未來從網址參數取得）
const SHOP_ID = 'default';

// 儲存從 Worker 取得的資料（給 PDF 生成用）
let shopData = null;
let clausesData = [];

/* ════════════════════════════════════════
   頁面載入後初始化
════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  // 初始化簽名板（signature.js）
  initSignature();

  // 填入今天日期
  fillSignDate();

  // 從 Worker 載入店家設定和條文
  await loadConfig();

  // 綁定送出按鈕
  bindSubmitButton();
});

/**
 * 從 Worker 取得店家設定和條文資料
 * 成功後填入頁首、渲染條文
 */
async function loadConfig() {
  try {
    const response = await fetch(`${WORKER_URL}/config?shop_id=${SHOP_ID}`);
    const data = await response.json();

    if (data.success) {
      // 儲存資料供後續使用
      shopData = data.shopConfig;
      clausesData = data.clauses;

      // 填入頁首店家名稱
      const shopNameEl = document.getElementById('shop-name');
      if (shopNameEl) shopNameEl.textContent = shopData.company_name || '';

      // 儲存預設獸醫供表單使用
      window.defaultVet = shopData.default_vet || '';

      // 渲染條文（clause-renderer.js）
      renderClauses(clausesData);

    } else {
      // 找不到店家設定（尚未完成設定）
      console.warn('[app] 找不到店家設定，使用空白顯示');
      const shopNameEl = document.getElementById('shop-name');
      if (shopNameEl) shopNameEl.textContent = '（請完成店家設定）';
    }

  } catch (err) {
    // 網路錯誤或 Worker 未部署
    console.error('[app] 載入設定失敗：', err);
    const shopNameEl = document.getElementById('shop-name');
    if (shopNameEl) shopNameEl.textContent = '（載入失敗，請重新整理）';
  }
}

/**
 * 填入今天的簽約日期
 * 格式：YYYY年MM月DD日
 */
function fillSignDate() {
  const dateInput = document.getElementById('sign-date');
  if (!dateInput) return;

  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');

  dateInput.value = `${year}年${month}月${day}日`;
}

/**
 * 綁定送出按鈕的點擊事件
 */
function bindSubmitButton() {
  const submitBtn = document.getElementById('submit-btn');
  if (!submitBtn) return;
  submitBtn.addEventListener('click', handleSubmit);
}

/**
 * 處理送出流程
 * 步驟：驗證 → 確認簽名 → 生成 PDF → POST 給 Worker → 顯示完成
 */
async function handleSubmit() {
  const submitBtn = document.getElementById('submit-btn');
  const errorMessage = document.getElementById('error-message');

  errorMessage.hidden = true;

  // 步驟一：表單驗證（form-validator.js）
  const isValid = validateForm();
  if (!isValid) return;

  // 步驟二：確認簽名不為空（signature.js）
  if (isSignatureEmpty()) {
    const signatureWrapper = document.getElementById('signature-wrapper');
    if (signatureWrapper) signatureWrapper.classList.add('error');
    document.getElementById('signature-section')
      .scrollIntoView({ behavior: 'smooth', block: 'center' });
    showGlobalError('請完成簽名後再送出');
    return;
  }

  // 步驟三：生成 PDF（pdf-client.js）
  submitBtn.textContent = '生成 PDF 中...';
  submitBtn.classList.add('loading');

  try {
    const formData = collectFormData();
    const signatureDataUrl = getSignatureDataUrl();

    const pdfBytes = await generatePDF(
      formData,
      signatureDataUrl,
      clausesData,
      shopData || { company_name: '', default_vet: '' }
    );

    window.generatedPdfBytes = pdfBytes;

    // 步驟四：POST 資料給 Worker 存入 KV
    submitBtn.textContent = '儲存中...';
    try {
      const response = await fetch(`${WORKER_URL}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shop_id: SHOP_ID,
          formData,
          signatureDataUrl,
          clauses: clausesData,
        }),
      });
      const result = await response.json();
      if (!result.success) {
        console.warn('[app] Worker 儲存失敗：', result);
      }
    } catch (err) {
      console.warn('[app] Worker 呼叫失敗（不中斷流程）：', err);
    }

    // 步驟五：顯示完成畫面
    showSuccessScreen();

  } catch (err) {
    console.error('[app] PDF 生成失敗：', err);
    showGlobalError('PDF 生成失敗，請重試。如問題持續請聯絡店家。');
    submitBtn.textContent = '確認簽署並送出';
    submitBtn.classList.remove('loading');
  }
}

/**
 * 收集所有表單欄位的值
 * @returns {Object}
 */
function collectFormData() {
  return {
    ownerName:      document.getElementById('owner-name').value.trim(),
    ownerId:        document.getElementById('owner-id').value.trim(),
    ownerAddress:   document.getElementById('owner-address').value.trim(),
    ownerPhone:     document.getElementById('owner-phone').value.trim(),
    emergencyName:  document.getElementById('emergency-name').value.trim(),
    emergencyPhone: document.getElementById('emergency-phone').value.trim(),
    vetName:        document.getElementById('vet-name').value.trim() || window.defaultVet || '',
    petChip:        document.getElementById('pet-chip').value.trim(),
    signDate:       document.getElementById('sign-date').value,
  };
}

/**
 * 顯示全域錯誤訊息
 */
function showGlobalError(message) {
  const errorMessage = document.getElementById('error-message');
  if (!errorMessage) return;
  errorMessage.textContent = message;
  errorMessage.hidden = false;
  errorMessage.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/**
 * 顯示完成畫面
 */
function showSuccessScreen() {
  document.getElementById('clause-section').hidden = true;
  document.getElementById('agreement-section').hidden = true;
  document.getElementById('form-section').hidden = true;
  document.getElementById('signature-section').hidden = true;
  document.getElementById('submit-section').hidden = true;

  const successSection = document.getElementById('success-section');
  successSection.hidden = false;
  successSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const downloadBtn = document.getElementById('download-pdf-btn');
  if (downloadBtn && window.generatedPdfBytes) {
    downloadBtn.addEventListener('click', () => {
      const blob = new Blob([window.generatedPdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `寵物美容契約_${document.getElementById('sign-date').value}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }
}
